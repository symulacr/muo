import { describe, expect, test } from "bun:test";

import { MAX_U128, MIN_BOND_MUSD } from "@muo/core/native";

import { assertSchema, validateBondMusd } from "@/components/verify/assert-dialog";
import { disputeWindow } from "@/components/verify/assertion-card";
import { blocksToHuman, getTransactionExplorerUrl, truncate, with0x } from "@/lib/utils";
import { makeAssertion } from "@/test-support/fixtures";

const row = makeAssertion;
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x9999999999999999999999999999999999999999";

describe("bond form validation", () => {
  test("accepts the 10 MUSD minimum", () => {
    expect(validateBondMusd("10")).toBeNull();
    expect(validateBondMusd(String(MIN_BOND_MUSD))).toBeNull();
  });

  test("rejects below the minimum", () => {
    expect(validateBondMusd("9")).toMatch(/minimum/i);
    expect(validateBondMusd("0")).toMatch(/minimum/i);
  });

  test("rejects floats, signs, exponents, and padded zeros", () => {
    for (const bad of ["10.5", "-10", "+10", "1e3", "010", " 10", "10 "]) {
      if (bad === " 10" || bad === "10 ") {
        // Surrounding whitespace is trimmed before validation by design.
        expect(validateBondMusd(bad)).toBeNull();
        continue;
      }
      expect(validateBondMusd(bad)).not.toBeNull();
    }
  });

  test("rejects an empty bond", () => {
    expect(validateBondMusd("")).toMatch(/enter a bond/i);
  });

  test("accepts uint128 max and rejects one above it", () => {
    expect(validateBondMusd(MAX_U128.toString())).toBeNull();
    expect(validateBondMusd((MAX_U128 + 1n).toString())).toMatch(/cannot exceed/i);
  });

  test("accepts values beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(validateBondMusd("9007199254740993")).toBeNull();
    expect(validateBondMusd("9007199254740993")).toBeNull();
  });

  test("schema rejects a sub-minimum bond", () => {
    expect(assertSchema.safeParse({ claim: "ok", bondMusd: "9", liveness: 1 }).success).toBe(false);
  });

  test("schema accepts a valid bond and an empty liveness (protocol default)", () => {
    expect(assertSchema.safeParse({ claim: "ok", bondMusd: "10", liveness: "" }).success).toBe(true);
  });

  test("schema enforces the claim byte limit", () => {
    expect(assertSchema.safeParse({ claim: "a".repeat(2048), bondMusd: "10", liveness: "1" }).success).toBe(true);
    expect(assertSchema.safeParse({ claim: "a".repeat(2049), bondMusd: "10", liveness: "1" }).success).toBe(false);
    expect(assertSchema.safeParse({ claim: "   ", bondMusd: "10", liveness: "1" }).success).toBe(false);
  });

  test("schema enforces the liveness range", () => {
    expect(assertSchema.safeParse({ claim: "ok", bondMusd: "10", liveness: "1" }).success).toBe(true);
    expect(assertSchema.safeParse({ claim: "ok", bondMusd: "10", liveness: "52560" }).success).toBe(true);
    expect(assertSchema.safeParse({ claim: "ok", bondMusd: "10", liveness: "0" }).success).toBe(false);
    expect(assertSchema.safeParse({ claim: "ok", bondMusd: "10", liveness: "52561" }).success).toBe(false);
  });

  test("schema accepts typed text, which is what the form control actually emits", () => {
    // Regression: the field renders through a text input, so a numeric schema made it permanently invalid.
    for (const typed of ["1440", " 1440 ", "1"]) {
      const parsed = assertSchema.safeParse({ claim: "ok", bondMusd: "10", liveness: typed });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(typeof parsed.data.liveness).toBe("string");
    }
    for (const bad of ["1.5", "-1", "1e3", "blocks"]) {
      expect(assertSchema.safeParse({ claim: "ok", bondMusd: "10", liveness: bad }).success).toBe(false);
    }
  });
});

describe("dispute window boundaries", () => {
  const base = row({ status: "open", assertedAtBlock: 100, liveness: 10, asserter: ME });

  test("window is open at exactly the expiry block (>= 0 blocks left)", () => {
    // assertedAtBlock 100 + liveness 10 = expiry 110; at block 110 the window is still open.
    const w = disputeWindow(base, 110, OTHER);
    expect(w.blocksLeft).toBe(0);
    expect(w.canSettle).toBe(false);
    expect(w.canDispute).toBe(true);
  });

  test("window closes one block past expiry", () => {
    const w = disputeWindow(base, 111, OTHER);
    expect(w.blocksLeft).toBe(-1);
    expect(w.canSettle).toBe(true);
    expect(w.canDispute).toBe(false);
  });

  test("never claims either action without a block height", () => {
    const w = disputeWindow(base, null, OTHER);
    expect(w.canDispute).toBe(false);
    expect(w.canSettle).toBe(false);
  });

  test("a disconnected account cannot dispute", () => {
    expect(disputeWindow(base, 105, null).canDispute).toBe(false);
  });

  test("the asserter cannot dispute their own assertion", () => {
    expect(disputeWindow(base, 105, ME).canDispute).toBe(false);
    expect(disputeWindow(base, 105, ME.toUpperCase().replace("0X", "0x")).canDispute).toBe(false);
  });

  test("a different account can dispute inside the window", () => {
    expect(disputeWindow(base, 105, OTHER).canDispute).toBe(true);
  });

  test("a settled assertion offers neither action", () => {
    const w = disputeWindow(row({ status: "settled", assertedAtBlock: 100, liveness: 10, asserter: ME }), 200, OTHER);
    expect(w.canDispute).toBe(false);
    expect(w.canSettle).toBe(false);
  });
});

describe("explorer urls", () => {
  test("builds a Mezo tx url and normalizes the hash", () => {
    const hash = `0x${"AB".repeat(32)}`;
    const url = getTransactionExplorerUrl(hash);
    expect(url).toContain("/tx/0x");
    expect(url).toContain("ab".repeat(32));
  });

  test("rejects a non-32-byte hash", () => {
    expect(() => getTransactionExplorerUrl("0x1234")).toThrow();
  });

  test("with0x normalizes exactly one prefix", () => {
    expect(with0x("abc")).toBe("0xabc");
    expect(with0x("0xabc")).toBe("0xabc");
    expect(with0x("0Xabc")).toBe("0xabc");
  });

  test("truncate keeps head and tail", () => {
    expect(truncate("abcdefghij", 3, 3)).toBe("abc...hij");
    expect(truncate("abc", 8, 6)).toBe("abc");
  });
});

describe("block time formatting", () => {
  test("picks units from elapsed seconds", () => {
    expect([1, 12, 100, 720, 1440].map((b) => blocksToHuman(b))).toEqual(["~5s", "~1m", "~8m", "~1h", "~2h"]);
  });

  test("treats zero, negative, and non-finite as zero", () => {
    expect([0, -10, Number.NaN, Number.POSITIVE_INFINITY].map((b) => blocksToHuman(b))).toEqual(Array(4).fill("~0s"));
  });
});
