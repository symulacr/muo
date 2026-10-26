import { describe, expect, test } from "bun:test";

import type { AssertionEvent, Hex } from "@muo/core/native";
import { TESTNET_CORE } from "@muo/core/native";
import { computeAssertionId } from "@muo/utils/native";

import type { LedgerEntry } from "../lib/mezo/projection";
import { affectedAssertions, compareLedger, groupByAssertion, projectAssertion } from "../lib/mezo/projection";

const CHAIN = 31611;
const CORE = TESTNET_CORE;
const IDENT = `0x${"11".repeat(32)}` as Hex;
const CLAIM = "0xdeadbeef" as Hex;
const ACTOR = "0x2a2a8551e30c63263dd9dbb698e57fb37c77a6b3" as Hex;
const OTHER = "0x118917a40faf1cd7a13db0ef56c86de7973ac503" as Hex;
const ID = computeAssertionId(IDENT, CLAIM, 10n, 1440n, 100n);

const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const hash = (n: number): Hex => `0x${(n + 1000).toString(16).padStart(64, "0")}` as Hex;

const prov = (blockNumber: number, logIndex: number, transactionIndex = 0) => ({
  chainId: CHAIN as 31611,
  coreAddress: CORE,
  blockNumber,
  blockHash: hash(blockNumber),
  transactionHash: tx(blockNumber * 100 + logIndex),
  transactionIndex,
  logIndex,
});

const entry = (p: ReturnType<typeof prov>, event: AssertionEvent): LedgerEntry => ({
  txHash: p.transactionHash,
  logIndex: p.logIndex,
  blockNumber: p.blockNumber,
  blockHash: p.blockHash,
  transactionIndex: p.transactionIndex,
  assertionId: ID,
  event,
});

const asserted = (block = 100, logIndex = 0, transactionIndex = 0): LedgerEntry => {
  const p = prov(block, logIndex, transactionIndex);
  return entry(p, {
    event: "asserted",
    data: {
      assertionId: ID,
      identifier: IDENT,
      claim: CLAIM,
      bondMusd: "10",
      liveness: 1440,
      assertedBy: ACTOR,
      assertedAtBlock: block,
      assertedTxId: p.transactionHash,
    },
    provenance: p,
  });
};

const outcome = (kind: "disputed" | "settled" | "rejected" | "unresolved", block: number, logIndex: number, by = OTHER): LedgerEntry => {
  const p = prov(block, logIndex);
  const data = {
    assertionId: ID,
    [`${kind}By`]: by,
    [`${kind}AtBlock`]: block,
    [`${kind}TxId`]: p.transactionHash,
  };
  return entry(p, { event: kind, data, provenance: p } as unknown as AssertionEvent);
};

describe("projectAssertion", () => {
  test("a lone asserted log opens the row", () => {
    const row = projectAssertion([asserted()]);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
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
      assertedAtBlock: 100,
    });
  });

  test("no asserted log projects to null (the row must be deleted)", () => {
    expect(projectAssertion([])).toBeNull();
    expect(projectAssertion([outcome("disputed", 101, 0)])).toBeNull();
  });

  test("uncontested settle records a settler, not a resolver", () => {
    const row = projectAssertion([asserted(), outcome("settled", 1540, 0)]);
    expect(row).toMatchObject({ status: "settled", settler: OTHER, resolver: null, settledAtBlock: 1540 });
    expect(row?.settledTxId).toBe(prov(1540, 0).transactionHash);
  });

  test("disputed then settled records a resolver, not a settler", () => {
    const row = projectAssertion([asserted(), outcome("disputed", 101, 0), outcome("settled", 200, 0, ACTOR)]);
    expect(row).toMatchObject({ status: "settled", settler: null, resolver: ACTOR, resolvedAtBlock: 200 });
    expect(row?.disputer).toBe(OTHER);
  });

  test.each(["rejected", "unresolved"] as const)("disputed then %s records a resolver", (kind) => {
    const row = projectAssertion([asserted(), outcome("disputed", 101, 0), outcome(kind, 200, 0, ACTOR)]);
    expect(row?.status).toBe(kind);
    expect(row?.resolver).toBe(ACTOR);
    expect(row?.resolvedAtBlock).toBe(200);
  });

  test("an outcome without a preceding dispute is skipped, not applied", () => {
    const row = projectAssertion([asserted(), outcome("rejected", 200, 0)]);
    expect(row?.status).toBe("open");
    expect(row?.resolver).toBeNull();
  });

  test("a second dispute after settlement is skipped", () => {
    const row = projectAssertion([asserted(), outcome("settled", 1540, 0), outcome("disputed", 1600, 0)]);
    expect(row?.status).toBe("settled");
    expect(row?.disputer).toBeNull();
  });

  test("order is canonical, not insertion order", () => {
    const shuffled = [outcome("settled", 1540, 0), asserted(), outcome("disputed", 101, 0)];
    const row = projectAssertion(shuffled);
    expect(row).toMatchObject({ status: "settled", disputer: OTHER, settler: null, resolver: OTHER });
  });

  test("within one block, transactionIndex then logIndex decide order", () => {
    const a = asserted(100, 0, 0);
    const d = outcome("disputed", 100, 0);
    d.transactionIndex = 1;
    const row = projectAssertion([d, a]);
    expect(row?.status).toBe("disputed");
  });
});

describe("reorg rebuild semantics", () => {
  test("orphaning the settled log returns the row to disputed", () => {
    const kept = [asserted(), outcome("disputed", 101, 0)];
    expect(projectAssertion(kept)?.status).toBe("disputed");
  });

  test("orphaning both dispute and settle returns the row to open", () => {
    expect(projectAssertion([asserted()])?.status).toBe("open");
  });

  test("orphaning the asserted log removes the row entirely", () => {
    expect(projectAssertion([outcome("disputed", 101, 0)])).toBeNull();
  });

  test("a rollback is never a blind reverse patch: settled->open is not produced", () => {
    // If only the asserted log survived, the state is open with no settler.
    const row = projectAssertion([asserted()]);
    expect(row?.status).toBe("open");
    expect(row?.settler).toBeNull();
    expect(row?.settledTxId).toBeNull();
  });
});

describe("ordering and grouping helpers", () => {
  test("compareLedger orders by block, transactionIndex, logIndex", () => {
    const a = asserted(100, 5, 1);
    const b = asserted(100, 0, 2);
    const c = asserted(99, 9, 0);
    expect([a, b, c].sort(compareLedger).map((e) => e.blockNumber)).toEqual([99, 100, 100]);
    // Same block: transactionIndex decides, so b (tx 2) sorts after a (tx 1).
    expect([b, a].sort(compareLedger).map((e) => e.transactionIndex)).toEqual([1, 2]);
  });

  test("groupByAssertion keeps canonical order inside each group", () => {
    const otherId = computeAssertionId(`0x${"22".repeat(32)}`, CLAIM, 10n, 1440n, 100n);
    const e2 = asserted(100, 1);
    const e2other = { ...asserted(100, 0), assertionId: otherId };
    const groups = groupByAssertion([e2, e2other]);
    expect(groups.size).toBe(2);
    expect(groups.get(ID)?.length).toBe(1);
    expect(groups.get(otherId)?.length).toBe(1);
  });

  test("affectedAssertions unions incoming and removed ids", () => {
    const otherId = `0x${"33".repeat(32)}` as Hex;
    const ids = affectedAssertions([asserted()], [{ assertionId: otherId }]);
    expect(ids.has(ID)).toBe(true);
    expect(ids.has(otherId)).toBe(true);
    expect(ids.size).toBe(2);
  });
});
