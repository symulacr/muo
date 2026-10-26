import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ABI_SHAPE, BIOME_CANDIDATES, checkInvariants, findBinary, PROTECTED_HASHES, planSteps, runStep, runSteps, TSCONFIGS } from "../verify-local.mjs";

/** Minimal fake repo root with the nine tsconfigs present. */
function fixtureRoot({ tsconfigs = TSCONFIGS } = {}) {
  const root = mkdtempSync(join(tmpdir(), "muo-verify-"));
  mkdirSync(join(root, "scripts", "__tests__"), { recursive: true });
  for (const config of tsconfigs) {
    mkdirSync(join(root, config, ".."), { recursive: true });
    writeFileSync(join(root, config), "{}");
  }
  return root;
}

const NOOP = () => {};

test("plans the full gate: tests, all nine tsconfigs, biome, runtime, both builds, install, audit", () => {
  const root = fixtureRoot();
  const steps = planSteps(root, { bun: "/bun", node: "/node", biome: "/biome" });
  const names = steps.map((step) => step.name);

  // Preflight first: a stale lockfile invalidates everything downstream, so it
  // is checked before the expensive steps rather than after them.
  assert.equal(names[0], "frozen install");

  // Then the two test stages, which are distinct: one runs the workspace
  // suites only, the other runs the Node guard tests exactly once.
  assert.equal(names[1], "workspace suites");
  assert.equal(names[2], "node guard tests");
  assert.equal(names.filter((name) => name === "node guard tests").length, 1, "guards must run exactly once");
  assert.equal(names.filter((name) => name === "workspace suites").length, 1, "workspaces must run exactly once");

  // Exactly the nine TypeScript configs, one step each.
  const tscNames = names.filter((name) => name.startsWith("tsc "));
  assert.deepEqual(
    tscNames,
    TSCONFIGS.map((config) => `tsc ${config}`)
  );
  assert.equal(tscNames.length, 9);

  // The remaining required stages are present exactly once.
  for (const required of ["biome check", "api runtime", "app build", "www build", "frozen install", "bun audit"]) {
    assert.equal(names.filter((name) => name === required).length, 1, `missing or duplicated: ${required}`);
  }

  // Builds are separate serial steps, never combined.
  assert.notEqual(names.indexOf("app build"), names.indexOf("www build"));

  // Preflight ordering: the lock check must precede both builds.
  assert.ok(names.indexOf("frozen install") < names.indexOf("app build"));
  assert.ok(names.indexOf("frozen install") < names.indexOf("www build"));
});

test("every step carries a bounded timeout and an absolute binary", () => {
  const steps = planSteps(fixtureRoot(), { bun: "/bun", node: "/node", biome: "/biome" });
  for (const step of steps) {
    assert.equal(typeof step.timeout, "number");
    assert.ok(step.timeout > 0, `${step.name} has no timeout`);
    assert.ok(step.timeout <= 900_000, `${step.name} timeout is unbounded`);
    assert.ok(step.bin.startsWith("/"), `${step.name} binary is not absolute: ${step.bin}`);
  }
});

test("nested Bun invocations disable environment autoload", () => {
  const steps = planSteps(fixtureRoot(), { bun: "/bun", node: "/node", biome: "/biome" });
  for (const step of steps.filter((s) => s.bin === "/bun")) {
    // `bun x tsc` has no env-loading phase; every other bun call must opt out.
    if (step.args[0] === "x") continue;
    assert.ok(step.args.includes("--no-env-file"), `${step.name} does not disable env autoload`);
  }
});

test("no step can deploy, publish, stage or mutate Git", () => {
  const steps = planSteps(fixtureRoot(), { bun: "/bun", node: "/node", biome: "/biome" });
  const forbidden = ["deploy", "publish", "upload", "push", "commit", "stage:source", "wrangler"];
  for (const step of steps) {
    const line = [step.bin, ...step.args].join(" ").toLowerCase();
    for (const verb of forbidden) {
      assert.ok(!line.includes(verb), `${step.name} contains forbidden verb "${verb}": ${line}`);
    }
  }
});

test("a missing tsconfig fails planning instead of silently skipping the check", () => {
  const root = fixtureRoot({ tsconfigs: TSCONFIGS.filter((c) => c !== "packages/sdk/tsconfig.json") });
  assert.throws(() => planSteps(root, { bun: "/bun", node: "/node", biome: "/biome" }), /Missing TypeScript config/);
});

test("runs steps serially in declared order", () => {
  const order = [];
  const steps = [
    { name: "a", bin: "/x", args: [], cwd: "/", timeout: 1 },
    { name: "b", bin: "/x", args: [], cwd: "/", timeout: 1 },
    { name: "c", bin: "/x", args: [], cwd: "/", timeout: 1 },
  ];
  const result = runSteps(steps, {
    log: NOOP,
    spawn: (_bin, _args, options) => {
      order.push(options.cwd);
      return { status: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(order.length, 3);
});

test("fails fast: a failing step stops the run and names the step", () => {
  let calls = 0;
  const steps = [
    { name: "first", bin: "/x", args: [], cwd: "/", timeout: 1 },
    { name: "second", bin: "/x", args: [], cwd: "/", timeout: 1 },
    { name: "third", bin: "/x", args: [], cwd: "/", timeout: 1 },
  ];
  const result = runSteps(steps, {
    log: NOOP,
    spawn: () => {
      calls++;
      return { status: calls === 2 ? 3 : 0 };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failed, "second");
  assert.equal(calls, 2, "must not run steps after the failure");
});

test("spawn errors, signals, timeouts and missing statuses are failures, never passes", () => {
  const step = { name: "s", bin: "/x", args: [], cwd: "/", timeout: 1 };
  const cases = [
    { error: new Error("ENOENT") },
    { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) },
    { signal: "SIGTERM", status: 0 },
    { signal: "SIGKILL", status: null },
    { status: null },
    { status: undefined },
    { status: 1 },
  ];
  for (const result of cases) {
    const outcome = runStep(step, { log: NOOP, spawn: () => result });
    assert.equal(outcome.ok, false, `should fail for ${JSON.stringify(result)}`);
  }
});

test("a clean zero exit is the only pass", () => {
  const step = { name: "s", bin: "/x", args: [], cwd: "/", timeout: 1 };
  assert.equal(runStep(step, { log: NOOP, spawn: () => ({ status: 0 }) }).ok, true);
});

test("propagates the child's real exit code rather than flattening it", () => {
  const step = { name: "s", bin: "/x", args: [], cwd: "/", timeout: 1 };
  assert.equal(runStep(step, { log: NOOP, spawn: () => ({ status: 42 }) }).code, 42);
});

test("resolves binaries from PATH first, then pinned fallbacks, without mutating PATH", () => {
  const env = { PATH: "/only/here" };
  const present = new Set(["/only/here/bun", "/home/u/.bun/bin/biome"]);
  const exists = (p) => present.has(p);
  assert.equal(findBinary("bun", { env, exists, home: "/home/u" }), "/only/here/bun");
  assert.equal(findBinary("biome", { env, exists, home: "/home/u" }), "/home/u/.bun/bin/biome");
  assert.equal(findBinary("missing", { env, exists, home: "/home/u" }), null);
  assert.equal(env.PATH, "/only/here", "PATH must not be mutated");
});

test("biome fallbacks include workspace node_modules locations", () => {
  const root = "/repo";
  const env = { PATH: "" };
  const target = join(root, "packages/app/node_modules/.bin/biome");
  const exists = (p) => p === target;
  const extra = BIOME_CANDIDATES.map((relative) => join(root, relative));
  assert.equal(findBinary("biome", { env, exists, home: "/home/u", extra }), target);
});

test("invariants detect a changed protected file", () => {
  const root = fixtureRoot();
  const abi = `export const muoCoreAbi = ${JSON.stringify([
    { type: "constructor" },
    ...Array.from({ length: ABI_SHAPE.function }, () => ({ type: "function" })),
    ...Array.from({ length: ABI_SHAPE.event }, () => ({ type: "event" })),
    ...Array.from({ length: ABI_SHAPE.error }, () => ({ type: "error" })),
  ])} as const;`;
  mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
  writeFileSync(join(root, "packages", "core", "src", "abi.ts"), abi);

  // Hash each protected file to its OWN expected value -> ok.
  const perFile = (p) => {
    const match = Object.entries(PROTECTED_HASHES).find(([relative]) => p.endsWith(relative));
    return match ? match[1] : "unexpected";
  };
  const good = checkInvariants(root, { exists: () => true, hash: perFile, read: () => abi });
  assert.equal(good.ok, true, JSON.stringify(good.problems));

  // One drifted hash -> reported, not ignored.
  const bad = checkInvariants(root, {
    exists: () => true,
    hash: (p) => (p.endsWith("MuoCore.sol") ? "deadbeef" : perFile(p)),
    read: () => abi,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes("MuoCore.sol")));
  assert.equal(bad.problems.length, 1, "only the drifted file should be reported");
});

test("invariants detect a wrong ABI shape and unparseable ABI", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
  // Every protected file matches its own expected hash, so only the ABI shape can fail.
  const perFile = (p) => {
    const match = Object.entries(PROTECTED_HASHES).find(([relative]) => p.endsWith(relative));
    return match ? match[1] : "unexpected";
  };

  const wrongShape = `export const muoCoreAbi = ${JSON.stringify([{ type: "function" }])} as const;`;
  writeFileSync(join(root, "packages", "core", "src", "abi.ts"), wrongShape);
  const shape = checkInvariants(root, { exists: () => true, hash: perFile });
  assert.equal(shape.ok, false);
  assert.ok(shape.problems.some((p) => p.includes("ABI")));

  const unparseable = "export const muoCoreAbi = [not json] as const;";
  writeFileSync(join(root, "packages", "core", "src", "abi.ts"), unparseable);
  const broken = checkInvariants(root, { exists: () => true, hash: perFile });
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some((p) => p.includes("not parseable")));
});

test("invariants report a missing protected file", () => {
  const root = fixtureRoot();
  const result = checkInvariants(root, { exists: () => false, hash: () => "", read: () => "" });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.startsWith("missing protected file")));
});

test("the gate itself is never a step, so it cannot recurse", () => {
  const steps = planSteps(fixtureRoot(), { bun: "/bun", node: "/node", biome: "/biome" });
  for (const step of steps) {
    assert.ok(!step.args.some((arg) => String(arg).includes("verify-local.mjs")), `step ${step.name} invokes the gate`);
  }
});
