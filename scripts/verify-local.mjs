// One-command, resource-bounded local verification gate.
//
// Runs the durable local checks serially, in a fixed order, failing fast with a
// clear per-step name. Every child's real exit status, signal or timeout is
// honoured — a spawn error, a signal, or a null status is a FAILURE, never a
// pass. There is no "zero suites found" success path.
//
// Deliberately NOT included: any deploy, publish, upload, Git mutation, secret
// read, or public-chain transaction. Builds run locally and write only to
// ignored build output.
//
// Usage:
//   node scripts/verify-local.mjs            # full gate (default)
//   node scripts/verify-local.mjs --list     # print the step plan and exit
//
// The full gate is the only supported mode. A partial/fast profile is
// intentionally not offered: a partial run must never be reported as a pass.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The nine TypeScript configs that must all pass. */
export const TSCONFIGS = [
  "packages/api/tsconfig.json",
  "packages/app/tsconfig.json",
  "packages/app/tsconfig.test.json",
  "packages/core/tsconfig.json",
  "packages/event-listener/tsconfig.json",
  "packages/integration/tsconfig.json",
  "packages/sdk/tsconfig.json",
  "packages/utils/tsconfig.json",
  "packages/www/tsconfig.json",
];

/** Protected artifacts: these bytes must not drift. */
export const PROTECTED_HASHES = {
  "contracts/muo/contracts/MuoCore.sol": "b188e69030fea5a98b03e612e08f06759cbf0342330372de8d548039bb7275e9",
  "theme/theme.css": "cfa25464141d3dadfea2c3fecfc6daf0ee558e43798115946659aa78f9ad1531",
  "packages/core/src/abi.ts": "78355aadbf3eabbc3cf0ed5e8a10bb4868de9c6fdcaaf735d1148c416db88070",
};

/** The generated ABI shape that must be preserved. */
export const ABI_SHAPE = { total: 64, function: 55, event: 7, error: 1, constructor: 1 };

const BUN_TIMEOUT_MS = 600_000;
const TSC_TIMEOUT_MS = 300_000;
const LINT_TIMEOUT_MS = 300_000;
const RUNTIME_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 900_000;
const INSTALL_TIMEOUT_MS = 600_000;
const AUDIT_TIMEOUT_MS = 180_000;

/**
 * Resolve an executable from PATH, then from explicit fallbacks. Never mutates PATH.
 *
 * `extra` lets a caller add repo-relative candidates (Biome is a workspace
 * dependency, so its binary lives under a package's node_modules/.bin rather
 * than at the repo root).
 */
export function findBinary(name, { env = process.env, exists = existsSync, home = homedir(), extra = [] } = {}) {
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean)];
  // Pinned toolchain fallbacks. Bun and Foundry are commonly outside PATH in
  // non-interactive shells; these are the documented install locations.
  dirs.push(join(home, ".bun", "bin"), join(home, ".foundry", "bin"), join(home, ".local", "bin"));
  dirs.push(...extra);
  for (const directory of dirs) {
    const candidate = join(directory, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Repo-relative locations where a workspace-installed Biome binary may live. */
export const BIOME_CANDIDATES = ["node_modules/.bin", "packages/app/node_modules/.bin", "packages/www/node_modules/.bin", "packages/api/node_modules/.bin"];

/**
 * Build the ordered step plan.
 *
 * `root` is the repo root. Returns an array of steps; each step is
 * `{ name, bin, args, cwd, timeout }`. Nothing here mutates the repo.
 */
export function planSteps(root, { bun, node, biome, exists = existsSync } = {}) {
  const steps = [];
  const add = (name, bin, args, cwd, timeout) => steps.push({ name, bin, args, cwd, timeout });

  // 1. Preflight: the lockfile must already be consistent with the manifests.
  //    This is cheap (~10 ms when consistent) and it invalidates everything
  //    downstream, so it runs first rather than after the expensive builds.
  //    `--frozen-lockfile` refuses to rewrite the lock; `--ignore-scripts`
  //    keeps install-time lifecycle scripts from running.
  add("frozen install", bun, ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts"], root, INSTALL_TIMEOUT_MS);

  // 2. Workspace suites. `test-workspaces.mjs` runs ONLY the workspace test
  //    scripts; it does not invoke the Node guard tests. Those run once, in the
  //    next step, so nothing is executed twice.
  add("workspace suites", node, [join(root, "scripts", "test-workspaces.mjs")], root, BUN_TIMEOUT_MS);
  // 3. Node guard tests, exactly once (stage-source, test-workspaces, verify-local).
  add(
    "node guard tests",
    node,
    [
      "--test",
      join(root, "scripts", "__tests__", "stage-source.test.mjs"),
      join(root, "scripts", "__tests__", "test-workspaces.test.mjs"),
      join(root, "scripts", "__tests__", "verify-local.test.mjs"),
    ],
    root,
    TSC_TIMEOUT_MS
  );

  // 4. All nine TypeScript configs, one at a time.
  for (const config of TSCONFIGS) {
    if (!exists(join(root, config))) throw new Error(`Missing TypeScript config: ${config}`);
    add(`tsc ${config}`, bun, ["x", "tsc", "--noEmit", "-p", config], root, TSC_TIMEOUT_MS);
  }

  // 5. Biome over the repo.
  add("biome check", biome, ["check", "."], root, LINT_TIMEOUT_MS);

  // 6. Workers minified runtime smoke test.
  add("api runtime", bun, ["--no-env-file", "run", "--filter", "@muo/api", "test:runtime"], root, RUNTIME_TIMEOUT_MS);

  // 7. Production builds, one at a time.
  add("app build", bun, ["--no-env-file", "run", "--filter", "@muo/app", "build"], root, BUILD_TIMEOUT_MS);
  add("www build", bun, ["--no-env-file", "run", "--filter", "@muo/www", "build"], root, BUILD_TIMEOUT_MS);

  // 8. Registry advisory check (read-only; not a security guarantee).
  //    `--no-env-file` must precede the subcommand; `bun audit` itself has no
  //    such flag, but the top-level Bun launcher does.
  add("bun audit", bun, ["--no-env-file", "audit", "--json"], root, AUDIT_TIMEOUT_MS);

  return steps;
}

/**
 * Run one step. Returns `{ ok, code, detail }`.
 *
 * A spawn error, a signal, or a missing status is a failure. This is the single
 * place where "did it really pass?" is decided.
 */
export function runStep(step, { spawn = spawnSync, log = console.log } = {}) {
  log(`\n=== ${step.name} ===`);
  const result = spawn(step.bin, step.args, { cwd: step.cwd, stdio: "inherit", timeout: step.timeout });
  if (result.error) {
    const code = result.error.code === "ETIMEDOUT" ? "timeout" : result.error.message;
    log(`FAIL ${step.name}: ${code}`);
    return { ok: false, code: 1, detail: String(code) };
  }
  if (result.signal) {
    log(`FAIL ${step.name}: killed by ${result.signal}`);
    return { ok: false, code: 1, detail: `signal ${result.signal}` };
  }
  if (typeof result.status !== "number") {
    log(`FAIL ${step.name}: no exit status`);
    return { ok: false, code: 1, detail: "no exit status" };
  }
  if (result.status !== 0) {
    log(`FAIL ${step.name}: exit ${result.status}`);
    return { ok: false, code: result.status, detail: `exit ${result.status}` };
  }
  log(`PASS ${step.name}`);
  return { ok: true, code: 0, detail: "ok" };
}

/** Run every step serially, stopping at the first failure. */
export function runSteps(steps, { spawn = spawnSync, log = console.log } = {}) {
  for (const step of steps) {
    const result = runStep(step, { spawn, log });
    if (!result.ok) return { ok: false, failed: step.name, detail: result.detail };
  }
  return { ok: true, failed: null, detail: "ok" };
}

/** SHA-256 of a file, as lowercase hex. */
export function sha256File(path, { read = readFileSync } = {}) {
  return createHash("sha256").update(read(path)).digest("hex");
}

/**
 * Verify the protected artifacts and the generated ABI shape.
 * Returns `{ ok, problems[] }`.
 */
export function checkInvariants(root, { exists = existsSync, hash = sha256File, read = readFileSync } = {}) {
  const problems = [];
  for (const [relative, expected] of Object.entries(PROTECTED_HASHES)) {
    const path = join(root, relative);
    if (!exists(path)) {
      problems.push(`missing protected file: ${relative}`);
      continue;
    }
    const actual = hash(path, { read });
    if (actual !== expected) problems.push(`${relative} changed: ${actual} != ${expected}`);
  }

  const abiPath = join(root, "packages", "core", "src", "abi.ts");
  if (exists(abiPath)) {
    const source = read(abiPath, "utf8");
    const match = source.match(/export const muoCoreAbi = (\[[\s\S]*?\]) as const;/);
    if (!match) {
      problems.push("generated ABI export not found");
    } else {
      try {
        const entries = JSON.parse(match[1]);
        // Null-prototype map: a plain {} would inherit Object.prototype.constructor,
        // making counts["constructor"] a function instead of a number.
        const counts = Object.create(null);
        for (const entry of entries) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
        const shape = {
          total: entries.length,
          function: counts.function ?? 0,
          event: counts.event ?? 0,
          error: counts.error ?? 0,
          constructor: counts.constructor ?? 0,
        };
        for (const [key, expected] of Object.entries(ABI_SHAPE)) {
          if (shape[key] !== expected) problems.push(`ABI ${key} is ${shape[key]}, expected ${expected}`);
        }
      } catch {
        problems.push("generated ABI is not parseable JSON");
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  if (argv.includes("--list")) {
    const bun = findBinary("bun") ?? "bun";
    const node = process.execPath;
    const biome = findBinary("biome", { extra: BIOME_CANDIDATES.map((relative) => join(root, relative)) }) ?? "biome";
    for (const step of planSteps(root, { bun, node, biome })) console.log(`${step.name}: ${step.bin} ${step.args.join(" ")}`);
    return 0;
  }

  const bun = findBinary("bun");
  const biome = findBinary("biome", { extra: BIOME_CANDIDATES.map((relative) => join(root, relative)) });
  const node = process.execPath;
  if (!bun) {
    console.error("FAIL: bun not found on PATH, ~/.bun/bin, ~/.foundry/bin or ~/.local/bin");
    return 1;
  }
  if (!biome) {
    console.error("FAIL: biome not found on PATH or pinned fallbacks");
    return 1;
  }

  const invariants = checkInvariants(root);
  if (!invariants.ok) {
    console.error("FAIL protected invariants:");
    for (const problem of invariants.problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log("PASS protected invariants");

  let steps;
  try {
    steps = planSteps(root, { bun, node, biome });
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (steps.length === 0) {
    console.error("FAIL: no verification steps were planned");
    return 1;
  }

  const result = runSteps(steps);
  if (!result.ok) {
    console.error(`\nVERIFY-LOCAL FAILED at step: ${result.failed} (${result.detail})`);
    return 1;
  }
  console.log(`\nVERIFY-LOCAL PASSED: ${steps.length} steps`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "verify-local failed");
    process.exitCode = 1;
  }
}
