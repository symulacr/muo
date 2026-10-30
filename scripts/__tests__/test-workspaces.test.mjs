import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runWorkspaceTests, workspaceTests } from "../test-workspaces.mjs";

function fixture(packages, patterns = ["packages/*"]) {
  const root = mkdtempSync(join(tmpdir(), "muo-workspaces-"));
  mkdirSync(join(root, "packages"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: { packages: patterns } }));
  for (const [directory, pkg] of Object.entries(packages)) {
    mkdirSync(join(root, "packages", directory));
    writeFileSync(join(root, "packages", directory, "package.json"), JSON.stringify(pkg));
  }
  return root;
}

test("discovers every declared suite and explicitly identifies the landing-site exception", () => {
  const root = fixture({ core: { name: "@muo/core", scripts: { test: "bun test" } }, www: { name: "@muo/www" } });
  assert.deepEqual(
    workspaceTests(root).map(({ name, skipped }) => ({ name, skipped })),
    [
      { name: "@muo/core", skipped: false },
      { name: "@muo/www", skipped: true },
    ]
  );
});
test("rejects missing tests, empty test scripts, empty discovery and unsupported patterns", () => {
  assert.throws(() => workspaceTests(fixture({ new: { name: "@muo/new" } })), /must declare/);
  assert.throws(() => workspaceTests(fixture({ core: { scripts: { test: "  " } } })), /must declare/);
  assert.throws(() => workspaceTests(fixture({})), /No workspace/);
  assert.throws(() => workspaceTests(fixture({}, ["packages/**"])), /Unsupported/);
});
test("runs serially with environment autoload disabled and propagates an earlier failure", () => {
  const calls = [];
  const suites = [
    { name: "first", directory: "/first" },
    { name: "second", directory: "/second" },
  ];
  const code = runWorkspaceTests(suites, {
    bun: "/bun",
    log: () => {},
    spawn: (bin, args, options) => {
      calls.push({ bin, args, cwd: options.cwd });
      return { status: calls.length === 1 ? 7 : 0 };
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(
    calls,
    suites.map(({ directory }) => ({ bin: "/bun", args: ["--no-env-file", "run", "test"], cwd: directory }))
  );
});
test("spawn errors, signals and missing child exit statuses never become success", () => {
  for (const result of [{ error: new Error("missing") }, { signal: "SIGTERM", status: 0 }, { status: null }]) {
    assert.equal(runWorkspaceTests([{ name: "suite", directory: "/suite" }], { bun: "/bun", log: () => {}, spawn: () => result }), 1);
  }
});
test("successful suites pass and the documented no-test workspace is not spawned", () => {
  let calls = 0;
  assert.equal(
    runWorkspaceTests(
      [
        { name: "unit", directory: "/unit" },
        { name: "@muo/www", skipped: true },
      ],
      {
        bun: "/bun",
        log: () => {},
        spawn: () => {
          calls++;
          return { status: 0 };
        },
      }
    ),
    0
  );
  assert.equal(calls, 1);
});
