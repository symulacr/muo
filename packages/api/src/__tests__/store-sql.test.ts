// SQL-level regression tests for the commit protocol.
//
// These run against REAL SQLite (bun:sqlite) through ./sqlite-d1.ts, which
// implements `batch()` as a genuine `BEGIN IMMEDIATE ... COMMIT` and reports
// real `meta.changes` / `last_row_id` for writes. That combination is the only
// way to prove the properties below; an `all()`-based mock or a `Promise.all`
// batch cannot distinguish a working guard from a broken one.
//
// Properties under test:
//   1. the projection upsert is GUARDED (a lost CAS writes no projection row)
//   2. the witness token is unique per commit and required by every write
//   3. success is the CAS's own `meta.changes`, not a post-read of the cursor
//   4. a stale run targeting the EXACT winner position still writes nothing
//   5. a mid-batch failure rolls back everything, and a retry then succeeds
//
// Scope: LOCAL ONLY. SQLite is not D1, but it shares the SQL semantics that
// these guards rely on. This is not evidence about production D1 behaviour.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AssertionEvent, Hex } from "@muo/core/native";
import { TESTNET_CORE } from "@muo/core/native";
import { computeAssertionId } from "@muo/utils/native";

import type { CommitInput, Cursor } from "../lib/mezo/indexer";
import type { LedgerEntry, ProjectedAssertion } from "../lib/mezo/projection";
import { D1IndexerStore } from "../lib/mezo/store";
import { SqliteD1 } from "./sqlite-d1";

const CHAIN = 31611;
const CORE = TESTNET_CORE;
const IDENT = `0x${"11".repeat(32)}` as Hex;
const CLAIM = "0xdeadbeef" as Hex;
const ACTOR = "0x2a2a8551e30c63263dd9dbb698e57fb37c77a6b3" as Hex;
const BLOCK = 100;
const ID = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(BLOCK));
const BH = `0x${"bb".repeat(32)}` as Hex;
const TX = `0x${"cc".repeat(32)}` as Hex;

let d1: SqliteD1;
let store: D1IndexerStore;

beforeEach(() => {
  d1 = new SqliteD1();
  store = new D1IndexerStore(d1 as unknown as D1Database);
});

afterEach(() => {
  d1.close();
});

const event = (over: Partial<AssertionEvent["data"]> = {}): AssertionEvent => ({
  event: "asserted",
  data: {
    assertionId: ID,
    identifier: IDENT,
    claim: CLAIM,
    bondMusd: "10",
    liveness: 1440,
    assertedBy: ACTOR,
    assertedAtBlock: BLOCK,
    assertedTxId: TX,
    ...(over as object),
  },
  provenance: {
    chainId: CHAIN as 31611,
    coreAddress: CORE,
    blockNumber: BLOCK,
    blockHash: BH,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex: 0,
  },
});

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => {
  const e = event();
  return {
    txHash: TX,
    logIndex: 0,
    blockNumber: BLOCK,
    blockHash: BH,
    transactionIndex: 0,
    assertionId: ID,
    event: e,
    ...over,
  };
};

const row = (): ProjectedAssertion => ({
  assertionId: ID,
  identifier: IDENT,
  claim: CLAIM,
  bondMusd: "10",
  liveness: 1440,
  status: "open",
  asserter: ACTOR,
  disputer: null,
  settler: null,
  resolver: null,
  assertedAtBlock: BLOCK,
  assertedTxId: TX,
  disputedAtBlock: null,
  disputedTxId: null,
  settledAtBlock: null,
  settledTxId: null,
  resolvedAtBlock: null,
  resolvedTxId: null,
  blockNumber: BLOCK,
  blockHash: BH,
  transactionIndex: 0,
  logIndex: 0,
});

const cursorAt = (version: number, block = BLOCK): Cursor => ({
  blockNumber: block,
  blockHash: BH,
  logIndex: 0,
  version,
});

const input = (expected: Cursor | null, next: Cursor, over: Partial<CommitInput> = {}): CommitInput => ({
  chainId: CHAIN,
  coreAddress: CORE,
  expectedCursor: expected,
  nextCursor: next,
  leaseExpiresAt: 2_000_000,
  append: [entry()],
  remove: [],
  projections: [{ assertionId: ID, row: row(), blockNumber: BLOCK }],
  blockHashes: [{ blockNumber: BLOCK, blockHash: BH }],
  removeBlockHashesAbove: null,
  now: 1_000_000,
  ...over,
});

const count = (table: string): number => (d1.db.query(`select count(*) as c from "${table}"`).get() as { c: number }).c;
const projectionRows = (): number => count("mezo_assertions");
const ledgerRows = (): number => count("mezo_applied_logs");
const anchorRows = (): number => count("mezo_block_hashes");

describe("first commit", () => {
  test("reports ok with applied=1 and writes all three stores", async () => {
    const r = await store.commit(input(null, cursorAt(0)));
    expect(r).toEqual({ ok: true, applied: 1 });
    expect(projectionRows()).toBe(1);
    expect(ledgerRows()).toBe(1);
    expect(anchorRows()).toBe(1);
    const cursor = await store.readCursor(CHAIN, CORE);
    expect(cursor?.version).toBe(0);
  });

  test("releases the witness token at the end of the batch", async () => {
    await store.commit(input(null, cursorAt(0)));
    const lease = await store.readLease(CHAIN, CORE);
    expect(lease.owner).toBeNull();
  });

  test("a duplicate re-delivery reports applied=0 and does not duplicate rows", async () => {
    await store.commit(input(null, cursorAt(0)));
    const r = await store.commit(input(cursorAt(0), cursorAt(1)));
    expect(r).toEqual({ ok: true, applied: 0 });
    expect(ledgerRows()).toBe(1);
    expect(projectionRows()).toBe(1);
  });
});

describe("CAS loss", () => {
  test("a stale version writes NO projection, ledger or anchor row", async () => {
    await store.commit(input(null, cursorAt(0)));

    // The stale run still believes the cursor is at version -1 (i.e. absent)
    // but the row now exists, so its CAS matches nothing.
    const r = await store.commit(
      input(null, cursorAt(0), {
        append: [entry({ txHash: `0x${"dd".repeat(32)}` as Hex })],
        projections: [{ assertionId: `0x${"99".repeat(32)}` as Hex, row: row(), blockNumber: BLOCK }],
        blockHashes: [{ blockNumber: BLOCK + 1, blockHash: `0x${"ee".repeat(32)}` as Hex }],
      })
    );

    expect(r).toEqual({ ok: false, applied: 0 });
    // Nothing from the loser landed.
    expect(projectionRows()).toBe(1);
    expect(ledgerRows()).toBe(1);
    expect(anchorRows()).toBe(1);
  });

  test("a stale run targeting the EXACT winner position still writes nothing", async () => {
    // Winner commits to (version 0, block BLOCK, logIndex 0).
    await store.commit(input(null, cursorAt(0)));

    // A stale run computed the SAME next cursor (same version, block, hash and
    // logIndex) from a stale read. A position+version guard would be satisfied
    // here; only the unique witness token distinguishes the two.
    const r = await store.commit(
      input(null, cursorAt(0), {
        append: [entry({ txHash: `0x${"ab".repeat(32)}` as Hex, logIndex: 1 })],
        projections: [{ assertionId: `0x${"77".repeat(32)}` as Hex, row: row(), blockNumber: BLOCK }],
        blockHashes: [{ blockNumber: BLOCK, blockHash: `0x${"12".repeat(32)}` as Hex }],
      })
    );

    expect(r).toEqual({ ok: false, applied: 0 });
    expect(projectionRows()).toBe(1);
    expect(ledgerRows()).toBe(1);
    // The winner's anchor was not overwritten.
    const anchor = d1.db.query(`select "block_hash" from "mezo_block_hashes" where "block_number" = ?`).get(BLOCK) as {
      block_hash: string;
    };
    expect(anchor.block_hash).toBe(BH);
  });

  test("the winner's projection is preserved byte-for-byte after a lost CAS", async () => {
    await store.commit(input(null, cursorAt(0)));
    const before = d1.db.query(`select * from "mezo_assertions" where "assertion_id" = ?`).get(ID);

    await store.commit(
      input(null, cursorAt(0), {
        projections: [{ assertionId: ID, row: { ...row(), status: "settled", bondMusd: "999" }, blockNumber: BLOCK }],
      })
    );

    const after = d1.db.query(`select * from "mezo_assertions" where "assertion_id" = ?`).get(ID);
    expect(after).toEqual(before);
  });

  test("a lost CAS does not release the winner's witness", async () => {
    // Winner commits and releases its own token.
    await store.commit(input(null, cursorAt(0)));
    // A loser runs; its RELEASE_LEASE targets its own token, so it is a no-op.
    await store.commit(input(null, cursorAt(0)));
    const lease = await store.readLease(CHAIN, CORE);
    expect(lease.owner).toBeNull();
    const cursor = await store.readCursor(CHAIN, CORE);
    expect(cursor?.version).toBe(0);
  });
});

describe("projection guards cover every write shape", () => {
  test("a lost CAS blocks a projection INSERT", async () => {
    await store.commit(input(null, cursorAt(0)));
    const fresh = `0x${"33".repeat(32)}` as Hex;
    const r = await store.commit(
      input(null, cursorAt(0), {
        projections: [{ assertionId: fresh, row: { ...row(), assertionId: fresh }, blockNumber: BLOCK }],
      })
    );
    expect(r.ok).toBe(false);
    const found = d1.db.query(`select 1 from "mezo_assertions" where "assertion_id" = ?`).get(fresh);
    expect(found).toBeNull();
  });

  test("a lost CAS blocks a projection UPDATE", async () => {
    await store.commit(input(null, cursorAt(0)));
    const r = await store.commit(
      input(null, cursorAt(0), {
        projections: [{ assertionId: ID, row: { ...row(), status: "settled" }, blockNumber: BLOCK }],
      })
    );
    expect(r.ok).toBe(false);
    const stored = d1.db.query(`select "status" from "mezo_assertions" where "assertion_id" = ?`).get(ID) as {
      status: string;
    };
    expect(stored.status).toBe("open");
  });

  test("a lost CAS blocks a projection DELETE", async () => {
    await store.commit(input(null, cursorAt(0)));
    const r = await store.commit(
      input(null, cursorAt(0), {
        append: [],
        projections: [{ assertionId: ID, row: null, blockNumber: BLOCK }],
      })
    );
    expect(r.ok).toBe(false);
    expect(projectionRows()).toBe(1);
  });

  test("a lost CAS blocks a ledger DELETE", async () => {
    await store.commit(input(null, cursorAt(0)));
    const r = await store.commit(
      input(null, cursorAt(0), {
        append: [],
        remove: [{ txHash: TX, logIndex: 0, assertionId: ID }],
        projections: [],
      })
    );
    expect(r.ok).toBe(false);
    expect(ledgerRows()).toBe(1);
  });

  test("a lost CAS blocks anchor cleanup above the fork", async () => {
    await store.commit(input(null, cursorAt(0)));
    const r = await store.commit(
      input(null, cursorAt(0), {
        append: [],
        projections: [],
        blockHashes: [],
        removeBlockHashesAbove: 0,
      })
    );
    expect(r.ok).toBe(false);
    expect(anchorRows()).toBe(1);
  });
});

describe("atomicity", () => {
  test("a mid-batch failure rolls back everything and a retry then succeeds", async () => {
    // Fail after the CAS and the first ledger insert.
    d1.failNextBatchAfter = 2;
    const first = await store.commit(input(null, cursorAt(0)));
    expect(first).toEqual({ ok: false, applied: 0 });

    // Nothing survived the rollback.
    expect(projectionRows()).toBe(0);
    expect(ledgerRows()).toBe(0);
    expect(anchorRows()).toBe(0);
    const cursor = await store.readCursor(CHAIN, CORE);
    expect(cursor).toBeNull();

    // A clean retry succeeds.
    const retry = await store.commit(input(null, cursorAt(0)));
    expect(retry).toEqual({ ok: true, applied: 1 });
    expect(projectionRows()).toBe(1);
  });

  test("a failure after the projection write still rolls the projection back", async () => {
    // CAS(1) + ledger(2) + projection(3) -> fail at index 3, after the projection.
    d1.failNextBatchAfter = 3;
    const r = await store.commit(input(null, cursorAt(0)));
    expect(r.ok).toBe(false);
    expect(projectionRows()).toBe(0);
    expect(ledgerRows()).toBe(0);
  });

  test("the CAS trigger rejects an unversioned position change", () => {
    d1.db.run(
      `insert into "mezo_indexer_cursor" ("chain_id","core_address","block_number","block_hash","log_index","version","updated_at")
       values (?,?,?,?,?,0,?)`,
      [CHAIN, CORE, BLOCK, BH, 0, 1]
    );
    expect(() =>
      d1.db.run(`update "mezo_indexer_cursor" set "block_number" = ? where "chain_id" = ? and "core_address" = ?`, [BLOCK + 1, CHAIN, CORE])
    ).toThrow(/cas_lost/);
  });
});

describe("reorg cleanup", () => {
  test("anchors above the fork are deleted, anchors at or below survive", async () => {
    await store.commit(
      input(null, cursorAt(0, BLOCK), {
        blockHashes: [
          { blockNumber: BLOCK - 2, blockHash: `0x${"01".repeat(32)}` as Hex },
          { blockNumber: BLOCK - 1, blockHash: `0x${"02".repeat(32)}` as Hex },
          { blockNumber: BLOCK, blockHash: BH },
        ],
      })
    );
    expect(anchorRows()).toBe(3);

    const r = await store.commit(
      input(cursorAt(0, BLOCK), cursorAt(1, BLOCK - 1), {
        append: [],
        projections: [],
        blockHashes: [{ blockNumber: BLOCK - 1, blockHash: `0x${"02".repeat(32)}` as Hex }],
        removeBlockHashesAbove: BLOCK - 1,
      })
    );
    expect(r.ok).toBe(true);
    expect(anchorRows()).toBe(2);
    const remaining = d1.db.query(`select "block_number" from "mezo_block_hashes" order by "block_number"`).all() as {
      block_number: number;
    }[];
    expect(remaining.map((x) => x.block_number)).toEqual([BLOCK - 2, BLOCK - 1]);
  });

  test("readBlockHash falls back to the ledger when no anchor exists", async () => {
    await store.commit(input(null, cursorAt(0)));
    // Remove the anchor row, leaving only the ledger entry.
    d1.db.run(`delete from "mezo_block_hashes"`);
    expect(await store.readBlockHash(CHAIN, CORE, BLOCK)).toBe(BH);
  });
});

describe("metadata fidelity", () => {
  test("the adapter reports real changes for a matched and an unmatched update", async () => {
    await store.commit(input(null, cursorAt(0)));
    const [matched] = await d1.batch([
      d1.prepare(`update "mezo_indexer_cursor" set "version" = "version" + 1 where "chain_id" = ? and "core_address" = ? and "version" = 0`).bind(CHAIN, CORE),
    ]);
    expect(matched?.meta.changes).toBe(1);

    const [unmatched] = await d1.batch([
      d1.prepare(`update "mezo_indexer_cursor" set "version" = "version" + 1 where "chain_id" = ? and "core_address" = ? and "version" = 99`).bind(CHAIN, CORE),
    ]);
    expect(unmatched?.meta.changes).toBe(0);
  });

  test("an insert reports last_row_id", async () => {
    const [res] = await d1.batch([
      d1
        .prepare(`insert into "mezo_block_hashes" ("chain_id","core_address","block_number","block_hash","observed_at") values (?,?,?,?,?)`)
        .bind(CHAIN, CORE, 1, BH, 1),
    ]);
    expect(res?.meta.changes).toBe(1);
    expect(res?.meta.last_row_id).toBeGreaterThan(0);
  });
});
