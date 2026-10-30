// Builds REAL ABI-encoded MuoCore log fixtures for unit tests.
//
// The confirmation logic decodes event payloads with the compiler ABI, so a
// topics-only fake receipt is no longer a valid success fixture. These helpers
// encode genuine logs (topics + data) with viem against `muoCoreAbi`, so the
// decoder under test exercises the same code path as a real receipt.

import type { AbiEvent } from "viem";
import { encodeAbiParameters, encodeEventTopics, toEventSelector } from "viem";

import type { Address, Hex } from "@muo/core/native";
import { muoCoreAbi } from "@muo/core/abi";
import { MUSD_UNIT } from "@muo/core/native";
import { computeAssertionId } from "@muo/utils/native";

const eventAbi = (name: string): AbiEvent => {
  const entry = muoCoreAbi.find((e) => e.type === "event" && e.name === name);
  if (!entry) throw new Error(`ABI is missing ${name}`);
  return entry as AbiEvent;
};

/** topic0 for a MuoCore event, from the compiler ABI. */
export const topic0 = (name: string): Hex => toEventSelector(eventAbi(name)).toLowerCase() as Hex;

export type EncodedLog = { address: string; topics: string[]; data: Hex };

export type AssertedFields = {
  assertionId: Hex;
  assertedBy: Address;
  identifier: Hex;
  claim: Hex;
  bondMusd: bigint;
  liveness: bigint;
  assertedAtBlock: bigint;
};

/**
 * Encodes a real `Asserted` log.
 *
 * `assertionId` is derived from the consensus packing at `assertedAtBlock` unless
 * an explicit override is supplied (used to build the wrong-id regression).
 */
export const encodeAsserted = (opts: {
  coreAddress: string;
  assertedBy: Address;
  identifier: Hex;
  claim: Hex;
  bondMusd: bigint;
  liveness: bigint;
  assertedAtBlock: bigint;
  assertionId?: Hex;
}): EncodedLog => {
  const assertionId = opts.assertionId ?? computeAssertionId(opts.identifier, opts.claim, opts.bondMusd, opts.liveness, opts.assertedAtBlock);

  const abi = eventAbi("Asserted");
  const topics = encodeEventTopics({
    abi: [abi],
    eventName: "Asserted",
    args: { assertionId, assertedBy: opts.assertedBy },
  }) as Hex[];

  const data = encodeAbiParameters(
    [
      { name: "identifier", type: "bytes32" },
      { name: "claim", type: "bytes" },
      { name: "bondMusd", type: "uint256" },
      { name: "liveness", type: "uint256" },
      { name: "assertedAtBlock", type: "uint256" },
    ],
    [opts.identifier, opts.claim, opts.bondMusd, opts.liveness, opts.assertedAtBlock]
  );

  return { address: opts.coreAddress, topics, data };
};

/** Encodes a real outcome log (Disputed / Settled / Rejected / Unresolved). */
export const encodeOutcome = (opts: {
  coreAddress: string;
  event: "Disputed" | "Settled" | "Rejected" | "Unresolved";
  assertionId: Hex;
  actor: Address;
  atBlock: bigint;
}): EncodedLog => {
  const abi = eventAbi(opts.event);
  const byKey = `${opts.event.toLowerCase()}By`;
  const blockKey = `${opts.event.toLowerCase()}AtBlock`;

  const topics = encodeEventTopics({
    abi: [abi],
    eventName: opts.event,
    args: { assertionId: opts.assertionId, [byKey]: opts.actor },
  }) as Hex[];

  const data = encodeAbiParameters([{ name: blockKey, type: "uint256" }], [opts.atBlock]);
  return { address: opts.coreAddress, topics, data };
};

/** A topics-only log: right topic0, no decodable payload. */
export const encodeMalformed = (coreAddress: string, event: "Asserted" | "Disputed" | "Settled" | "Rejected" | "Unresolved"): EncodedLog => ({
  address: coreAddress,
  topics: [topic0(event)],
  data: "0x" as Hex,
});

/** 10 whole MUSD in base units, for convenience in fixtures. */
export const TEN_MUSD = 10n * MUSD_UNIT;
