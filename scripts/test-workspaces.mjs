import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Serial execution keeps Foundry, Anvil and browser-related suites from
// competing for memory. Each actual child exit code determines the result.
export function workspaceTests(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const patterns = manifest.workspaces?.packages ?? manifest.workspaces;
  if (!Array.isArray(patterns) || patterns.length === 0) throw new Error("No workspace patterns configured");
  const suites = [];
  for (const pattern of patterns) {
    if (!/^[a-z-]+\/\*$/.test(pattern)) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, parent, entry.name);
      const file = join(directory, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim()) {
        suites.push({ name: pkg.name, directory, skipped: false });
      } else if (pkg.name === "@muo/www") {
        suites.push({ name: pkg.name, directory, skipped: true });
      } else {
        throw new Error(`Workspace ${pkg.name ?? directory} must declare a nonempty test script`);
      }
    }
  }
  if (!suites.some((suite) => !suite.skipped)) throw new Error("No workspace test suites found");
  return suites.sort((a, b) => a.directory.localeCompare(b.directory));
}

export function runWorkspaceTests(suites, { bun, spawn = spawnSync, log = console.log }) {
  let failed = false;
  for (const suite of suites) {
    if (suite.skipped) {
      log(`${suite.name}: no unit suite, validate with types/lint/build separately`);
      continue;
    }
    log(`\n=== ${suite.name} ===`);
    const result = spawn(bun, ["--no-env-file", "run", "test"], { cwd: suite.directory, stdio: "inherit", timeout: 600_000 });
    const code = result.error || result.signal ? 1 : (result.status ?? 1);
    failed ||= code !== 0;
    log(`${suite.name}: exit ${code}${result.signal ? ` (${result.signal})` : ""}`);
  }
  return failed ? 1 : 0;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const name = process.platform === "win32" ? "bun.exe" : "bun";
  const bun = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".bun", "bin")].map((directory) => join(directory, name)).find(existsSync);
  if (!bun) throw new Error("Bun not found on PATH or at ~/.bun/bin");
  process.exitCode = runWorkspaceTests(workspaceTests(root), { bun });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Workspace verification failed");
    process.exitCode = 1;
  }
}
