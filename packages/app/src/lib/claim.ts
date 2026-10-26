import type { Hex } from "@muo/core/native";
import { MAX_CLAIM_BYTES } from "@muo/core/native";
import { claimIdentifier } from "@muo/utils/native";

const UTF8 = new TextEncoder();

export const utf8Length = (text: string): number => UTF8.encode(text).length;

export const claimToHex = (text: string): Hex => {
  const bytes = UTF8.encode(text);
  if (bytes.length === 0) throw new RangeError("Enter a claim");
  if (bytes.length > MAX_CLAIM_BYTES) throw new RangeError(`Maximum length is ${MAX_CLAIM_BYTES} bytes`);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

/**
 * SHA-256 of the UTF-8 claim bytes, matching the packed on-chain `identifier`
 * convention. Deliberately SHA-256 (not keccak) to preserve the existing protocol.
 */
export const identifierForClaim = (text: string): Hex => claimIdentifier(UTF8.encode(text));

export const claimFromHex = (hex: Hex): string => {
  const body = hex.slice(2);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
};
