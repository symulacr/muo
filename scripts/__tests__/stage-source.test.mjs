import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { selectTrackedPaths, shouldIncludePath, stageFiles } from "../stage-source.mjs";

test("allowlist includes actual monorepo build inputs", () => {
  for (const path of [
    "package.json",
    "bun.lock",
    "theme/theme.css",
    "packages/app/src/app/page.tsx",
    "packages/api/.migrations/0003_native.sql",
    "packages/api/wrangler.jsonc",
    "packages/core/src/native.ts",
    "packages/integration/src/fixture.ts",
    "packages/integration/package.json",
    "contracts/muo/contracts/MuoCore.sol",
    "packages/www/public/MUO-Pitch-Deck.pdf",
    "packages/app/.env.example",
    ".github/workflows/check.yml",
  ])
    assert.equal(shouldIncludePath(path), true, path);
});
test("never allow real env/key/generated/local files", () => {
  for (const path of [
    ".env",
    ".env.dev",
    "packages/app/.env.local",
    "packages/api/.dev.vars",
    "packages/app/wallet.key",
    "packages/core/key.pem",
    "packages/app/id_rsa",
    "node_modules/x/index.js",
    "packages/app/.next/server.js",
    "contracts/muo/out/MuoCore.json",
    "packages/integration/.env.local",
    "outputs/report.pdf",
    ".claude/report.md",
    "packages/docs/private.md",
    "stubs/inert-base-account/index.js",
    "patches/base-x@5.0.1.patch",
    "../package.json",
    "/etc/passwd",
    "packages/core/../../.env.dev",
    "packages\\core\\src\\x.ts",
  ])
    assert.equal(shouldIncludePath(path), false, path);
});
test("staging uses current approved files and preserves theme bytes and hashes", () => {
  const temp = mkdtempSync(join(tmpdir(), "muo-stage-test-")),
    repo = join(temp, "repo");
  const sources = {
    "package.json": '{"name":"fixture"}',
    "theme/theme.css": ":root{--primary:red}",
    "packages/core/src/native.ts": "export const n = 2;\n",
    "packages/core/.env.example": "PUBLIC_VALUE=placeholder\n",
    ".env.dev": "DO_NOT_COPY_THIS_FIXTURE\n",
  };
  for (const [rel, body] of Object.entries(sources)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  const result = stageFiles({ repoRoot: repo, artifactRoot: join(temp, "artifact"), files: Object.keys(sources) });
  assert.equal(result.scanState, "not-run");
  assert.equal(result.files.length, 4);
  assert.equal(existsSync(join(result.sourceDir, ".env.dev")), false);
  for (const row of result.files) {
    const body = readFileSync(join(result.sourceDir, row.path));
    assert.equal(body.toString(), sources[row.path]);
    assert.equal(row.sha256, createHash("sha256").update(body).digest("hex"));
  }
});
test("refuses an output inside source or an existing artifact", () => {
  const temp = mkdtempSync(join(tmpdir(), "muo-stage-test-")),
    repo = join(temp, "repo");
  mkdirSync(repo);
  assert.throws(() => stageFiles({ repoRoot: repo, artifactRoot: join(repo, "artifact"), files: [] }));
  assert.throws(() => stageFiles({ repoRoot: repo, artifactRoot: repo, files: [] }));
  mkdirSync(join(temp, "existing"));
  assert.throws(() => stageFiles({ repoRoot: repo, artifactRoot: join(temp, "existing"), files: [] }));
});
test("refuses both file and directory symlinks before copying", () => {
  const temp = mkdtempSync(join(tmpdir(), "muo-stage-test-")),
    repo = join(temp, "repo");
  mkdirSync(join(repo, "packages/core/src"), { recursive: true });
  writeFileSync(join(temp, "outside.ts"), "not an approved source path");
  symlinkSync(join(temp, "outside.ts"), join(repo, "packages/core/src/link.ts"));
  assert.throws(() => stageFiles({ repoRoot: repo, artifactRoot: join(temp, "file-link"), files: ["packages/core/src/link.ts"] }), /symlink/);
  mkdirSync(join(temp, "outside"));
  writeFileSync(join(temp, "outside/data.ts"), "not an approved directory");
  symlinkSync(join(temp, "outside"), join(repo, "packages/core/shared"));
  assert.throws(() => stageFiles({ repoRoot: repo, artifactRoot: join(temp, "dir-link"), files: ["packages/core/shared/data.ts"] }), /symlink/);
});

test("CLI requires reviewed tracked source instead of automatically including new files", () => {
  assert.throws(() => selectTrackedPaths(["package.json"], ["packages/core/src/new.ts"]), /Review and stage/);
  assert.throws(() => selectTrackedPaths(["package.json"], ["packages/integration/src/fixture.ts"]), /Review and stage/);
  assert.deepEqual(selectTrackedPaths(["package.json"], [".env.dev", "outputs/private.pdf"]), ["package.json"]);
});
test("tracked real environment/key material blocks staging rather than being hidden", () => {
  assert.throws(() => selectTrackedPaths(["package.json", ".env.dev"], []), /Forbidden/);
  assert.throws(() => selectTrackedPaths(["packages/core/wallet.key"], []), /Forbidden/);
  assert.deepEqual(selectTrackedPaths(["packages/app/.env.example"], []), ["packages/app/.env.example"]);
});
