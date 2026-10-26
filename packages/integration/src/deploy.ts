// Deploys the ALREADY-COMPILED MuoCore / MockMUSD artifacts onto the local
// anvil fixture using anvil's unlocked dev accounts.
//
// No private key is ever handled: deployment uses `eth_sendTransaction` from an
// address returned by `eth_accounts`, which anvil signs internally.
//
// Constructor calldata is built with viem's `encodeDeployData` against the real
// ABI, so a constructor-signature drift fails loudly instead of producing
// silently wrong bytecode.
//
// The artifacts are read from contracts/muo/out (produced by `forge build`).
// This module never recompiles and never deletes out/cache.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";
import { encodeDeployData } from "viem";

import type { RpcClient } from "./rpc.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** packages/integration/src -> repo root */
export const REPO_ROOT = resolve(here, "..", "..", "..");
export const CONTRACT_OUT = join(REPO_ROOT, "contracts", "muo", "out");

export type Artifact = { abi: Abi; bytecode: Hex };

/** Load a compiled artifact. Throws a clear error if `forge build` has not run. */
export function loadArtifact(contractFile: string, contractName: string): Artifact {
  const path = join(CONTRACT_OUT, `${contractFile}.sol`, `${contractName}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Missing artifact ${path}. Run: cd contracts/muo && forge build --offline`);
  }
  const json = JSON.parse(raw) as { abi: Abi; bytecode?: { object?: string } };
  const object = json.bytecode?.object ?? "";
  if (!object || object === "0x") throw new Error(`Artifact ${path} has no deployable bytecode`);
  return { abi: json.abi, bytecode: (object.startsWith("0x") ? object : `0x${object}`) as Hex };
}

/** Cached MockMUSD artifact, so the ABI is loaded once and shared. */
let mockMusd: Artifact | undefined;
export function mockMusdArtifact(): Artifact {
  mockMusd ??= loadArtifact("MockMUSD", "MockMUSD");
  return mockMusd;
}

/**
 * Deploy `abi`+`bytecode` with `args` and wait for the receipt.
 * Returns the deployed address.
 */
export async function deploy(rpc: RpcClient, from: string, abi: Abi, bytecode: Hex, args: readonly unknown[] = []): Promise<Hex> {
  // viem builds constructor calldata from the ABI; a wrong arg list throws here.
  const data = encodeDeployData({ abi, bytecode, args } as never) as Hex;

  // Contract creation: no `to` field at all.
  const hash = await rpc.sendTransaction({ from, data, gas: "0x1c9c380" }); // 30M
  const receipt = await rpc.waitForReceipt(hash);
  if (receipt.status !== "0x1") throw new Error(`Deployment reverted (tx ${hash})`);
  if (!receipt.contractAddress) throw new Error(`Deployment produced no contract address (tx ${hash})`);
  return receipt.contractAddress.toLowerCase() as Hex;
}

/**
 * Send a transaction from an unlocked account and return its receipt.
 *
 * IMPORTANT: anvil returns a tx hash for a reverting call and mines a FAILED
 * transaction (receipt.status === "0x0") rather than raising a JSON-RPC error.
 * So a caller that only awaits the receipt would treat a revert as success.
 * This helper therefore throws on any non-success status, which is what makes
 * `expect(send(...)).rejects.toThrow()` a meaningful assertion.
 *
 * Use `sendRaw` when you deliberately want the failed receipt (e.g. to inspect
 * revert data or gas).
 */
export async function send(rpc: RpcClient, from: string, to: string, data: Hex, gas = "0x2dc6c0") {
  const { hash, receipt } = await sendRaw(rpc, from, to, data, gas);
  if (receipt.status !== "0x1") {
    throw new Error(`Transaction reverted: ${hash} (status ${receipt.status})`);
  }
  return { hash, receipt };
}

/** Send without asserting success. Returns the receipt even when status is 0x0. */
export async function sendRaw(rpc: RpcClient, from: string, to: string, data: Hex, gas = "0x2dc6c0") {
  const hash = await rpc.sendTransaction({ from, to, data, gas });
  const receipt = await rpc.waitForReceipt(hash);
  return { hash, receipt };
}
