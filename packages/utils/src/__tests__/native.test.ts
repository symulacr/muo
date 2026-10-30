import { describe, expect, test } from "bun:test";

import type { Hex } from "@muo/core/native";
import { MAX_U128 } from "@muo/core/native";

import {
  bytesToHex,
  claimIdentifier,
  computeAssertionId,
  decodeHex,
  formatBondMusd,
  formatBtcBalance,
  formatMusdBalance,
  formatRawUnits,
  putU128,
} from "../native";

const ID = `0x${"bb".repeat(32)}` as Hex;
const CLAIM = `0x${"cc".repeat(64)}` as Hex;
const GOLDEN = "0xc7ad84cdbc859160151cf23a7cfe5aaf67115a58447971c926292aab113741b5";
describe("native consensus assertion ID", () => {
  test("preserves the exact legacy SHA-256 bytes", () => {
    expect(computeAssertionId(ID, CLAIM, 10000n, 1440n, 900000n)).toBe(GOLDEN);
    expect(computeAssertionId(ID, CLAIM, 10000n, 1440n, 900000n)).toBe(GOLDEN);
  });
  test("each consensus field changes the digest", () => {
    const hashes = [
      computeAssertionId(ID, CLAIM, 10000n, 1440n, 900000n),
      computeAssertionId(`0x${"aa".repeat(32)}`, CLAIM, 10000n, 1440n, 900000n),
      computeAssertionId(ID, "0xff", 10000n, 1440n, 900000n),
      computeAssertionId(ID, CLAIM, 10001n, 1440n, 900000n),
      computeAssertionId(ID, CLAIM, 10000n, 1441n, 900000n),
      computeAssertionId(ID, CLAIM, 10000n, 1440n, 900001n),
    ];
    expect(new Set(hashes).size).toBe(6);
  });
  test("enforces the claim byte boundary", () => {
    expect(computeAssertionId(ID, `0x${"aa".repeat(2048)}`, 10n, 1n, 1n)).toMatch(/^0x[0-9a-f]{64}$/);
    for (const claim of ["0x", "0xa", "0xgg", `0x${"aa".repeat(2049)}`]) expect(() => computeAssertionId(ID, claim as Hex, 10n, 1n, 1n)).toThrow();
    expect(() => computeAssertionId("0xaa", CLAIM, 10n, 1n, 1n)).toThrow();
  });
  test("uses uint128 tags and big-endian encoding", () => {
    const out = new Uint8Array(17);
    expect(putU128(258n, 0, out)).toBe(17);
    expect(bytesToHex(out)).toBe(`0x01${"00".repeat(14)}0102`);
    expect(() => putU128(1n, 0, new Uint8Array(16))).toThrow();
    expect(() => putU128(1n, -1, out)).toThrow();
    expect(() => putU128(1n, 0.5, out)).toThrow();
    expect(() => putU128(-1n, 0, out)).toThrow();
    expect(() => putU128(MAX_U128 + 1n, 0, out)).toThrow();
    expect(putU128(MAX_U128, 0, out)).toBe(17);
  });
  test("bounds hex decoding and never shares a global scratch buffer", () => {
    expect(decodeHex("0xaabb", 0, new Uint8Array(2))).toBe(2);
    expect(() => decodeHex("0xaabb", 0, new Uint8Array(1))).toThrow();
    expect(() => decodeHex("aabb", 0, new Uint8Array(2))).toThrow();
    expect(() => decodeHex("0xaa", -1, new Uint8Array(2))).toThrow();
    computeAssertionId(ID, `0x${"aa".repeat(2048)}`, 10n, 1n, 1n);
    expect(computeAssertionId(ID, CLAIM, 10000n, 1440n, 900000n)).toBe(GOLDEN);
  });
  test("claim identifier remains SHA-256 of the actual bytes", () => {
    expect(claimIdentifier(new TextEncoder().encode("abc"))).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
describe("exact native monetary formatting", () => {
  test("distinguishes whole bonds from 18-decimal balances", () => {
    expect(formatBondMusd("10")).toBe("10");
    expect(formatMusdBalance(10n * 10n ** 18n)).toBe("10");
    expect(formatMusdBalance(1n)).toBe("0.000000000000000001");
    expect(formatBtcBalance(1n)).toBe("0.000000000000000001");
    expect(formatMusdBalance(0n)).toBe("0");
    expect(formatMusdBalance(null)).toBeUndefined();
    expect(formatBtcBalance(undefined)).toBeUndefined();
  });
  test("keeps values beyond Number's precision", () => {
    expect(formatRawUnits(9007199254740993n, 0)).toBe("9007199254740993");
    expect(formatBondMusd(MAX_U128)).toBe(MAX_U128.toString());
    expect(() => formatBondMusd("010")).toThrow();
    expect(() => formatBondMusd("9".repeat(1000))).toThrow();
    expect(() => formatRawUnits(-1n)).toThrow();
    expect(() => formatRawUnits(1n, 37)).toThrow();
  });
});
