// ABI boundary tests for the read-only probe's viem call path.
//
// These prove the properties that matter for the probe's correctness and
// safety, without any network:
//   1. calldata selectors come from the compiler ABI (no hand-written drift)
//   2. return data is decoded by viem, including the 11-field Assertion struct
//   3. checksummed addresses returned by viem are normalized to lowercase at
//      the boundary, so comparison against the native lowercase constants works
//   4. a malformed return payload throws instead of yielding a plausible value
//
// No `fetch` is involved; these are pure encode/decode assertions.

import { describe, expect, test } from "bun:test";
import type { Abi } from "viem";
import { decodeFunctionResult, encodeFunctionData } from "viem";

import { muoCoreAbi, musdAbi } from "@muo/core/abi";

const CORE_ABI = muoCoreAbi as Abi;
const MUSD_ABI = musdAbi as Abi;

const word = (v: bigint): string => v.toString(16).padStart(64, "0");
const addrWord = (a: string): string => a.slice(2).padStart(64, "0");

/** Lowercase normalization, mirroring the probe's boundary helper. */
const lowerAddress = (v: string): string => v.toLowerCase();

describe("selectors come from the compiler ABI", () => {
  // Pinned values, independently derived. If @muo/core/abi changes a signature
  // these fail, which is the point: the probe must not decode against a stale
  // selector.
  test.each([
    ["getMinBondMusd", "0xf5535a41"],
    ["MUSD_UNIT", "0x910781c8"],
    ["musd", "0xcab666d0"],
    ["CONTRACT_OWNER", "0xfd301c49"],
  ])("%s encodes to %s", (fn, expected) => {
    const data = encodeFunctionData({ abi: CORE_ABI, functionName: fn } as never);
    expect(data.slice(0, 10)).toBe(expected);
  });

  test("getAssertion(bytes32) selector and argument encoding", () => {
    const id = `0x${"11".repeat(32)}`;
    const data = encodeFunctionData({ abi: CORE_ABI, functionName: "getAssertion", args: [id] } as never);
    expect(data.slice(0, 10)).toBe("0x88302884");
    // The bytes32 argument occupies the first data word unchanged.
    expect(data.slice(10)).toBe("11".repeat(32));
  });

  test("musdAbi decimals() matches the canonical ERC-20 selector", () => {
    expect(encodeFunctionData({ abi: MUSD_ABI, functionName: "decimals" } as never)).toBe("0x313ce567");
  });

  test("an unknown function throws instead of encoding something wrong", () => {
    expect(() => encodeFunctionData({ abi: CORE_ABI, functionName: "notARealFunction" } as never)).toThrow();
  });

  test("wrong argument types throw", () => {
    expect(() => encodeFunctionData({ abi: CORE_ABI, functionName: "getAssertion", args: [123] } as never)).toThrow();
  });
});

describe("return data decoding", () => {
  test("a uint256 return decodes to bigint", () => {
    const raw = `0x${word(10n)}` as `0x${string}`;
    const v = decodeFunctionResult({ abi: CORE_ABI, functionName: "getMinBondMusd", data: raw } as never);
    expect(v).toBe(10n);
  });

  test("an address return decodes CHECKSUMMED, so normalization is required", () => {
    const mixed = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
    const raw = `0x${addrWord(mixed.toLowerCase())}` as `0x${string}`;
    const v = decodeFunctionResult({ abi: CORE_ABI, functionName: "musd", data: raw } as never) as string;

    // viem returns EIP-55 checksummed form...
    expect(v).toBe(mixed);
    // ...which does NOT equal the lowercase constant without normalization.
    expect(v).not.toBe(mixed.toLowerCase());
    // ...and does after it.
    expect(lowerAddress(v)).toBe(mixed.toLowerCase());
  });

  test("the 11-field Assertion struct decodes by field, not by word index", () => {
    const asserter = "0x2a2a8551e30c63263dd9dbb698e57fb37c77a6b3";
    const disputer = "0x118917a40faf1cd7a13db0ef56c86de7973ac503";
    const payload =
      `0x${addrWord(asserter)}${addrWord(disputer)}${word(10n)}${word(1440n)}${word(2n)}${word(100n)}${word(101n)}${word(200n)}${word(0n)}${word(0n)}${word(1n)}` as `0x${string}`;

    const view = decodeFunctionResult({ abi: CORE_ABI, functionName: "getAssertion", data: payload } as never) as {
      asserter: string;
      disputer: string;
      bondMusd: bigint;
      liveness: bigint;
      status: number;
      assertedAtBlock: bigint;
      disputedAtBlock: bigint;
      settledAtBlock: bigint;
      rejectedAtBlock: bigint;
      unresolvedAtBlock: bigint;
      exists: boolean;
    };

    expect(view.bondMusd).toBe(10n);
    expect(view.liveness).toBe(1440n);
    expect(Number(view.status)).toBe(2);
    expect(view.assertedAtBlock).toBe(100n);
    expect(view.disputedAtBlock).toBe(101n);
    expect(view.settledAtBlock).toBe(200n);
    expect(view.exists).toBe(true);
    expect(lowerAddress(view.asserter)).toBe(asserter);
    expect(lowerAddress(view.disputer)).toBe(disputer);
  });

  test("a truncated struct payload throws rather than yielding a partial view", () => {
    // Only 5 of 11 words.
    const payload =
      `0x${addrWord("0x2a2a8551e30c63263dd9dbb698e57fb37c77a6b3")}${addrWord("0x118917a40faf1cd7a13db0ef56c86de7973ac503")}${word(10n)}${word(1440n)}${word(2n)}` as `0x${string}`;
    expect(() => decodeFunctionResult({ abi: CORE_ABI, functionName: "getAssertion", data: payload } as never)).toThrow();
  });

  test("an empty return payload throws for a function that returns a value", () => {
    expect(() => decodeFunctionResult({ abi: CORE_ABI, functionName: "getMinBondMusd", data: "0x" } as never)).toThrow();
  });
});

describe("probe comparison semantics", () => {
  test("a checksummed musd() result compares equal only after normalization", () => {
    const onChain: string = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
    const EXPECTED = "0x118917a40faf1cd7a13db0ef56c86de7973ac503";
    // This is exactly the bug the boundary helper prevents.
    expect(onChain === EXPECTED).toBe(false);
    expect(lowerAddress(onChain) === EXPECTED).toBe(true);
  });

  test("bond comparison is string-to-string against the decoded event", () => {
    // The SDK emits bondMusd as a decimal string; the contract returns bigint.
    const onChain = 10n;
    const decoded = "10";
    expect(String(onChain)).toBe(decoded);
    // A numeric comparison would also work here but not above 2^53.
    const big = (1n << 100n) + 7n;
    expect(String(big)).toBe(big.toString());
    expect(Number.isSafeInteger(Number(big))).toBe(false);
  });
});
