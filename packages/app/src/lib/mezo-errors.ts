import { decodeErrorResult, hexToString, isHex } from "viem";

import { muoCoreAbi } from "@muo/core/abi";

/**
 * MuoCore revert codes, transcribed from contracts/muo/contracts/MuoCore.sol.
 * These are numeric `MuoError(uint256)` payloads -- there is no Clarity `u` prefix.
 */
export const MUO_ERROR_MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  8400001: "The dispute window is still open. Wait for it to close.",
  8400002: "The dispute window is already closed.",
  8400003: "The assertion status does not permit this action.",
  8400004: "The MUSD transfer failed.",
  8400100: "The bond is below the 10 MUSD minimum.",
  8400101: "The liveness must be between 1 and 52,560 blocks.",
  8400102: "The identifier must be 32 bytes.",
  8403000: "Only the contract owner can run this function.",
  8403200: "Only an arbiter can run this function.",
  8403300: "An arbiter cannot be the asserter or the disputer.",
  8403400: "You cannot dispute your own assertion.",
  8404100: "That assertion does not exist.",
  8404200: "That arbiter does not exist.",
  8409100: "That assertion already exists.",
  8409200: "That arbiter already exists.",
  8500000: "The on-chain serialization failed.",
});

const MUO_ERROR_NAME = "MuoError";
const ERROR_STRING_SELECTOR = "0x08c379a0";

const dig = (error: unknown, key: string, depth = 0): unknown => {
  if (depth > 6 || typeof error !== "object" || error === null) return undefined;
  if (Object.hasOwn(error, key)) return (error as Record<string, unknown>)[key];
  return dig((error as { cause?: unknown }).cause, key, depth + 1);
};

const collectHexCandidates = (error: unknown, out: string[], depth = 0): void => {
  if (depth > 6 || out.length >= 8) return;
  if (typeof error === "string") {
    if (isHex(error) && error.length >= 10) out.push(error);
    return;
  }
  if (typeof error !== "object" || error === null) return;
  for (const key of ["data", "error", "result", "return", "revert", "reason"]) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" && isHex(value) && value.length >= 10) out.push(value);
    else if (typeof value === "object" && value !== null) collectHexCandidates(value, out, depth + 1);
  }
  collectHexCandidates((error as { cause?: unknown }).cause, out, depth + 1);
};

/**
 * Decodes a MuoCore custom error into a human message.
 *
 * Returns `undefined` when the payload is not a recognised `MuoError(uint256)` or
 * `Error(string)`, so callers can fall back to a generic message rather than
 * inventing a cause.
 */
export const decodeMuoError = (error: unknown): { code: number; message: string } | undefined => {
  const candidates: string[] = [];
  collectHexCandidates(error, candidates);

  for (const candidate of candidates) {
    if (candidate.startsWith(ERROR_STRING_SELECTOR)) {
      try {
        const decoded = decodeErrorResult({ abi: muoCoreAbi, data: candidate as `0x${string}` });
        // Not reachable for Error(string); handled below by a manual decode.
        if (decoded.errorName === MUO_ERROR_NAME) continue;
      } catch {
        // Fall through to the manual string decode.
      }
      try {
        const body = candidate.slice(10);
        const offset = Number.parseInt(body.slice(0, 64), 16);
        const length = Number.parseInt(body.slice(64, 128), 16);
        if (!Number.isFinite(offset) || !Number.isFinite(length) || length > 4096) continue;
        const text = hexToString(`0x${body.slice(128, 128 + length * 2)}` as `0x${string}`);
        if (text) return { code: 0, message: text };
      } catch {
        // Ignore and try the next candidate.
      }
      continue;
    }
    try {
      const decoded = decodeErrorResult({ abi: muoCoreAbi, data: candidate as `0x${string}` });
      if (decoded.errorName !== MUO_ERROR_NAME) continue;
      const raw = decoded.args?.[0];
      if (typeof raw !== "bigint") continue;
      const code = Number(raw);
      if (!Number.isSafeInteger(code)) continue;
      return { code, message: MUO_ERROR_MESSAGES[code] ?? `The contract rejected the transaction (code ${code}).` };
    } catch {
      // Not a MuoCore error payload; try the next candidate.
    }
  }
  return undefined;
};

/** Extracts a 32-byte transaction hash from a wallet/provider result. */
export const readTxHash = (result: unknown): `0x${string}` | undefined => {
  const candidate = typeof result === "string" ? result : typeof result === "object" && result !== null ? (result as { hash?: unknown }).hash : undefined;
  return typeof candidate === "string" && /^0x[0-9a-fA-F]{64}$/.test(candidate) ? (candidate.toLowerCase() as `0x${string}`) : undefined;
};

/** Best-effort short reason for a wallet/RPC failure, without leaking calldata or secrets. */
export const describeError = (error: unknown): string => {
  const muo = decodeMuoError(error);
  if (muo) return muo.message;
  const shortMessage = dig(error, "shortMessage");
  if (typeof shortMessage === "string" && shortMessage.trim()) return shortMessage.trim();
  const message = dig(error, "message");
  if (typeof message === "string" && message.trim()) {
    const firstLine = message.trim().split("\n")[0] ?? "";
    return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
  }
  return "The transaction could not be completed.";
};
