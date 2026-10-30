// REAL local end-to-end: anvil -> MuoCore -> SDK decoder -> D1IndexerStore ->
// GET /v2/assertions.
//
// Every layer here is the production layer:
//   - a real anvil dev chain (127.0.0.1, ephemeral port, chainId 31611)
//   - the real compiled MuoCore + MockMUSD bytecode
//   - the real `decodeMuoLog` from @muo/sdk
//   - the real `runIndexerCycle` + `D1IndexerStore`
//   - the real Hono app via `app.request`
//   - a REAL SQLite transaction for `batch()` (see ./sqlite-d1.ts), not a
//     Promise.all mock and not a string matcher
//
// Scope and non-claims:
//   - LOCAL ONLY. Anvil is not Mezo. Nothing here is evidence of live Mezo
//     behaviour, public-RPC behaviour, or a real wallet flow.
//   - No private key is handled: deployment and calls use anvil's unlocked
//     accounts through `eth_sendTransaction`.
//   - Reorgs are simulated with `evm_snapshot` / `evm_revert`, which is how
//     anvil models a chain rewind.
//
// The fixture helpers are imported READ-ONLY from @muo/integration.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Hex } from "@muo/core/native";
import { isAssertionEvent, MEZO_CHAIN_IDS, MUSD_UNIT } from "@muo/core/native";
import { decodeMuoLog } from "@muo/sdk";

import type { Fixture } from "../../../integration/src/fixture.ts";
import type { RpcLog } from "../../../integration/src/rpc.ts";
import type { IndexerConfig } from "../lib/mezo/indexer";
import { MuoCoreClient, MusdClient, STATUS } from "../../../integration/src/contracts.ts";
import { deploy, loadArtifact, mockMusdArtifact, send } from "../../../integration/src/deploy.ts";
import { startAnvil } from "../../../integration/src/fixture.ts";
import app from "../app";
import { DEFAULT_INDEXER_CONFIG, runIndexerCycle } from "../lib/mezo/indexer";
import { MezoRpc } from "../lib/mezo/rpc";
import { D1IndexerStore } from "../lib/mezo/store";
import { SqliteD1 } from "./sqlite-d1";

const CHAIN_ID = MEZO_CHAIN_IDS.testnet; // 31611
const BOND = 10n; // whole MUSD, the contract floor
const BOND_UNITS = BOND * MUSD_UNIT;
const LIVENESS = 5n;
const CLAIM = `0x${"cc".repeat(64)}` as Hex;

let fx: Fixture;
let d1: SqliteD1;
let core: MuoCoreClient;
let musd: MusdClient;
let coreAddr: Hex;
let musdAddr: Hex;
let owner: Hex;
let asserter: Hex;
let disputer: Hex;
let arbiter: Hex;

/** The production RPC client, pointed at the local anvil. */
const rpc = () => new MezoRpc({ url: fx.url, timeoutMs: 10_000, maxRetries: 2, backoffMs: 50 });
const store = () => new D1IndexerStore(d1 as unknown as D1Database);

const cfg = (over: Partial<IndexerConfig> = {}): IndexerConfig =>
  DEFAULT_INDEXER_CONFIG({
    chainId: CHAIN_ID,
    coreAddress: coreAddr,
    startBlock: 0,
    confirmations: 0,
    maxBlocksPerRun: 5_000,
    ...over,
  });

/** The env the Hono app needs for /v2/*. */
const env = () =>
  ({
    MUO_DB: d1 as unknown as D1Database,
    WEBHOOK_SECRET: "unused-webhook",
    CHAINHOOKS_SECRET: "unused-chainhooks",
    MUO_CORE_CONTRACT: coreAddr,
    MEZO_CHAIN_ID: String(CHAIN_ID),
    MEZO_CORE_ADDRESS: coreAddr,
    MEZO_START_BLOCK: "0",
    MEZO_CONFIRMATIONS: "0",
    MEZO_MAX_BLOCKS_PER_RUN: "5000",
    CORS_ORIGINS: "https://ok.example",
  }) as never;

/**
 * Run one indexer cycle and fail loudly if it did not commit.
 *
 * `confirmations: 0` means the safe head is the chain head, so a cycle that
 * starts at the cursor may legitimately have nothing new to read. Tests that
 * assert on a row call this AFTER mining the event, so the range is non-empty.
 */
async function index() {
  const r = await runIndexerCycle(cfg(), { rpc: rpc(), store: store() });
  if (r.status === "halted") throw new Error(`indexer halted: ${r.reason}: ${r.error}`);
  return r;
}

/**
 * Reset the cursor to the start so the next cycle re-scans everything.
 *
 * The indexer is incremental by design, so a test that asserts "this specific
 * row is present" must not depend on which earlier test happened to advance the
 * cursor past the block it cares about. Resetting makes each test independent
 * without weakening the production code path (the ledger dedup still applies).
 */
function resetCursor(): void {
  d1.db.run(`delete from "mezo_indexer_cursor" where "chain_id" = ? and "core_address" = ?`, [CHAIN_ID, coreAddr]);
}

/** Read /v2/assertions through the real Hono app. */
async function listV2(): Promise<Record<string, unknown>[]> {
  const res = await app.request("/v2/assertions?limit=200", {}, env());
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>[];
}

/** Approve exactly one bond, then assert. Returns the mined receipt. */
async function assertAs(actor: Hex, identifier: Hex, claim: Hex, bond: bigint, liveness: bigint) {
  const units = bond * MUSD_UNIT;
  await send(fx.rpc, actor, musdAddr, musd.approveData(coreAddr, units));
  const { receipt } = await send(fx.rpc, actor, coreAddr, MuoCoreClient.assertClaimData(identifier, claim, bond, liveness));
  return receipt;
}

/** Decode the Asserted event out of a mined receipt's block. */
async function assertedFrom(receipt: { blockNumber: string }) {
  const logs = await fx.rpc.getLogs({
    address: coreAddr,
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  for (const l of logs) {
    const ev = decodeMuoLog(l as unknown as RpcLog, CHAIN_ID, coreAddr);
    if (ev?.event === "asserted") return ev;
  }
  throw new Error(`no Asserted event in block ${receipt.blockNumber}`);
}

beforeAll(async () => {
  fx = await startAnvil({ chainId: CHAIN_ID });
  [owner, asserter, disputer, arbiter] = fx.accounts as [Hex, Hex, Hex, Hex];

  const musdArtifact = mockMusdArtifact();
  musdAddr = await deploy(fx.rpc, owner, musdArtifact.abi, musdArtifact.bytecode);
  musd = new MusdClient(fx.rpc, musdAddr, musdArtifact.abi);

  const coreArtifact = loadArtifact("MuoCore", "MuoCore");
  coreAddr = await deploy(fx.rpc, owner, coreArtifact.abi, coreArtifact.bytecode, [musdAddr]);
  core = new MuoCoreClient(fx.rpc, coreAddr);

  await send(fx.rpc, owner, coreAddr, core.addArbiterData(arbiter));
  await send(fx.rpc, owner, musdAddr, musd.mintData(asserter, 10_000n * MUSD_UNIT));
  await send(fx.rpc, owner, musdAddr, musd.mintData(disputer, 10_000n * MUSD_UNIT));

  d1 = new SqliteD1();
}, 180_000);

afterAll(async () => {
  d1?.close();
  await fx?.stop();
});

describe("e2e: assert", () => {
  test("a mined assert becomes a native row served by GET /v2/assertions", async () => {
    const identifier = `0x${"a1".repeat(32)}` as Hex;
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await assertedFrom(receipt);

    const r = await index();
    expect(r.status).toBe("advanced");

    const rows = await listV2();
    const row = rows.find((x) => x.id === ev.data.assertionId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      identifier,
      claim: CLAIM,
      bondMusd: "10",
      liveness: 5,
      status: "open",
      asserter: asserter.toLowerCase(),
      chainId: CHAIN_ID,
      coreAddress: coreAddr,
    });
    // The bond survives HTTP as a STRING, exactly as the wire contract says.
    expect(typeof row?.bondMusd).toBe("string");
    expect(row?.bondMusd).toBe("10");
    // v1 field must not leak into v2.
    expect("bondSats" in (row ?? {})).toBe(false);
  });

  test("the row carries real chain provenance", async () => {
    const identifier = `0x${"a2".repeat(32)}` as Hex;
    resetCursor();
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await assertedFrom(receipt);
    await index();

    const row = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(row).toBeDefined();
    // Provenance must equal the DECODED event's provenance, which is the log's
    // own block/tx — not the receipt of the approve transaction that preceded it.
    // The row exposes the assert tx as `assertedTxId` (the schema has no
    // separate `transactionHash` field).
    expect(row).toMatchObject({
      blockNumber: ev.provenance.blockNumber,
      blockHash: ev.provenance.blockHash,
      assertedTxId: ev.provenance.transactionHash,
      transactionIndex: ev.provenance.transactionIndex,
      logIndex: ev.provenance.logIndex,
    });
    // The assert tx is the one in the row, and it is a real mined tx.
    expect(row?.assertedTxId).toBe(receipt.transactionHash.toLowerCase());
    expect(typeof row?.logIndex).toBe("number");
    expect(typeof row?.transactionIndex).toBe("number");
  });

  test("an unrelated contract's logs are not indexed", async () => {
    const before = (await listV2()).length;
    // MockMUSD emits Transfer during approve; it must be ignored.
    await send(fx.rpc, asserter, musdAddr, musd.approveData(coreAddr, BOND_UNITS));
    await index();
    expect((await listV2()).length).toBe(before);
  });
});

describe("e2e: dispute and resolve", () => {
  test("dispute then arbiter reject yields status rejected with a resolver", async () => {
    const identifier = `0x${"b1".repeat(32)}` as Hex;
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await assertedFrom(receipt);

    await send(fx.rpc, disputer, musdAddr, musd.approveData(coreAddr, BOND_UNITS));
    await send(fx.rpc, disputer, coreAddr, core.disputeData(ev.data.assertionId));
    await index();

    let row = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(row).toMatchObject({ status: "disputed", disputer: disputer.toLowerCase() });

    await send(fx.rpc, arbiter, coreAddr, core.resolveData(ev.data.assertionId, STATUS.rejected));
    await index();

    row = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(row).toMatchObject({ status: "rejected", resolver: arbiter.toLowerCase() });
    expect(row?.resolvedAtBlock).toBeGreaterThan(0);
    // A rejected assertion must never be reported as settled.
    expect(row?.settler).toBeNull();
  });

  test("dispute then arbiter settle yields status settled with a resolver, not a settler", async () => {
    const identifier = `0x${"b2".repeat(32)}` as Hex;
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await assertedFrom(receipt);

    await send(fx.rpc, disputer, musdAddr, musd.approveData(coreAddr, BOND_UNITS));
    await send(fx.rpc, disputer, coreAddr, core.disputeData(ev.data.assertionId));
    await send(fx.rpc, arbiter, coreAddr, core.resolveData(ev.data.assertionId, STATUS.settled));
    await index();

    const row = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(row).toMatchObject({ status: "settled", resolver: arbiter.toLowerCase() });
    expect(row?.settler).toBeNull();
  });

  test("unresolved is reachable and distinct from rejected", async () => {
    const identifier = `0x${"b3".repeat(32)}` as Hex;
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await assertedFrom(receipt);

    await send(fx.rpc, disputer, musdAddr, musd.approveData(coreAddr, BOND_UNITS));
    await send(fx.rpc, disputer, coreAddr, core.disputeData(ev.data.assertionId));
    await send(fx.rpc, arbiter, coreAddr, core.resolveData(ev.data.assertionId, STATUS.unresolved));
    await index();

    const row = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(row?.status).toBe("unresolved");
  });
});

describe("e2e: expiry settle", () => {
  test("an uncontested assertion settles after its liveness window and records a settler", async () => {
    const identifier = `0x${"c1".repeat(32)}` as Hex;
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await assertedFrom(receipt);
    await index();

    // Mine past the liveness window, then settle.
    await fx.rpc.mine(Number(LIVENESS) + 1);
    await send(fx.rpc, owner, coreAddr, core.settleData(ev.data.assertionId));
    await index();

    const row = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(row).toMatchObject({ status: "settled", settler: owner.toLowerCase() });
    // Uncontested settle must not fabricate a resolver.
    expect(row?.resolver).toBeNull();
  });
});

describe("e2e: restart and duplicates", () => {
  test("re-running the indexer is idempotent: no duplicate rows", async () => {
    const identifier = `0x${"d1".repeat(32)}` as Hex;
    await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    await index();

    const rowsAfterFirst = (await listV2()).length;
    const cursorAfterFirst = await store().readCursor(CHAIN_ID, coreAddr);

    // A second cycle over the same range (simulating a restart) must not
    // duplicate anything.
    await index();
    await index();

    expect((await listV2()).length).toBe(rowsAfterFirst);
    const cursorAfterRestart = await store().readCursor(CHAIN_ID, coreAddr);
    expect(cursorAfterRestart?.version).toBeGreaterThanOrEqual(cursorAfterFirst?.version ?? 0);
  });

  test("a fresh store instance resumes from the persisted cursor", async () => {
    const before = await store().readCursor(CHAIN_ID, coreAddr);
    expect(before).not.toBeNull();
    // New D1IndexerStore object, same SQLite file: proves the cursor is durable
    // in the database, not in process memory.
    const fresh = new D1IndexerStore(d1 as unknown as D1Database);
    const resumed = await fresh.readCursor(CHAIN_ID, coreAddr);
    expect(resumed).toEqual(before);
  });
});

describe("e2e: real reorg via evm_snapshot / evm_revert", () => {
  test("reverting the chain orphans the assertion and removes its row", async () => {
    const identifier = `0x${"e1".repeat(32)}` as Hex;

    const snapshot = (await fx.rpc.call<string>("evm_snapshot", [])) as string;
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await assertedFrom(receipt);
    await index();

    const present = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(present).toBeDefined();
    expect(present?.status).toBe("open");

    // Rewind the chain: the assert transaction no longer exists.
    const reverted = (await fx.rpc.call<boolean>("evm_revert", [snapshot])) as boolean;
    expect(reverted).toBe(true);

    // The cursor points at a block whose hash no longer exists. The indexer
    // must detect that, rewind, and rebuild from the surviving ledger.
    const r = await runIndexerCycle(cfg(), { rpc: rpc(), store: store() });
    expect(r.status).toBe("advanced");
    if (r.status === "advanced") expect(r.reorg).toBe(true);

    const after = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(after).toBeUndefined();
  }, 60_000);

  test("reverting only the settlement returns the row to disputed", async () => {
    const identifier = `0x${"e2".repeat(32)}` as Hex;
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await assertedFrom(receipt);

    await send(fx.rpc, disputer, musdAddr, musd.approveData(coreAddr, BOND_UNITS));
    await send(fx.rpc, disputer, coreAddr, core.disputeData(ev.data.assertionId));
    await index();

    const snapshotBeforeResolve = (await fx.rpc.call<string>("evm_snapshot", [])) as string;
    await send(fx.rpc, arbiter, coreAddr, core.resolveData(ev.data.assertionId, STATUS.rejected));
    await index();

    let row = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(row?.status).toBe("rejected");

    // Orphan ONLY the resolve; the dispute survives.
    await fx.rpc.call<boolean>("evm_revert", [snapshotBeforeResolve]);
    const r = await runIndexerCycle(cfg(), { rpc: rpc(), store: store() });
    expect(r.status).toBe("advanced");

    row = (await listV2()).find((x) => x.id === ev.data.assertionId);
    expect(row?.status).toBe("disputed");
    expect(row?.resolver).toBeNull();
  }, 60_000);
});

describe("e2e: atomicity with a real SQLite transaction", () => {
  test("an injected mid-batch failure commits nothing and leaves the cursor unchanged", async () => {
    const identifier = `0x${"f1".repeat(32)}` as Hex;
    await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);

    const cursorBefore = await store().readCursor(CHAIN_ID, coreAddr);
    const rowsBefore = (await listV2()).length;

    // Fail partway through the batch, after the cursor CAS and the first insert.
    d1.failNextBatchAfter = 2;
    const r = await runIndexerCycle(cfg(), { rpc: rpc(), store: store() });

    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("conflict");

    // Nothing from the failed batch survived the ROLLBACK.
    expect((await listV2()).length).toBe(rowsBefore);
    const cursorAfter = await store().readCursor(CHAIN_ID, coreAddr);
    expect(cursorAfter).toEqual(cursorBefore);

    // A clean retry then succeeds, proving the failure was recoverable.
    const retry = await runIndexerCycle(cfg(), { rpc: rpc(), store: store() });
    expect(retry.status).toBe("advanced");
    expect((await listV2()).length).toBe(rowsBefore + 1);
  }, 60_000);

  test("a lost CAS writes nothing: the stale projection never commits", async () => {
    const identifier = `0x${"f2".repeat(32)}` as Hex;
    await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);

    // Bring the index fully up to date FIRST, so `rowsBefore` is a stable
    // baseline and the only pending work is genuinely new.
    await index();
    const rowsBefore = (await listV2()).length;
    const stale = await store().readCursor(CHAIN_ID, coreAddr);
    expect(stale).not.toBeNull();

    // Now create new work that this run would apply if its CAS succeeded.
    const pending = `0x${"f4".repeat(32)}` as Hex;
    await assertAs(asserter, pending, CLAIM, BOND, LIVENESS);
    const rowsWithPending = (await listV2()).length;
    expect(rowsWithPending).toBe(rowsBefore);

    // Model the real race precisely: this run reads the cursor, THEN a
    // concurrent run commits (version+1, lease released), THEN our run tries to
    // commit against the version it read. The store is wrapped so the FIRST
    // `readCursor` returns the pre-race value while the database holds the
    // post-race one. `readLease` reports no lease so the run is not skipped as
    // `lease-held` — the point under test is the CAS, not the lease.
    const real = store();
    let firstRead = true;
    const staleView: D1IndexerStore = Object.assign(Object.create(null), {
      readCursor: async (c: number, a: string) => {
        if (firstRead) {
          firstRead = false;
          return stale;
        }
        return real.readCursor(c, a);
      },
      readLease: async () => ({ owner: null, expiresAt: null }),
      readLedgerFrom: (c: number, a: string, b: number) => real.readLedgerFrom(c, a, b),
      readLedgerFor: (c: number, a: string, id: Hex) => real.readLedgerFor(c, a, id),
      readBlockHash: (c: number, a: string, b: number) => real.readBlockHash(c, a, b),
      recordError: (c: number, a: string, m: string) => real.recordError(c, a, m),
      commit: (input: Parameters<D1IndexerStore["commit"]>[0]) => real.commit(input),
    }) as D1IndexerStore;

    // The concurrent winner commits.
    d1.db.run(
      `update "mezo_indexer_cursor"
         set "version" = "version" + 1, "lease_owner" = null, "lease_expires_at" = null
       where "chain_id" = ? and "core_address" = ?`,
      [CHAIN_ID, coreAddr]
    );

    const r = await runIndexerCycle(cfg(), { rpc: rpc(), store: staleView });
    expect(r.status).toBe("halted");
    if (r.status === "halted") expect(r.reason).toBe("conflict");

    // THE ASSERTION THAT MATTERS: the loser wrote NOTHING. Assert the pending
    // row is absent BEFORE any recovery run, otherwise the test would pass even
    // if the loser had written the projection (a later legitimate run would
    // produce the same row and hide the leak).
    const afterLoss = await listV2();
    expect(afterLoss.length).toBe(rowsBefore);
    expect(afterLoss.filter((x) => x.identifier === pending)).toEqual([]);

    // Its cursor did not move either.
    const cursorAfterLoss = await store().readCursor(CHAIN_ID, coreAddr);
    expect(cursorAfterLoss?.version).toBe((stale?.version ?? 0) + 1);
    expect(cursorAfterLoss?.blockNumber).toBe(stale?.blockNumber);

    // Only NOW prove the state was recoverable: a legitimate run indexes it.
    const recovered = await runIndexerCycle(cfg(), { rpc: rpc(), store: store() });
    expect(recovered.status).toBe("advanced");
    const pendingRows = (await listV2()).filter((x) => x.identifier === pending);
    expect(pendingRows.length).toBe(1);
  }, 60_000);

  test("the CAS trigger aborts an unversioned position change", async () => {
    expect(() =>
      d1.db.run(`update "mezo_indexer_cursor" set "block_number" = 999999 where "chain_id" = ? and "core_address" = ?`, [CHAIN_ID, coreAddr])
    ).toThrow(/cas_lost/);
  });
});

describe("e2e: namespace and schema strictness over HTTP", () => {
  test("a different chain id is not served", async () => {
    const res = await app.request("/v2/assertions", {}, { ...(env() as object), MEZO_CHAIN_ID: "31612" } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("a different core address is not served", async () => {
    const res = await app.request("/v2/assertions", {}, { ...(env() as object), MEZO_CORE_ADDRESS: `0x${"ab".repeat(20)}` } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("every served row satisfies the strict native schema", async () => {
    const rows = await listV2();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Whole-MUSD bond must be a canonical decimal string, never a number.
      expect(typeof row.bondMusd).toBe("string");
      expect(/^(0|[1-9][0-9]*)$/.test(row.bondMusd as string)).toBe(true);
      expect(BigInt(row.bondMusd as string)).toBeGreaterThanOrEqual(10n);
      // Ids and hashes are lowercase 0x + hex.
      for (const k of ["id", "identifier", "claim", "blockHash"]) {
        expect(row[k]).toMatch(/^0x[0-9a-f]+$/);
      }
      expect(row.chainId).toBe(CHAIN_ID);
      expect(row.coreAddress).toBe(coreAddr);
    }
  });

  test("the decoded event also satisfies isAssertionEvent", async () => {
    const identifier = `0x${"f3".repeat(32)}` as Hex;
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await assertedFrom(receipt);
    expect(isAssertionEvent(ev)).toBe(true);
    expect(ev.data.bondMusd).toBe("10");
  });
});
