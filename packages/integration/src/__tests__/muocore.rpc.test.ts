// MuoCore + native SDK integration tests against a LOCAL anvil dev chain.
//
// Scope and non-claims:
//  - LOCAL ONLY. This is an anvil dev chain, not Mezo testnet. Nothing here is
//    evidence of live Mezo equivalence, public RPC behaviour, or a real
//    end-to-end wallet flow.
//  - Deployment uses anvil's unlocked accounts via eth_sendTransaction. No
//    private key is handled by this code.
//  - Assertion ids are taken from MINED receipts (`eth_getLogs` on the mined
//    block), never from an `eth_call` simulation, because a simulated call runs
//    against the pending block and its id is not final.
//
// All balance assertions are DELTAS. Tests share one anvil chain, so absolute
// escrow totals would couple tests to execution order.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Hex } from "@muo/core/native";
import { muoCoreAbi } from "@muo/core/abi";
import { isAssertionEvent, MEZO_CHAIN_IDS, MUSD_UNIT } from "@muo/core/native";
import { decodeMuoLog, isMuoTopic, MUO_EVENT_SIGNATURES, MUO_TOPIC0 } from "@muo/sdk/native";
import { computeAssertionId } from "@muo/utils/native";

import type { Fixture } from "../fixture.ts";
import type { RpcLog } from "../rpc.ts";
import { decodeCall, encodeCall, MuoCoreClient, MusdClient, STATUS } from "../contracts.ts";
import { deploy, loadArtifact, mockMusdArtifact, send } from "../deploy.ts";
import { startAnvil } from "../fixture.ts";

const CHAIN_ID = MEZO_CHAIN_IDS.testnet; // 31611
const BOND = 10n; // whole MUSD, the contract floor
const BOND_UNITS = BOND * MUSD_UNIT;
const LIVENESS = 5n; // short window so settle is reachable by mining
const CLAIM = `0x${"cc".repeat(64)}` as Hex; // 64 bytes of arbitrary data
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

let fx: Fixture;
let core: MuoCoreClient;
let musd: MusdClient;
let coreAddr: Hex;
let musdAddr: Hex;
let owner: Hex;
let asserter: Hex;
let disputer: Hex;
let arbiter: Hex;

/** Fetch mined MuoCore logs for a block range. */
async function logsIn(fromBlock: bigint, toBlock: bigint): Promise<RpcLog[]> {
  return fx.rpc.getLogs({
    address: coreAddr,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
  });
}

/** Decode every MuoCore log in a single block. */
async function decodeBlock(blockNumber: string) {
  const logs = await logsIn(BigInt(blockNumber), BigInt(blockNumber));
  return logs.map((l) => decodeMuoLog(l, CHAIN_ID, coreAddr)).filter((e): e is NonNullable<typeof e> => e !== null);
}

/** Extract the first decoded event of a given name from a receipt's block. */
async function eventFromReceipt(receipt: { blockNumber: string }, name: string) {
  const decoded = await decodeBlock(receipt.blockNumber);
  const found = decoded.find((e) => e.event === name.toLowerCase());
  if (!found) {
    throw new Error(`no ${name} event in block ${receipt.blockNumber} (saw ${decoded.map((e) => e.event).join(",")})`);
  }
  return found;
}

/**
 * Approve EXACTLY `bond * 1e18` and assert.
 *
 * Bounded approvals are a property under test, not a workaround: because the
 * allowance is exactly one bond, every assertion needs a fresh approval. This
 * helper makes that explicit so a regression to an unbounded approval is visible.
 */
async function assertAs(actor: Hex, identifier: Hex, claim: Hex, bond: bigint, liveness: bigint) {
  const units = bond * MUSD_UNIT;
  await send(fx.rpc, actor, musdAddr, musd.approveData(coreAddr, units));
  const allowance = await musd.allowance(actor, coreAddr);
  if (allowance !== units) throw new Error(`approval not exact: ${allowance} != ${units}`);
  const { receipt } = await send(fx.rpc, actor, coreAddr, MuoCoreClient.assertClaimData(identifier, claim, bond, liveness));
  return receipt;
}

/** Assert as `asserter`, then dispute as `disputer`. Returns the assertion id. */
async function freshDisputed(seed: string): Promise<Hex> {
  const identifier = `0x${seed.repeat(32)}` as Hex;
  const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
  const ev = await eventFromReceipt(receipt, "Asserted");
  if (ev.event !== "asserted") throw new Error("unreachable");
  await send(fx.rpc, disputer, musdAddr, musd.approveData(coreAddr, BOND_UNITS));
  await send(fx.rpc, disputer, coreAddr, core.disputeData(ev.data.assertionId));
  return ev.data.assertionId;
}

beforeAll(async () => {
  fx = await startAnvil({ chainId: CHAIN_ID });
  [owner, asserter, disputer, arbiter] = fx.accounts as [Hex, Hex, Hex, Hex];

  // MockMUSD is a test-only contract, so its ABI comes from the locally
  // compiled artifact rather than an @muo/core export.
  const musdArtifact = mockMusdArtifact();
  musdAddr = await deploy(fx.rpc, owner, musdArtifact.abi, musdArtifact.bytecode);
  musd = new MusdClient(fx.rpc, musdAddr, musdArtifact.abi);

  // MuoCore's constructor takes the MUSD address; viem builds the calldata.
  const coreArtifact = loadArtifact("MuoCore", "MuoCore");
  coreAddr = await deploy(fx.rpc, owner, coreArtifact.abi, coreArtifact.bytecode, [musdAddr]);
  core = new MuoCoreClient(fx.rpc, coreAddr);

  // Only the DEPLOYER is seeded as arbiter by the constructor. Grant the
  // dedicated arbiter account explicitly, otherwise resolve() reverts
  // ERR_NOT_ARBITER.
  await send(fx.rpc, owner, coreAddr, core.addArbiterData(arbiter));

  await send(fx.rpc, owner, musdAddr, musd.mintData(asserter, 1_000n * MUSD_UNIT));
  await send(fx.rpc, owner, musdAddr, musd.mintData(disputer, 1_000n * MUSD_UNIT));
}, 120_000);

afterAll(async () => {
  await fx?.stop();
});

describe("fixture and deployment", () => {
  test("anvil is a local dev chain on the Mezo testnet chain id", async () => {
    expect(await fx.rpc.chainId()).toBe(`0x${CHAIN_ID.toString(16)}`);
    expect(fx.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("both contracts have code at their deployed addresses", async () => {
    expect(await fx.rpc.getCode(musdAddr)).not.toBe("0x");
    expect(await fx.rpc.getCode(coreAddr)).not.toBe("0x");
  });

  test("MockMUSD reports 18 decimals", async () => {
    expect(await musd.decimals()).toBe(18);
  });

  test("deployed ABI is the compiler ABI from @muo/core/abi", () => {
    // Widen to string[] so the loop variable is not narrowed to the ABI's
    // literal name union (which would reject an arbitrary `n` in toContain).
    const names: string[] = muoCoreAbi.filter((e) => e.type === "function").map((e) => String(e.name));
    for (const n of ["assertClaim", "dispute", "settle", "resolve", "getAssertion", "getMinBondSats", "deriveAssertionId"]) {
      expect(names).toContain(n);
    }
  });

  test("constructor seeds only the deployer as arbiter", async () => {
    expect(await core.contractOwner()).toBe(owner);
    expect(await core.isArbiter(owner)).toBe(true);
    expect(await core.isArbiter(arbiter)).toBe(true); // granted in beforeAll
    expect(await core.isArbiter(asserter)).toBe(false);
  });

  test("event topic0 constants match the human-readable signatures", () => {
    const { keccak_256 } = require("@noble/hashes/sha3");
    const { bytesToHex } = require("@noble/hashes/utils");
    for (const [name, sig] of Object.entries(MUO_EVENT_SIGNATURES)) {
      const derived = `0x${bytesToHex(keccak_256(new TextEncoder().encode(sig)))}`;
      expect(derived).toBe(MUO_TOPIC0[name as keyof typeof MUO_TOPIC0]);
      expect(isMuoTopic(derived)).toBe(true);
    }
  });
});

describe("MUSD funding and approvals", () => {
  test("mint fixture MUSD to asserter and disputer", async () => {
    expect(await musd.balanceOf(asserter)).toBe(1_000n * MUSD_UNIT);
    expect(await musd.balanceOf(disputer)).toBe(1_000n * MUSD_UNIT);
  });

  test("approval is exactly bond * 1e18 and funds only one assertion", async () => {
    await send(fx.rpc, asserter, musdAddr, musd.approveData(coreAddr, BOND_UNITS));
    expect(await musd.allowance(asserter, coreAddr)).toBe(BOND_UNITS);

    // An approval of exactly one bond cannot fund two assertions.
    await send(fx.rpc, asserter, coreAddr, MuoCoreClient.assertClaimData(`0x${"01".repeat(32)}` as Hex, CLAIM, BOND, LIVENESS));
    expect(await musd.allowance(asserter, coreAddr)).toBe(0n);
    await expect(send(fx.rpc, asserter, coreAddr, MuoCoreClient.assertClaimData(`0x${"02".repeat(32)}` as Hex, CLAIM, BOND, LIVENESS))).rejects.toThrow();
  });
});

describe("assert -> dispute -> resolve(2)", () => {
  let assertionId: Hex;
  let assertBlock: bigint;

  test("assertClaim with whole bond 10 escrows exactly 10e18 and emits a decodable event", async () => {
    const identifier = `0x${"bb".repeat(32)}` as Hex;
    const before = await musd.balanceOf(asserter);
    const escrowBefore = await musd.balanceOf(coreAddr);

    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    expect(receipt.status).toBe("0x1");
    assertBlock = BigInt(receipt.blockNumber);

    // Delta, not absolute: earlier tests may have left other bonds escrowed.
    expect(await musd.balanceOf(asserter)).toBe(before - BOND_UNITS);
    expect(await musd.balanceOf(coreAddr)).toBe(escrowBefore + BOND_UNITS);

    const ev = await eventFromReceipt(receipt, "Asserted");
    expect(ev.event).toBe("asserted");
    if (ev.event !== "asserted") throw new Error("unreachable");
    assertionId = ev.data.assertionId;

    expect(assertionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ev.data.bondMusd).toBe("10");
    expect(typeof ev.data.bondMusd).toBe("string");
    expect(ev.data.claim).toBe(CLAIM);
    expect(ev.data.identifier).toBe(identifier);
    expect(ev.data.assertedAtBlock).toBe(Number(assertBlock));

    expect(ev.provenance.chainId).toBe(CHAIN_ID);
    expect(ev.provenance.coreAddress).toBe(coreAddr);
    expect(ev.provenance.blockNumber).toBe(Number(assertBlock));
    expect(ev.provenance.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ev.provenance.transactionHash).toBe(receipt.transactionHash);
    expect(ev.provenance.transactionIndex).toBe(0);
    expect(typeof ev.provenance.logIndex).toBe("number");
  });

  test("receipt assertion id equals @muo/utils/native computeAssertionId at the real block", () => {
    const identifier = `0x${"bb".repeat(32)}` as Hex;
    expect(assertionId).toBe(computeAssertionId(identifier, CLAIM, BOND, LIVENESS, assertBlock));
  });

  test("getAssertion reads back the stored record", async () => {
    const a = await core.getAssertion(assertionId);
    expect(a.exists).toBe(true);
    expect(a.asserter).toBe(asserter);
    expect(a.disputer).toBe(ZERO);
    expect(a.bondMusd).toBe(BOND);
    expect(a.liveness).toBe(Number(LIVENESS));
    expect(a.status).toBe(STATUS.open);
    expect(a.assertedAtBlock).toBe(assertBlock);
  });

  test("dispute pulls a matching bond and emits Disputed", async () => {
    const before = await musd.balanceOf(disputer);
    const escrowBefore = await musd.balanceOf(coreAddr);

    await send(fx.rpc, disputer, musdAddr, musd.approveData(coreAddr, BOND_UNITS));
    const { receipt } = await send(fx.rpc, disputer, coreAddr, core.disputeData(assertionId));
    expect(receipt.status).toBe("0x1");

    expect(await musd.balanceOf(disputer)).toBe(before - BOND_UNITS);
    expect(await musd.balanceOf(coreAddr)).toBe(escrowBefore + BOND_UNITS);

    const ev = await eventFromReceipt(receipt, "Disputed");
    expect(ev.event).toBe("disputed");
    if (ev.event !== "disputed") throw new Error("unreachable");
    expect(ev.data.assertionId).toBe(assertionId);
    expect(ev.data.disputedBy).toBe(disputer);
    expect(ev.data.disputedAtBlock).toBe(Number(BigInt(receipt.blockNumber)));

    const a = await core.getAssertion(assertionId);
    expect(a.status).toBe(STATUS.disputed);
    expect(a.disputer).toBe(disputer);
  });

  test("resolve(2) pays the asserter 2 bonds and releases the escrowed pair", async () => {
    const a0 = await musd.balanceOf(asserter);
    const d0 = await musd.balanceOf(disputer);
    const escrowBefore = await musd.balanceOf(coreAddr);

    const { receipt } = await send(fx.rpc, arbiter, coreAddr, core.resolveData(assertionId, STATUS.settled));
    expect(receipt.status).toBe("0x1");

    expect(await musd.balanceOf(asserter)).toBe(a0 + 2n * BOND_UNITS);
    expect(await musd.balanceOf(disputer)).toBe(d0);
    expect(await musd.balanceOf(coreAddr)).toBe(escrowBefore - 2n * BOND_UNITS);

    const ev = await eventFromReceipt(receipt, "Settled");
    expect(ev.event).toBe("settled");
    if (ev.event !== "settled") throw new Error("unreachable");
    expect(ev.data.assertionId).toBe(assertionId);
    expect(ev.data.settledBy).toBe(arbiter);

    expect((await core.getAssertion(assertionId)).status).toBe(STATUS.settled);
  });
});

describe("resolve 3 and 4 distributions", () => {
  test("resolve(3) pays the disputer 2 bonds and releases the escrowed pair", async () => {
    const id = await freshDisputed("31");
    const a0 = await musd.balanceOf(asserter);
    const d0 = await musd.balanceOf(disputer);
    const escrowBefore = await musd.balanceOf(coreAddr);

    const { receipt } = await send(fx.rpc, arbiter, coreAddr, core.resolveData(id, STATUS.rejected));
    expect(receipt.status).toBe("0x1");

    expect(await musd.balanceOf(disputer)).toBe(d0 + 2n * BOND_UNITS);
    expect(await musd.balanceOf(asserter)).toBe(a0);
    expect(await musd.balanceOf(coreAddr)).toBe(escrowBefore - 2n * BOND_UNITS);

    const ev = await eventFromReceipt(receipt, "Rejected");
    expect(ev.event).toBe("rejected");
    if (ev.event !== "rejected") throw new Error("unreachable");
    expect(ev.data.rejectedBy).toBe(arbiter);
    expect((await core.getAssertion(id)).status).toBe(STATUS.rejected);
  });

  test("resolve(4) refunds one bond to each and releases the escrowed pair", async () => {
    const id = await freshDisputed("41");
    const a0 = await musd.balanceOf(asserter);
    const d0 = await musd.balanceOf(disputer);
    const escrowBefore = await musd.balanceOf(coreAddr);

    const { receipt } = await send(fx.rpc, arbiter, coreAddr, core.resolveData(id, STATUS.unresolved));
    expect(receipt.status).toBe("0x1");

    expect(await musd.balanceOf(asserter)).toBe(a0 + BOND_UNITS);
    expect(await musd.balanceOf(disputer)).toBe(d0 + BOND_UNITS);
    expect(await musd.balanceOf(coreAddr)).toBe(escrowBefore - 2n * BOND_UNITS);

    const ev = await eventFromReceipt(receipt, "Unresolved");
    expect(ev.event).toBe("unresolved");
    if (ev.event !== "unresolved") throw new Error("unreachable");
    expect(ev.data.unresolvedBy).toBe(arbiter);
    expect((await core.getAssertion(id)).status).toBe(STATUS.unresolved);
  });
});

describe("uncontested settle after the mined expiry", () => {
  test("settle reverts while the window is open, succeeds after expiry, returns the bond", async () => {
    const identifier = `0x${"77".repeat(32)}` as Hex;
    const receipt = await assertAs(asserter, identifier, CLAIM, BOND, LIVENESS);
    const ev = await eventFromReceipt(receipt, "Asserted");
    if (ev.event !== "asserted") throw new Error("unreachable");
    const id = ev.data.assertionId;
    const assertedAt = BigInt(receipt.blockNumber);

    // Still open: expiry is assertedAt + liveness, and we are at assertedAt.
    // `send` throws on a 0x0 receipt, so this is a real revert assertion.
    await expect(send(fx.rpc, owner, coreAddr, core.settleData(id))).rejects.toThrow();
    expect((await core.getAssertion(id)).status).toBe(STATUS.open);

    // Mine past the expiry, then settle permissionlessly from a third party.
    const now = BigInt(await fx.rpc.blockNumber());
    const target = assertedAt + LIVENESS;
    if (now <= target) await fx.rpc.mine(Number(target - now) + 1);

    const before = await musd.balanceOf(asserter);
    const escrowBefore = await musd.balanceOf(coreAddr);
    const { receipt: settleReceipt } = await send(fx.rpc, arbiter, coreAddr, core.settleData(id));
    expect(settleReceipt.status).toBe("0x1");

    expect(await musd.balanceOf(asserter)).toBe(before + BOND_UNITS);
    expect(await musd.balanceOf(coreAddr)).toBe(escrowBefore - BOND_UNITS);

    const settled = await eventFromReceipt(settleReceipt, "Settled");
    expect(settled.event).toBe("settled");
    if (settled.event !== "settled") throw new Error("unreachable");
    expect(settled.data.assertionId).toBe(id);
    expect((await core.getAssertion(id)).status).toBe(STATUS.settled);
  });
});

describe("escrow conservation across all terminal paths", () => {
  test("every resolved assertion releases exactly the 2 bonds it held", async () => {
    // Fresh pair, then verify the escrow returns to its pre-assert level after
    // resolve(4). This is the conservation invariant stated as a single delta.
    const escrowBefore = await musd.balanceOf(coreAddr);
    const id = await freshDisputed("51");
    expect(await musd.balanceOf(coreAddr)).toBe(escrowBefore + 2n * BOND_UNITS);
    await send(fx.rpc, arbiter, coreAddr, core.resolveData(id, STATUS.unresolved));
    expect(await musd.balanceOf(coreAddr)).toBe(escrowBefore);
  });
});

describe("SDK rejection surface", () => {
  let sampleLog: RpcLog;

  beforeAll(async () => {
    const logs = await logsIn(0n, BigInt(await fx.rpc.blockNumber()));
    const asserted = logs.find((l) => l.topics[0]?.toLowerCase() === MUO_TOPIC0.Asserted);
    if (!asserted) throw new Error("no Asserted log available for rejection tests");
    sampleLog = asserted;
  });

  test("wrong core address is out of scope (null)", () => {
    expect(decodeMuoLog(sampleLog, CHAIN_ID, `0x${"11".repeat(20)}` as Hex)).toBeNull();
  });

  test("unsupported chain id throws", () => {
    expect(() => decodeMuoLog(sampleLog, 999 as never, coreAddr)).toThrow();
  });

  test("malformed in-scope log throws rather than silently skipping", () => {
    expect(() => decodeMuoLog({ ...sampleLog, data: "0x1234" }, CHAIN_ID, coreAddr)).toThrow();
  });

  test("a reorg-removed log is skipped, not applied", () => {
    expect(decodeMuoLog({ ...sampleLog, removed: true }, CHAIN_ID, coreAddr)).toBeNull();
  });

  test("unknown topic0 is out of scope", () => {
    const other = { ...sampleLog, topics: [`0x${"ab".repeat(32)}`, ...sampleLog.topics.slice(1)] };
    expect(decodeMuoLog(other, CHAIN_ID, coreAddr)).toBeNull();
  });

  test("a log whose assertedAtBlock disagrees with its block is rejected", () => {
    // Corrupt the assertedAtBlock word (index 4 of the Asserted data head).
    const body = sampleLog.data.slice(2);
    const words = body.match(/.{64}/g) ?? [];
    if (words.length < 5) throw new Error("unexpected Asserted data shape");
    words[4] = (BigInt(`0x${words[4]}`) + 1n).toString(16).padStart(64, "0");
    const tampered = { ...sampleLog, data: `0x${words.join("")}` };
    expect(() => decodeMuoLog(tampered, CHAIN_ID, coreAddr)).toThrow();
  });

  test("decoded events satisfy the native AssertionEvent schema", async () => {
    const logs = await logsIn(0n, BigInt(await fx.rpc.blockNumber()));
    let count = 0;
    for (const l of logs) {
      const ev = decodeMuoLog(l, CHAIN_ID, coreAddr);
      if (ev) {
        expect(isAssertionEvent(ev)).toBe(true);
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
  });
});

describe("ABI decode hardening (viem)", () => {
  // A real, decodable getAssertion payload, captured from the chain so the
  // "good" case is genuine rather than a hand-built fixture.
  let good: Hex;

  beforeAll(async () => {
    // Use any existing assertion: the first Asserted log's id.
    const logs = await logsIn(0n, BigInt(await fx.rpc.blockNumber()));
    const first = logs.find((l) => l.topics[0]?.toLowerCase() === MUO_TOPIC0.Asserted);
    if (!first?.topics[1]) throw new Error("no Asserted id to seed decode tests");
    const seededId = first.topics[1] as Hex;
    good = await fx.rpc.ethCall(coreAddr, encodeCall(muoCoreAbi, "getAssertion", [seededId]));
  });

  test("a real getAssertion payload decodes to the documented struct shape", () => {
    const a = decodeCall<Record<string, unknown>>(muoCoreAbi, "getAssertion", good);
    expect(Object.keys(a).sort()).toEqual(
      [
        "asserter",
        "bondMusd",
        "assertedAtBlock",
        "disputedAtBlock",
        "disputer",
        "exists",
        "liveness",
        "rejectedAtBlock",
        "settledAtBlock",
        "status",
        "unresolvedAtBlock",
      ].sort()
    );
    expect(typeof a.exists).toBe("boolean");
    expect(typeof a.bondMusd).toBe("bigint");
  });

  test("empty return data is rejected, not silently defaulted", () => {
    expect(() => decodeCall(muoCoreAbi, "getAssertion", "0x")).toThrow();
  });

  test("truncated return data is rejected", () => {
    // One word short of the 11-word struct.
    const truncated = `0x${good.slice(2, 2 + 10 * 64)}` as Hex;
    expect(() => decodeCall(muoCoreAbi, "getAssertion", truncated)).toThrow();
  });

  test("over-long return data is TOLERATED by viem (documented, not a guarantee)", () => {
    // Finding: viem's decodeFunctionResult accepts trailing bytes and ignores
    // them. It does NOT reject a payload that is longer than the ABI expects.
    // This is recorded as a known property rather than asserted as an error,
    // because the harness must not encode a false expectation. Callers that
    // need strict length checking must compare data.length themselves.
    const extra = `0x${good.slice(2)}${"00".repeat(32)}` as Hex;
    const decoded = decodeCall<Record<string, unknown>>(muoCoreAbi, "getAssertion", extra);
    expect(decoded.exists).toBe(true);
    expect(extra.length).toBe(good.length + 64);
  });

  test("non-hex return data is rejected", () => {
    expect(() => decodeCall(muoCoreAbi, "getAssertion", "0xzzzz" as Hex)).toThrow();
  });

  test("unknown function name is rejected at encode time", () => {
    expect(() => encodeCall(muoCoreAbi, "notARealFunction", [])).toThrow();
  });

  test("wrong argument type is rejected at encode time", () => {
    // `dispute` takes bytes32; a number must not be coerced.
    expect(() => encodeCall(muoCoreAbi, "dispute", [123])).toThrow();
  });

  test("wrong argument count is rejected at encode time", () => {
    expect(() => encodeCall(muoCoreAbi, "resolve", [`0x${"00".repeat(32)}`])).toThrow();
  });

  test("uint8 status outside ABI range is rejected at encode time", () => {
    expect(() => encodeCall(muoCoreAbi, "resolve", [`0x${"00".repeat(32)}`, 256])).toThrow();
  });
});
