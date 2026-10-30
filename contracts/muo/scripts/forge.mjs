#!/usr/bin/env node
// Package-local wrapper that lets the root workspace `test` filter reach the
// Foundry suite.
//
// The root serial runner invokes each workspace's `test` script. This package
// previously exposed only `test:forge`, so aggregate workspace checks could
// silently exclude the contracts. This wrapper is the standard `test` entry.
//
// Scope: build / test / abi ONLY. There is deliberately no deploy, no broadcast,
// no network command, and no private-key handling here.
//
// forge resolution: PATH first, then ~/.foundry/bin/forge. PATH is never mutated.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveForge() {
  // 1. PATH
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, "forge");
    if (existsSync(candidate)) return candidate;
  }
  // 2. Foundry default install location
  const fallback = join(homedir(), ".foundry", "bin", "forge");
  if (existsSync(fallback)) return fallback;
  return null;
}

const forge = resolveForge();
if (!forge) {
  console.error("forge not found on PATH or at ~/.foundry/bin/forge");
  console.error("Install Foundry, or run the suite directly from contracts/muo.");
  process.exit(1);
}

const [mode = "test", ...rest] = process.argv.slice(2);

// Only these verbs are allowed. Anything else is refused so this wrapper can
// never be used to deploy or broadcast.
const ALLOWED = new Set(["build", "test", "abi"]);

if (!ALLOWED.has(mode)) {
  console.error(`Refusing unknown mode "${mode}". Allowed: ${[...ALLOWED].join(", ")}`);
  process.exit(2);
}

const run = (args) => {
  const res = spawnSync(forge, args, { stdio: "inherit", cwd: process.cwd() });
  if (res.error) {
    console.error(`Failed to run forge: ${res.error.message}`);
    process.exit(1);
  }
  return res.status ?? 1;
};

if (mode === "build") {
  process.exit(run(["build", ...rest]));
}

if (mode === "test") {
  process.exit(run(["test", ...rest]));
}

// mode === "abi": build, then regenerate packages/core/src/abi.ts.
const buildStatus = run(["build"]);
if (buildStatus !== 0) process.exit(buildStatus);

// Resolve bun the same way as forge: PATH first, then ~/.bun/bin/bun.
function resolveBun() {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, "bun");
    if (existsSync(candidate)) return candidate;
  }
  const fallback = join(homedir(), ".bun", "bin", "bun");
  return existsSync(fallback) ? fallback : null;
}

const bun = resolveBun();
if (!bun) {
  console.error("bun not found on PATH or at ~/.bun/bin/bun (needed for abi generation)");
  process.exit(1);
}

const res = spawnSync(bun, ["--no-env-file", "scripts/emit-abi.mjs"], { stdio: "inherit", cwd: process.cwd() });
process.exit(res.status ?? 1);
