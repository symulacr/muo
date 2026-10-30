// Static guard: the test wallet harness must never reach production code.
//
// The inject proxy and fake wallet are test-only. If any non-test module ever
// imported them, the app bundle could carry a wallet override. This test reads
// the source tree and fails if that happens.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "..");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

/** True when a path is test-only (a test file or inside test-support). */
const isTestOnly = (path: string): boolean => path.includes(`${join("src", "test-support")}`) || /__tests__/.test(path) || /\.test\.(ts|tsx)$/.test(path);

const FORBIDDEN = ["test-support", "wallet-inject", "inject-proxy", "isFakeLocalWallet", "__fakeLocalWallet"];

describe("test harness isolation", () => {
  const files = walk(SRC);

  test("the source tree was actually scanned", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("no production module imports the test harness or fake wallet", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (isTestOnly(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) offenders.push(`${relative(SRC, file)} -> ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the fake wallet script is only read by the test proxy", () => {
    const readers: string[] = [];
    for (const file of files) {
      if (isTestOnly(file)) continue;
      if (readFileSync(file, "utf8").includes("wallet-inject.js")) readers.push(relative(SRC, file));
    }
    expect(readers).toEqual([]);
  });
});
