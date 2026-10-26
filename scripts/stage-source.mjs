import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_FILES = new Set([
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "biome.json",
  "biome.next.json",
  "tsconfig.lib.json",
  "tsconfig.next.json",
  "README.md",
  "LICENSE",
  ".gitignore",
  ".vercelignore",
]);
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".css",
  ".svg",
  ".png",
  ".ico",
  ".webmanifest",
  ".pdf",
  ".sql",
  ".toml",
  ".md",
  ".sol",
  ".patch",
  ".yml",
  ".yaml",
]);
const BLOCKED_DIRS = new Set([".git", ".claude", ".next", ".vercel", ".wrangler", "node_modules", "out", "dist", "cache", "coverage", "broadcast", "outputs"]);
const inTree = (root, path) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

export function shouldIncludePath(path) {
  if (!path || isAbsolute(path) || /[\\\r\n\0]/.test(path)) return false;
  const parts = path.split("/");
  if (parts.some((p) => p === "." || p === ".." || BLOCKED_DIRS.has(p))) return false;
  const name = parts.at(-1);
  if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") return false;
  if (name === ".dev.vars" || /(?:^id_rsa|^id_ed25519|\.pem$|\.key$|^wallet\.dat$)/i.test(name)) return false;
  if (ROOT_FILES.has(path)) return true;
  if (!/^(?:packages\/(?:app|www|api|core|utils|sdk|event-listener|integration)|contracts\/muo|scripts|theme|docs|\.github\/workflows)\//.test(path))
    return false;
  return name === ".env.example" || name === ".gitignore" || name === ".vercelignore" || EXTENSIONS.has(extname(name));
}

export function selectTrackedPaths(cached, untracked) {
  const forbidden = cached.some((p) => {
    const name = p.split("/").at(-1);
    return (
      ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") ||
      name === ".dev.vars" ||
      /(?:^id_rsa|^id_ed25519|\.pem$|\.key$|^wallet\.dat$)/i.test(name)
    );
  });
  if (forbidden) throw new Error("Forbidden environment/key material is tracked; staging refused");
  if (untracked.some(shouldIncludePath)) throw new Error("Review and stage new source files in Git before producing a deployment artifact");
  return cached.filter(shouldIncludePath);
}

function assertRegularSource(root, rel) {
  let current = root;
  for (const part of rel.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink: ${rel}`);
  }
  if (!lstatSync(current).isFile()) throw new Error(`Expected a regular file: ${rel}`);
  return current;
}

// A copied artifact is explicitly unscanned until the CLI's mandatory scanner succeeds.
export function stageFiles({ repoRoot, artifactRoot, files }) {
  const root = resolve(repoRoot),
    output = resolve(artifactRoot);
  if (output === root || inTree(root, output)) throw new Error("Staging must be outside the repository");
  if (existsSync(output)) throw new Error("Refusing to overwrite an existing staging directory");
  const selected = [...new Set(files)].filter(shouldIncludePath).sort();
  for (const rel of selected) assertRegularSource(root, rel);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const manifest = [];
  for (const rel of selected) {
    const source = assertRegularSource(root, rel);
    const target = resolve(output, rel);
    if (!inTree(output, target)) throw new Error("Invalid artifact target");
    const bytes = readFileSync(source);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: "wx" });
    manifest.push({ path: rel, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { sourceDir: output, scanState: "not-run", files: manifest };
}

function main() {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const cached = execFileSync("git", ["-C", root, "ls-files", "--cached", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const untracked = execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const paths = selectTrackedPaths(cached, untracked);
  const directory = mkdtempSync(join(tmpdir(), "muo-source-"));
  const staged = stageFiles({ repoRoot: root, artifactRoot: join(directory, "source"), files: paths });
  const manifestPath = join(directory, "source-manifest.json");
  const reportPath = join(directory, "gitleaks.redacted.json");
  writeFileSync(manifestPath, `${JSON.stringify(staged, null, 2)}\n`, { flag: "wx" });
  const localScanner = join(homedir(), ".local", "bin", "gitleaks");
  const scanner = process.env.GITLEAKS_BIN || (existsSync(localScanner) ? localScanner : "gitleaks");
  const result = spawnSync(
    scanner,
    ["dir", staged.sourceDir, "--redact=100", "--ignore-gitleaks-allow", "--no-banner", "--report-format=json", `--report-path=${reportPath}`],
    { encoding: "utf8", timeout: 120_000 }
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Artifact scan did not pass. No deployment performed. Inspect the redacted report at ${reportPath}`);
  }
  const receipt = { ...staged, scanState: "clean", scanner: "gitleaks (redacted)", reportPath, deploymentPerformed: false };
  writeFileSync(manifestPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { sourceDir: staged.sourceDir, manifestPath, reportPath, files: staged.files.length, scanState: "clean", deploymentPerformed: false },
      null,
      2
    )
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Source staging failed");
    process.exitCode = 1;
  }
}
