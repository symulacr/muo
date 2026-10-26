// Native Mezo indexer: one bounded, atomic, resumable poll cycle.
//
// Atomicity
// ---------
// A single D1 `batch()` is the commit unit. It contains, in order:
//   1. the cursor CAS, which also writes this commit's unique witness token
//   2. `INSERT OR IGNORE` into `mezo_applied_logs`
//   3. reorg ledger removals
//   4. the projection upsert/delete for every affected assertion
//   5. block-hash anchors
//   6. anchor cleanup above the fork point
//   7. release of the witness token
//
// D1 `batch()` is transactional, so either all of it lands or none of it does.
// There is no window in which the projection is ahead of the ledger or the
// cursor is ahead of both.
//
// Concurrency
// -----------
// Two overlapping runs read the same prior cursor and both compute a batch. The
// first commits and moves the cursor; the second's CAS matches zero rows, so its
// witness token is never written, and every guarded statement in its batch is a
// no-op. Success is decided by the CAS statement's own `meta.changes`, not by a
// later read of the cursor (a later commit could legitimately move it again).
//
// Cursor semantics
// ----------------
// The cursor records the END of the last fully validated RPC range, not the
// last event seen. A range whose only event is early and whose tail is empty
// must still advance to the range end; otherwise the next cycle re-fetches the
// same event forever and never makes progress. `logIndex` is the highest
// committed log at that end block, or `-1` when the end block produced none.
//
// Reorgs
// ------
// A reorg rewinds to the highest stored anchor that is still canonical — the
// common ancestor — not merely to the old cursor height. A multi-block fork
// leaves ledger rows and projections above the ancestor orphaned, so
// everything above the ancestor is removed and the affected assertions are
// rebuilt from the surviving ledger plus a bounded re-read. If no canonical
// anchor is found within the lookback budget, the cycle HALTS and asks for an
// operator rebuild; it never reports "caught-up" while holding known orphans.
//
// Canonicality during a fetch
// ---------------------------
// The range-end block hash is read before and after `eth_getLogs`. A change
// means the chain moved under the fetch, so the page is discarded rather than
// committed under a cursor that no longer describes it. Every fetched log's
// block hash is also checked against the canonical block observation.
//
// This module never claims a D1 transaction across separate HTTP requests. The
// only transaction boundary is the single `batch()` call.

import type { Address, AssertionEvent, Hex, MezoChainId } from "@muo/core/native";
import { isAddress, isChainId } from "@muo/core/native";
import { decodeMuoLog, MUO_TOPIC0, MuoLogDecodeError } from "@muo/sdk/native";

import type { LedgerEntry, ProjectedAssertion } from "./projection";
import type { MezoRpc, RpcLog } from "./rpc";
import { affectedAssertions, groupByAssertion, ledgerKey, projectAssertion } from "./projection";
import { RPC_LIMITS } from "./rpc";

export type IndexerConfig = {
  chainId: MezoChainId;
  coreAddress: Address;
  startBlock: number;
  confirmations: number;
  /** Max blocks to ingest in one invocation. */
  maxBlocksPerRun: number;
  /** Max blocks per `eth_getLogs` call. */
  maxBlockRange: number;
  /** Lease duration for the advisory lock. */
  leaseMs: number;
  /**
   * How many blocks below the cursor to search for a common ancestor.
   * A fork deeper than this halts rather than guessing.
   */
  reorgLookback: number;
};

export const DEFAULT_INDEXER_CONFIG = (over: Partial<IndexerConfig> = {}): IndexerConfig => ({
  chainId: 31611,
  coreAddress: "0x61c41cd7299fd668c3a7aae62f12c017fe654cb0",
  startBlock: 16_380_473,
  confirmations: RPC_LIMITS.DEFAULT_CONFIRMATIONS,
  maxBlocksPerRun: 500,
  maxBlockRange: RPC_LIMITS.MAX_BLOCK_RANGE,
  leaseMs: 60_000,
  reorgLookback: 128,
  ...over,
});

/** The cursor as stored. `logIndex` is the highest committed log within `blockNumber`. */
export type Cursor = {
  blockNumber: number;
  blockHash: Hex;
  logIndex: number;
  /** Monotonic commit counter; part of the compare-and-swap predicate. */
  version: number;
};

export type IndexerResult =
  | { status: "idle"; reason: "no-head" | "caught-up" | "lease-held"; cursor: Cursor | null }
  | {
      status: "advanced";
      from: Cursor | null;
      to: Cursor;
      /** Ledger rows actually inserted (dedup-aware, from `meta.changes`). */
      applied: number;
      rebuilt: number;
      reorg: boolean;
      /** Common ancestor the reorg rewound to, when a reorg occurred. */
      ancestor: number | null;
    }
  | {
      status: "halted";
      reason: "decode" | "rpc" | "conflict" | "reorg-unresolved" | "unstable-range";
      error: string;
      cursor: Cursor | null;
      log?: unknown;
    };

/** Outcome of one atomic commit. */
export type CommitResult = { ok: boolean; applied: number };

/** Abstract the D1 surface so the state machine is testable without Cloudflare. */
export interface IndexerStore {
  readCursor(chainId: number, coreAddress: string): Promise<Cursor | null>;
  readLease(chainId: number, coreAddress: string): Promise<{ owner: string | null; expiresAt: number | null }>;
  /** Ledger entries at or above `fromBlock`, for reorg rebuild. */
  readLedgerFrom(chainId: number, coreAddress: string, fromBlock: number): Promise<LedgerEntry[]>;
  /** Ledger entries for one assertion. */
  readLedgerFor(chainId: number, coreAddress: string, assertionId: Hex): Promise<LedgerEntry[]>;
  /** Best-known stored hash for a height (anchor table, then ledger). */
  readBlockHash(chainId: number, coreAddress: string, blockNumber: number): Promise<Hex | null>;
  /** Commit the whole cycle atomically. */
  commit(input: CommitInput): Promise<CommitResult>;
  /** Record a halt so `/status` can report it honestly. */
  recordError(chainId: number, coreAddress: string, message: string): Promise<void>;
}

export type CommitInput = {
  chainId: number;
  coreAddress: string;
  expectedCursor: Cursor | null;
  nextCursor: Cursor;
  leaseExpiresAt: number;
  /** New ledger rows to insert (dedup by natural key). */
  append: readonly LedgerEntry[];
  /** Ledger keys to delete (reorg). */
  remove: readonly { txHash: Hex; logIndex: number; assertionId: Hex }[];
  /** Projection writes: full row, or delete when `null`. */
  projections: readonly { assertionId: Hex; row: ProjectedAssertion | null; blockNumber: number }[];
  /** Block hashes observed this cycle, for future canonicality checks. */
  blockHashes: readonly { blockNumber: number; blockHash: Hex }[];
  /** When set, delete anchors strictly above this height (reorg cleanup). */
  removeBlockHashesAbove: number | null;
  now: number;
};

export type IndexerDeps = {
  rpc: Pick<MezoRpc, "chainId" | "blockNumber" | "getBlock" | "getLogs">;
  store: IndexerStore;
  now?: () => number;
  /** Injected so tests can control the advisory lease owner. */
  leaseOwner?: string;
};

const TOPICS = Object.values(MUO_TOPIC0) as Hex[];

/**
 * Run one bounded poll cycle.
 *
 * Never throws for an expected failure: returns `halted` so the caller can
 * record it and `/v2/status` can report it. A halt never advances the cursor, so
 * the next run retries the same range.
 */
export async function runIndexerCycle(cfg: IndexerConfig, deps: IndexerDeps): Promise<IndexerResult> {
  if (!isChainId(cfg.chainId)) throw new TypeError("Unsupported chain id");
  if (!isAddress(cfg.coreAddress)) throw new TypeError("coreAddress must be a lowercase 20-byte address");
  if (!Number.isSafeInteger(cfg.startBlock) || cfg.startBlock < 0) throw new TypeError("startBlock must be a safe integer");

  const now = deps.now ?? Date.now;
  const owner = deps.leaseOwner ?? `run-${now()}-${Math.random().toString(36).slice(2, 10)}`;
  const { chainId, coreAddress } = cfg;

  const cursor = await deps.store.readCursor(chainId, coreAddress);
  const lease = await deps.store.readLease(chainId, coreAddress);
  if (lease.owner !== null && lease.owner !== owner && (lease.expiresAt ?? 0) > now()) {
    return { status: "idle", reason: "lease-held", cursor };
  }

  let rpcChainId: MezoChainId;
  try {
    rpcChainId = await deps.rpc.chainId();
  } catch (err) {
    await deps.store.recordError(chainId, coreAddress, `eth_chainId failed: ${(err as Error).message}`);
    return { status: "halted", reason: "rpc", error: (err as Error).message, cursor };
  }
  if (rpcChainId !== chainId) {
    const error = `RPC reports chain ${rpcChainId}, configured ${chainId}`;
    await deps.store.recordError(chainId, coreAddress, error);
    return { status: "halted", reason: "conflict", error, cursor };
  }

  let head: number;
  try {
    head = await deps.rpc.blockNumber();
  } catch (err) {
    await deps.store.recordError(chainId, coreAddress, `eth_blockNumber failed: ${(err as Error).message}`);
    return { status: "halted", reason: "rpc", error: (err as Error).message, cursor };
  }

  // Highest block we may safely read. No `finalized`/`safe` tag is used.
  const safeHead = head - cfg.confirmations;

  // A chain that rewound below startBlock leaves every stored row above the new
  // head orphaned. Reporting "no-head" here would be a healthy-looking lie.
  if (safeHead < cfg.startBlock) {
    if (cursor !== null && cursor.blockNumber >= cfg.startBlock) {
      const error = `chain head ${head} is below startBlock ${cfg.startBlock} while the cursor is at ${cursor.blockNumber}; all indexed rows are orphaned and require an operator rebuild`;
      await deps.store.recordError(chainId, coreAddress, error);
      return { status: "halted", reason: "reorg-unresolved", error, cursor };
    }
    return { status: "idle", reason: "no-head", cursor };
  }

  // ---- reorg detection: bounded common-ancestor search -------------------
  let reorg = false;
  let ancestor: number | null = null;
  if (cursor !== null) {
    let canonicalAtCursor: Hex | null;
    try {
      const chainBlock = await deps.rpc.getBlock(cursor.blockNumber);
      canonicalAtCursor = chainBlock?.hash ?? null;
    } catch (err) {
      await deps.store.recordError(chainId, coreAddress, `reorg check failed: ${(err as Error).message}`);
      return { status: "halted", reason: "rpc", error: (err as Error).message, cursor };
    }

    if (canonicalAtCursor === null || canonicalAtCursor !== cursor.blockHash) {
      reorg = true;
      // Walk DOWN from the cursor looking for the highest height whose stored
      // anchor still matches the chain. That height is the common ancestor.
      const floor = Math.max(cfg.startBlock, cursor.blockNumber - cfg.reorgLookback);
      ancestor = null;
      for (let h = cursor.blockNumber - 1; h >= floor; h--) {
        const stored = await deps.store.readBlockHash(chainId, coreAddress, h);
        if (stored === null) continue;
        let chainHash: Hex | null;
        try {
          const b = await deps.rpc.getBlock(h);
          chainHash = b?.hash ?? null;
        } catch (err) {
          await deps.store.recordError(chainId, coreAddress, `ancestor search failed at ${h}: ${(err as Error).message}`);
          return { status: "halted", reason: "rpc", error: (err as Error).message, cursor };
        }
        if (chainHash !== null && chainHash === stored) {
          ancestor = h;
          break;
        }
      }
      if (ancestor === null) {
        const error = `no canonical ancestor within ${cfg.reorgLookback} blocks below cursor ${cursor.blockNumber}; operator rebuild required`;
        await deps.store.recordError(chainId, coreAddress, error);
        return { status: "halted", reason: "reorg-unresolved", error, cursor };
      }
    }
  }

  // ---- bounded range ----------------------------------------------------
  // After a reorg, re-read from the ancestor so the replacement blocks are
  // ingested; otherwise continue from the cursor.
  const resumeFrom = reorg && ancestor !== null ? ancestor : cursor === null ? cfg.startBlock : cursor.blockNumber;

  // The cursor records the END of the last fully processed range. Once it
  // reaches the safe head there is nothing new to read. Without this check the
  // range collapses to the single block at `safeHead`, which is re-fetched on
  // every cycle and never reports caught-up.
  if (!reorg && cursor !== null && resumeFrom >= safeHead) {
    return { status: "idle", reason: "caught-up", cursor };
  }

  const fromBlock = Math.max(cfg.startBlock, resumeFrom);
  const toBlock = Math.min(safeHead, fromBlock + Math.min(cfg.maxBlocksPerRun, cfg.maxBlockRange) - 1);

  const hasRange = toBlock >= fromBlock;
  if (!hasRange && !reorg) return { status: "idle", reason: "caught-up", cursor };

  // ---- canonicality of the range end, before and after the fetch --------
  let endHashBefore: Hex | null = null;
  if (hasRange) {
    try {
      endHashBefore = (await deps.rpc.getBlock(toBlock))?.hash ?? null;
    } catch (err) {
      await deps.store.recordError(chainId, coreAddress, `range-end read failed: ${(err as Error).message}`);
      return { status: "halted", reason: "rpc", error: (err as Error).message, cursor };
    }
    if (endHashBefore === null) {
      const error = `range end ${toBlock} is not available`;
      await deps.store.recordError(chainId, coreAddress, error);
      return { status: "halted", reason: "rpc", error, cursor };
    }
  }

  let logs: RpcLog[] = [];
  if (hasRange) {
    try {
      logs = await deps.rpc.getLogs({ address: coreAddress, topics: TOPICS, fromBlock, toBlock });
    } catch (err) {
      await deps.store.recordError(chainId, coreAddress, `eth_getLogs failed: ${(err as Error).message}`);
      return { status: "halted", reason: "rpc", error: (err as Error).message, cursor };
    }

    // A `removed` log inside a requested canonical range means the provider's
    // view is inconsistent with the range we asked for. Halting is correct: it
    // is not safe to skip the log and advance past it.
    for (const log of logs) {
      if (log.removed === true && typeof log.topics?.[0] === "string" && TOPICS.includes(log.topics[0].toLowerCase() as Hex)) {
        const error = `provider returned a removed MuoCore log at block ${log.blockNumber} inside a canonical range`;
        await deps.store.recordError(chainId, coreAddress, error);
        return { status: "halted", reason: "unstable-range", error, cursor };
      }
    }

    // Re-read the end hash: a change means the chain moved during the fetch.
    let endHashAfter: Hex | null;
    try {
      endHashAfter = (await deps.rpc.getBlock(toBlock))?.hash ?? null;
    } catch (err) {
      await deps.store.recordError(chainId, coreAddress, `range-end re-read failed: ${(err as Error).message}`);
      return { status: "halted", reason: "rpc", error: (err as Error).message, cursor };
    }
    if (endHashAfter !== endHashBefore) {
      const error = `range end ${toBlock} changed during the fetch (${endHashBefore} -> ${endHashAfter}); page discarded`;
      await deps.store.recordError(chainId, coreAddress, error);
      return { status: "halted", reason: "unstable-range", error, cursor };
    }
  }

  // ---- strict decode ----------------------------------------------------
  const decoded: LedgerEntry[] = [];
  for (const log of logs) {
    try {
      const ev = decodeMuoLog(log, chainId, coreAddress);
      if (ev === null) continue;
      decoded.push(toLedgerEntry(ev));
    } catch (err) {
      const message = err instanceof MuoLogDecodeError ? err.message : `unexpected decode failure: ${(err as Error).message}`;
      await deps.store.recordError(chainId, coreAddress, message);
      return { status: "halted", reason: "decode", error: message, cursor, log: (err as MuoLogDecodeError).log };
    }
  }

  // ---- canonicality of each fetched log's block -------------------------
  // A log whose block hash does not match the canonical observation at that
  // height must not be committed under a new canonical cursor.
  if (decoded.length > 0) {
    const heights = [...new Set(decoded.map((e) => e.blockNumber))].sort((a, b) => a - b);
    if (heights.length > cfg.reorgLookback) {
      const error = `page touches ${heights.length} distinct blocks, above the ${cfg.reorgLookback}-block canonicality budget`;
      await deps.store.recordError(chainId, coreAddress, error);
      return { status: "halted", reason: "unstable-range", error, cursor };
    }
    for (const h of heights) {
      let chainHash: Hex | null;
      try {
        chainHash = (await deps.rpc.getBlock(h))?.hash ?? null;
      } catch (err) {
        await deps.store.recordError(chainId, coreAddress, `log-block read failed at ${h}: ${(err as Error).message}`);
        return { status: "halted", reason: "rpc", error: (err as Error).message, cursor };
      }
      const observed = new Set(decoded.filter((e) => e.blockNumber === h).map((e) => e.blockHash));
      if (chainHash === null || observed.size !== 1 || !observed.has(chainHash)) {
        const error = `log block ${h} does not match the canonical hash (${chainHash}); page discarded`;
        await deps.store.recordError(chainId, coreAddress, error);
        return { status: "halted", reason: "unstable-range", error, cursor };
      }
    }
  }

  // Dedup inside the page.
  const seen = new Set<string>();
  const append: LedgerEntry[] = [];
  for (const entry of decoded) {
    const key = ledgerKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    append.push(entry);
  }

  // ---- reorg cleanup: remove EVERYTHING above the common ancestor -------
  let removed: { txHash: Hex; logIndex: number; assertionId: Hex }[] = [];
  const surviving: LedgerEntry[] = [];
  if (reorg && ancestor !== null) {
    const stale = await deps.store.readLedgerFrom(chainId, coreAddress, ancestor + 1);
    removed = stale.map((e) => ({ txHash: e.txHash, logIndex: e.logIndex, assertionId: e.assertionId }));
    const removedKeys = new Set(removed.map((r) => ledgerKey(r)));
    const ids = new Set(stale.map((e) => e.assertionId));
    for (const id of ids) {
      const all = await deps.store.readLedgerFor(chainId, coreAddress, id);
      for (const e of all) if (!removedKeys.has(ledgerKey(e))) surviving.push(e);
    }
  }

  const affected = affectedAssertions(append, removed);
  if (reorg) for (const e of surviving) affected.add(e.assertionId);

  const removedKeys = new Set(removed.map((r) => ledgerKey(r)));
  const projections: { assertionId: Hex; row: ProjectedAssertion | null; blockNumber: number }[] = [];
  for (const id of affected) {
    const fromStore = await deps.store.readLedgerFor(chainId, coreAddress, id);
    const merged = new Map<string, LedgerEntry>();
    for (const e of fromStore) if (!removedKeys.has(ledgerKey(e))) merged.set(ledgerKey(e), e);
    for (const e of append) if (e.assertionId === id) merged.set(ledgerKey(e), e);
    const row = projectAssertion([...merged.values()]);
    const blockNumber = row?.blockNumber ?? Math.min(...[...merged.values()].map((e) => e.blockNumber), fromBlock);
    projections.push({ assertionId: id, row, blockNumber });
  }

  // ---- cursor: END of the validated range, not the last event -----------
  // A range whose only event sits early and whose tail is empty must still
  // advance to `toBlock`; otherwise the next cycle re-fetches the same event
  // forever.
  const endBlock = hasRange ? toBlock : Math.max(cfg.startBlock, Math.min(safeHead, fromBlock));
  const endHash = hasRange ? (endHashBefore as Hex) : ((await deps.rpc.getBlock(endBlock))?.hash ?? null);
  if (endHash === null) {
    const error = `range end ${endBlock} is not available`;
    await deps.store.recordError(chainId, coreAddress, error);
    return { status: "halted", reason: "rpc", error, cursor };
  }

  const logsAtEnd = decoded.filter((e) => e.blockNumber === endBlock);
  const endLogIndex = logsAtEnd.length > 0 ? Math.max(...logsAtEnd.map((e) => e.logIndex)) : -1;
  const nextCursor: Cursor = {
    blockNumber: endBlock,
    blockHash: endHash,
    logIndex: endLogIndex,
    version: (cursor?.version ?? -1) + 1,
  };

  // ---- anchors ----------------------------------------------------------
  const blockHashes = await collectBlockHashes(deps, fromBlock, endBlock, nextCursor);

  const result = await deps.store.commit({
    chainId,
    coreAddress,
    expectedCursor: cursor,
    nextCursor,
    leaseExpiresAt: now() + cfg.leaseMs,
    append,
    remove: removed,
    projections,
    blockHashes,
    removeBlockHashesAbove: reorg ? ancestor : null,
    now: now(),
  });

  if (!result.ok) {
    return { status: "halted", reason: "conflict", error: "cursor compare-and-swap lost; another run advanced it", cursor };
  }

  return {
    status: "advanced",
    from: cursor,
    to: nextCursor,
    applied: result.applied,
    rebuilt: projections.filter((p) => p.row !== null).length,
    reorg,
    ancestor,
  };
}

const toLedgerEntry = (ev: AssertionEvent): LedgerEntry => ({
  txHash: ev.provenance.transactionHash,
  logIndex: ev.provenance.logIndex,
  blockNumber: ev.provenance.blockNumber,
  blockHash: ev.provenance.blockHash,
  transactionIndex: ev.provenance.transactionIndex,
  assertionId: ev.data.assertionId,
  event: ev,
});

/** Read the hashes we will use as future canonicality anchors. */
async function collectBlockHashes(deps: IndexerDeps, fromBlock: number, endBlock: number, next: Cursor): Promise<{ blockNumber: number; blockHash: Hex }[]> {
  const out: { blockNumber: number; blockHash: Hex }[] = [];
  // The cursor's own block is the primary anchor for the next run; the range
  // start keeps a second anchor near the bottom of the page so an ancestor
  // search has something to find without walking the whole ledger.
  for (const n of new Set([fromBlock, endBlock, next.blockNumber])) {
    const b = await deps.rpc.getBlock(n);
    if (b !== null) out.push({ blockNumber: n, blockHash: b.hash });
  }
  return out;
}

export { groupByAssertion, projectAssertion };
