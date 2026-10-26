import type { AbiEvent } from "viem";
import { decodeEventLog, toEventSelector } from "viem";

import type { Address, Hex, MezoChainId } from "@muo/core/native";
import { muoCoreAbi, musdAbi } from "@muo/core/abi";
import { bondToUnits, DEFAULT_LIVENESS } from "@muo/core/native";
import { computeAssertionId } from "@muo/utils/native";

import type { PublicClient } from "@/lib/mezo-client";
import type { Eip1193Provider } from "@/lib/wallet-eip1193";
import { getWalletClient } from "@/lib/mezo-client";
import { readTxHash } from "@/lib/mezo-errors";
import { isUserRejection, readAccounts, readChainId } from "@/lib/wallet-eip1193";

export type MuoEventName = "Asserted" | "Disputed" | "Settled" | "Rejected" | "Unresolved";

/**
 * topic0 for each MuoCore outcome event, derived from the compiled ABI so a
 * signature change can never leave a stale hand-written hash behind.
 */
const eventTopic = (name: MuoEventName): Hex => {
  const entry = muoCoreAbi.find((e) => e.type === "event" && e.name === name);
  if (!entry) throw new Error(`ABI is missing the ${name} event`);
  return toEventSelector(entry as AbiEvent).toLowerCase() as Hex;
};

export const EVENT_TOPICS = Object.freeze({
  Asserted: eventTopic("Asserted"),
  Disputed: eventTopic("Disputed"),
  Settled: eventTopic("Settled"),
  Rejected: eventTopic("Rejected"),
  Unresolved: eventTopic("Unresolved"),
});

export type TxPhase = "preparing" | "approving" | "awaiting-approval" | "writing" | "awaiting-receipt" | "confirmed" | "uncertain" | "failed" | "cancelled";

export type TxOutcome =
  | { status: "confirmed"; hash: Hex; blockNumber: bigint }
  | { status: "uncertain"; hash: Hex; reason: string }
  | { status: "failed"; reason: string; code?: number }
  | { status: "cancelled" };

export type TxContext = {
  provider: Eip1193Provider;
  chainId: MezoChainId;
  coreAddress: Address;
  musdAddress: Address;
  publicClient: PublicClient;
  /** Account the user believes they are acting as. Re-verified before every prompt. */
  expectedAccount: Address;
};

export class TxError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "TxError";
    this.code = code;
  }
}

const RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Re-reads the account and chain from the wallet immediately before prompting.
 *
 * Guards against the user switching account or network between preparation and
 * signature -- the classic stale-closure / wrong-account failure.
 */
export const assertFreshSession = async (ctx: TxContext): Promise<void> => {
  const chainId = await readChainId(ctx.provider);
  if (chainId !== ctx.chainId) {
    throw new TxError(`The wallet is on chain ${chainId}; switch to ${ctx.chainId} and retry.`);
  }
  const accounts = await readAccounts(ctx.provider);
  const current = accounts[0];
  if (!current) throw new TxError("The wallet is no longer connected.");
  if (current !== ctx.expectedAccount) {
    throw new TxError("The active wallet account changed. Reconnect and retry.");
  }
};

/**
 * Runs `assertFreshSession` and converts a drift error into a controlled
 * `failed` outcome. Returns `null` when the session is still valid.
 *
 * This keeps account/chain drift on the same reporting path as any other
 * failure, so callers never see an unhandled exception from a stale session.
 */
const guardSession = async (ctx: TxContext): Promise<TxOutcome | null> => {
  try {
    await assertFreshSession(ctx);
    return null;
  } catch (error) {
    if (error instanceof TxError) return { status: "failed", reason: error.message };
    return { status: "failed", reason: "The wallet session could not be verified." };
  }
};

const waitForReceipt = async (ctx: TxContext, hash: Hex) => {
  try {
    return await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: 2_000 });
  } catch {
    return null;
  }
};

/** Reads the live assertion record so writes never trust cached bond data. */
export const readAssertionOnChain = async (ctx: TxContext, assertionId: Hex) => {
  const result = await ctx.publicClient.readContract({
    address: ctx.coreAddress,
    abi: muoCoreAbi,
    functionName: "getAssertion",
    args: [assertionId],
  });
  return result as {
    asserter: Address;
    disputer: Address;
    bondMusd: bigint;
    liveness: bigint;
    status: number;
    assertedAtBlock: bigint;
    disputedAtBlock: bigint;
    settledAtBlock: bigint;
    rejectedAtBlock: bigint;
    unresolvedAtBlock: bigint;
    exists: boolean;
  };
};

const readAllowance = async (ctx: TxContext, owner: Address): Promise<bigint> =>
  (await ctx.publicClient.readContract({
    address: ctx.musdAddress,
    abi: musdAbi,
    functionName: "allowance",
    args: [owner, ctx.coreAddress],
  })) as bigint;

/**
 * Ensures the core contract can pull exactly `requiredUnits`.
 *
 * Approves only when the current allowance is insufficient, and always approves the
 * exact required amount (never an unbounded allowance). The approval receipt must be
 * successful before the caller proceeds to the core call.
 */
export const ensureAllowance = async (ctx: TxContext, requiredUnits: bigint, onPhase?: (phase: TxPhase) => void): Promise<TxOutcome | { status: "ok" }> => {
  const allowance = await readAllowance(ctx, ctx.expectedAccount);
  if (allowance >= requiredUnits) return { status: "ok" };

  onPhase?.("approving");
  const drift = await guardSession(ctx);
  if (drift) return drift;
  const wallet = getWalletClient(ctx.provider, ctx.chainId, ctx.expectedAccount);

  let hash: Hex | undefined;
  try {
    hash = readTxHash(
      await wallet.writeContract({
        address: ctx.musdAddress,
        abi: musdAbi,
        functionName: "approve",
        args: [ctx.coreAddress, requiredUnits],
        account: ctx.expectedAccount,
        chain: wallet.chain,
      })
    );
  } catch (error) {
    if (isUserRejection(error)) return { status: "cancelled" };
    throw error;
  }
  if (!hash) return { status: "failed", reason: "The wallet did not return an approval transaction hash." };

  onPhase?.("awaiting-approval");
  const receipt = await waitForReceipt(ctx, hash);
  if (!receipt) return { status: "uncertain", hash, reason: "The approval was submitted but its receipt did not arrive in time." };
  if (receipt.status !== "success") return { status: "failed", reason: "The MUSD approval transaction reverted." };

  const after = await readAllowance(ctx, ctx.expectedAccount);
  if (after < requiredUnits) return { status: "failed", reason: "The MUSD allowance did not increase as expected." };
  return { status: "ok" };
};

export type WriteRequest =
  | {
      functionName: "assertClaim";
      args: readonly [Hex, Hex, bigint, bigint];
      requiredUnits: bigint;
      expectedEvent: MuoEventName;
      /**
       * Not used for confirmation: the real assertion id is derived on-chain from
       * `block.number` and is re-computed from the mined event instead. Kept so
       * callers can log the identifier they submitted.
       */
      assertionId?: Hex;
    }
  | {
      functionName: "dispute";
      args: readonly [Hex];
      requiredUnits: bigint;
      expectedEvent: MuoEventName;
      assertionId: Hex;
    }
  | {
      functionName: "settle";
      args: readonly [Hex];
      requiredUnits: 0n;
      expectedEvent: MuoEventName;
      assertionId: Hex;
    }
  | {
      functionName: "resolve";
      args: readonly [Hex, number];
      requiredUnits: 0n;
      expectedEvent: MuoEventName;
      assertionId: Hex;
    };

/**
 * Simulates, writes, and confirms a MuoCore call.
 *
 * A receipt with `status: "success"` but no matching event is reported as
 * `uncertain`, never as confirmed -- the UI must reconcile rather than claim success.
 */
export const submitCoreWrite = async (ctx: TxContext, request: WriteRequest, onPhase?: (phase: TxPhase) => void): Promise<TxOutcome> => {
  onPhase?.("preparing");

  if (request.requiredUnits > 0n) {
    const approval = await ensureAllowance(ctx, request.requiredUnits, onPhase);
    if (approval.status !== "ok") return approval;
  }

  onPhase?.("preparing");
  const preWrite = await guardSession(ctx);
  if (preWrite) return preWrite;

  try {
    await ctx.publicClient.simulateContract({
      address: ctx.coreAddress,
      abi: muoCoreAbi,
      functionName: request.functionName,
      args: request.args,
      account: ctx.expectedAccount,
    } as Parameters<typeof ctx.publicClient.simulateContract>[0]);
  } catch (error) {
    if (isUserRejection(error)) return { status: "cancelled" };
    const { decodeMuoError, describeError } = await import("@/lib/mezo-errors");
    // Only a decoded MuoError means the call would revert; anything else is transport
    // (RPC down, 429, DNS, CORS) and must not be reported as a contract revert.
    return { status: "failed", reason: describeError(error), code: decodeMuoError(error)?.code };
  }

  // The approval prompt may have taken time; re-verify before the core call.
  const postApproval = await guardSession(ctx);
  if (postApproval) return postApproval;

  const wallet = getWalletClient(ctx.provider, ctx.chainId, ctx.expectedAccount);
  onPhase?.("writing");
  let hash: Hex | undefined;
  try {
    hash = readTxHash(
      await wallet.writeContract({
        address: ctx.coreAddress,
        abi: muoCoreAbi,
        functionName: request.functionName,
        args: request.args,
        account: ctx.expectedAccount,
        chain: wallet.chain,
      } as Parameters<typeof wallet.writeContract>[0])
    );
  } catch (error) {
    if (isUserRejection(error)) return { status: "cancelled" };
    const { decodeMuoError } = await import("@/lib/mezo-errors");
    const decoded = decodeMuoError(error);
    return { status: "failed", reason: decoded?.message ?? "The wallet rejected the transaction.", code: decoded?.code };
  }
  if (!hash) return { status: "failed", reason: "The wallet did not return a transaction hash." };

  onPhase?.("awaiting-receipt");
  const receipt = await waitForReceipt(ctx, hash);
  if (!receipt) return { status: "uncertain", hash, reason: "The transaction was submitted but its receipt did not arrive in time." };
  if (receipt.status !== "success") return { status: "failed", reason: "The transaction reverted on-chain." };

  // Confirm ONLY when the receipt carries the expected MuoCore event AND its
  // decoded payload describes THIS operation. A topic0-only check would accept an
  // unrelated event of the same kind as success.
  const mismatch = confirmReceiptEvent(request, receipt, ctx);
  if (mismatch) return { status: "uncertain", hash, reason: mismatch };

  return { status: "confirmed", hash, blockNumber: receipt.blockNumber };
};

/**
 * Confirms a receipt against the EXACT event the operation should have emitted.
 *
 * A topic0 match alone is not enough: it proves an event of the right *kind*
 * fired, not that it describes *this* operation. So the payload is decoded with
 * the compiler ABI and checked field by field:
 *
 *  - `Asserted` is checked against the identifier, claim, whole-MUSD bond, and
 *    resolved liveness we submitted, the acting account, and the assertion id
 *    RE-DERIVED from the consensus packing at the receipt's real block number.
 *    The id is never taken from a simulation, and never from the request.
 *  - Every outcome event is checked against the requested assertion id and the
 *    acting account, plus the block number the event reports.
 *
 * Returns `null` when the receipt is acceptable, or a human reason when it is not.
 * Any mismatch is treated as UNCERTAIN by the caller: the write may well have
 * landed, but the client cannot attest to what it did.
 */
export const confirmReceiptEvent = (
  request: WriteRequest,
  receipt: { blockNumber: bigint; logs: readonly { address: string; topics: readonly string[]; data: Hex }[] },
  ctx: Pick<TxContext, "coreAddress" | "expectedAccount">
): string | null => {
  const expectedTopic = EVENT_TOPICS[request.expectedEvent];
  const core = ctx.coreAddress.toLowerCase();

  const candidates = receipt.logs.filter((log) => log.address.toLowerCase() === core && log.topics[0]?.toLowerCase() === expectedTopic);
  if (candidates.length === 0) {
    return `The transaction succeeded but emitted no ${request.expectedEvent} event.`;
  }

  for (const log of candidates) {
    let decoded: { eventName: string; args: unknown };
    try {
      decoded = decodeEventLog({
        abi: muoCoreAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { eventName: string; args: unknown };
    } catch {
      // A malformed payload for the expected topic is not a confirmation.
      continue;
    }
    if (decoded.eventName !== request.expectedEvent) continue;

    if (decoded.eventName === "Asserted") {
      const args = decoded.args as {
        assertionId: Hex;
        assertedBy: Address;
        identifier: Hex;
        claim: Hex;
        bondMusd: bigint;
        liveness: bigint;
        assertedAtBlock: bigint;
      };

      // The acting account must be the one the event credits.
      if (args.assertedBy.toLowerCase() !== ctx.expectedAccount.toLowerCase()) continue;

      if (request.functionName !== "assertClaim") continue;
      const [identifier, claim, bondMusd, liveness] = request.args;

      if (args.identifier.toLowerCase() !== identifier.toLowerCase()) continue;
      if (args.claim.toLowerCase() !== claim.toLowerCase()) continue;
      if (args.bondMusd !== bondMusd) continue;

      // The contract resolves liveness == 0 to DEFAULT_LIVENESS.
      const resolved = liveness === 0n ? BigInt(DEFAULT_LIVENESS) : liveness;
      if (args.liveness !== resolved) continue;

      // Re-derive the id from the consensus packing at the REAL receipt block.
      let derived: Hex;
      try {
        derived = computeAssertionId(identifier, claim, bondMusd, resolved, args.assertedAtBlock);
      } catch {
        continue;
      }
      if (derived.toLowerCase() !== args.assertionId.toLowerCase()) continue;
      if (args.assertedAtBlock !== receipt.blockNumber) continue;

      return null;
    }

    // Outcome events: assertion id + acting account + reported block.
    const args = decoded.args as { assertionId: Hex; [key: string]: unknown };
    if (!request.assertionId) continue;
    if (args.assertionId?.toLowerCase() !== request.assertionId.toLowerCase()) continue;

    const byKey = `${request.expectedEvent.toLowerCase()}By`;
    const blockKey = `${request.expectedEvent.toLowerCase()}AtBlock`;
    const actor = args[byKey];
    const atBlock = args[blockKey];
    if (typeof actor !== "string" || actor.toLowerCase() !== ctx.expectedAccount.toLowerCase()) continue;
    if (typeof atBlock !== "bigint" || atBlock !== receipt.blockNumber) continue;

    return null;
  }

  return `The ${request.expectedEvent} event did not match this operation (wrong id, actor, or payload).`;
};

/** Converts a whole-MUSD wire string to base units exactly once. */
export const bondUnits = (bondMusd: string): bigint => bondToUnits(bondMusd);
