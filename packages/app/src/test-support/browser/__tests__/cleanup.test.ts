// Tests for harness cleanup semantics.
//
// These use real short-lived child processes (no anvil, no Next) to prove the
// teardown path handles the cases that previously leaked resources:
//   - a child that already exited
//   - a child that needs SIGTERM then exits
//   - a null child
// They do NOT exercise the full harness teardown (that needs anvil + Next).

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import { stopChild } from "@/test-support/browser/harness";

const BUN = Bun.which("bun") ?? "bun";

describe("stopChild", () => {
  test("is a no-op for a null child", async () => {
    await expect(stopChild(null)).resolves.toBeUndefined();
  });

  test("is a no-op for a child that already exited", async () => {
    const child = spawn(BUN, ["--no-env-file", "-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode).toBe(0);
    // Must not hang waiting for an exit event that will never fire again.
    await expect(stopChild(child)).resolves.toBeUndefined();
  });

  test("terminates a running child and waits for actual exit", async () => {
    const child = spawn(BUN, ["--no-env-file", "-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    // Give it a moment to actually start.
    await new Promise((r) => setTimeout(r, 150));
    expect(child.exitCode).toBeNull();

    const started = Date.now();
    await stopChild(child, 3_000);
    const elapsed = Date.now() - started;

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    // Must return promptly rather than waiting out the grace period.
    expect(elapsed).toBeLessThan(3_000);
  });

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    // A child that ignores SIGTERM.
    const child = spawn(BUN, ["--no-env-file", "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));

    await stopChild(child, 400);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 10_000);
});
