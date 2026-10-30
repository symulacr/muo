import { sha256 } from "@noble/hashes/sha256";

import type { Hex } from "@muo/core/native";
import { isClaim, isId, MAX_CLAIM_BYTES, MAX_U128 } from "@muo/core/native";

export const decodeHex = (hex: string, off: number, out: Uint8Array): number => {
  if (!Number.isSafeInteger(off) || off < 0) throw new RangeError("Invalid output offset");
  if (!/^0x(?:[0-9a-f]{2})*$/.test(hex)) throw new TypeError("Expected canonical 0x-prefixed hex");
  const size = (hex.length - 2) / 2;
  if (off + size > out.length) throw new RangeError("Output buffer is too small");
  for (let i = 0; i < size; i++) out[off + i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return off + size;
};
export const putU128 = (v: bigint, off: number, out: Uint8Array): number => {
  if (typeof v !== "bigint" || v < 0n || v > MAX_U128) throw new RangeError("Expected uint128");
  if (!Number.isSafeInteger(off) || off < 0 || off + 17 > out.length) throw new RangeError("Output buffer is too small");
  out[off] = 1;
  for (let i = 0; i < 16; i++) out[off + 16 - i] = Number((v >> BigInt(i * 8)) & 255n);
  return off + 17;
};
export const bytesToHex = (bytes: Uint8Array): Hex => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
export function computeAssertionId(identifier: Hex, claim: Hex, bondMusd: bigint, liveness: bigint, assertedAtBlock: bigint): Hex {
  if (!isId(identifier)) throw new TypeError("Identifier must be 32 bytes");
  if (!isClaim(claim)) throw new RangeError("Claim must be 1..2048 bytes");
  const out = new Uint8Array(32 + MAX_CLAIM_BYTES + 51);
  const end = putU128(assertedAtBlock, putU128(liveness, putU128(bondMusd, decodeHex(claim, decodeHex(identifier, 0, out), out), out), out), out);
  return bytesToHex(sha256(out.subarray(0, end)));
}
export const claimIdentifier = (claim: Uint8Array): Hex => bytesToHex(sha256(claim));
export const formatRawUnits = (value: bigint, decimals = 18): string => {
  if (typeof value !== "bigint" || value < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new RangeError("Invalid amount or decimals");
  if (decimals === 0) return value.toString();
  const raw = value.toString().padStart(decimals + 1, "0");
  const fractional = raw.slice(-decimals).replace(/0+$/, "");
  return raw.slice(0, -decimals) + (fractional ? `.${fractional}` : "");
};
export const formatMusdBalance = (v?: bigint | null) => (v == null ? undefined : formatRawUnits(v, 18));
export const formatBtcBalance = (v?: bigint | null) => (v == null ? undefined : formatRawUnits(v, 18));
export const formatBondMusd = (v: string | bigint) => {
  const text = typeof v === "bigint" ? v.toString() : v;
  if (text.length > 39 || !/^(0|[1-9][0-9]*)$/.test(text) || BigInt(text) > MAX_U128) throw new RangeError("Invalid whole-MUSD amount");
  return text;
};
