import { describe, expect, test } from "bun:test";

import {
  assertionEventSchema,
  assertionSchema,
  bondToUnits,
  isAddress,
  isAssertionEvent,
  isBondMusdWire,
  isChainId,
  isClaim,
  isId,
  MAX_U128,
  MUSD_UNIT,
  normalizeAddress,
  normalizeHex,
  toSafeNumber,
} from "../native";

const A = `0x${"ab".repeat(20)}` as const;
const H = `0x${"cd".repeat(32)}` as const;
const I = `0x${"ef".repeat(32)}` as const;
const provenance = { chainId: 31611, coreAddress: A, blockNumber: 20, blockHash: H, transactionHash: I, transactionIndex: 0, logIndex: 1 };
const data = { assertionId: H, identifier: I, claim: "0xff", bondMusd: "10", liveness: 1440, assertedBy: A, assertedAtBlock: 20, assertedTxId: I };
const event = { event: "asserted", data, provenance };
const row = {
  id: H,
  identifier: I,
  claim: "0xff",
  bondMusd: "10",
  liveness: 1440,
  asserter: A,
  status: "open",
  assertedAtBlock: 20,
  assertedTxId: I,
  chainId: 31611,
  coreAddress: A,
  blockNumber: 20,
  blockHash: H,
  transactionIndex: 0,
  logIndex: 1,
};
describe("native wire quantities", () => {
  test.each(["10", "10000", "9007199254740993", MAX_U128.toString()])("accepts exact whole-MUSD string %s", (v) => expect(isBondMusdWire(v)).toBe(true));
  test.each(["0", "9", "010", "10.5", "-10", "+10", " 10", "1e3", "", (MAX_U128 + 1n).toString(), "9".repeat(1000), 10, null])("rejects invalid bond %j", (v) =>
    expect(isBondMusdWire(v)).toBe(false)
  );
  test("scales once without Number conversion", () => {
    expect(bondToUnits("10")).toBe(10n * MUSD_UNIT);
    expect(bondToUnits(9007199254740993n)).toBe(9007199254740993n * MUSD_UNIT);
    expect(() => bondToUnits("9")).toThrow();
    expect(() => bondToUnits("010")).toThrow();
  });
  test("safe numbers are for bounded metadata only", () => {
    expect(toSafeNumber(20n)).toBe(20);
    expect(() => toSafeNumber(-1n)).toThrow();
    expect(() => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow();
  });
});
describe("native canonical hexadecimal data", () => {
  test("requires exact prefixed hash/address forms", () => {
    expect(isId(H)).toBe(true);
    expect(isId(H.slice(2))).toBe(false);
    expect(isId(`0x${H}`)).toBe(false);
    expect(isId(H.toUpperCase())).toBe(false);
    expect(isAddress(A)).toBe(true);
    expect(isAddress("ST1.muo-core")).toBe(false);
    expect(normalizeAddress(A.toUpperCase().replace("0X", "0x"))).toBe(A);
    expect(normalizeHex("0xAAbb")).toBe("0xaabb");
    expect(() => normalizeHex("aa")).toThrow();
    expect(() => normalizeHex("0xa")).toThrow();
    expect(() => normalizeAddress("0x123")).toThrow();
  });
  test("keeps arbitrary claim bytes with a strict byte limit", () => {
    expect(isClaim("0xff")).toBe(true);
    expect(isClaim(`0x${"aa".repeat(2048)}`)).toBe(true);
    expect(isClaim(`0x${"aa".repeat(2049)}`)).toBe(false);
    expect(isClaim("0x")).toBe(false);
    expect(isClaim("0xa")).toBe(false);
    expect(isClaim("0xgg")).toBe(false);
  });
  test("only recognizes Mezo chain ids", () => {
    expect([31611, 31612, 1, "31611", null].map(isChainId)).toEqual([true, true, false, false, false]);
  });
});
describe("native row and event schemas", () => {
  test("validates the v2 row without legacy coercion", () => {
    expect(assertionSchema.safeParse(row).success).toBe(true);
    expect(assertionSchema.safeParse({ ...row, bondMusd: 10 }).success).toBe(false);
    expect(assertionSchema.safeParse({ ...row, bondSats: 10000 }).success).toBe(false);
    expect(assertionSchema.safeParse({ ...row, status: "SETTLED" }).success).toBe(false);
    expect(assertionSchema.safeParse({ ...row, liveness: 0 }).success).toBe(false);
    expect(assertionSchema.safeParse({ ...row, liveness: 52561 }).success).toBe(false);
    expect(assertionSchema.safeParse({ ...row, assertedTxId: "0x12" }).success).toBe(false);
  });
  test("validates all five event shapes", () => {
    expect(isAssertionEvent(event)).toBe(true);
    for (const kind of ["disputed", "settled", "rejected", "unresolved"]) {
      const e = { event: kind, data: { assertionId: H, [`${kind}By`]: A, [`${kind}AtBlock`]: 20, [`${kind}TxId`]: I }, provenance };
      expect(isAssertionEvent(e)).toBe(true);
    }
  });
  test("rejects extra writable fields and prototype-shaped objects", () => {
    expect(isAssertionEvent(Object.create(event))).toBe(false);
    expect(isAssertionEvent({ ...event, data: Object.create(data) })).toBe(false);
    expect(isAssertionEvent({ ...event, provenance: Object.create(provenance) })).toBe(false);
    expect(assertionEventSchema.safeParse({ ...event, data: { ...data, status: "settled" } }).success).toBe(false);
    expect(assertionEventSchema.safeParse({ ...event, data: { ...data, id: I } }).success).toBe(false);
  });
});
