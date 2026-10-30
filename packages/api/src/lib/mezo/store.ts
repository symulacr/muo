// D1-backed IndexerStore.
//
// Atomicity
// ---------
// The whole cycle commits in ONE `db.batch()` call. D1 `batch()` is
// transactional, so the ledger, the projection, the cursor and the block-hash
// history land together or not at all. This is the only transaction boundary in
// the indexer; nothing here claims a transaction across separate HTTP requests.
//
// Commit witness
// --------------
// Each `commit()` mints a UNIQUE token (`crypto.randomUUID()`) and writes it into
// `mezo_indexer_cursor.lease_owner` as the FIRST statement — the cursor CAS.
// Every subsequent statement is guarded by
//
//   EXISTS (SELECT 1 FROM mezo_indexer_cursor
//            WHERE chain_id = ? AND core_address = ? AND lease_owner = <token>)
//
// The token is the witness that THIS transaction is the one that won the CAS.
//
// A position+version guard alone is NOT unique: a stale run that happens to
// target the exact same next position (same version, block, hash, logIndex)
// would satisfy such a guard, write its projection, and report success. The
// token is minted inside `commit()` and is never reused or caller-supplied, so a
// stale run's writes are always no-ops.
//
// Success detection
// -----------------
// Success is the FIRST statement's `meta.changes === 1`. It is NOT a post-read
// of the cursor: a later commit may legitimately advance the cursor between our
// batch and our read, which would make a genuine winner look like a loser (and,
// worse, a loser that matched the winner's position look like a winner).
//
// The `applied` count is the sum of `meta.changes` over the ledger inserts, so a
// duplicate re-delivery reports 0 rather than the number of rows attempted.

import type { AssertionEvent, Hex } from "@muo/core/native";

import type { CommitInput, CommitResult, Cursor, IndexerStore } from "./indexer";
import type { LedgerEntry } from "./projection";

const ASSERTION_COLUMNS = [
  "chain_id",
  "core_address",
  "assertion_id",
  "identifier",
  "claim",
  "bond_musd",
  "liveness",
  "status",
  "asserter",
  "disputer",
  "settler",
  "resolver",
  "asserted_at_block",
  "asserted_tx_id",
  "disputed_at_block",
  "disputed_tx_id",
  "settled_at_block",
  "settled_tx_id",
  "resolved_at_block",
  "resolved_tx_id",
  "block_number",
  "block_hash",
  "transaction_index",
  "log_index",
  "updated_at",
] as const;

/**
 * The per-commit witness guard.
 *
 * Binds `(chain_id, core_address, witness)`. The witness is the token this
 * commit wrote into `lease_owner`, so the guard is satisfied only inside the
 * transaction that won the CAS.
 */
const GUARD = `exists (select 1 from "mezo_indexer_cursor"
  where "chain_id" = ? and "core_address" = ? and "lease_owner" = ?)`;

/**
 * Guarded projection upsert.
 *
 * `INSERT ... SELECT ... WHERE <guard>` — NOT `VALUES`. An unguarded `VALUES`
 * upsert ignores the CAS entirely: a lost commit would still write the
 * projection even though every ledger statement was correctly skipped.
 */
const UPSERT_ASSERTION = `insert into "mezo_assertions" (${ASSERTION_COLUMNS.map((c) => `"${c}"`).join(", ")})
select ${ASSERTION_COLUMNS.map(() => "?").join(", ")}
where ${GUARD}
on conflict ("chain_id", "core_address", "assertion_id") do update set
${ASSERTION_COLUMNS.filter((c) => c !== "chain_id" && c !== "core_address" && c !== "assertion_id")
  .map((c) => `"${c}" = excluded."${c}"`)
  .join(", ")}`;

const INSERT_LEDGER = `insert or ignore into "mezo_applied_logs"
("chain_id", "core_address", "tx_hash", "log_index", "block_number", "block_hash", "transaction_index", "assertion_id", "event_kind", "payload", "applied_at")
select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
where ${GUARD}`;

const DELETE_LEDGER = `delete from "mezo_applied_logs"
where "chain_id" = ? and "core_address" = ? and "tx_hash" = ? and "log_index" = ?
  and ${GUARD}`;

const DELETE_ASSERTION = `delete from "mezo_assertions"
where "chain_id" = ? and "core_address" = ? and "assertion_id" = ?
  and ${GUARD}`;

const UPSERT_BLOCK_HASH = `insert into "mezo_block_hashes" ("chain_id", "core_address", "block_number", "block_hash", "observed_at")
select ?, ?, ?, ?, ?
where ${GUARD}
on conflict ("chain_id", "core_address", "block_number") do update set "block_hash" = excluded."block_hash", "observed_at" = excluded."observed_at"`;

/** Drop anchors above the fork point so a stale anchor cannot mask a later reorg. */
const DELETE_BLOCK_HASHES_ABOVE = `delete from "mezo_block_hashes"
where "chain_id" = ? and "core_address" = ? and "block_number" > ?
  and ${GUARD}`;

/**
 * Cursor CAS. Writes the witness token into `lease_owner` and bumps `version`.
 *
 * `meta.changes === 1` means this transaction won. `0` means another commit
 * already moved the cursor (or the row does not exist).
 */
const CAS_CURSOR = `update "mezo_indexer_cursor"
set "version" = "version" + 1, "block_number" = ?, "block_hash" = ?, "log_index" = ?,
    "lease_owner" = ?, "lease_expires_at" = ?, "last_error" = null, "updated_at" = ?
where "chain_id" = ? and "core_address" = ? and "version" = ?`;

/**
 * Release the witness token.
 *
 * Runs last, in the same transaction. It does not change the cursor position, so
 * the CAS trigger (which only rejects an unversioned position change) allows it.
 * If the CAS lost, `lease_owner` holds the winner's token, so this matches zero
 * rows and changes nothing.
 */
const RELEASE_LEASE = `update "mezo_indexer_cursor"
set "lease_owner" = null, "lease_expires_at" = null
where "chain_id" = ? and "core_address" = ? and "lease_owner" = ?`;

/**
 * First-run insert. `on conflict do nothing` makes `meta.changes` the CAS
 * witness: 1 if this run created the row, 0 if a concurrent run already did.
 */
const INSERT_CURSOR = `insert into "mezo_indexer_cursor"
("chain_id", "core_address", "block_number", "block_hash", "log_index", "version", "lease_owner", "lease_expires_at", "last_error", "updated_at")
values (?, ?, ?, ?, ?, 0, ?, ?, null, ?)
on conflict ("chain_id", "core_address") do nothing`;

export class D1IndexerStore implements IndexerStore {
  constructor(private readonly db: D1Database) {}

  async readCursor(chainId: number, coreAddress: string): Promise<Cursor | null> {
    const row = await this.db
      .prepare(`select "block_number", "block_hash", "log_index", "version" from "mezo_indexer_cursor" where "chain_id" = ? and "core_address" = ?`)
      .bind(chainId, coreAddress)
      .first<{ block_number: number; block_hash: string; log_index: number; version: number }>();
    if (!row) return null;
    return {
      blockNumber: row.block_number,
      blockHash: row.block_hash as Hex,
      logIndex: row.log_index,
      version: row.version,
    };
  }

  async readLease(chainId: number, coreAddress: string): Promise<{ owner: string | null; expiresAt: number | null }> {
    const row = await this.db
      .prepare(`select "lease_owner", "lease_expires_at" from "mezo_indexer_cursor" where "chain_id" = ? and "core_address" = ?`)
      .bind(chainId, coreAddress)
      .first<{ lease_owner: string | null; lease_expires_at: number | null }>();
    return { owner: row?.lease_owner ?? null, expiresAt: row?.lease_expires_at ?? null };
  }

  async readLedgerFrom(chainId: number, coreAddress: string, fromBlock: number): Promise<LedgerEntry[]> {
    const { results } = await this.db
      .prepare(
        `select "payload" from "mezo_applied_logs" where "chain_id" = ? and "core_address" = ? and "block_number" >= ? order by "block_number", "transaction_index", "log_index"`
      )
      .bind(chainId, coreAddress, fromBlock)
      .all<{ payload: string }>();
    return (results ?? []).map((r) => entryFromPayload(r.payload));
  }

  async readLedgerFor(chainId: number, coreAddress: string, assertionId: Hex): Promise<LedgerEntry[]> {
    const { results } = await this.db
      .prepare(
        `select "payload" from "mezo_applied_logs" where "chain_id" = ? and "core_address" = ? and "assertion_id" = ? order by "block_number", "transaction_index", "log_index"`
      )
      .bind(chainId, coreAddress, assertionId)
      .all<{ payload: string }>();
    return (results ?? []).map((r) => entryFromPayload(r.payload));
  }

  /**
   * Best-known stored hash for a height.
   *
   * Prefers the anchor table, then falls back to any ledger row at that height.
   * Ledger rows are denser than anchors (every block that produced an event has
   * one), which is what makes a bounded ancestor search actually find a fork
   * point several blocks below the cursor.
   */
  async readBlockHash(chainId: number, coreAddress: string, blockNumber: number): Promise<Hex | null> {
    const row = await this.db
      .prepare(
        `select "block_hash" from "mezo_block_hashes" where "chain_id" = ? and "core_address" = ? and "block_number" = ?
         union all
         select "block_hash" from "mezo_applied_logs" where "chain_id" = ? and "core_address" = ? and "block_number" = ?
         limit 1`
      )
      .bind(chainId, coreAddress, blockNumber, chainId, coreAddress, blockNumber)
      .first<{ block_hash: string }>();
    return (row?.block_hash as Hex | undefined) ?? null;
  }

  async recordError(chainId: number, coreAddress: string, message: string): Promise<void> {
    await this.db
      .prepare(`update "mezo_indexer_cursor" set "last_error" = ?, "updated_at" = ? where "chain_id" = ? and "core_address" = ?`)
      .bind(message.slice(0, 500), Date.now(), chainId, coreAddress)
      .run();
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    const { chainId, coreAddress } = input;
    // Minted HERE, never supplied by the caller: the witness must be unique to
    // this commit attempt, otherwise a stale run could reuse it.
    const witness = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    const guard = [chainId, coreAddress, witness] as const;

    // 1. Cursor CAS. Writes the witness; its `meta.changes` is the success signal.
    if (input.expectedCursor === null) {
      statements.push(
        this.db
          .prepare(INSERT_CURSOR)
          .bind(
            chainId,
            coreAddress,
            input.nextCursor.blockNumber,
            input.nextCursor.blockHash,
            input.nextCursor.logIndex,
            witness,
            input.leaseExpiresAt,
            input.now
          )
      );
    } else {
      statements.push(
        this.db
          .prepare(CAS_CURSOR)
          .bind(
            input.nextCursor.blockNumber,
            input.nextCursor.blockHash,
            input.nextCursor.logIndex,
            witness,
            input.leaseExpiresAt,
            input.now,
            chainId,
            coreAddress,
            input.expectedCursor.version
          )
      );
    }

    // 2. Ledger appends, guarded by the witness. `insert or ignore` reports
    //    changes=1 only for a row that was actually new, so the sum is the true
    //    applied count (a duplicate re-delivery contributes 0).
    const ledgerFrom = statements.length;
    for (const e of input.append) {
      statements.push(
        this.db
          .prepare(INSERT_LEDGER)
          .bind(
            chainId,
            coreAddress,
            e.txHash,
            e.logIndex,
            e.blockNumber,
            e.blockHash,
            e.transactionIndex,
            e.assertionId,
            e.event.event,
            JSON.stringify(e.event),
            input.now,
            ...guard
          )
      );
    }
    const ledgerTo = statements.length;

    // 3. Reorg ledger removals, same witness.
    for (const r of input.remove) {
      statements.push(this.db.prepare(DELETE_LEDGER).bind(chainId, coreAddress, r.txHash, r.logIndex, ...guard));
    }

    // 4. Projection writes, same witness. `null` row => delete.
    for (const p of input.projections) {
      if (p.row === null) {
        statements.push(this.db.prepare(DELETE_ASSERTION).bind(chainId, coreAddress, p.assertionId, ...guard));
        continue;
      }
      const r = p.row;
      statements.push(
        this.db
          .prepare(UPSERT_ASSERTION)
          .bind(
            chainId,
            coreAddress,
            r.assertionId,
            r.identifier,
            r.claim,
            r.bondMusd,
            r.liveness,
            r.status,
            r.asserter,
            r.disputer,
            r.settler,
            r.resolver,
            r.assertedAtBlock,
            r.assertedTxId,
            r.disputedAtBlock,
            r.disputedTxId,
            r.settledAtBlock,
            r.settledTxId,
            r.resolvedAtBlock,
            r.resolvedTxId,
            r.blockNumber,
            r.blockHash,
            r.transactionIndex,
            r.logIndex,
            input.now,
            ...guard
          )
      );
    }

    // 5. Block-hash anchors, same witness.
    for (const b of input.blockHashes) {
      statements.push(this.db.prepare(UPSERT_BLOCK_HASH).bind(chainId, coreAddress, b.blockNumber, b.blockHash, input.now, ...guard));
    }

    // 6. Drop anchors above the fork point, same witness.
    if (input.removeBlockHashesAbove !== null) {
      statements.push(this.db.prepare(DELETE_BLOCK_HASHES_ABOVE).bind(chainId, coreAddress, input.removeBlockHashesAbove, ...guard));
    }

    // 7. Release the witness token, last.
    statements.push(this.db.prepare(RELEASE_LEASE).bind(chainId, coreAddress, witness));

    let results: { meta?: { changes?: number } }[];
    try {
      results = (await this.db.batch(statements as [D1PreparedStatement, ...D1PreparedStatement[]])) as never;
    } catch {
      // A failed batch rolls back in D1. Nothing from this run is committed.
      return { ok: false, applied: 0 };
    }

    // Success is the CAS's own `meta.changes`, not a post-read of the cursor.
    const casChanges = results?.[0]?.meta?.changes ?? 0;
    if (casChanges !== 1) return { ok: false, applied: 0 };

    let applied = 0;
    for (let i = ledgerFrom; i < ledgerTo; i++) applied += results?.[i]?.meta?.changes ?? 0;

    return { ok: true, applied };
  }
}

const entryFromPayload = (payload: string): LedgerEntry => {
  const event = JSON.parse(payload) as AssertionEvent;
  return {
    txHash: event.provenance.transactionHash,
    logIndex: event.provenance.logIndex,
    blockNumber: event.provenance.blockNumber,
    blockHash: event.provenance.blockHash,
    transactionIndex: event.provenance.transactionIndex,
    assertionId: event.data.assertionId,
    event,
  };
};
