// Typed call layer over the deployed MuoCore + MockMUSD contracts.
//
// Encoding and decoding are delegated to viem against the REAL ABIs:
//   - MuoCore: `muoCoreAbi` from @muo/core/abi (solc output, frozen)
//   - MockMUSD: the locally compiled artifact ABI (contracts/muo/out), since the
//     mock is test-only and not exported from @muo/core/abi
//
// No hand-written ABI layout, no hand-computed selectors, and no signature
// strings live here any more. The only hand-written piece is the thin JSON-RPC
// transport in ./rpc.ts, which viem's `custom` transport is pointed at.

import type { Abi, Hex } from "viem";
import { decodeFunctionResult, encodeFunctionData } from "viem";

import { muoCoreAbi } from "@muo/core/abi";

import type { RpcClient } from "./rpc.ts";

/**
 * viem returns EIP-55 CHECKSUMMED addresses. The native wire contract
 * (@muo/core/native) requires lowercase `0x` + 40 hex. Normalize at this
 * boundary so callers never have to remember which representation they hold.
 */
const lower = (a: string): Hex => a.toLowerCase() as Hex;

/** The 11-field Assertion struct as returned by getAssertion. */
export type AssertionView = {
  asserter: Hex;
  disputer: Hex;
  bondMusd: bigint;
  liveness: number;
  status: number;
  assertedAtBlock: bigint;
  disputedAtBlock: bigint;
  settledAtBlock: bigint;
  rejectedAtBlock: bigint;
  unresolvedAtBlock: bigint;
  exists: boolean;
};

export const STATUS = { open: 0, disputed: 1, settled: 2, rejected: 3, unresolved: 4 } as const;

/**
 * Encode a call against `abi`, returning calldata.
 * Throws (viem `AbiEncodingError` / `AbiFunctionNotFoundError`) if the function
 * is absent or the args do not match — which is exactly the drift we want to
 * surface rather than silently mis-encode.
 */
export function encodeCall(abi: Abi, functionName: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi, functionName, args } as never);
}

/**
 * Decode a call's return data against `abi`.
 * Throws on short/garbage data rather than returning a plausible-looking value.
 */
export function decodeCall<T = unknown>(abi: Abi, functionName: string, data: Hex): T {
  return decodeFunctionResult({ abi, functionName, data } as never) as T;
}

export class MuoCoreClient {
  constructor(
    readonly rpc: RpcClient,
    readonly address: Hex
  ) {}

  /** Calldata for assertClaim(identifier, claim, bondMusd, liveness). */
  static assertClaimData(identifier: Hex, claim: Hex, bondMusd: bigint, liveness: bigint): Hex {
    return encodeCall(muoCoreAbi, "assertClaim", [identifier, claim, bondMusd, liveness]);
  }

  disputeData = (id: Hex): Hex => encodeCall(muoCoreAbi, "dispute", [id]);
  settleData = (id: Hex): Hex => encodeCall(muoCoreAbi, "settle", [id]);
  resolveData = (id: Hex, status: number): Hex => encodeCall(muoCoreAbi, "resolve", [id, status]);
  addArbiterData = (account: string): Hex => encodeCall(muoCoreAbi, "addArbiter", [account]);

  /** eth_call getAssertion(id) and decode the struct. */
  async getAssertion(id: Hex): Promise<AssertionView> {
    const data = await this.rpc.ethCall(this.address, encodeCall(muoCoreAbi, "getAssertion", [id]));
    const raw = decodeCall<{
      asserter: Hex;
      disputer: Hex;
      bondMusd: bigint;
      liveness: bigint;
      status: number;
      assertedAtBlock: bigint;
      disputedAtBlock: bigint;
      settledAtBlock: bigint;
      rejectedAtBlock: bigint;
      unresolvedAtBlock: bigint;
      exists: boolean;
    }>(muoCoreAbi, "getAssertion", data);
    return {
      asserter: lower(raw.asserter),
      disputer: lower(raw.disputer),
      bondMusd: raw.bondMusd,
      liveness: Number(raw.liveness),
      status: Number(raw.status),
      assertedAtBlock: raw.assertedAtBlock,
      disputedAtBlock: raw.disputedAtBlock,
      settledAtBlock: raw.settledAtBlock,
      rejectedAtBlock: raw.rejectedAtBlock,
      unresolvedAtBlock: raw.unresolvedAtBlock,
      exists: raw.exists,
    };
  }

  /** eth_call CONTRACT_OWNER(). */
  async contractOwner(): Promise<Hex> {
    const data = await this.rpc.ethCall(this.address, encodeCall(muoCoreAbi, "CONTRACT_OWNER"));
    return lower(decodeCall<Hex>(muoCoreAbi, "CONTRACT_OWNER", data));
  }

  /** eth_call isArbiter(account). */
  async isArbiter(account: string): Promise<boolean> {
    const data = await this.rpc.ethCall(this.address, encodeCall(muoCoreAbi, "isArbiter", [account]));
    return decodeCall<boolean>(muoCoreAbi, "isArbiter", data);
  }

  /** eth_call getMinBondSats() — compatibility getter retained on-chain. */
  async getMinBondSats(): Promise<bigint> {
    const data = await this.rpc.ethCall(this.address, encodeCall(muoCoreAbi, "getMinBondSats"));
    return decodeCall<bigint>(muoCoreAbi, "getMinBondSats", data);
  }
}

/**
 * MockMUSD client. The mock is a test-only contract, so its ABI is the locally
 * compiled artifact rather than an @muo/core export. `musdAbi` from
 * @muo/core/abi describes the REAL MUSD surface and is used for the read
 * functions both tokens share.
 */
export class MusdClient {
  constructor(
    readonly rpc: RpcClient,
    readonly address: Hex,
    readonly abi: Abi
  ) {}

  mintData = (to: string, amount: bigint): Hex => encodeCall(this.abi, "mint", [to, amount]);
  approveData = (spender: string, amount: bigint): Hex => encodeCall(this.abi, "approve", [spender, amount]);

  async balanceOf(owner: string): Promise<bigint> {
    const data = await this.rpc.ethCall(this.address, encodeCall(this.abi, "balanceOf", [owner]));
    return decodeCall<bigint>(this.abi, "balanceOf", data);
  }

  async allowance(owner: string, spender: string): Promise<bigint> {
    const data = await this.rpc.ethCall(this.address, encodeCall(this.abi, "allowance", [owner, spender]));
    return decodeCall<bigint>(this.abi, "allowance", data);
  }

  async decimals(): Promise<number> {
    const data = await this.rpc.ethCall(this.address, encodeCall(this.abi, "decimals"));
    return Number(decodeCall<number>(this.abi, "decimals", data));
  }
}
