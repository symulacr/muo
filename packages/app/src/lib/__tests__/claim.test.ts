import { describe, expect, test } from "bun:test";

import { MAX_CLAIM_BYTES } from "@muo/core/native";

import { claimFromHex, claimToHex, identifierForClaim, utf8Length } from "@/lib/claim";

describe("claim encoding", () => {
  test("encodes ASCII to canonical lowercase hex", () => {
    expect(claimToHex("BTC >= 100k")).toBe(`0x${Buffer.from("BTC >= 100k").toString("hex")}`);
  });

  test("round-trips multi-byte UTF-8", () => {
    for (const text of ["éüñß", "中文日本語", "₿🚀🔥", "aé₿🚀z"]) {
      expect(claimFromHex(claimToHex(text))).toBe(text);
    }
  });

  test("measures UTF-8 bytes, not code units", () => {
    expect(utf8Length("🚀")).toBe(4);
    expect(utf8Length("a")).toBe(1);
    expect(utf8Length("")).toBe(0);
  });

  test("rejects an empty claim", () => {
    expect(() => claimToHex("")).toThrow();
  });

  test("accepts exactly 2048 bytes and rejects 2049", () => {
    const ok = "a".repeat(MAX_CLAIM_BYTES);
    expect(() => claimToHex(ok)).not.toThrow();
    expect(utf8Length(ok)).toBe(MAX_CLAIM_BYTES);
    expect(() => claimToHex(`${ok}a`)).toThrow();
  });

  test("counts multi-byte characters against the byte limit", () => {
    expect(() => claimToHex("🚀".repeat(512))).not.toThrow();
    expect(() => claimToHex("🚀".repeat(513))).toThrow();
  });

  test("identifier is deterministic SHA-256 of the claim bytes", () => {
    const id = identifierForClaim("BTC >= 100k");
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(identifierForClaim("BTC >= 100k")).toBe(id);
    expect(identifierForClaim("ETH >= 10k")).not.toBe(id);
  });

  test("identifier matches a known SHA-256 vector", () => {
    // sha256("") and sha256("abc") are stable references for the claim hasher.
    expect(identifierForClaim("abc")).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("identifier is SHA-256, not keccak256", () => {
    // keccak256("abc") begins 0x4e03657a; SHA-256 does not. Guards the packed protocol.
    expect(identifierForClaim("abc").startsWith("0x4e03657a")).toBe(false);
  });

  test("decodes invalid UTF-8 without throwing", () => {
    expect(() => claimFromHex("0xff")).not.toThrow();
  });
});
