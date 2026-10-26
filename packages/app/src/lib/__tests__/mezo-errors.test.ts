import { describe, expect, test } from "bun:test";
import { keccak256, toHex } from "viem";

import { decodeMuoError, describeError, MUO_ERROR_MESSAGES, readTxHash } from "@/lib/mezo-errors";

const MUO_SELECTOR = keccak256(toHex("MuoError(uint256)")).slice(0, 10);

/** Builds an ABI-encoded MuoError(uint256) revert payload. */
const encodeMuoError = (code: bigint): string => `${MUO_SELECTOR}${code.toString(16).padStart(64, "0")}`;

/** Builds an ABI-encoded Error(string) revert payload. */
const encodeErrorString = (text: string): string => {
  const body = Buffer.from(text, "utf8").toString("hex");
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
  return `0x08c379a0${(32).toString(16).padStart(64, "0")}${(body.length / 2).toString(16).padStart(64, "0")}${padded}`;
};

describe("MuoError decoding", () => {
  test("the selector matches the compiled ABI", () => {
    expect(MUO_SELECTOR).toBe("0xb4e159b9");
  });

  test("decodes a bond-too-low revert to the 10 MUSD message", () => {
    const decoded = decodeMuoError({ data: encodeMuoError(8400100n) });
    expect(decoded?.code).toBe(8400100);
    expect(decoded?.message).toBe("The bond is below the 10 MUSD minimum.");
  });

  test("decodes every documented code", () => {
    for (const [code, message] of Object.entries(MUO_ERROR_MESSAGES)) {
      const decoded = decodeMuoError({ data: encodeMuoError(BigInt(code)) });
      expect(decoded?.code).toBe(Number(code));
      expect(decoded?.message).toBe(message);
    }
  });

  test("decodes the arbiter error from a nested viem-style cause chain", () => {
    const nested = { cause: { cause: { data: encodeMuoError(8403200n) } } };
    expect(decodeMuoError(nested)?.message).toBe("Only an arbiter can run this function.");
  });

  test("decodes an unknown code with a generic message that keeps the number", () => {
    const decoded = decodeMuoError({ data: encodeMuoError(8409999n) });
    expect(decoded?.code).toBe(8409999);
    expect(decoded?.message).toContain("8409999");
  });

  test("decodes Error(string) reverts", () => {
    const decoded = decodeMuoError({ data: encodeErrorString("insufficient allowance") });
    expect(decoded?.message).toBe("insufficient allowance");
  });

  test("returns undefined for non-revert payloads", () => {
    expect(decodeMuoError({ data: "0xdeadbeef" })).toBeUndefined();
    expect(decodeMuoError(new Error("network down"))).toBeUndefined();
    expect(decodeMuoError(null)).toBeUndefined();
    expect(decodeMuoError(undefined)).toBeUndefined();
  });

  test("never claims a Clarity u-prefix code", () => {
    const decoded = decodeMuoError({ data: encodeMuoError(8403200n) });
    expect(decoded?.message.startsWith("u")).toBe(false);
    expect(decodeMuoError(new Error("(err u8400001)").message)).toBeUndefined();
  });
});

describe("transaction hash extraction", () => {
  test("accepts a bare 32-byte hash and normalizes case", () => {
    const hash = `0x${"AB".repeat(32)}`;
    expect(readTxHash(hash)).toBe(`0x${"ab".repeat(32)}`);
  });

  test("accepts an object with a hash field", () => {
    expect(readTxHash({ hash: `0x${"cd".repeat(32)}` })).toBe(`0x${"cd".repeat(32)}`);
  });

  test("rejects short, long, and missing hashes", () => {
    expect(readTxHash(`0x${"ab".repeat(31)}`)).toBeUndefined();
    expect(readTxHash(`0x${"ab".repeat(33)}`)).toBeUndefined();
    expect(readTxHash({})).toBeUndefined();
    expect(readTxHash(undefined)).toBeUndefined();
    expect(readTxHash("")).toBeUndefined();
  });
});

describe("error description", () => {
  test("prefers a decoded MuoError over the raw message", () => {
    const error = { data: encodeMuoError(8403400n), shortMessage: "execution reverted" };
    expect(describeError(error)).toBe("You cannot dispute your own assertion.");
  });

  test("falls back to shortMessage, then message", () => {
    expect(describeError({ shortMessage: "execution reverted" })).toBe("execution reverted");
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  test("never returns an empty string", () => {
    expect(describeError({})).toBe("The transaction could not be completed.");
    expect(describeError(new Error(""))).toBe("The transaction could not be completed.");
  });

  test("truncates an excessively long message", () => {
    const long = "x".repeat(1000);
    expect(describeError(new Error(long)).length).toBeLessThanOrEqual(240);
  });
});
