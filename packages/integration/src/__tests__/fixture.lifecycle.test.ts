// Narrow lifecycle tests for the anvil fixture.
//
// Scope: ONLY the pid / exited / stop contract. These tests start a real anvil
// because that is the only way to observe a real child pid and a real exit,
// but they keep it to one chain at a time and bounded timeouts.
//
// Deliberately NOT done here:
//  - no process discovery (no `pgrep`, no scanning for anvil by name)
//  - no signalling of any process this file did not spawn
//  - no RPC/contract assertions (those live in muocore.rpc.test.ts)

import { afterAll, describe, expect, test } from "bun:test";

import type { Fixture } from "../fixture.ts";
import { startAnvil } from "../fixture.ts";

// Every fixture created here is tracked so a failed assertion cannot leak anvil.
const started: Fixture[] = [];

async function track(fixture: Fixture): Promise<Fixture> {
  started.push(fixture);
  return fixture;
}

afterAll(async () => {
  // Bounded, owned cleanup. Only fixtures this file spawned are stopped.
  await Promise.all(started.map((fixture) => fixture.stop().catch(() => {})));
});

describe("fixture lifecycle contract", () => {
  test("exposes a positive pid for the child it actually spawned", async () => {
    const fixture = await track(await startAnvil({ chainId: 31611 }));

    expect(typeof fixture.pid).toBe("number");
    expect(Number.isInteger(fixture.pid)).toBe(true);
    expect(fixture.pid).toBeGreaterThan(0);

    // The pid must correspond to a live process while the chain is up.
    // `process.kill(pid, 0)` only probes existence; it sends no signal.
    expect(() => process.kill(fixture.pid, 0)).not.toThrow();
  }, 60_000);

  test("exited resolves with termination facts after stop()", async () => {
    const fixture = await track(await startAnvil({ chainId: 31611 }));

    await fixture.stop();

    const result = await fixture.exited;
    // A clean SIGTERM shutdown: either a code or the SIGTERM signal, never both null.
    expect(result.error).toBeUndefined();
    expect(result.code !== null || result.signal !== null).toBe(true);
    expect(result.signal === null || result.signal === "SIGTERM").toBe(true);

    // The pid is gone once exited has resolved.
    expect(() => process.kill(fixture.pid, 0)).toThrow();
  }, 60_000);

  test("stop() is idempotent and tolerates an already-exited child", async () => {
    const fixture = await track(await startAnvil({ chainId: 31611 }));

    await fixture.stop();
    const first = await fixture.exited;

    // Calling stop again must not throw, hang, or change the observed result.
    await fixture.stop();
    const second = await fixture.exited;
    expect(second).toEqual(first);

    // And a third time, still safe.
    await fixture.stop();
    expect(await fixture.exited).toEqual(first);
  }, 60_000);
});

describe("unexpected termination is observable", () => {
  test("an external SIGTERM to fixture.pid resolves exited without a pending promise", async () => {
    const fixture = await track(await startAnvil({ chainId: 31611 }));

    // Signal ONLY the pid this test just spawned and owns. No discovery, no
    // name matching, no other process is touched.
    process.kill(fixture.pid, "SIGTERM");

    const result = await fixture.exited;
    expect(result.error).toBeUndefined();

    // Observed anvil behaviour (verified separately against the binary): anvil
    // installs a SIGTERM handler and shuts down cleanly, so the child exits with
    // code 0 rather than dying from the signal. The lifecycle contract is that
    // `exited` resolves promptly with the REAL termination facts — not that the
    // signal is echoed back. Asserting `signal === "SIGTERM"` here would encode
    // a false expectation about anvil.
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();

    // stop() must still succeed afterwards and must not hang on a dead child.
    await fixture.stop();
    expect(await fixture.exited).toEqual(result);
    expect(() => process.kill(fixture.pid, 0)).toThrow();
  }, 60_000);

  test("exited resolves for a child killed with SIGKILL, reporting the signal", async () => {
    // SIGKILL cannot be trapped, so this is the case where the signal IS
    // reported. It proves the signal branch of the contract, which the SIGTERM
    // test above cannot exercise because anvil handles SIGTERM itself.
    const fixture = await track(await startAnvil({ chainId: 31611 }));

    process.kill(fixture.pid, "SIGKILL");

    const result = await fixture.exited;
    expect(result.error).toBeUndefined();
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");

    await fixture.stop();
    expect(await fixture.exited).toEqual(result);
  }, 60_000);
});
