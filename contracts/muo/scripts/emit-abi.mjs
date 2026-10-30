// Generates packages/core/src/abi.ts from the compiled MuoCore artifact.
//
// Usage (from contracts/muo):
//   forge build && bun scripts/emit-abi.mjs
//   forge build && node scripts/emit-abi.mjs   (also works)
//
// The MuoCore ABI is copied verbatim from out/MuoCore.sol/MuoCore.json so the
// emitted TypeScript is exactly what solc produced: no reordering, no filtering,
// no rewriting of stateMutability. The `musdAbi` export is a hand-authored
// minimal ERC-20 + EIP-2612 surface because the real MUSD source is not vendored
// in this repository.
//
// Run this after any change to contracts/MuoCore.sol and commit the result.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractRoot = resolve(here, "..");
const repoRoot = resolve(contractRoot, "..", "..");
const artifactPath = resolve(contractRoot, "out", "MuoCore.sol", "MuoCore.json");
const outPath = resolve(repoRoot, "packages", "core", "src", "abi.ts");

/** Minimal MUSD surface the portal needs. Standard ERC-20 + EIP-2612 signatures. */
const musdAbi = [
  { type: "function", name: "name", inputs: [], outputs: [{ name: "", type: "string", internalType: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8", internalType: "uint8" }], stateMutability: "view" },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address", internalType: "address" },
      { name: "spender", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nonces",
    inputs: [{ name: "owner", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  { type: "function", name: "DOMAIN_SEPARATOR", inputs: [], outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }], stateMutability: "view" },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      { name: "from", type: "address", internalType: "address" },
      { name: "to", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "permit",
    inputs: [
      { name: "owner", type: "address", internalType: "address" },
      { name: "spender", type: "address", internalType: "address" },
      { name: "value", type: "uint256", internalType: "uint256" },
      { name: "deadline", type: "uint256", internalType: "uint256" },
      { name: "v", type: "uint8", internalType: "uint8" },
      { name: "r", type: "bytes32", internalType: "bytes32" },
      { name: "s", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true, internalType: "address" },
      { name: "to", type: "address", indexed: true, internalType: "address" },
      { name: "value", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      { name: "owner", type: "address", indexed: true, internalType: "address" },
      { name: "spender", type: "address", indexed: true, internalType: "address" },
      { name: "value", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
];

const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
if (!Array.isArray(artifact.abi)) {
  throw new Error(`No .abi array in ${artifactPath}. Did forge build succeed?`);
}

const muoCoreAbi = artifact.abi;
const fnCount = muoCoreAbi.filter((e) => e.type === "function").length;
const evCount = muoCoreAbi.filter((e) => e.type === "event").length;
const errCount = muoCoreAbi.filter((e) => e.type === "error").length;
const ctorCount = muoCoreAbi.filter((e) => e.type === "constructor").length;

const header = `// AUTO-GENERATED by contracts/muo/scripts/emit-abi.mjs -- do not edit by hand.
//
// Source: contracts/muo/contracts/MuoCore.sol
// Solidity: 0.8.28, evmVersion: london, optimizer 200 runs (see contracts/muo/foundry.toml)
// Regenerate with:  cd contracts/muo && forge build && bun scripts/emit-abi.mjs
//
// muoCoreAbi is solc's ABI output verbatim (${fnCount} functions, ${evCount} events, ${errCount} error(s), ${ctorCount} constructor).
// musdAbi is a hand-authored minimal ERC-20 + EIP-2612 surface; the MUSD source is not vendored here.
`;

const body = `${header}
export const muoCoreAbi = ${JSON.stringify(muoCoreAbi, null, 2)} as const;

export const musdAbi = ${JSON.stringify(musdAbi, null, 2)} as const;
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body, "utf8");
console.log(`Wrote ${outPath}`);
console.log(`muoCoreAbi: ${fnCount} functions, ${evCount} events, ${errCount} errors, ${ctorCount} constructor`);
console.log(`musdAbi: ${musdAbi.length} entries`);
