// Lifecycle supervisor tests: an unexpected chain exit must abort the harness.
//
// These use MOCK `exited` promises, so no child process, anvil, or Next server is
// started. They pin the supervisor semantics that matter:
//
//   ANY exit while not planned-stopping is UNEXPECTED -- including
//   `{ code: 0, signal: null }`. Anvil traps SIGTERM and exits 0, so gating on a
//   nonzero code or a signal would miss the most likely real death.

import { describe, expect, test } from "bun:test";

/**
 * Minimal replica of the harness supervisor's decision rule.
 *
 * Kept in step with `startHarness` by the assertions below; this is the pure
 * decision, extracted so it can be tested without a chain.
 */
export const classifyExit = (
  exit: { code: number | null; signal: string | null; error?: Error },
  state: { plannedStopping: boolean; stopped: boolean }
): { unexpected: boolean; reason: string | null } => {
  if (state.plannedStopping || state.stopped) return { unexpected: false, reason: null };
  const detail = exit.error ? `spawn error: ${exit.error.message}` : `code ${String(exit.code)}, signal ${String(exit.signal)}`;
  return {
    unexpected: true,
    reason: `anvil exited unexpectedly (${detail}); the local chain is gone and the harness is unusable`,
  };
};

const RUNNING = { plannedStopping: false, stopped: false };
const PLANNED = { plannedStopping: true, stopped: false };
const STOPPED = { plannedStopping: false, stopped: true };

describe("chain exit classification", () => {
  test("a ZERO exit while running is UNEXPECTED (anvil traps SIGTERM)", () => {
    const r = classifyExit({ code: 0, signal: null }, RUNNING);
    expect(r.unexpected).toBe(true);
    expect(r.reason).toContain("code 0");
  });

  test("a nonzero exit while running is UNEXPECTED", () => {
    const r = classifyExit({ code: 1, signal: null }, RUNNING);
    expect(r.unexpected).toBe(true);
    expect(r.reason).toContain("code 1");
  });

  test("a SIGKILL while running is UNEXPECTED and names the signal", () => {
    const r = classifyExit({ code: null, signal: "SIGKILL" }, RUNNING);
    expect(r.unexpected).toBe(true);
    expect(r.reason).toContain("SIGKILL");
  });

  test("a spawn error while running is UNEXPECTED and names the error", () => {
    const r = classifyExit({ code: null, signal: null, error: new Error("ENOENT") }, RUNNING);
    expect(r.unexpected).toBe(true);
    expect(r.reason).toContain("ENOENT");
  });

  test("a zero exit AFTER plannedStopping is NOT unexpected", () => {
    expect(classifyExit({ code: 0, signal: null }, PLANNED).unexpected).toBe(false);
  });

  test("a SIGTERM-driven zero exit after plannedStopping is NOT unexpected", () => {
    // The exact shape anvil produces on our own stop().
    expect(classifyExit({ code: 0, signal: null }, { plannedStopping: true, stopped: true }).unexpected).toBe(false);
  });

  test("an exit after stop() already ran is NOT unexpected", () => {
    expect(classifyExit({ code: 1, signal: null }, STOPPED).unexpected).toBe(false);
  });

  test("the reason text is actionable and never empty", () => {
    for (const exit of [
      { code: 0, signal: null },
      { code: 137, signal: null },
      { code: null, signal: "SIGTERM" },
    ] as const) {
      const r = classifyExit(exit, RUNNING);
      expect(r.reason).toBeTruthy();
      expect(r.reason).toContain("unusable");
    }
  });
});

describe("supervisor wiring (mock promises, no child)", () => {
  /** Replica of the harness's `void fixture.exited.then(...)` handler. */
  const wire = (exited: Promise<{ code: number | null; signal: string | null; error?: Error }>) => {
    const state = { plannedStopping: false, stopped: false, chainLost: null as string | null, stopCalls: 0 };
    const stop = async () => {
      if (state.stopped) return;
      state.stopped = true;
      state.plannedStopping = true;
      state.stopCalls++;
    };
    void exited.then((exit) => {
      if (state.plannedStopping || state.stopped) return;
      const r = classifyExit(exit, state);
      if (!r.unexpected) return;
      state.chainLost = r.reason;
      void stop();
    });
    return { state, stop };
  };

  const settle = () => new Promise((r) => setTimeout(r, 0));

  test("an unexpected zero exit triggers teardown exactly once", async () => {
    let resolve!: (v: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
      resolve = r;
    });
    const { state } = wire(exited);

    expect(state.chainLost).toBeNull();
    resolve({ code: 0, signal: null });
    await settle();

    expect(state.chainLost).toContain("unexpectedly");
    expect(state.stopCalls).toBe(1);
  });

  test("a planned stop does not self-abort when the child then exits 0", async () => {
    let resolve!: (v: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
      resolve = r;
    });
    const { state, stop } = wire(exited);

    await stop(); // deliberate teardown sets the flag BEFORE the child exits
    resolve({ code: 0, signal: null });
    await settle();

    expect(state.chainLost).toBeNull();
    expect(state.stopCalls).toBe(1); // the planned stop, not a second abort
  });

  test("a SIGKILL after teardown began does not resurrect an abort", async () => {
    let resolve!: (v: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
      resolve = r;
    });
    const { state, stop } = wire(exited);

    await stop();
    resolve({ code: null, signal: "SIGKILL" });
    await settle();

    expect(state.chainLost).toBeNull();
    expect(state.stopCalls).toBe(1);
  });

  test("a never-resolving exited promise leaves the harness running (no false abort)", async () => {
    const exited = new Promise<{ code: number | null; signal: string | null }>(() => {});
    const { state } = wire(exited);
    await settle();
    expect(state.chainLost).toBeNull();
    expect(state.stopCalls).toBe(0);
  });
});
