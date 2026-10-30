// REAL local-anvil integration tests for the portal's transaction orchestration.
//
// What is real here:
//  - a real anvil process (spawned by @muo/integration's fixture)
//  - real MuoCore + MockMUSD deployments
//  - real viem public/wallet clients built by `lib/mezo-client.ts`
//  - the portal's ACTUAL orchestration in `lib/mezo-tx.ts` (approve ordering,
//    simulation, receipt/event confirmation, uncertainty handling)
//  - real ERC-20 allowance consumption and native balance movement
//
// What is NOT proven here:
//  - this is NOT a browser extension, NOT EIP-6963 discovery, and NOT a live
//    Mezo network. `AnvilProvider` is a test adapter over local JSON-RPC.
//  - no private key is handled anywhere: anvil signs for its unlocked accounts.
//
// All balance assertions are DELTAS because tests share one chain.
//
// Assertion ids are read from MINED `Asserted` logs, never computed off-chain:
// the contract derives the id from `block.number`, so `identifier` is only an input.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeEventLog } from "viem";

import type { Address, Hex } from "@muo/core/native";
import { muoCoreAbi } from "@muo/core/abi";
import { MUSD_UNIT } from "@muo/core/native";
import { computeAssertionId } from "@muo/utils/native";

import type { TxContext } from "@/lib/mezo-tx";
import type { Fixture } from "@/test-support/integration";
import { getPublicClient, getWalletClient } from "@/lib/mezo-client";
import { assertFreshSession, ensureAllowance, readAssertionOnChain, submitCoreWrite } from "@/lib/mezo-tx";
import { AnvilProvider } from "@/test-support/anvil-provider";
import { deploy, loadArtifact, MuoCoreClient, MusdClient, mockMusdArtifact, send, startAnvil } from "@/test-support/integration";

const CHAIN_ID = 31611;
const BOND = 10n;
const BOND_UNITS = BOND * MUSD_UNIT;
const LIVENESS = 5n;
const CLAIM = `0x${"cc".repeat(64)}` as Hex;

let fx: Fixture;
let coreAddr: Address;
let musdAddr: Address;
let core: MuoCoreClient;
let musd: MusdClient;
let owner: Address;
let asserter: Address;
let disputer: Address;
let arbiter: Address;
let provider: AnvilProvider;
let publicClient: ReturnType<typeof getPublicClient>;

/** Builds a TxContext for `account`, mirroring what the hooks pass in. */
const ctxFor = (account: Address, p: AnvilProvider = provider): TxContext => ({
  provider: p,
  chainId: CHAIN_ID,
  coreAddress: coreAddr,
  musdAddress: musdAddr,
  publicClient: publicClient as unknown as TxContext["publicClient"],
  expectedAccount: account,
});

const musdBalance = (who: Address) => musd.balanceOf(who);
const escrowBalance = () => musd.balanceOf(coreAddr);

/** A provider whose selected account is `account`. */
const providerFor = (account: Address) => new AnvilProvider({ url: fx.url, accounts: fx.accounts as Address[], selectedIndex: fx.accounts.indexOf(account) });

/** Read the real assertion id from the mined `Asserted` log of `txHash`. */
async function assertedIdFrom(txHash: Hex): Promise<Hex> {
  const receipt = await fx.rpc.waitForReceipt(txHash);
  const logs = await fx.rpc.getLogs({ address: coreAddr, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
  for (const log of logs) {
    const decoded = decodeEventLog({ abi: muoCoreAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    if (decoded.eventName === "Asserted") return (decoded.args as { assertionId: Hex }).assertionId;
  }
  throw new Error(`no Asserted event in block ${receipt.blockNumber}`);
}

/** Assert through the real orchestration and return the real, mined assertion id. */
async function assertVia(account: Address, seed: string, bond = BOND, liveness = LIVENESS): Promise<Hex> {
  const identifier = computeAssertionId(`0x${seed.repeat(32)}`, CLAIM, bond, liveness, 0n);
  const outcome = await submitCoreWrite(ctxFor(account, providerFor(account)), {
    functionName: "assertClaim",
    args: [identifier, CLAIM, bond, liveness],
    requiredUnits: bond * MUSD_UNIT,
    expectedEvent: "Asserted",
  });
  if (outcome.status !== "confirmed") throw new Error(`assert failed: ${JSON.stringify(outcome)}`);
  return assertedIdFrom(outcome.hash);
}

/** Dispute through the real orchestration. */
async function disputeVia(account: Address, id: Hex) {
  const outcome = await submitCoreWrite(ctxFor(account, providerFor(account)), {
    functionName: "dispute",
    args: [id],
    requiredUnits: BOND_UNITS,
    expectedEvent: "Disputed",
    assertionId: id,
  });
  if (outcome.status !== "confirmed") throw new Error(`dispute failed: ${JSON.stringify(outcome)}`);
  return outcome;
}

beforeAll(async () => {
  fx = await startAnvil({ chainId: CHAIN_ID });
  [owner, asserter, disputer, arbiter] = fx.accounts as [Address, Address, Address, Address];

  const musdArtifact = mockMusdArtifact();
  musdAddr = (await deploy(fx.rpc, owner, musdArtifact.abi, musdArtifact.bytecode)) as Address;
  musd = new MusdClient(fx.rpc, musdAddr, musdArtifact.abi);

  const coreArtifact = loadArtifact("MuoCore", "MuoCore");
  coreAddr = (await deploy(fx.rpc, owner, coreArtifact.abi, coreArtifact.bytecode, [musdAddr])) as Address;
  core = new MuoCoreClient(fx.rpc, coreAddr);

  await send(fx.rpc, owner, coreAddr, core.addArbiterData(arbiter));
  await send(fx.rpc, owner, musdAddr, musd.mintData(asserter, 1_000n * MUSD_UNIT));
  await send(fx.rpc, owner, musdAddr, musd.mintData(disputer, 1_000n * MUSD_UNIT));

  provider = providerFor(asserter);
  publicClient = getPublicClient(CHAIN_ID, fx.url);
}, 120_000);

afterAll(async () => {
  await fx?.stop();
});

describe("real anvil: provider adapter", () => {
  test("forwards eth_chainId from the real chain", async () => {
    expect(await provider.request({ method: "eth_chainId" })).toBe(`0x${CHAIN_ID.toString(16)}`);
  });

  test("reports the selected unlocked account", async () => {
    expect(await provider.request({ method: "eth_accounts" })).toEqual([asserter]);
  });

  test("can simulate a user-rejected connect", async () => {
    const rejecting = new AnvilProvider({ url: fx.url, accounts: fx.accounts as Address[], rejectConnect: true });
    await expect(rejecting.request({ method: "eth_requestAccounts" })).rejects.toMatchObject({ code: 4001 });
  });

  test("viem wallet client signs via anvil without any private key", async () => {
    const wallet = getWalletClient(provider, CHAIN_ID, asserter);
    const hash = await wallet.writeContract({
      address: musdAddr,
      abi: musd.abi,
      functionName: "approve",
      args: [coreAddr, 0n],
      account: asserter,
      chain: wallet.chain,
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");
  });
});

describe("real anvil: assert -> dispute -> resolve", () => {
  test("assertClaim approves exactly one bond, then writes; escrow conserves", async () => {
    const identifier = computeAssertionId(`0x${"11".repeat(32)}`, CLAIM, BOND, LIVENESS, 0n);
    const before = await musdBalance(asserter);
    const sendsBefore = provider.count("eth_sendTransaction");

    const outcome = await submitCoreWrite(ctxFor(asserter), {
      functionName: "assertClaim",
      args: [identifier, CLAIM, BOND, LIVENESS],
      requiredUnits: BOND_UNITS,
      expectedEvent: "Asserted",
    });
    expect(outcome.status).toBe("confirmed");

    // Exactly two sends: approve, then assertClaim. This is the ordering proof.
    expect(provider.count("eth_sendTransaction") - sendsBefore).toBe(2);

    // The core call consumed the allowance via transferFrom, so zero afterwards
    // is correct -- and proves the approval was exactly one bond.
    expect(await musd.allowance(asserter, coreAddr)).toBe(0n);

    // Real balance movement: asserter down exactly one bond, escrow up by it.
    expect(before - (await musdBalance(asserter))).toBe(BOND_UNITS);
    expect(await escrowBalance()).toBeGreaterThanOrEqual(BOND_UNITS);

    // The mined assertion carries the bond we sent.
    if (outcome.status !== "confirmed") throw new Error("expected a confirmed outcome");
    const id = await assertedIdFrom(outcome.hash);
    const live = await readAssertionOnChain(ctxFor(asserter), id);
    expect(live.exists).toBe(true);
    expect(live.bondMusd).toBe(BOND);
    expect(live.status).toBe(0);
  }, 60_000);

  test("dispute pulls a second bond, then resolve(settled=2) pays the asserter 2x with no approval", async () => {
    const id = await assertVia(asserter, "21");

    const disputerBefore = await musdBalance(disputer);
    await disputeVia(disputer, id);
    expect(disputerBefore - (await musdBalance(disputer))).toBe(BOND_UNITS);
    expect((await readAssertionOnChain(ctxFor(disputer), id)).status).toBe(1);

    // Resolve as arbiter: no approval must be requested.
    const arbiterProvider = providerFor(arbiter);
    const sendsBefore = arbiterProvider.count("eth_sendTransaction");
    const asserterBefore = await musdBalance(asserter);
    const outcome = await submitCoreWrite(ctxFor(arbiter, arbiterProvider), {
      functionName: "resolve",
      args: [id, 2],
      requiredUnits: 0n,
      expectedEvent: "Settled",
      assertionId: id,
    });
    expect(outcome.status).toBe("confirmed");
    // Exactly one send (the resolve) -- no approve for settle/resolve.
    expect(arbiterProvider.count("eth_sendTransaction") - sendsBefore).toBe(1);
    expect((await musdBalance(asserter)) - asserterBefore).toBe(BOND * 2n * MUSD_UNIT);
    expect((await readAssertionOnChain(ctxFor(arbiter), id)).status).toBe(2);
  }, 60_000);

  test("resolve(rejected=3) pays the disputer 2x", async () => {
    const id = await assertVia(asserter, "22");
    await disputeVia(disputer, id);

    const before = await musdBalance(disputer);
    const outcome = await submitCoreWrite(ctxFor(arbiter, providerFor(arbiter)), {
      functionName: "resolve",
      args: [id, 3],
      requiredUnits: 0n,
      expectedEvent: "Rejected",
      assertionId: id,
    });
    expect(outcome.status).toBe("confirmed");
    expect((await musdBalance(disputer)) - before).toBe(BOND * 2n * MUSD_UNIT);
    expect((await readAssertionOnChain(ctxFor(arbiter), id)).status).toBe(3);
  }, 60_000);

  test("resolve(unresolved=4) refunds one bond to each party", async () => {
    const id = await assertVia(asserter, "23");
    await disputeVia(disputer, id);

    const [aBefore, dBefore] = [await musdBalance(asserter), await musdBalance(disputer)];
    const outcome = await submitCoreWrite(ctxFor(arbiter, providerFor(arbiter)), {
      functionName: "resolve",
      args: [id, 4],
      requiredUnits: 0n,
      expectedEvent: "Unresolved",
      assertionId: id,
    });
    expect(outcome.status).toBe("confirmed");
    expect((await musdBalance(asserter)) - aBefore).toBe(BOND_UNITS);
    expect((await musdBalance(disputer)) - dBefore).toBe(BOND_UNITS);
    expect((await readAssertionOnChain(ctxFor(arbiter), id)).status).toBe(4);
  }, 60_000);
});

describe("real anvil: expiry settle", () => {
  test("settle reverts inside the window and succeeds after it, pulling no bond", async () => {
    const id = await assertVia(asserter, "31", BOND, 3n);

    // Inside the window the contract must reject the settle.
    const early = await submitCoreWrite(ctxFor(asserter, providerFor(asserter)), {
      functionName: "settle",
      args: [id],
      requiredUnits: 0n,
      expectedEvent: "Settled",
      assertionId: id,
    });
    expect(early.status).toBe("failed");

    // Mine past the window, then settle.
    await fx.rpc.mine(5);
    const before = await musdBalance(asserter);
    const settled = await submitCoreWrite(ctxFor(asserter, providerFor(asserter)), {
      functionName: "settle",
      args: [id],
      requiredUnits: 0n,
      expectedEvent: "Settled",
      assertionId: id,
    });
    expect(settled.status).toBe("confirmed");
    expect((await musdBalance(asserter)) - before).toBe(BOND_UNITS);
    expect((await readAssertionOnChain(ctxFor(asserter), id)).status).toBe(2);
  }, 60_000);
});

describe("real anvil: safety invariants", () => {
  test("an account change after approval blocks the core write", async () => {
    const identifier = computeAssertionId(`0x${"41".repeat(32)}`, CLAIM, BOND, LIVENESS, 0n);
    const p = providerFor(asserter);
    const ctx = ctxFor(asserter, p);

    expect(await ensureAllowance(ctx, BOND_UNITS)).toEqual({ status: "ok" });
    p.selectAccount(fx.accounts.indexOf(disputer));

    await expect(assertFreshSession(ctx)).rejects.toThrow(/account changed/i);
    const outcome = await submitCoreWrite(ctx, {
      functionName: "assertClaim",
      args: [identifier, CLAIM, BOND, LIVENESS],
      requiredUnits: BOND_UNITS,
      expectedEvent: "Asserted",
    });
    expect(outcome.status).toBe("failed");
  }, 60_000);

  test("a chain change after approval blocks the core write", async () => {
    const identifier = computeAssertionId(`0x${"42".repeat(32)}`, CLAIM, BOND, LIVENESS, 0n);
    const p = providerFor(asserter);
    const ctx = ctxFor(asserter, p);
    await ensureAllowance(ctx, BOND_UNITS);

    const original = p.request.bind(p);
    p.request = async (args: { method: string; params?: unknown[] | object }) => (args.method === "eth_chainId" ? "0x7a69" : original(args)); // 31337

    await expect(assertFreshSession(ctx)).rejects.toThrow(/chain/i);
    const outcome = await submitCoreWrite(ctx, {
      functionName: "assertClaim",
      args: [identifier, CLAIM, BOND, LIVENESS],
      requiredUnits: BOND_UNITS,
      expectedEvent: "Asserted",
    });
    expect(outcome.status).toBe("failed");
  }, 60_000);

  test("a below-floor bond is rejected by simulation as failed, never confirmed", async () => {
    const identifier = computeAssertionId(`0x${"43".repeat(32)}`, CLAIM, 1n, LIVENESS, 0n);
    const outcome = await submitCoreWrite(ctxFor(asserter, providerFor(asserter)), {
      functionName: "assertClaim",
      args: [identifier, CLAIM, 1n, LIVENESS],
      requiredUnits: MUSD_UNIT,
      expectedEvent: "Asserted",
    });
    expect(outcome.status).toBe("failed");
  }, 60_000);

  test("a non-arbiter resolve is rejected", async () => {
    const id = await assertVia(asserter, "44");
    await disputeVia(disputer, id);
    const outcome = await submitCoreWrite(ctxFor(asserter, providerFor(asserter)), {
      functionName: "resolve",
      args: [id, 2],
      requiredUnits: 0n,
      expectedEvent: "Settled",
      assertionId: id,
    });
    expect(outcome.status).toBe("failed");
    expect((await readAssertionOnChain(ctxFor(asserter), id)).status).toBe(1);
  }, 60_000);

  test("a success receipt without the expected event is uncertain and keeps the hash", async () => {
    // Ask for an event the call will not emit: assertClaim emits Asserted, not Settled.
    const identifier = computeAssertionId(`0x${"45".repeat(32)}`, CLAIM, BOND, LIVENESS, 0n);
    const outcome = await submitCoreWrite(ctxFor(asserter, providerFor(asserter)), {
      functionName: "assertClaim",
      args: [identifier, CLAIM, BOND, LIVENESS],
      requiredUnits: BOND_UNITS,
      expectedEvent: "Settled", // deliberately wrong
    });
    expect(outcome.status).toBe("uncertain");
    if (outcome.status !== "uncertain") return;
    expect(outcome.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(outcome.reason).toContain("Settled");

    // The write DID land -- uncertainty is about confirmation, not submission.
    const receipt = await fx.rpc.waitForReceipt(outcome.hash);
    expect(receipt.status).toBe("0x1");

    // No automatic resubmit: the assertion exists exactly once.
    const id = await assertedIdFrom(outcome.hash);
    expect((await readAssertionOnChain(ctxFor(asserter), id)).exists).toBe(true);
  }, 60_000);

  test("a receipt timeout is uncertain, retains the hash, and does not resubmit", async () => {
    const identifier = computeAssertionId(`0x${"46".repeat(32)}`, CLAIM, BOND, LIVENESS, 0n);
    const p = providerFor(asserter);
    const sendsBefore = p.count("eth_sendTransaction");

    // Force the receipt wait to fail by making the public client time out.
    const realClient = publicClient;
    const brokenClient = {
      ...realClient,
      waitForTransactionReceipt: async () => {
        throw new Error("timeout");
      },
    };
    const ctx: TxContext = { ...ctxFor(asserter, p), publicClient: brokenClient as unknown as TxContext["publicClient"] };

    const outcome = await submitCoreWrite(ctx, {
      functionName: "assertClaim",
      args: [identifier, CLAIM, BOND, LIVENESS],
      requiredUnits: BOND_UNITS,
      expectedEvent: "Asserted",
    });

    expect(outcome.status).toBe("uncertain");
    if (outcome.status !== "uncertain") return;
    expect(outcome.hash).toMatch(/^0x[0-9a-f]{64}$/);

    // No automatic resubmit: at most one approval plus exactly one core write.
    // (The approval is skipped when a prior test left a sufficient allowance.)
    const sends = p.count("eth_sendTransaction") - sendsBefore;
    expect(sends).toBeGreaterThanOrEqual(1);
    expect(sends).toBeLessThanOrEqual(2);
  }, 60_000);
});
