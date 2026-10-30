"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type { Address, Hex, MezoChainId } from "@muo/core/native";
import { RESOLVE_STATUS } from "@muo/core/native";

import type { TxOutcome, TxPhase } from "@/lib/mezo-tx";
import { useAppConfig, useWallet } from "@/components/providers/app-providers";
import { assertionsQueryKey } from "@/hooks/use-assertions";
import { balancesQueryKey } from "@/hooks/use-balances";
import { getPublicClient } from "@/lib/mezo-client";
import { describeError } from "@/lib/mezo-errors";
import { bondUnits, readAssertionOnChain, submitCoreWrite } from "@/lib/mezo-tx";
import { isUserRejection } from "@/lib/wallet-eip1193";

export type ResolveResult = keyof typeof RESOLVE_STATUS;

export type TxState = {
  phase: TxPhase | null;
  outcome: TxOutcome | null;
  error: string | null;
};

const IDLE: TxState = { phase: null, outcome: null, error: null };

/**
 * Shared executor for every MuoCore write.
 *
 * Refuses to run when configuration, wallet, or chain identity is not fully valid,
 * and never clears caller state on an uncertain outcome.
 */
export const useCoreTx = () => {
  const { config, issues } = useAppConfig();
  const { provider, address, chainId, connect, connected } = useWallet();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>(IDLE);

  const invalidate = useCallback(() => {
    if (!config) return;
    void queryClient.invalidateQueries({ queryKey: assertionsQueryKey(config.apiBaseUrl) });
    void queryClient.invalidateQueries({ queryKey: balancesQueryKey(config.chainId, config.musdAddress, address) });
  }, [config, queryClient, address]);

  const run = useCallback(
    async (build: (ctx: { coreAddress: Address; chainId: MezoChainId; musdAddress: Address }) => Promise<TxOutcome>): Promise<TxOutcome> => {
      if (!config) {
        const message = issues.length > 0 ? issues.map((i) => i.message).join(" ") : "The portal is not configured.";
        setState({ phase: null, outcome: null, error: message });
        return { status: "failed", reason: message };
      }
      if (!connected || !provider || !address) {
        const ok = await connect();
        if (!ok) {
          setState({ phase: null, outcome: null, error: "Connect a wallet to continue." });
          return { status: "cancelled" };
        }
        setState({ phase: null, outcome: null, error: "Wallet connected. Retry the action." });
        return { status: "cancelled" };
      }
      if (chainId !== config.chainId) {
        const message = `Your wallet is on chain ${chainId ?? "unknown"}; ${config.chainName} is required.`;
        setState({ phase: null, outcome: null, error: message });
        return { status: "failed", reason: message };
      }

      setState({ phase: "preparing", outcome: null, error: null });
      try {
        const outcome = await build({ coreAddress: config.coreAddress, chainId: config.chainId, musdAddress: config.musdAddress });
        if (outcome.status === "confirmed") {
          setState({ phase: "confirmed", outcome, error: null });
          invalidate();
        } else if (outcome.status === "uncertain") {
          setState({ phase: "uncertain", outcome, error: outcome.reason });
          invalidate();
        } else if (outcome.status === "cancelled") {
          setState({ phase: "cancelled", outcome, error: null });
        } else {
          setState({ phase: "failed", outcome, error: outcome.reason });
        }
        return outcome;
      } catch (error) {
        if (isUserRejection(error)) {
          setState({ phase: "cancelled", outcome: null, error: null });
          return { status: "cancelled" };
        }
        const message = describeError(error);
        setState({ phase: "failed", outcome: null, error: message });
        return { status: "failed", reason: message };
      }
    },
    [config, issues, connected, provider, address, chainId, connect, invalidate]
  );

  const reset = useCallback(() => setState(IDLE), []);

  return { state, run, reset };
};

const ctxFor = (
  provider: NonNullable<ReturnType<typeof useWallet>["provider"]>,
  config: NonNullable<ReturnType<typeof useAppConfig>["config"]>,
  address: Address
) => ({
  provider,
  chainId: config.chainId,
  coreAddress: config.coreAddress,
  musdAddress: config.musdAddress,
  publicClient: getPublicClient(config.chainId, config.rpcUrl),
  expectedAccount: address,
});

export type CreateAssertionInput = {
  identifier: Hex;
  claim: Hex;
  bondMusd: string;
  liveness: number | null;
};

/** Creates an assertion via approve + assertClaim. */
export const useCreateAssertion = () => {
  const { config } = useAppConfig();
  const { provider, address } = useWallet();
  const tx = useCoreTx();

  const mutate = useCallback(
    async (input: CreateAssertionInput): Promise<TxOutcome> =>
      tx.run(async () => {
        if (!provider || !address || !config) return { status: "failed", reason: "Wallet not connected." };
        const units = bondUnits(input.bondMusd);
        const liveness = BigInt(input.liveness ?? 0);
        const txCtx = ctxFor(provider, config, address);
        return submitCoreWrite(txCtx, {
          functionName: "assertClaim",
          args: [input.identifier, input.claim, BigInt(input.bondMusd), liveness],
          requiredUnits: units,
          expectedEvent: "Asserted",
          // No assertionId: the real id is derived on-chain from block.number and
          // is re-computed from the mined Asserted event during confirmation.
        });
      }),
    [tx, provider, address, config]
  );

  return { ...tx, mutate };
};

/** Disputes an assertion. The bond is read from the contract, never from cached data. */
export const useDisputeAssertion = (assertionId: Hex) => {
  const { config } = useAppConfig();
  const { provider, address } = useWallet();
  const tx = useCoreTx();

  const mutate = useCallback(
    async (): Promise<TxOutcome> =>
      tx.run(async () => {
        if (!provider || !address || !config) return { status: "failed", reason: "Wallet not connected." };
        const txCtx = ctxFor(provider, config, address);
        const live = await readAssertionOnChain(txCtx, assertionId);
        if (!live.exists) return { status: "failed", reason: "That assertion does not exist on-chain." };
        return submitCoreWrite(txCtx, {
          functionName: "dispute",
          args: [assertionId],
          requiredUnits: live.bondMusd * 10n ** 18n,
          expectedEvent: "Disputed",
          assertionId,
        });
      }),
    [tx, provider, address, config, assertionId]
  );

  return { ...tx, mutate };
};

/** Settles an uncontested assertion. Pulls no bond from the caller, so no approval. */
export const useSettleAssertion = (assertionId: Hex) => {
  const { config } = useAppConfig();
  const { provider, address } = useWallet();
  const tx = useCoreTx();

  const mutate = useCallback(
    async (): Promise<TxOutcome> =>
      tx.run(async () => {
        if (!provider || !address || !config) return { status: "failed", reason: "Wallet not connected." };
        const txCtx = ctxFor(provider, config, address);
        return submitCoreWrite(txCtx, {
          functionName: "settle",
          args: [assertionId],
          requiredUnits: 0n,
          expectedEvent: "Settled",
          assertionId,
        });
      }),
    [tx, provider, address, config, assertionId]
  );

  return { ...tx, mutate };
};

/** Resolves a disputed assertion as arbiter. Pulls no bond from the arbiter. */
export const useResolveAssertion = (assertionId: Hex) => {
  const { config } = useAppConfig();
  const { provider, address } = useWallet();
  const tx = useCoreTx();

  const mutate = useCallback(
    async (result: ResolveResult): Promise<TxOutcome> =>
      tx.run(async () => {
        if (!provider || !address || !config) return { status: "failed", reason: "Wallet not connected." };
        const txCtx = ctxFor(provider, config, address);
        return submitCoreWrite(txCtx, {
          functionName: "resolve",
          args: [assertionId, RESOLVE_STATUS[result]],
          requiredUnits: 0n,
          expectedEvent: result === "settled" ? "Settled" : result === "rejected" ? "Rejected" : "Unresolved",
          assertionId,
        });
      }),
    [tx, provider, address, config, assertionId]
  );

  return { ...tx, mutate };
};
