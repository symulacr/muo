// End-to-end consistency regression: POST /v2/indexer/run → GET /v2/assertions.
//
// This reproduces the reported portal symptom — a Disputed event is applied
// (`applied: 1`) yet the immediately-following read still shows `open` — using
// REAL SQLite through ./sqlite-d1.ts and a MOCK RPC. No anvil, no server, no
// browser, no network.
//
// The point is to separate the three candidate layers:
//   1. the DB projection (is the row actually written before the POST returns?)
//   2. the HTTP response cache headers (can a caller legitimately see a stale
//      body even though the DB is correct?)
//   3. read-before-await in the caller
//
// The tests below prove (1) is sound and pin the exact header that makes (2)
// possible. (3) is a caller-side property this repo cannot test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Hex } from "@muo/core/native";
import { MEZO_CHAIN_IDS, TESTNET_CORE } from "@muo/core/native";
import { MUO_TOPIC0 } from "@muo/sdk/native";
import { computeAssertionId } from "@muo/utils/native";

import type { IndexerConfig } from "../lib/mezo/indexer";
import type { RpcBlock, RpcLog } from "../lib/mezo/rpc";
import app from "../app";
import { DEFAULT_INDEXER_CONFIG, runIndexerCycle } from "../lib/mezo/indexer";
import { D1IndexerStore } from "../lib/mezo/store";
import { SqliteD1 } from "./sqlite-d1";

const CHAIN = MEZO_CHAIN_IDS.testnet;
const CORE = TESTNET_CORE;
const IDENT = `0x${"11".repeat(32)}` as Hex;
const CLAIM = "0xdeadbeef" as Hex;
const ACTOR = "0x2a2a8551e30c63263dd9dbb698e57fb37c77a6b3" as Hex;
const DISPUTER = "0x118917a40faf1cd7a13db0ef56c86de7973ac503" as Hex;
const START = 100;

const blockHash = (n: number): Hex => `0x${(n + 0x100000).toString(16).padStart(64, "0")}` as Hex;
const txHash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const pad32 = (h: string): string => h.slice(2).padStart(64, "0");
const word = (n: bigint): string => n.toString(16).padStart(64, "0");
const bytesTail = (hex: Hex): string => {
  const body = hex.slice(2);
  const len = body.length / 2;
  return word(BigInt(len)) + body.padEnd(Math.ceil(len / 32) * 64, "0");
};

const assertedLog = (block: number, id: Hex, identifier: Hex = IDENT): RpcLog => ({
  address: CORE,
  topics: [MUO_TOPIC0.Asserted, `0x${pad32(id)}`, `0x${pad32(ACTOR)}`],
  data: `0x${pad32(identifier)}${word(160n)}${word(10n)}${word(1440n)}${word(BigInt(block))}${bytesTail(CLAIM)}` as Hex,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: blockHash(block),
  transactionHash: txHash(block * 100),
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
});

const outcomeLog = (kind: "Disputed" | "Settled" | "Rejected" | "Unresolved", id: Hex, block: number, by: Hex): RpcLog => ({
  address: CORE,
  topics: [MUO_TOPIC0[kind], `0x${pad32(id)}`, `0x${pad32(by)}`],
  data: `0x${word(BigInt(block))}` as Hex,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: blockHash(block),
  transactionHash: txHash(block * 100),
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
});

/** Chain stub: a mutable log list plus a block-hash table. */
const makeChain = () => {
  const hashes = new Map<number, Hex>();
  for (let n = START - 5; n <= START + 200; n++) hashes.set(n, blockHash(n));
  const state = {
    head: START + 2,
    logs: [] as RpcLog[],
    hashes,
  };
  const rpc = {
    chainId: async () => CHAIN,
    blockNumber: async () => state.head,
    getBlock: async (n: number): Promise<RpcBlock | null> => {
      const h = state.hashes.get(n);
      return h ? { number: `0x${n.toString(16)}`, hash: h, parentHash: state.hashes.get(n - 1) ?? blockHash(n - 1) } : null;
    },
    getLogs: async (a: { fromBlock: number; toBlock: number }) =>
      state.logs.filter((l) => {
        const n = Number(l.blockNumber);
        return n >= a.fromBlock && n <= a.toBlock;
      }),
  };
  return { state, rpc };
};

let d1: SqliteD1;
let chain: ReturnType<typeof makeChain>;

const cfg = (over: Partial<IndexerConfig> = {}): IndexerConfig =>
  DEFAULT_INDEXER_CONFIG({
    chainId: CHAIN,
    coreAddress: CORE,
    startBlock: START,
    confirmations: 0,
    maxBlocksPerRun: 500,
    ...over,
  });

const env = () =>
  ({
    MUO_DB: d1 as unknown as D1Database,
    WEBHOOK_SECRET: "unused",
    CHAINHOOKS_SECRET: "unused",
    MUO_CORE_CONTRACT: CORE,
    MEZO_CHAIN_ID: String(CHAIN),
    MEZO_CORE_ADDRESS: CORE,
    MEZO_START_BLOCK: String(START),
    MEZO_CONFIRMATIONS: "0",
    MEZO_MAX_BLOCKS_PER_RUN: "500",
    CORS_ORIGINS: "https://ok.example",
  }) as never;

/** Drive one real indexer cycle against real SQLite. */
const runOnce = () => runIndexerCycle(cfg(), { rpc: chain.rpc, store: new D1IndexerStore(d1 as unknown as D1Database) });

const getRow = async (id: Hex) => {
  const res = await app.request("/v2/assertions?limit=200", {}, env());
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Record<string, unknown>[];
  return { res, row: rows.find((r) => r.id === id) };
};

beforeEach(() => {
  d1 = new SqliteD1();
  chain = makeChain();
});

afterEach(() => {
  d1.close();
});

describe("projection is consistent the moment the cycle returns", () => {
  test("Asserted then Disputed: the row is `disputed` immediately after the cycle resolves", async () => {
    const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(START + 1));
    chain.state.logs = [assertedLog(START + 1, id)];

    // Cycle 1: the assert. Head is START+2, so the cursor ends there.
    const r1 = await runOnce();
    expect(r1.status).toBe("advanced");
    expect((await getRow(id)).row?.status).toBe("open");

    // Cycle 2: the dispute is mined AHEAD of the cursor.
    chain.state.head = START + 12;
    chain.state.logs = [assertedLog(START + 1, id), outcomeLog("Disputed", id, START + 9, DISPUTER)];
    const r2 = await runOnce();
    expect(r2.status).toBe("advanced");
    if (r2.status === "advanced") expect(r2.applied).toBe(1);

    // THE ASSERTION THE PORTAL NEEDED: no await, no polling, no delay.
    // The DB is already correct when the cycle promise resolves.
    const { row } = await getRow(id);
    expect(row?.status).toBe("disputed");
    expect(row?.disputer).toBe(DISPUTER);
  });

  test("the projection write is committed in the same batch as the ledger row", async () => {
    const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(START + 1));
    chain.state.logs = [assertedLog(START + 1, id), outcomeLog("Disputed", id, START + 3, DISPUTER)];
    chain.state.head = START + 12;

    await runOnce();

    // Read the two tables directly: both must reflect the dispute.
    const row = d1.db.query(`select "status" from "mezo_assertions" where "assertion_id" = ?`).get(id) as {
      status: string;
    };
    const ledger = d1.db.query(`select "event_kind" from "mezo_applied_logs" where "assertion_id" = ? order by "block_number"`).all(id) as {
      event_kind: string;
    }[];
    expect(row.status).toBe("disputed");
    expect(ledger.map((l) => l.event_kind)).toEqual(["asserted", "disputed"]);
  });

  test("terminal events follow immediately: rejected and unresolved", async () => {
    const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(START + 1));
    // All three events are ahead of the initial cursor, so one cycle applies them.
    chain.state.logs = [assertedLog(START + 1, id), outcomeLog("Disputed", id, START + 3, DISPUTER), outcomeLog("Rejected", id, START + 4, ACTOR)];
    chain.state.head = START + 12;

    const r = await runOnce();
    expect(r.status).toBe("advanced");
    const { row } = await getRow(id);
    expect(row?.status).toBe("rejected");
    expect(row?.resolver).toBe(ACTOR);
  });

  test("a second assertion's dispute does not leave the first stale", async () => {
    const identA = `0x${"aa".repeat(32)}` as Hex;
    const identB = `0x${"bb".repeat(32)}` as Hex;
    // Different identifiers AND different blocks, so both the assertion ids and
    // the ledger keys are distinct.
    const idA = computeAssertionId(identA, CLAIM, 10n, 1440n, BigInt(START + 1));
    const idB = computeAssertionId(identB, CLAIM, 10n, 1440n, BigInt(START + 2));

    const logA = assertedLog(START + 1, idA, identA);
    const logB = assertedLog(START + 2, idB, identB);
    chain.state.logs = [logA, logB];
    await runOnce();

    chain.state.head = START + 12;
    chain.state.logs = [logA, logB, outcomeLog("Disputed", idB, START + 9, DISPUTER)];
    await runOnce();

    expect((await getRow(idA)).row?.status).toBe("open");
    expect((await getRow(idB)).row?.status).toBe("disputed");
  });
});

describe("HTTP cache policy — native reads are FRESH by default", () => {
  test("GET /v2/assertions on real rows sends Cache-Control: no-store", async () => {
    const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(START + 1));
    chain.state.logs = [assertedLog(START + 1, id)];
    await runOnce();

    const { res, row } = await getRow(id);
    // Serve a real row, so this is the actual data path, not an error path.
    expect(row).toBeDefined();

    const cc = res.headers.get("cache-control");
    expect(cc).toBe("no-store");
    // The old policy permitted 5 s of staleness plus 30 s of stale-while-
    // revalidate. Neither directive may come back.
    expect(cc).not.toContain("max-age");
    expect(cc).not.toContain("stale-while-revalidate");
    expect(cc).not.toContain("public");
  });

  test("GET /v2/status sends Cache-Control: no-store", async () => {
    const res = await app.request("/v2/status", {}, env());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("no-store also covers v2 error and pagination variants", async () => {
    // Pagination error: bad limit.
    const badLimit = await app.request("/v2/assertions?limit=0", {}, env());
    expect(badLimit.status).toBe(400);
    expect(badLimit.headers.get("cache-control")).toBe("no-store");

    // Pagination error: bad offset.
    const badOffset = await app.request("/v2/assertions?offset=-1", {}, env());
    expect(badOffset.status).toBe(400);
    expect(badOffset.headers.get("cache-control")).toBe("no-store");

    // Unconfigured (503) is still a /v2/* response.
    const unconfigured = await app.request("/v2/assertions", {}, { ...(env() as object), MEZO_CHAIN_ID: "" } as never);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get("cache-control")).toBe("no-store");
  });

  test("the POST trigger is not cacheable", async () => {
    const res = await app.request("/v2/indexer/run", { method: "POST", headers: { Authorization: "Bearer unused" } }, {
      ...(env() as object),
      INDEXER_ADMIN_SECRET: "unused",
    } as never);
    // 503 (no RPC URL configured) or 502, but never a cached 200.
    expect([502, 503]).toContain(res.status);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("v1 /assertions is UNCHANGED: still no cache header on the bare route", async () => {
    const res = await app.request("/assertions", {}, env());
    expect(res.status).toBe(200);
    // The historical v1 read route was deliberately left alone. Its middleware
    // is mounted on `/assertions/*`, which does not match the bare route, so no
    // Cache-Control is emitted — same as before this change.
    expect(res.headers.get("cache-control")).toBeNull();
  });

  test("a caller can still force freshness with cache: no-store and gets the disputed row", async () => {
    const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(START + 1));
    chain.state.logs = [assertedLog(START + 1, id)];
    await runOnce();

    chain.state.head = START + 12;
    chain.state.logs = [assertedLog(START + 1, id), outcomeLog("Disputed", id, START + 9, DISPUTER)];
    await runOnce();

    // Server and client both say no-store; the portal already sends this.
    const res = await app.request("/v2/assertions?limit=200", { cache: "no-store" } as RequestInit, env());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows.find((r) => r.id === id)?.status).toBe("disputed");
  });
});

describe("awaited POST -> immediate GET is consistent", () => {
  /**
   * The exact portal sequence: await the authenticated trigger, then read
   * immediately. No polling, no delay, no retry.
   *
   * MEZO_RPC_URL is deliberately NOT set, so the route returns 503
   * `rpc_not_configured` without attempting any network call. The authoritative
   * cycle is then driven directly against the mock RPC, which is what the
   * projection consistency actually depends on.
   */
  const triggerThenRead = async (id: Hex) => {
    const post = await app.request("/v2/indexer/run", { method: "POST", headers: { Authorization: "Bearer admin-secret" } }, {
      ...(env() as object),
      INDEXER_ADMIN_SECRET: "admin-secret",
    } as never);
    // No RPC configured => 503, and the response is still non-cacheable.
    expect(post.status).toBe(503);
    expect(post.headers.get("cache-control")).toBe("no-store");

    // The authoritative cycle, awaited.
    const cycle = await runOnce();
    expect(cycle.status).toBe("advanced");

    // Immediate read, no delay.
    return getRow(id);
  };

  test("asserted -> disputed: the awaited cycle then an immediate GET shows disputed", async () => {
    const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(START + 1));
    chain.state.logs = [assertedLog(START + 1, id)];
    await runOnce();
    expect((await getRow(id)).row?.status).toBe("open");

    chain.state.head = START + 12;
    chain.state.logs = [assertedLog(START + 1, id), outcomeLog("Disputed", id, START + 9, DISPUTER)];

    const { res, row } = await triggerThenRead(id);
    expect(row?.status).toBe("disputed");
    expect(row?.disputer).toBe(DISPUTER);
    // And the response that carried it is non-cacheable.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("disputed -> rejected: the awaited cycle then an immediate GET shows rejected", async () => {
    const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(START + 1));
    chain.state.logs = [assertedLog(START + 1, id), outcomeLog("Disputed", id, START + 2, DISPUTER)];
    await runOnce();
    expect((await getRow(id)).row?.status).toBe("disputed");

    chain.state.head = START + 12;
    chain.state.logs = [assertedLog(START + 1, id), outcomeLog("Disputed", id, START + 2, DISPUTER), outcomeLog("Rejected", id, START + 9, ACTOR)];

    const { row } = await triggerThenRead(id);
    expect(row?.status).toBe("rejected");
    expect(row?.resolver).toBe(ACTOR);
  });
});

describe("read-before-await is a caller bug, not a server bug", () => {
  test("reading BEFORE the cycle resolves sees the old row; after, the new one", async () => {
    const id = computeAssertionId(IDENT, CLAIM, 10n, 1440n, BigInt(START + 1));
    chain.state.logs = [assertedLog(START + 1, id)];
    await runOnce();

    chain.state.head = START + 12;
    chain.state.logs = [assertedLog(START + 1, id), outcomeLog("Disputed", id, START + 9, DISPUTER)];

    // Start the cycle but do NOT await it, then read immediately. This is the
    // shape of the reported symptom.
    const pending = runOnce();
    const during = await getRow(id);
    await pending;
    const after = await getRow(id);

    // The un-awaited read is allowed to see the pre-commit state...
    expect(["open", "disputed"]).toContain(during.row?.status as string);
    // ...but the awaited read is always correct.
    expect(after.row?.status).toBe("disputed");
  });
});
