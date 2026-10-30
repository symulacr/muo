// Native MuoCore log decoder.
//
// Decoding is delegated to viem's `decodeEventLog` against the COMPILER ABI
// (`muoCoreAbi` from `@muo/core/abi`), so event names, argument names and
// `topics[0]` selectors are derived from one source of truth. There is no
// hand-written signature string and no hand-written topic constant that could
// drift from the contract.
//
// viem is deliberately strict about *truncated* data but NOT about *trailing*
// data: `decodeEventLog` happily ignores extra bytes after a fully decoded
// payload. A log with a valid prefix and junk appended would therefore decode
// "successfully". `assertExactDataLength` below closes that hole by computing
// the canonical ABI length for each event and requiring an exact match.
//
// Wire contract: @muo/core/native. Ids/hashes are lowercase 0x + 64 hex;
// addresses are lowercase 0x + 40; `bondMusd` is a canonical whole-MUSD decimal
// STRING (never a JS number).

import type { AbiEvent } from "viem";
import { decodeEventLog, getAbiItem, toEventSelector } from "viem";

import type { Address, AssertionEvent, Hex, LogProvenance, MezoChainId } from "@muo/core/native";
import { muoCoreAbi } from "@muo/core/abi";
import { isAddress, isBondMusdWire, isChainId, isClaim, isId, isLiveness, normalizeHex, toSafeNumber } from "@muo/core/native";
import { computeAssertionId } from "@muo/utils/native";

/** The five assertion events, in ABI order. Derived from the compiler ABI. */
export const MUO_EVENT_NAMES = ["Asserted", "Disputed", "Settled", "Rejected", "Unresolved"] as const;
export type MuoEventName = (typeof MUO_EVENT_NAMES)[number];

type MuoEventAbi = AbiEvent & { readonly name: MuoEventName };

const eventItem = (name: MuoEventName): MuoEventAbi => getAbiItem({ abi: muoCoreAbi, name }) as unknown as MuoEventAbi;

/** The five event ABI items, resolved once from the compiler ABI. */
export const MUO_EVENTS = MUO_EVENT_NAMES.map(eventItem) as readonly MuoEventAbi[];

/**
 * `topics[0]` for each event, computed by viem from the compiler ABI.
 * These are keccak256 of the event signature — NOT assertion ids.
 */
export const MUO_TOPIC0 = Object.fromEntries(MUO_EVENTS.map((e) => [e.name, toEventSelector(e) as Hex])) as Record<MuoEventName, Hex>;

/** Human-readable signatures, derived from the ABI (for diagnostics/tests). */
export const MUO_EVENT_SIGNATURES = Object.fromEntries(MUO_EVENTS.map((e) => [e.name, `${e.name}(${e.inputs.map((i) => i.type).join(",")})`])) as Record<
  MuoEventName,
  string
>;

const TOPIC0_TO_NAME = new Map<string, MuoEventName>(MUO_EVENT_NAMES.map((name) => [MUO_TOPIC0[name], name] as const));

/** The subset of an `eth_getLogs` result this decoder reads. */
export type RpcLog = {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string | number | bigint;
  blockHash?: string | null;
  transactionHash?: string | null;
  transactionIndex?: string | number | bigint | null;
  logIndex: string | number | bigint;
  removed?: boolean;
};

/**
 * A log that is in scope for MuoCore but could not be decoded.
 *
 * Recognised-but-malformed logs are a hard stop: the caller must NOT advance a
 * cursor past them. This is deliberately a thrown error, not a null return, so
 * a silent skip is impossible.
 */
export class MuoLogDecodeError extends Error {
  readonly log: unknown;
  constructor(message: string, log: unknown) {
    super(message);
    this.name = "MuoLogDecodeError";
    this.log = log;
  }
}

/** A log outside MuoCore's topic scope. Skipping these is safe. */
export const isMuoTopic = (topic: string | undefined): boolean => typeof topic === "string" && TOPIC0_TO_NAME.has(topic.toLowerCase());

const asBig = (v: unknown): bigint | undefined => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  return undefined;
};

/**
 * Canonical ABI data length for an event, in bytes.
 *
 * `Asserted` carries a dynamic `bytes` tail, so its length depends on the claim
 * size: 5 head words + 1 length word + ceil(len/32) data words. The four
 * outcome events carry a single `uint256`, so exactly 32 bytes.
 */
export function expectedDataLength(name: MuoEventName, claimBytes: number): number {
  if (name !== "Asserted") return 32;
  return 5 * 32 + 32 + Math.ceil(claimBytes / 32) * 32;
}

/**
 * Decode one MuoCore log into the native event envelope.
 *
 * Returns `null` for logs that are out of scope: a different address, an
 * unknown `topics[0]`, or a log the provider marked `removed` (a reorg signal,
 * not an event to apply).
 *
 * Throws `MuoLogDecodeError` for a log that IS in scope (correct address and a
 * known MuoCore topic) but whose payload is malformed, whose claimed block
 * disagrees with the log's block, whose assertion id does not match the
 * recomputed digest, or whose integers are not safe. Callers must treat a throw
 * as "stop; do not advance the cursor".
 */
export function decodeMuoLog(log: unknown, chainId: MezoChainId, coreAddress: Address): AssertionEvent | null {
  if (!isChainId(chainId)) throw new TypeError("Unsupported chain id");
  if (!isAddress(coreAddress)) throw new TypeError("Core address must be a lowercase 0x-prefixed 20-byte address");
  if (typeof log !== "object" || log === null) return null;

  const l = log as RpcLog;
  if (typeof l.address !== "string" || !Array.isArray(l.topics) || typeof l.data !== "string") return null;
  if (l.address.toLowerCase() !== coreAddress) return null;

  const topic0 = typeof l.topics[0] === "string" ? l.topics[0].toLowerCase() : undefined;
  const name = topic0 === undefined ? undefined : TOPIC0_TO_NAME.get(topic0);
  if (name === undefined) return null;

  // A `removed` log is a reorg signal. It is not an event to apply, and it is
  // not an error: the poller reconciles by block hash, not by this flag.
  if (l.removed === true) return null;

  const provenance = buildProvenance(l, chainId, coreAddress, name);

  const topics = l.topics.map((t) => {
    try {
      return normalizeHex(t);
    } catch {
      throw new MuoLogDecodeError(`${name} has a non-canonical topic`, log);
    }
  });
  if (topics.length !== 3) {
    throw new MuoLogDecodeError(`${name} expects 3 topics, got ${topics.length}`, log);
  }

  const data = (() => {
    try {
      return normalizeHex(l.data);
    } catch {
      throw new MuoLogDecodeError(`${name} data is not canonical 0x-prefixed even-length hex`, log);
    }
  })();

  const bytes = (data.length - 2) / 2;
  // Shape checks BEFORE viem, so a malformed tail is reported as a MuoCore
  // decode failure rather than an opaque ABI error.
  if (name === "Asserted") {
    if (bytes < 6 * 32) throw new MuoLogDecodeError("Asserted data is shorter than its 5-word head", log);
    const claimLen = readWord(data, 5, "claim length", log);
    if (claimLen > 2048n) throw new MuoLogDecodeError(`Asserted claim length ${claimLen} exceeds 2048`, log);
    const want = expectedDataLength(name, Number(claimLen));
    if (bytes !== want) {
      throw new MuoLogDecodeError(`Asserted data is ${bytes} bytes, canonical is ${want}`, log);
    }
  } else if (bytes !== 32) {
    throw new MuoLogDecodeError(`${name} data must be exactly 32 bytes, got ${bytes}`, log);
  }

  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: muoCoreAbi,
      data,
      topics: topics as [Hex, ...Hex[]],
      strict: true,
    }) as unknown as { eventName: string; args: Record<string, unknown> };
  } catch (err) {
    throw new MuoLogDecodeError(`Malformed ${name} log payload: ${(err as Error).message}`, log);
  }
  if (decoded.eventName !== name) {
    throw new MuoLogDecodeError(`Topic/name mismatch: ${topic0} decoded as ${decoded.eventName}`, log);
  }

  const args = decoded.args;

  if (name === "Asserted") {
    const assertionId = asId(args.assertionId, "assertionId", log);
    const assertedBy = asAddress(args.assertedBy, "assertedBy", log);
    const identifier = asId(args.identifier, "identifier", log);
    const claim = asClaim(args.claim, "claim", log);
    const bondMusd = asBond(args.bondMusd, log);
    const liveness = asLiveness(args.liveness, log);
    const assertedAtBlock = asBlock(args.assertedAtBlock, "assertedAtBlock", log);

    if (assertedAtBlock !== provenance.blockNumber) {
      throw new MuoLogDecodeError(`Asserted claims block ${assertedAtBlock} but the log is in block ${provenance.blockNumber}`, log);
    }

    const expected = computeAssertionId(identifier, claim, BigInt(bondMusd), BigInt(liveness), BigInt(assertedAtBlock));
    if (expected !== assertionId) {
      throw new MuoLogDecodeError(`Asserted id ${assertionId} does not match recomputed ${expected}`, log);
    }

    return {
      event: "asserted",
      data: {
        assertionId,
        identifier,
        claim,
        bondMusd,
        liveness,
        assertedBy,
        assertedAtBlock,
        assertedTxId: provenance.transactionHash,
      },
      provenance,
    };
  }

  const assertionId = asId(args.assertionId, "assertionId", log);
  const atBlock = asBlock(args[`${name.toLowerCase()}AtBlock`], `${name}AtBlock`, log);
  const by = asAddress(args[`${name.toLowerCase()}By`], `${name}By`, log);
  if (atBlock !== provenance.blockNumber) {
    throw new MuoLogDecodeError(`${name} claims block ${atBlock} but the log is in block ${provenance.blockNumber}`, log);
  }

  const txId = provenance.transactionHash;
  switch (name) {
    case "Disputed":
      return { event: "disputed", data: { assertionId, disputedBy: by, disputedAtBlock: atBlock, disputedTxId: txId }, provenance };
    case "Settled":
      return { event: "settled", data: { assertionId, settledBy: by, settledAtBlock: atBlock, settledTxId: txId }, provenance };
    case "Rejected":
      return { event: "rejected", data: { assertionId, rejectedBy: by, rejectedAtBlock: atBlock, rejectedTxId: txId }, provenance };
    case "Unresolved":
      return { event: "unresolved", data: { assertionId, unresolvedBy: by, unresolvedAtBlock: atBlock, unresolvedTxId: txId }, provenance };
    default: {
      const exhaustive: never = name;
      throw new MuoLogDecodeError(`Unhandled event ${String(exhaustive)}`, log);
    }
  }
}

/** Read one 32-byte word as a bigint, bounded to the safe integer range. */
function readWord(data: Hex, wordIndex: number, field: string, log: unknown): bigint {
  const start = 2 + wordIndex * 64;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) throw new MuoLogDecodeError(`${field} is missing`, log);
  return BigInt(`0x${word}`);
}

function buildProvenance(l: RpcLog, chainId: MezoChainId, coreAddress: Address, name: MuoEventName): LogProvenance {
  const blockNumber = asBig(l.blockNumber);
  if (blockNumber === undefined) throw new MuoLogDecodeError(`${name} log has an unsafe blockNumber`, l);
  if (typeof l.blockHash !== "string") throw new MuoLogDecodeError(`${name} log has no blockHash`, l);
  if (typeof l.transactionHash !== "string") throw new MuoLogDecodeError(`${name} log has no transactionHash`, l);
  const txIndex = asBig(l.transactionIndex);
  if (txIndex === undefined) throw new MuoLogDecodeError(`${name} log has no transactionIndex`, l);
  const logIndex = asBig(l.logIndex);
  if (logIndex === undefined) throw new MuoLogDecodeError(`${name} log has an unsafe logIndex`, l);
  return {
    chainId,
    coreAddress,
    blockNumber: safe(`${name} blockNumber`, blockNumber, l),
    blockHash: asId(l.blockHash, "blockHash", l),
    transactionHash: asId(l.transactionHash, "transactionHash", l),
    transactionIndex: safe(`${name} transactionIndex`, txIndex, l),
    logIndex: safe(`${name} logIndex`, logIndex, l),
  };
}

/** `toSafeNumber` with the error type the caller must treat as a hard stop. */
const safe = (field: string, v: bigint, log: unknown): number => {
  try {
    return toSafeNumber(v);
  } catch {
    throw new MuoLogDecodeError(`${field} exceeds the safe integer range`, log);
  }
};

const asId = (v: unknown, field: string, log: unknown): Hex => {
  if (typeof v !== "string") throw new MuoLogDecodeError(`${field} is not a string`, log);
  const hex = v.toLowerCase();
  if (!isId(hex)) throw new MuoLogDecodeError(`${field} is not a 32-byte 0x-prefixed hex value`, log);
  return hex;
};
const asAddress = (v: unknown, field: string, log: unknown): Address => {
  if (typeof v !== "string") throw new MuoLogDecodeError(`${field} is not a string`, log);
  const addr = v.toLowerCase();
  if (!isAddress(addr)) throw new MuoLogDecodeError(`${field} is not a 20-byte address`, log);
  return addr;
};
const asClaim = (v: unknown, field: string, log: unknown): Hex => {
  if (typeof v !== "string") throw new MuoLogDecodeError(`${field} is not a string`, log);
  const hex = v.toLowerCase();
  if (!isClaim(hex)) throw new MuoLogDecodeError(`${field} is not 1..2048 bytes of 0x-prefixed hex`, log);
  return hex;
};
const asBond = (v: unknown, log: unknown): string => {
  if (typeof v !== "bigint") throw new MuoLogDecodeError("bondMusd is not a bigint", log);
  const text = v.toString();
  if (!isBondMusdWire(text)) throw new MuoLogDecodeError(`bondMusd ${text} is outside 10..uint128.max`, log);
  return text;
};
const asLiveness = (v: unknown, log: unknown): number => {
  if (typeof v !== "bigint") throw new MuoLogDecodeError("liveness is not a bigint", log);
  const n = toSafeNumber(v);
  if (!isLiveness(n)) throw new MuoLogDecodeError(`liveness ${n} is outside 1..52560`, log);
  return n;
};
const asBlock = (v: unknown, field: string, log: unknown): number => {
  if (typeof v !== "bigint") throw new MuoLogDecodeError(`${field} is not a bigint`, log);
  return toSafeNumber(v);
};
