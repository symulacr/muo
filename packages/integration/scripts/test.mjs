#!/usr/bin/env node
// Standard `test` entry point for @muo/integration, so the root workspace
// verification (`bun run --filter '*' test`) actually runs these tests.
//
// Steps:
//   1. Ensure the compiled artifacts exist. If they are missing, build them via
//      the EXISTING safe contracts wrapper (contracts/muo/scripts/forge.mjs),
//      which only permits build/test/abi and can never deploy or broadcast.
//   2. Run `bun test` in this package.
//
// Deliberately no deploy, no network write, no private key, no env auto-load.
// The tests themselves start a local anvil on 127.0.0.1 and tear it down.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const contractRoot = join(repoRoot, "contracts", "muo");
const coreArtifact = join(contractRoot, "out", "MuoCore.sol", "MuoCore.json");
const musdArtifact = join(contractRoot, "out", "MockMUSD.sol", "MockMUSD.json");

function resolveOnPath(name, fallbackDir) {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  const fallback = join(fallbackDir, name);
  return existsSync(fallback) ? fallback : null;
}

// --- 1. Ensure artifacts -----------------------------------------------------
if (!existsSync(coreArtifact) || !existsSync(musdArtifact)) {
  console.log("[integration] artifacts missing; building via contracts/muo wrapper");
  const node = process.execPath;
  const wrapper = join(contractRoot, "scripts", "forge.mjs");
  if (!existsSync(wrapper)) {
    console.error(`[integration] missing ${wrapper}; cannot build artifacts`);
    process.exit(1);
  }
  // `build` is one of the wrapper's three allowed verbs.
  const res = spawnSync(node, [wrapper, "build"], { stdio: "inherit", cwd: contractRoot });
  if (res.status !== 0) {
    console.error("[integration] artifact build failed; cannot run integration tests");
    process.exit(res.status ?? 1);
  }
  if (!existsSync(coreArtifact) || !existsSync(musdArtifact)) {
    console.error("[integration] artifacts still missing after build");
    process.exit(1);
  }
}

// --- 2. Run the suite --------------------------------------------------------
const bun = resolveOnPath("bun", join(homedir(), ".bun", "bin"));
if (!bun) {
  console.error("[integration] bun not found on PATH or at ~/.bun/bin/bun");
  process.exit(1);
}

const res = spawnSync(bun, ["--no-env-file", "test", "--timeout", "120000"], { stdio: "inherit", cwd: pkgRoot });
process.exit(res.status ?? 1);
