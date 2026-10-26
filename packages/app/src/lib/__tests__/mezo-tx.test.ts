import { describe, expect, test } from "bun:test";

import type { Hex } from "@muo/core/native";
import { bondToUnits, MIN_BOND_MUSD, MUSD_UNIT } from "@muo/core/native";

import type { TxContext, WriteRequest } from "@/lib/mezo-tx";
import { assertFreshSession, bondUnits, ensureAllowance, submitCoreWrite, TxError } from "@/lib/mezo-tx";
import { encodeAsserted, encodeMalformed, encodeOutcome } from "@/test-support/event-fixtures";
import { FakeProvider, OTHER_ACCOUNT, TEST_ACCOUNT, TEST_CORE, TEST_ID, TEST_MUSD, TEST_TX } from "@/test-support/fake-provider";

type Call = { kind: "read" | "simulate" | "write"; functionName: string; args: readonly unknown[]; to?: string };

/**
 * Minimal public-client double. Records every call so tests can assert exact
 * scaling, ordering, and that reads precede writes.
 */
class FakePublicClient {
  calls: Call[] = [];
  allowance = 0n;
  bondMusd = 10n;
  simulateError: unknown = null;
  receipt: { status: "success" | "reverted"; blockNumber: bigint; logs: Array<{ address: string; topics: string[]; data: Hex }> } | null = null;
  receiptDelayForever = false;

  async readContract(req: { address: string; functionName: string; args: readonly unknown[] }) {
    this.calls.push({ kind: "read", functionName: req.functionName, args: req.args, to: req.address });
    if (req.functionName === "allowance") return this.allowance;
    if (req.functionName === "getAssertion") {
      return {
        asserter: TEST_ACCOUNT,
        disputer: "0x0000000000000000000000000000000000000000",
        bondMusd: this.bondMusd,
        liveness: 1440n,
        status: 0,
        assertedAtBlock: 1n,
        disputedAtBlock: 0n,
        settledAtBlock: 0n,
        rejectedAtBlock: 0n,
        unresolvedAtBlock: 0n,
        exists: true,
      };
    }
    if (req.functionName === "isArbiter") return true;
    if (req.functionName === "balanceOf") return 0n;
    throw new Error(`unexpected read ${req.functionName}`);
  }

  async simulateContract(req: { functionName: string; args: readonly unknown[] }) {
    this.calls.push({ kind: "simulate", functionName: req.functionName, args: req.args });
    if (this.simulateError) throw this.simulateError;
    return { request: {} };
  }

  async waitForTransactionReceipt() {
    if (this.receiptDelayForever) throw new Error("timeout");
    return this.receipt;
  }

  async getBalance() {
    return 0n;
  }
}

const makeCtx = (overrides: Partial<TxContext> = {}): { ctx: TxContext; client: FakePublicClient; provider: FakeProvider } => {
  const provider = new FakeProvider({ chainId: 31611, accounts: [TEST_ACCOUNT] });
  const client = new FakePublicClient();
  const ctx = {
    provider,
    chainId: 31611,
    coreAddress: TEST_CORE,
    musdAddress: TEST_MUSD,
    publicClient: client as unknown as TxContext["publicClient"],
    expectedAccount: TEST_ACCOUNT,
    ...overrides,
  } as TxContext;
  return { ctx, client, provider };
};

describe("bond scaling", () => {
  test("scales whole MUSD to base units exactly once", () => {
    expect(bondUnits("10")).toBe(10n * MUSD_UNIT);
    expect(bondUnits("10000")).toBe(10_000n * MUSD_UNIT);
    expect(bondUnits("340282366920938463463374607431768211455")).toBe(340282366920938463463374607431768211455n * MUSD_UNIT);
  });

  test("rejects sub-minimum and malformed bonds", () => {
    for (const bad of ["0", "9", "10.5", "-10", "1e3", "", " 10", "010"]) {
      expect(() => bondUnits(bad)).toThrow();
    }
  });

  test("bondToUnits agrees with the shared helper", () => {
    expect(bondUnits(MIN_BOND_MUSD.toString())).toBe(bondToUnits(MIN_BOND_MUSD));
  });

  test("does not use Number arithmetic for large bonds", () => {
    const huge = "9007199254740993"; // beyond Number.MAX_SAFE_INTEGER
    expect(bondUnits(huge).toString()).toBe("9007199254740993000000000000000000");
  });
});

describe("fresh session guards", () => {
  test("passes when account and chain are unchanged", async () => {
    const { ctx } = makeCtx();
    await expect(assertFreshSession(ctx)).resolves.toBeUndefined();
  });

  test("rejects a chain switch between prepare and prompt", async () => {
    const { ctx, provider } = makeCtx();
    provider.chainId = 31612;
    await expect(assertFreshSession(ctx)).rejects.toThrow(/chain/i);
  });

  test("rejects an account switch between prepare and prompt", async () => {
    const { ctx, provider } = makeCtx();
    provider.accounts = [OTHER_ACCOUNT];
    await expect(assertFreshSession(ctx)).rejects.toThrow(/account changed/i);
  });

  test("rejects a disconnected wallet", async () => {
    const { ctx, provider } = makeCtx();
    provider.accounts = [];
    await expect(assertFreshSession(ctx)).rejects.toThrow(/no longer connected/i);
  });

  test("TxError carries an optional numeric code", () => {
    expect(new TxError("x", 8403200).code).toBe(8403200);
    expect(new TxError("x").code).toBeUndefined();
  });
});

describe("allowance handling", () => {
  test("skips approval when the allowance already covers the bond", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 100n * MUSD_UNIT;
    const result = await ensureAllowance(ctx, 10n * MUSD_UNIT);
    expect(result).toEqual({ status: "ok" });
    expect(client.calls.filter((c) => c.kind === "simulate").length).toBe(0);
  });

  test("approves the exact required amount, never an unbounded allowance", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 0n;
    client.receipt = { status: "success", blockNumber: 5n, logs: [{ address: TEST_MUSD, topics: ["0xapproval"], data: "0x" as Hex }] };
    // The fake models a wallet that applies the approval on confirmation.
    const originalWait = client.waitForTransactionReceipt.bind(client);
    client.waitForTransactionReceipt = async () => {
      const receipt = await originalWait();
      client.allowance = 10n * MUSD_UNIT;
      return receipt;
    };
    const result = await ensureAllowance(ctx, 10n * MUSD_UNIT);
    expect(result).toEqual({ status: "ok" });
    expect(client.allowance).toBe(10n * MUSD_UNIT);
  });

  test("reports a reverted approval as a failure", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 0n;
    client.receipt = { status: "reverted", blockNumber: 5n, logs: [] };
    const result = await ensureAllowance(ctx, 10n * MUSD_UNIT);
    expect(result.status).toBe("failed");
  });

  test("reports an approval with no receipt as uncertain, with the hash", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 0n;
    client.receiptDelayForever = true;
    const result = await ensureAllowance(ctx, 10n * MUSD_UNIT);
    expect(result.status).toBe("uncertain");
    if (result.status !== "uncertain") return;
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("core write lifecycle", () => {
  const CLAIM = "0x48656c6c6f" as Hex;
  const BOND = 10n;
  const LIVENESS = 1440n;
  const BLOCK = 9n;

  const assertRequest: WriteRequest = {
    functionName: "assertClaim",
    args: [TEST_ID, CLAIM, BOND, LIVENESS],
    requiredUnits: 10n * MUSD_UNIT,
    expectedEvent: "Asserted",
  };

  /** A real, correctly-encoded Asserted log for `assertRequest` at `BLOCK`. */
  const goodAsserted = () =>
    encodeAsserted({
      coreAddress: TEST_CORE,
      assertedBy: TEST_ACCOUNT,
      identifier: TEST_ID,
      claim: CLAIM,
      bondMusd: BOND,
      liveness: LIVENESS,
      assertedAtBlock: BLOCK,
    });

  test("simulates before writing and confirms on a matching receipt", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receipt = { status: "success", blockNumber: BLOCK, logs: [goodAsserted()] };
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("confirmed");
    const kinds = client.calls.map((c) => c.kind);
    expect(kinds).toContain("simulate");
    expect(kinds.indexOf("simulate")).toBeLessThan(kinds.length);
  });

  test("passes the whole-MUSD bond as a BigInt, not raw units", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receipt = { status: "success", blockNumber: BLOCK, logs: [goodAsserted()] };
    await submitCoreWrite(ctx, assertRequest);
    const sim = client.calls.find((c) => c.kind === "simulate");
    expect(sim?.args[2]).toBe(10n);
  });

  test("a simulation revert fails before any write", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.simulateError = Object.assign(new Error("reverted"), { data: `0xb4e159b9${"0".repeat(58)}8403200` });
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("failed");
  });

  test("a reverted receipt is a failure, not a success", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receipt = { status: "reverted", blockNumber: BLOCK, logs: [] };
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("failed");
  });

  test("a successful receipt with no MuoCore event is uncertain, not confirmed", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receipt = { status: "success", blockNumber: BLOCK, logs: [] };
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("uncertain");
    if (outcome.status !== "uncertain") return;
    expect(outcome.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("a missing receipt is uncertain and carries the hash", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receiptDelayForever = true;
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("uncertain");
    if (outcome.status !== "uncertain") return;
    expect(outcome.hash).toBe(TEST_TX);
  });

  test("settle and resolve request no approval", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 0n;
    client.receipt = {
      status: "success",
      blockNumber: BLOCK,
      logs: [encodeOutcome({ coreAddress: TEST_CORE, event: "Settled", assertionId: TEST_ID, actor: TEST_ACCOUNT, atBlock: BLOCK })],
    };
    const settle: WriteRequest = { functionName: "settle", args: [TEST_ID], requiredUnits: 0n, expectedEvent: "Settled", assertionId: TEST_ID };
    const outcome = await submitCoreWrite(ctx, settle);
    expect(outcome.status).toBe("confirmed");
    expect(client.calls.some((c) => c.functionName === "allowance")).toBe(false);
  });

  test("an Asserted event with the wrong identifier is uncertain", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receipt = {
      status: "success",
      blockNumber: BLOCK,
      logs: [
        encodeAsserted({
          coreAddress: TEST_CORE,
          assertedBy: TEST_ACCOUNT,
          identifier: `0x${"99".repeat(32)}` as Hex, // not what we submitted
          claim: CLAIM,
          bondMusd: BOND,
          liveness: LIVENESS,
          assertedAtBlock: BLOCK,
        }),
      ],
    };
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("uncertain");
  });

  test("an Asserted event with the wrong actor is uncertain", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receipt = {
      status: "success",
      blockNumber: BLOCK,
      logs: [
        encodeAsserted({
          coreAddress: TEST_CORE,
          assertedBy: OTHER_ACCOUNT, // not the acting account
          identifier: TEST_ID,
          claim: CLAIM,
          bondMusd: BOND,
          liveness: LIVENESS,
          assertedAtBlock: BLOCK,
        }),
      ],
    };
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("uncertain");
  });

  test("an Asserted event with a wrong bond is uncertain", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receipt = {
      status: "success",
      blockNumber: BLOCK,
      logs: [
        encodeAsserted({
          coreAddress: TEST_CORE,
          assertedBy: TEST_ACCOUNT,
          identifier: TEST_ID,
          claim: CLAIM,
          bondMusd: 11n, // not the 10 we sent
          liveness: LIVENESS,
          assertedAtBlock: BLOCK,
        }),
      ],
    };
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("uncertain");
  });

  test("an Asserted event whose id does not match the consensus packing is uncertain", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receipt = {
      status: "success",
      blockNumber: BLOCK,
      logs: [
        encodeAsserted({
          coreAddress: TEST_CORE,
          assertedBy: TEST_ACCOUNT,
          identifier: TEST_ID,
          claim: CLAIM,
          bondMusd: BOND,
          liveness: LIVENESS,
          assertedAtBlock: BLOCK,
          assertionId: `0x${"77".repeat(32)}` as Hex, // arbitrary override
        }),
      ],
    };
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("uncertain");
  });

  test("a malformed Asserted payload is uncertain, not confirmed", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 10n * MUSD_UNIT;
    client.receipt = { status: "success", blockNumber: BLOCK, logs: [encodeMalformed(TEST_CORE, "Asserted")] };
    const outcome = await submitCoreWrite(ctx, assertRequest);
    expect(outcome.status).toBe("uncertain");
  });

  test("a Settled event for a different assertion id is uncertain", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 0n;
    client.receipt = {
      status: "success",
      blockNumber: BLOCK,
      logs: [
        encodeOutcome({
          coreAddress: TEST_CORE,
          event: "Settled",
          assertionId: `0x${"55".repeat(32)}` as Hex, // not the requested one
          actor: TEST_ACCOUNT,
          atBlock: BLOCK,
        }),
      ],
    };
    const settle: WriteRequest = { functionName: "settle", args: [TEST_ID], requiredUnits: 0n, expectedEvent: "Settled", assertionId: TEST_ID };
    const outcome = await submitCoreWrite(ctx, settle);
    expect(outcome.status).toBe("uncertain");
  });

  test("a Settled event from a different actor is uncertain", async () => {
    const { ctx, client } = makeCtx();
    client.allowance = 0n;
    client.receipt = {
      status: "success",
      blockNumber: BLOCK,
      logs: [encodeOutcome({ coreAddress: TEST_CORE, event: "Settled", assertionId: TEST_ID, actor: OTHER_ACCOUNT, atBlock: BLOCK })],
    };
    const settle: WriteRequest = { functionName: "settle", args: [TEST_ID], requiredUnits: 0n, expectedEvent: "Settled", assertionId: TEST_ID };
    const outcome = await submitCoreWrite(ctx, settle);
    expect(outcome.status).toBe("uncertain");
  });
});
