import * as z from "zod/mini";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;
export const MEZO_CHAIN_IDS = { testnet: 31611, mainnet: 31612 } as const;
export type MezoChainId = (typeof MEZO_CHAIN_IDS)[keyof typeof MEZO_CHAIN_IDS];
export const MUSD_DECIMALS = 18;
export const BTC_DECIMALS = 18;
export const MUSD_UNIT = 10n ** 18n;
export const MIN_BOND_MUSD = 10n;
export const MAX_U128 = (1n << 128n) - 1n;
export const MAX_CLAIM_BYTES = 2048;
export const MIN_LIVENESS = 1;
export const DEFAULT_LIVENESS = 1440;
export const MAX_LIVENESS = 52_560;
export const TESTNET_CORE = "0x61c41cd7299fd668c3a7aae62f12c017fe654cb0" as const;
export const TESTNET_START_BLOCK = 16_380_473;
export const MEZO_NETWORKS = {
  31611: {
    id: 31611,
    name: "Mezo Testnet",
    rpcUrl: "https://rpc.test.mezo.org",
    explorerUrl: "https://explorer.test.mezo.org",
    musdAddress: "0x118917a40faf1cd7a13db0ef56c86de7973ac503" as Address,
  },
  31612: {
    id: 31612,
    name: "Mezo",
    rpcUrl: "https://rpc.mezo.org",
    explorerUrl: "https://explorer.mezo.org",
    musdAddress: "0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186" as Address,
  },
} as const;

export const isChainId = (v: unknown): v is MezoChainId => v === 31611 || v === 31612;
export const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const isLiveness = (v: unknown): v is number => isUint(v) && v >= MIN_LIVENESS && v <= MAX_LIVENESS;
export const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v);
export const isId = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
export const isClaim = (v: unknown): v is Hex =>
  typeof v === "string" && v.length >= 4 && v.length <= 2 + MAX_CLAIM_BYTES * 2 && /^0x(?:[0-9a-f]{2})+$/.test(v);
export const isBondMusdWire = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 39 && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) >= MIN_BOND_MUSD && BigInt(v) <= MAX_U128;
export const normalizeAddress = (v: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new TypeError("Expected a 20-byte EVM address");
  return v.toLowerCase() as Address;
};
export const normalizeHex = (v: string): Hex => {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(v)) throw new TypeError("Expected even-length 0x-prefixed hex");
  return v.toLowerCase() as Hex;
};
export const toSafeNumber = (v: bigint): number => {
  if (typeof v !== "bigint" || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Value exceeds safe integer range");
  return Number(v);
};
export const bondToUnits = (v: string | bigint): bigint => {
  const text = typeof v === "bigint" ? v.toString() : v;
  if (!isBondMusdWire(text)) throw new RangeError("Bond must be 10..uint128.max whole MUSD");
  return BigInt(text) * MUSD_UNIT;
};

export const assertionStatusSchema = z.enum(["open", "disputed", "settled", "rejected", "unresolved"]);
export type AssertionStatus = z.infer<typeof assertionStatusSchema>;
export const RESOLVE_STATUS = { settled: 2, rejected: 3, unresolved: 4 } as const;
export const STATUS_NAMES = ["open", "disputed", "settled", "rejected", "unresolved"] as const;
export const idHex = z.custom<Hex>(isId);
export const claimHex = z.custom<Hex>(isClaim);
export const address = z.custom<Address>(isAddress);
export const uint = z.custom<number>(isUint);
export const chainId = z.custom<MezoChainId>(isChainId);
export const bondMusd = z.custom<string>(isBondMusdWire);
export const liveness = z.custom<number>(isLiveness);
export const claimShape = { identifier: idHex, claim: claimHex, bondMusd, liveness };
export const provenanceSchema = z.strictObject({
  chainId,
  coreAddress: address,
  blockNumber: uint,
  blockHash: idHex,
  transactionHash: idHex,
  transactionIndex: uint,
  logIndex: uint,
});
export type LogProvenance = z.infer<typeof provenanceSchema>;
const np = z.nullish(address),
  nu = z.nullish(uint),
  nh = z.nullish(idHex);
export const assertionSchema = z.strictObject({
  id: idHex,
  ...claimShape,
  status: assertionStatusSchema,
  asserter: address,
  disputer: np,
  settler: np,
  resolver: np,
  assertedAtBlock: uint,
  assertedTxId: idHex,
  disputedAtBlock: nu,
  disputedTxId: nh,
  settledAtBlock: nu,
  settledTxId: nh,
  resolvedAtBlock: nu,
  resolvedTxId: nh,
  chainId,
  coreAddress: address,
  blockNumber: uint,
  blockHash: idHex,
  transactionIndex: uint,
  logIndex: uint,
});
export type Assertion = z.infer<typeof assertionSchema>;
const asserted = z.strictObject({
  event: z.literal("asserted"),
  data: z.strictObject({ assertionId: idHex, ...claimShape, assertedBy: address, assertedAtBlock: uint, assertedTxId: idHex }),
  provenance: provenanceSchema,
});
const disputed = z.strictObject({
  event: z.literal("disputed"),
  data: z.strictObject({ assertionId: idHex, disputedBy: address, disputedAtBlock: uint, disputedTxId: idHex }),
  provenance: provenanceSchema,
});
const settled = z.strictObject({
  event: z.literal("settled"),
  data: z.strictObject({ assertionId: idHex, settledBy: address, settledAtBlock: uint, settledTxId: idHex }),
  provenance: provenanceSchema,
});
const rejected = z.strictObject({
  event: z.literal("rejected"),
  data: z.strictObject({ assertionId: idHex, rejectedBy: address, rejectedAtBlock: uint, rejectedTxId: idHex }),
  provenance: provenanceSchema,
});
const unresolved = z.strictObject({
  event: z.literal("unresolved"),
  data: z.strictObject({ assertionId: idHex, unresolvedBy: address, unresolvedAtBlock: uint, unresolvedTxId: idHex }),
  provenance: provenanceSchema,
});
const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isEnvelope = (v: unknown): v is Record<string, unknown> =>
  isPlainRecord(v) &&
  Object.hasOwn(v, "event") &&
  Object.hasOwn(v, "data") &&
  Object.hasOwn(v, "provenance") &&
  isPlainRecord(v.data) &&
  isPlainRecord(v.provenance);
export const assertionEventSchema = z.pipe(
  z.custom<Record<string, unknown>>(isEnvelope),
  z.discriminatedUnion("event", [asserted, disputed, settled, rejected, unresolved])
);
export type AssertionEvent = z.infer<typeof assertionEventSchema>;
export const isAssertionEvent = (v: unknown): v is AssertionEvent =>
  typeof v === "object" &&
  v !== null &&
  Object.hasOwn(v, "event") &&
  Object.hasOwn(v, "data") &&
  Object.hasOwn(v, "provenance") &&
  assertionEventSchema.safeParse(v).success;
