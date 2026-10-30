// Direct unit tests for the strict receipt-confirmation decoder.
//
// `confirmReceiptEvent` is the function that decides whether a mined receipt
// actually describes the operation the user performed. These tests call it with
// real ABI-encoded logs so every field check is exercised in isolation.

import { describe, expect, test } from "bun:test";

import type { Hex } from "@muo/core/native";

import type { WriteRequest } from "@/lib/mezo-tx";
import { confirmReceiptEvent } from "@/lib/mezo-tx";
import { encodeAsserted, encodeMalformed, encodeOutcome, topic0 } from "@/test-support/event-fixtures";
import { OTHER_ACCOUNT, TEST_ACCOUNT, TEST_CORE, TEST_ID } from "@/test-support/fake-provider";

const CLAIM = "0x48656c6c6f" as Hex;
const BOND = 10n;
const LIVENESS = 1440n;
const BLOCK = 500n;
const OTHER_ID = `0x${"55".repeat(32)}` as Hex;

const ctx = { coreAddress: TEST_CORE, expectedAccount: TEST_ACCOUNT };

const assertRequest: WriteRequest = {
  functionName: "assertClaim",
  args: [TEST_ID, CLAIM, BOND, LIVENESS],
  requiredUnits: 10n * 10n ** 18n,
  expectedEvent: "Asserted",
};

const goodAsserted = (overrides: Partial<Parameters<typeof encodeAsserted>[0]> = {}) =>
  encodeAsserted({
    coreAddress: TEST_CORE,
    assertedBy: TEST_ACCOUNT,
    identifier: TEST_ID,
    claim: CLAIM,
    bondMusd: BOND,
    liveness: LIVENESS,
    assertedAtBlock: BLOCK,
    ...overrides,
  });

const receipt = (logs: ReturnType<typeof encodeAsserted>[]) => ({ blockNumber: BLOCK, logs });

describe("confirmReceiptEvent: Asserted", () => {
  test("accepts a fully matching Asserted log", () => {
    expect(confirmReceiptEvent(assertRequest, receipt([goodAsserted()]), ctx)).toBeNull();
  });

  test("rejects the wrong identifier", () => {
    const reason = confirmReceiptEvent(assertRequest, receipt([goodAsserted({ identifier: `0x${"99".repeat(32)}` as Hex })]), ctx);
    expect(reason).toContain("did not match");
  });

  test("rejects the wrong claim", () => {
    const reason = confirmReceiptEvent(assertRequest, receipt([goodAsserted({ claim: "0xdeadbeef" as Hex })]), ctx);
    expect(reason).toContain("did not match");
  });

  test("rejects the wrong bond", () => {
    const reason = confirmReceiptEvent(assertRequest, receipt([goodAsserted({ bondMusd: 11n })]), ctx);
    expect(reason).toContain("did not match");
  });

  test("rejects the wrong liveness", () => {
    const reason = confirmReceiptEvent(assertRequest, receipt([goodAsserted({ liveness: 1441n })]), ctx);
    expect(reason).toContain("did not match");
  });

  test("rejects the wrong actor", () => {
    const reason = confirmReceiptEvent(assertRequest, receipt([goodAsserted({ assertedBy: OTHER_ACCOUNT })]), ctx);
    expect(reason).toContain("did not match");
  });

  test("rejects an assertionId that does not match the consensus packing", () => {
    const reason = confirmReceiptEvent(assertRequest, receipt([goodAsserted({ assertionId: OTHER_ID })]), ctx);
    expect(reason).toContain("did not match");
  });

  test("rejects an event whose assertedAtBlock is not the receipt block", () => {
    // The id is derived from the event's own block, so this is self-consistent
    // but does not match the receipt's block number.
    const reason = confirmReceiptEvent(assertRequest, receipt([goodAsserted({ assertedAtBlock: BLOCK + 1n })]), ctx);
    expect(reason).toContain("did not match");
  });

  test("accepts liveness 0 because the contract resolves it to DEFAULT_LIVENESS", () => {
    const zeroLiveness: WriteRequest = { ...assertRequest, args: [TEST_ID, CLAIM, BOND, 0n] };
    const log = goodAsserted({ liveness: 1440n }); // DEFAULT_LIVENESS
    expect(confirmReceiptEvent(zeroLiveness, receipt([log]), ctx)).toBeNull();
  });

  test("rejects a malformed payload with the right topic0", () => {
    const reason = confirmReceiptEvent(assertRequest, receipt([encodeMalformed(TEST_CORE, "Asserted")]), ctx);
    expect(reason).not.toBeNull();
  });

  test("rejects a log from a different contract address", () => {
    const log = { ...goodAsserted(), address: "0x9999999999999999999999999999999999999999" };
    const reason = confirmReceiptEvent(assertRequest, receipt([log]), ctx);
    expect(reason).toContain("emitted no");
  });

  test("rejects when there are no logs at all", () => {
    expect(confirmReceiptEvent(assertRequest, receipt([]), ctx)).toContain("emitted no");
  });
});

describe("confirmReceiptEvent: outcome events", () => {
  const settle: WriteRequest = {
    functionName: "settle",
    args: [TEST_ID],
    requiredUnits: 0n,
    expectedEvent: "Settled",
    assertionId: TEST_ID,
  };

  const settled = (overrides: Partial<Parameters<typeof encodeOutcome>[0]> = {}) =>
    encodeOutcome({ coreAddress: TEST_CORE, event: "Settled", assertionId: TEST_ID, actor: TEST_ACCOUNT, atBlock: BLOCK, ...overrides });

  test("accepts a matching Settled log", () => {
    expect(confirmReceiptEvent(settle, receipt([settled()]), ctx)).toBeNull();
  });

  test("rejects the wrong assertion id", () => {
    expect(confirmReceiptEvent(settle, receipt([settled({ assertionId: OTHER_ID })]), ctx)).toContain("did not match");
  });

  test("rejects the wrong actor", () => {
    expect(confirmReceiptEvent(settle, receipt([settled({ actor: OTHER_ACCOUNT })]), ctx)).toContain("did not match");
  });

  test("rejects a block mismatch", () => {
    expect(confirmReceiptEvent(settle, receipt([settled({ atBlock: BLOCK + 1n })]), ctx)).toContain("did not match");
  });

  test("rejects a Disputed log when Settled was expected", () => {
    const disputed = encodeOutcome({ coreAddress: TEST_CORE, event: "Disputed", assertionId: TEST_ID, actor: TEST_ACCOUNT, atBlock: BLOCK });
    expect(confirmReceiptEvent(settle, receipt([disputed]), ctx)).toContain("emitted no");
  });

  test("accepts Rejected and Unresolved for their own requests", () => {
    for (const event of ["Rejected", "Unresolved"] as const) {
      const req: WriteRequest = {
        functionName: "resolve",
        args: [TEST_ID, event === "Rejected" ? 3 : 4],
        requiredUnits: 0n,
        expectedEvent: event,
        assertionId: TEST_ID,
      };
      const log = encodeOutcome({ coreAddress: TEST_CORE, event, assertionId: TEST_ID, actor: TEST_ACCOUNT, atBlock: BLOCK });
      expect(confirmReceiptEvent(req, receipt([log]), ctx)).toBeNull();
    }
  });
});

describe("topic derivation", () => {
  test("topic0 is stable and lowercase", () => {
    expect(topic0("Asserted")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(topic0("Asserted")).toBe(topic0("Asserted"));
  });

  test("each event has a distinct topic0", () => {
    const topics = ["Asserted", "Disputed", "Settled", "Rejected", "Unresolved"].map(topic0);
    expect(new Set(topics).size).toBe(5);
  });
});
