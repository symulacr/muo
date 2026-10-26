// Indexer state-machine tests.
//
// These use an in-memory store that models the real commit contract: a commit
// succeeds only if the expected cursor version matches, and it reports the
// number of ledger rows it actually inserted. That is enough to test the
// state machine's decisions. The SQL-level guarantees (witness-token guards,
// real `meta.changes`, real transactions) are proven separately in
// ./store-sql.test.ts against real SQLite, which is the only place they can be
// proven honestly.

import { describe, expect, test } from "bun:test";

import type { Hex } from "@muo/core/native";
import { TESTNET_CORE } from "@muo/core/native";
import { MUO_TOPIC0 } from "@muo/sdk/native";
import { computeAssertionId } from "@muo/utils/native";

import type { CommitInput, CommitResult, Cursor, IndexerConfig, IndexerStore } from "../lib/mezo/indexer";
import type { LedgerEntry } from "../lib/mezo/projection";
import type { RpcBlock, RpcLog } from "../lib/mezo/rpc";
import { DEFAULT_INDEXER_CONFIG, runIndexerCycle } from "../lib/mezo/indexer";

const CHAIN = 31611 as const;
const CORE = TESTNET_CORE;
const IDENT = `0x${"11".repeat(32)}` as Hex;
const CLAIM = "0xdeadbeef" as Hex;
const ACTOR = "0x2a2a8551e30c63263dd9dbb698e57fb37c77a6b3" as Hex;
const OTHER = "0x118917a40faf1cd7a13db0ef56c86de7973ac503" as Hex;
const START = 16_380_473;

const txHash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const blockHash = (n: number): Hex => `0x${(n + 0x100000).toString(16).padStart(64, "0")}` as Hex;
const pad32 = (h: string): string => h.slice(2).padStart(64, "0");
const word = (n: bigint): string => n.toString(16).padStart(64, "0");
const bytesTail = (hex: Hex): string => {
  const body = hex.slice(2);
  const len = body.length / 2;
  return word(BigInt(len)) + body.padEnd(Math.ceil(len / 32) * 64, "0");
};

const assertedLog = (block: number, logIndex = 0, over: Partial<RpcLog> = {}): RpcLog => {
  const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(block));
  const data = `0x${pad32(IDENT)}${word(160n)}${word(10n)}${word(1440n)}${word(BigInt(block))}${bytesTail(CLAIM)}` as Hex;
  return {
    address: CORE,
    topics: [MUO_TOPIC0.Asserted, `0x${pad32(id)}`, `0x${pad32(ACTOR)}`],
    data,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: blockHash(block),
    transactionHash: txHash(block * 100 + logIndex),
    transactionIndex: "0x0",
    logIndex: `0x${logIndex.toString(16)}`,
    removed: false,
    ...over,
  };
};

const outcomeLog = (kind: "Disputed" | "Settled" | "Rejected" | "Unresolved", id: Hex, block: number, logIndex = 0, by = OTHER): RpcLog => ({
  address: CORE,
  topics: [MUO_TOPIC0[kind], `0x${pad32(id)}`, `0x${pad32(by)}`],
  data: `0x${word(BigInt(block))}` as Hex,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: blockHash(block),
  transactionHash: txHash(block * 100 + logIndex),
  transactionIndex: "0x0",
  logIndex: `0x${logIndex.toString(16)}`,
  removed: false,
});

/** Fake chain: block hash table + log list, mutable for reorg simulation. */
class FakeChain {
  head = START + 100;
  hashes = new Map<number, Hex>();
  logs: RpcLog[] = [];
  chainIdValue = CHAIN as number;
  getLogsCalls: { fromBlock: number; toBlock: number }[] = [];
  /** When set, the block hash at this height changes on the NEXT getBlock call. */
  flipAt: number | null = null;
  constructor() {
    for (let n = START - 5; n <= this.head + 50; n++) this.hashes.set(n, blockHash(n));
  }
  block(n: number): RpcBlock | null {
    const h = this.hashes.get(n);
    return h ? { number: `0x${n.toString(16)}`, hash: h, parentHash: this.hashes.get(n - 1) ?? blockHash(n - 1) } : null;
  }
  /** Simulate a fork: every height above `from` gets a new hash and its logs vanish. */
  fork(from: number): void {
    for (const [n] of this.hashes) if (n >= from) this.hashes.set(n, `0x${(n + 0x900000).toString(16).padStart(64, "0")}` as Hex);
    this.logs = this.logs.filter((l) => Number(l.blockNumber) < from);
  }
  rpc = {
    chainId: async () => this.chainIdValue as 31611,
    blockNumber: async () => this.head,
    getBlock: async (n: number) => this.block(n),
    getLogs: async (a: { fromBlock: number; toBlock: number }) => {
      this.getLogsCalls.push({ fromBlock: a.fromBlock, toBlock: a.toBlock });
      return this.logs.filter((l) => {
        const n = Number(l.blockNumber);
        return n >= a.fromBlock && n <= a.toBlock;
      });
    },
  };
}

/** In-memory store modelling the real commit contract (version CAS + applied count). */
class MemoryStore implements IndexerStore {
  cursor: Cursor | null = null;
  lease: { owner: string | null; expiresAt: number | null } = { owner: null, expiresAt: null };
  ledger: LedgerEntry[] = [];
  projected = new Map<Hex, unknown>();
  blockHashes = new Map<number, Hex>();
  errors: string[] = [];
  /** When set, the next commit simulates a concurrent winner. */
  loseNextCas = false;
  /** Every commit attempt, for assertions about what was proposed. */
  attempts: CommitInput[] = [];

  async readCursor() {
    return this.cursor;
  }
  async readLease() {
    return this.lease;
  }
  async readBlockHash(_c: number, _a: string, n: number) {
    return this.blockHashes.get(n) ?? this.ledger.find((e) => e.blockNumber === n)?.blockHash ?? null;
  }
  async readLedgerFrom(_c: number, _a: string, from: number) {
    return this.ledger.filter((e) => e.blockNumber >= from);
  }
  async readLedgerFor(_c: number, _a: string, id: Hex) {
    return this.ledger.filter((e) => e.assertionId === id);
  }
  async recordError(_c: number, _a: string, m: string) {
    this.errors.push(m);
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    this.attempts.push(input);
    const expected = input.expectedCursor?.version ?? null;
    const actual = this.cursor?.version ?? null;
    if (this.loseNextCas || expected !== actual) {
      this.loseNextCas = false;
      return { ok: false, applied: 0 };
    }
    let applied = 0;
    for (const e of input.append) {
      if (!this.ledger.some((x) => x.txHash === e.txHash && x.logIndex === e.logIndex)) {
        this.ledger.push(e);
        applied++;
      }
    }
    for (const r of input.remove) {
      this.ledger = this.ledger.filter((e) => !(e.txHash === r.txHash && e.logIndex === r.logIndex));
    }
    for (const p of input.projections) {
      if (p.row === null) this.projected.delete(p.assertionId);
      else this.projected.set(p.assertionId, p.row);
    }
    for (const b of input.blockHashes) this.blockHashes.set(b.blockNumber, b.blockHash);
    if (input.removeBlockHashesAbove !== null) {
      for (const n of [...this.blockHashes.keys()]) if (n > input.removeBlockHashesAbove) this.blockHashes.delete(n);
    }
    this.cursor = input.nextCursor;
    this.lease = { owner: null, expiresAt: null };
    return { ok: true, applied };
  }
}

const cfg = (over: Partial<IndexerConfig> = {}): IndexerConfig =>
  DEFAULT_INDEXER_CONFIG({ chainId: CHAIN, coreAddress: CORE, startBlock: START, confirmations: 2, maxBlocksPerRun: 50, ...over });

const deps = (chain: FakeChain, store: MemoryStore, now = () => 1_000_000) => ({
  rpc: chain.rpc,
  store,
  now,
  leaseOwner: "test-owner",
});

describe("first run", () => {
  test("starts at startBlock and advances to the safe head", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    const r = await runIndexerCycle(cfg(), deps(chain, store));
    expect(r.status).toBe("advanced");
    if (r.status !== "advanced") return;
    expect(r.from).toBeNull();
    expect(r.applied).toBe(1);
    expect(chain.getLogsCalls[0]?.fromBlock).toBe(START);
    expect(chain.getLogsCalls[0]?.toBlock).toBeLessThanOrEqual(chain.head - 2);
  });

  test("creates the projection row from the applied log", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    await runIndexerCycle(cfg(), deps(chain, store));
    expect(store.projected.size).toBe(1);
    const row = [...store.projected.values()][0] as { status: string; bondMusd: string };
    expect(row.status).toBe("open");
    expect(row.bondMusd).toBe("10");
  });

  test("returns idle when the safe head is below startBlock", async () => {
    const chain = new FakeChain();
    chain.head = START;
    const store = new MemoryStore();
    const r = await runIndexerCycle(cfg({ confirmations: 100 }), deps(chain, store));
    expect(r).toEqual({ status: "idle", reason: "no-head", cursor: null });
    expect(store.cursor).toBeNull();
  });
});

describe("cursor advances to the END of the validated range", () => {
  test("an early event with a long empty tail still advances to the range end", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    // The only event is at the very start of the range.
    chain.logs = [assertedLog(START + 1)];
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 40 }), deps(chain, store));
    expect(r.status).toBe("advanced");
    if (r.status !== "advanced") return;
    // Cursor must be the range END, not the event block.
    expect(r.to.blockNumber).toBe(START + 39);
    expect(r.to.blockNumber).toBeGreaterThan(START + 1);
  });

  test("repeated cycles over an old event plus an empty tail make progress", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];

    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 20 }), deps(chain, store));
      expect(r.status).toBe("advanced");
      if (r.status === "advanced") seen.push(r.to.blockNumber);
    }
    // Strictly increasing: the old event is not re-fetched forever.
    const [first, second, third] = seen;
    if (first === undefined || second === undefined || third === undefined) throw new Error("Expected three completed ranges");
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    // The event was applied exactly once across the three cycles.
    expect(store.ledger.length).toBe(1);
  });

  test("eventually reaches caught-up instead of looping", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    // Small pages so several cycles are needed to cross the whole chain.
    for (let i = 0; i < 20; i++) {
      const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 10 }), deps(chain, store));
      if (r.status === "idle") {
        expect(r.reason).toBe("caught-up");
        return;
      }
    }
    throw new Error("never reached caught-up");
  });

  test("logIndex is -1 when the end block produced no event", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 40 }), deps(chain, store));
    expect(r.status).toBe("advanced");
    if (r.status === "advanced") expect(r.to.logIndex).toBe(-1);
  });

  test("logIndex is the highest committed log at the end block", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    const end = START + 39;
    chain.logs = [assertedLog(end, 0), assertedLog(end, 4)];
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 40 }), deps(chain, store));
    expect(r.status).toBe("advanced");
    if (r.status === "advanced") {
      expect(r.to.blockNumber).toBe(end);
      expect(r.to.logIndex).toBe(4);
    }
  });

  test("a duplicate re-delivery reports applied=0, not the attempted count", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    const first = await runIndexerCycle(cfg({ maxBlocksPerRun: 40 }), deps(chain, store));
    expect(first.status).toBe("advanced");
    if (first.status === "advanced") expect(first.applied).toBe(1);

    // Rewind the cursor so the same range is fetched again.
    store.cursor = null;
    const second = await runIndexerCycle(cfg({ maxBlocksPerRun: 40 }), deps(chain, store));
    expect(second.status).toBe("advanced");
    if (second.status === "advanced") expect(second.applied).toBe(0);
    expect(store.ledger.length).toBe(1);
  });
});

describe("resume and dedup", () => {
  test("a second run resumes from the cursor and does not re-apply", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    await runIndexerCycle(cfg(), deps(chain, store));
    const afterFirst = store.ledger.length;
    chain.head += 20;
    const r = await runIndexerCycle(cfg(), deps(chain, store));
    expect(r.status).toBe("advanced");
    expect(store.ledger.length).toBe(afterFirst);
    expect(store.cursor?.version).toBe(1);
  });

  test("a duplicate log in the same page is applied once", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    const dup = assertedLog(START + 1);
    chain.logs = [dup, { ...dup }];
    const r = await runIndexerCycle(cfg(), deps(chain, store));
    expect(r.status).toBe("advanced");
    if (r.status === "advanced") expect(r.applied).toBe(1);
    expect(store.ledger.length).toBe(1);
  });
});

describe("CAS contention", () => {
  test("a lost CAS reports conflict and commits nothing", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    await runIndexerCycle(cfg(), deps(chain, store));
    if (!store.cursor) throw new Error("Initial cycle did not commit a cursor");
    const before = { ledger: store.ledger.length, cursor: { ...store.cursor } };
    chain.head += 20;
    chain.logs.push(assertedLog(START + 2));
    store.loseNextCas = true;
    const r = await runIndexerCycle(cfg(), deps(chain, store));
    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("conflict");
    expect(store.ledger.length).toBe(before.ledger);
    expect(store.cursor?.version).toBe(before.cursor.version);
  });

  test("an unexpired lease from another owner makes the run idle", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    store.lease = { owner: "someone-else", expiresAt: 2_000_000 };
    const r = await runIndexerCycle(
      cfg(),
      deps(chain, store, () => 1_000_000)
    );
    expect(r).toEqual({ status: "idle", reason: "lease-held", cursor: null });
    expect(chain.getLogsCalls.length).toBe(0);
  });

  test("an expired lease is taken over", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    store.lease = { owner: "stale", expiresAt: 1 };
    const r = await runIndexerCycle(
      cfg(),
      deps(chain, store, () => 1_000_000)
    );
    expect(r.status).toBe("advanced");
  });
});

describe("reorg: bounded common ancestor", () => {
  test("a fork several blocks BELOW the cursor rewinds to the true ancestor", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1), assertedLog(START + 5)];
    await runIndexerCycle(cfg({ maxBlocksPerRun: 100 }), deps(chain, store));
    if (!store.cursor) throw new Error("Initial cycle did not commit a cursor");
    const cursorBefore = store.cursor.blockNumber;
    expect(cursorBefore).toBeGreaterThanOrEqual(START + 5);

    // Fork 4 blocks below the cursor: blocks START+1 survives, START+5 does not.
    chain.head += 5;
    chain.fork(START + 3);
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 100 }), deps(chain, store));

    expect(r.status).toBe("advanced");
    if (r.status !== "advanced") return;
    expect(r.reorg).toBe(true);
    // The ancestor is the highest height whose stored anchor is still canonical.
    // Only START+1 produced a log (START+5 was orphaned), so that is the fork
    // point — NOT the old cursor height, which was several blocks higher.
    expect(r.ancestor).toBe(START + 1);
    expect(r.ancestor).toBeLessThan(cursorBefore);
  });

  test("orphaned assert, dispute and settlement are each repaired", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(START + 1));
    chain.logs = [assertedLog(START + 1), outcomeLog("Disputed", id, START + 2), outcomeLog("Settled", id, START + 3)];
    await runIndexerCycle(cfg({ maxBlocksPerRun: 100 }), deps(chain, store));
    expect((store.projected.get(id) as { status: string }).status).toBe("settled");

    // Fork at START+2: the dispute and settlement are orphaned, the assert
    // survives. State must return to open.
    chain.head += 3;
    chain.fork(START + 2);
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 100 }), deps(chain, store));
    expect(r.status).toBe("advanced");
    expect((store.projected.get(id) as { status: string }).status).toBe("open");
    // The orphaned ledger rows are gone, the assert remains.
    expect(store.ledger.filter((e) => e.assertionId === id).length).toBe(1);
  });

  test("a fork that orphans the assert removes the projection row", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    await runIndexerCycle(cfg({ maxBlocksPerRun: 100 }), deps(chain, store));
    expect(store.projected.size).toBe(1);

    chain.head += 3;
    chain.fork(START + 1);
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 100 }), deps(chain, store));
    expect(r.status).toBe("advanced");
    expect(store.projected.size).toBe(0);
  });

  test("a fork deeper than the lookback budget HALTS instead of guessing", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    await runIndexerCycle(cfg({ maxBlocksPerRun: 100, reorgLookback: 2 }), deps(chain, store));

    chain.head += 5;
    chain.fork(START + 1);
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 100, reorgLookback: 2 }), deps(chain, store));
    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("reorg-unresolved");
    // The orphaned state is NOT silently preserved as healthy.
    expect(store.errors.some((e) => e.includes("operator rebuild"))).toBe(true);
  });

  test("a chain rewind below startBlock halts rather than reporting healthy rows", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    await runIndexerCycle(cfg({ maxBlocksPerRun: 100 }), deps(chain, store));

    // The whole indexed range is now below the new head.
    chain.head = START - 1;
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 100, confirmations: 0 }), deps(chain, store));
    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("reorg-unresolved");
  });
});

describe("canonicality during a fetch", () => {
  test("a range end that changes during the fetch discards the page", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];

    // Make the end block's hash change between the pre- and post-fetch reads.
    const realGetBlock = chain.rpc.getBlock;
    let calls = 0;
    chain.rpc.getBlock = async (n: number) => {
      const b = await realGetBlock(n);
      // The second read of the range end returns a different hash.
      if (n === START + 49 && ++calls === 2 && b) {
        return { ...b, hash: `0x${"ee".repeat(32)}` as Hex };
      }
      return b;
    };

    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 50 }), deps(chain, store));
    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("unstable-range");
    expect(store.ledger.length).toBe(0);
  });

  test("a fetched log whose block hash is not canonical discards the page", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1, 0, { blockHash: `0x${"dd".repeat(32)}` as Hex })];
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 50 }), deps(chain, store));
    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("unstable-range");
    expect(store.ledger.length).toBe(0);
  });

  test("a removed MuoCore log inside a canonical range halts", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1, 0, { removed: true })];
    const r = await runIndexerCycle(cfg({ maxBlocksPerRun: 50 }), deps(chain, store));
    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("unstable-range");
    expect(store.ledger.length).toBe(0);
  });
});

describe("halts", () => {
  test("a malformed recognised log halts and does not advance", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1, 0, { data: "0x" })];
    const r = await runIndexerCycle(cfg(), deps(chain, store));
    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("decode");
    expect(store.cursor).toBeNull();
    expect(store.errors.length).toBeGreaterThan(0);
  });

  test("a chain-id mismatch halts before any log read", async () => {
    const chain = new FakeChain();
    chain.chainIdValue = 31612;
    const store = new MemoryStore();
    const r = await runIndexerCycle(cfg(), deps(chain, store));
    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("conflict");
    expect(chain.getLogsCalls.length).toBe(0);
  });

  test("an RPC failure halts and leaves the cursor unchanged", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    await runIndexerCycle(cfg(), deps(chain, store));
    const version = store.cursor?.version;
    chain.rpc.getLogs = async () => {
      throw new Error("rpc down");
    };
    chain.head += 20;
    const r = await runIndexerCycle(cfg(), deps(chain, store));
    expect(r.status).toBe("halted");
    expect(store.cursor?.version).toBe(version);
  });

  test("a failed commit writes nothing", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.logs = [assertedLog(START + 1)];
    const original = store.commit.bind(store);
    let calls = 0;
    store.commit = async (input) => {
      calls++;
      if (calls === 1) return { ok: false, applied: 0 };
      return original(input);
    };
    const r = await runIndexerCycle(cfg(), deps(chain, store));
    expect(r.status).toBe("halted");
    expect(store.ledger.length).toBe(0);
    expect(store.cursor).toBeNull();
  });
});

describe("config guards", () => {
  test("an unsupported chain id throws", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    await expect(runIndexerCycle(cfg({ chainId: 1 as never }), deps(chain, store))).rejects.toThrow(TypeError);
  });

  test("a malformed core address throws", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    await expect(runIndexerCycle(cfg({ coreAddress: "0x123" as never }), deps(chain, store))).rejects.toThrow(TypeError);
  });
});
