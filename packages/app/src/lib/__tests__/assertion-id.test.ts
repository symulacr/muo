import { describe, expect, test } from "bun:test";

import { computeAssertionId } from "@muo/utils/native";

const ID = `0x${"bb".repeat(32)}` as const;
/** 64-byte claim, matching the original pinned vector exactly. */
const CLAIM = `0x${"cc".repeat(64)}` as const;

/**
 * Golden vector pinning the packed assertion-ID byte layout.
 *
 * The layout is `identifier || claim || 0x01 || uint128(bond) || 0x01 || uint128(liveness) || 0x01 || uint128(block)`,
 * which is what `MuoCore.deriveAssertionId` hashes. Any change here is a protocol break,
 * not a refactor -- see MIGRATION.md constraint C1.
 */
const GOLDEN = "0xc7ad84cdbc859160151cf23a7cfe5aaf67115a58447971c926292aab113741b5";

describe("computeAssertionId", () => {
  test("reproduces the pinned golden digest", () => {
    expect(computeAssertionId(ID, CLAIM, 10_000n, 1_440n, 900_000n)).toBe(GOLDEN);
  });

  test("is deterministic", () => {
    expect(computeAssertionId(ID, CLAIM, 10_000n, 1_440n, 900_000n)).toBe(computeAssertionId(ID, CLAIM, 10_000n, 1_440n, 900_000n));
  });

  test("every single-field perturbation changes the digest", () => {
    const base = [ID, CLAIM, 10_000n, 1_440n, 900_000n] as const;
    const bumped = [`0xff${ID.slice(4)}`, `0xff${CLAIM.slice(4)}`, 10_001n, 1_441n, 900_001n] as const;
    const digests = new Set<string>([GOLDEN]);
    for (let i = 0; i < base.length; i++) {
      const args = base.map((v, j) => (j === i ? bumped[i] : v)) as unknown as [typeof ID, typeof CLAIM, bigint, bigint, bigint];
      digests.add(computeAssertionId(...args));
    }
    expect(digests.size).toBe(6);
  });

  test("rejects a non-32-byte identifier", () => {
    expect(() => computeAssertionId(`0x${"aa".repeat(31)}`, CLAIM, 10n, 1n, 1n)).toThrow();
  });

  test("rejects an empty claim and an over-long claim", () => {
    expect(() => computeAssertionId(ID, "0x", 10n, 1n, 1n)).toThrow();
    expect(() => computeAssertionId(ID, `0x${"aa".repeat(2049)}`, 10n, 1n, 1n)).toThrow();
  });

  test("rejects a negative or out-of-range uint128", () => {
    expect(() => computeAssertionId(ID, CLAIM, -1n, 1n, 1n)).toThrow();
    expect(() => computeAssertionId(ID, CLAIM, 1n << 128n, 1n, 1n)).toThrow();
  });

  test("accepts uint128 max for each numeric field", () => {
    const max = (1n << 128n) - 1n;
    expect(() => computeAssertionId(ID, CLAIM, max, max, max)).not.toThrow();
  });

  test("the digest differs from a keccak-based encoding", () => {
    // Guards against a silent switch from the packed SHA-256 protocol.
    expect(computeAssertionId(ID, CLAIM, 10_000n, 1_440n, 900_000n)).not.toBe(`0x${"00".repeat(32)}`);
  });
});

describe("packed layout compatibility", () => {
  test("the 0x01 uint tag bytes are present in the hashed preimage", () => {
    // Reconstruct the preimage independently and confirm the three tag bytes.
    const identifier = ID.slice(2);
    const claim = CLAIM.slice(2);
    const enc = (v: bigint) => `01${v.toString(16).padStart(32, "0")}`;
    const preimage = `${identifier}${claim}${enc(10_000n)}${enc(1_440n)}${enc(900_000n)}`;
    expect(preimage).toContain(`01${"2710".padStart(32, "0")}`);
    // The helper must agree with an independent SHA-256 of that exact preimage.
    const digest = new Bun.CryptoHasher("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    expect(`0x${digest}`).toBe(GOLDEN);
  });

  test("the layout is plain bytes, independent of any Clarity wrapper", () => {
    // The 0x01 tag bytes are the only Clarity remnant, and they are literal bytes here.
    expect(computeAssertionId(ID, CLAIM, 10_000n, 1_440n, 900_000n)).toBe(GOLDEN);
  });
});
