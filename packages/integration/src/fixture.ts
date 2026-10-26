// Local anvil fixture for the MuoCore integration harness.
//
// Design constraints (from the task brief):
//  - Starts ONLY anvil, bound to 127.0.0.1 on an ephemeral port.
//  - chainId 31611 (Mezo testnet id) and --hardfork london.
//  - Quiet/silent: anvil's stdout+stderr are discarded so no dev private keys
//    are ever written to logs. We never read anvil's stdout.
//  - Deploys use `eth_accounts` + `eth_sendTransaction` (anvil's unlocked dev
//    accounts), so NO private key is ever handled by this code.
//  - Guaranteed teardown: the child is killed in `finally`, and a process-exit
//    safety net is registered.
//  - No persistent public bind; no killing of pre-existing processes.
//  - Environment auto-load is off: we only pass an explicit env to the child.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { RpcClient } from "./rpc.ts";

/** Resolve anvil via PATH, then ~/.foundry/bin/anvil. Never mutates PATH. */
export function resolveAnvil(): string {
  const fromPath = Bun.which("anvil");
  if (fromPath) return fromPath;
  const fallback = join(homedir(), ".foundry", "bin", "anvil");
  if (existsSync(fallback)) return fallback;
  throw new Error("anvil not found on PATH or at ~/.foundry/bin/anvil");
}

/** Pick a free TCP port by binding an ephemeral listener, then releasing it. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  if (typeof port !== "number" || port <= 0) throw new Error("Failed to allocate an ephemeral port");
  return port;
}

export type FixtureExit = {
  /** Exit code, or null when the child was terminated by a signal. */
  code: number | null;
  /** Terminating signal, or null for a normal exit. */
  signal: NodeJS.Signals | null;
  /** Present only when the spawn itself failed (binary missing, EACCES, ...). */
  error?: Error;
};

export type Fixture = {
  rpc: RpcClient;
  url: string;
  port: number;
  chainId: number;
  /** anvil's unlocked dev accounts, in order. */
  accounts: `0x${string}`[];
  /**
   * The actual OS process id of the spawned anvil child.
   *
   * Positive on Linux for a live child. This is the pid a caller may use to
   * observe or signal *this* child specifically; it is never a pid discovered
   * by scanning for processes.
   */
  pid: number;
  /**
   * Resolves exactly once, when the child exits — normally or unexpectedly.
   *
   * Never rejects. A caller that ignores it cannot trigger an unhandled
   * rejection, and a caller that awaits it always gets the real termination
   * facts. `error` is set only when the spawn itself failed, in which case
   * `code` is null and `signal` is null.
   */
  exited: Promise<FixtureExit>;
  /** Stop anvil and wait for exit. Idempotent. */
  stop: () => Promise<void>;
};

export type StartOptions = {
  chainId?: number;
  /** Bounded readiness wait. */
  readyTimeoutMs?: number;
  /** Extra anvil args (rarely needed). */
  extraArgs?: string[];
};

const READY_TIMEOUT_MS = 20_000;

/**
 * Start a local anvil and return a ready fixture.
 *
 * The caller MUST call `stop()` (ideally in `finally`). A `process.on("exit")`
 * safety net also kills the child if the test runner dies unexpectedly.
 *
 * Lifecycle contract:
 *  - `pid` is the real child pid, so a supervisor can watch for this specific
 *    process instead of scanning the machine.
 *  - `exited` resolves on ANY termination, including one this module did not
 *    cause (a crash, or an external SIGTERM). It never rejects.
 *  - `stop()` is idempotent, tolerates an already-exited child, and only
 *    resolves after the child has actually exited.
 */
export async function startAnvil(opts: StartOptions = {}): Promise<Fixture> {
  const bin = resolveAnvil();
  const port = await freePort();
  const chainId = opts.chainId ?? 31611;

  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--chain-id",
    String(chainId),
    "--hardfork",
    "london",
    // Quiet: no banner, no dev-key table. Belt-and-braces with stdio:"ignore".
    "-q",
    ...(opts.extraArgs ?? []),
  ];

  const child: ChildProcess = spawn(bin, args, {
    // Fully detached from our stdio so anvil can never print dev private keys
    // into test output or logs.
    stdio: ["ignore", "ignore", "ignore"],
    // Explicit env only; do not inherit a shell that might auto-load dotenv.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir(), TZ: "UTC", NODE_ENV: "test" },
    detached: false,
  });

  // ---------------------------------------------------------------------
  // Exit observation
  // ---------------------------------------------------------------------
  // `exited` must be created immediately after spawn and must resolve on every
  // termination path. It deliberately never rejects: an unobserved rejection
  // would crash a caller that only wants `stop()`.
  let settleExited: (value: FixtureExit) => void = () => {};
  const exited = new Promise<FixtureExit>((resolve) => {
    settleExited = resolve;
  });

  let exitedSettled = false;
  const settle = (value: FixtureExit) => {
    if (exitedSettled) return;
    exitedSettled = true;
    settleExited(value);
  };

  // A spawn failure emits 'error' and may never emit 'exit'. Without this
  // handler the process would crash on an unhandled 'error' event, and
  // readiness would hang until its timeout. Settle immediately instead.
  child.on("error", (err: Error) => {
    settle({ code: null, signal: null, error: err });
  });

  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    settle({ code, signal });
  });

  let stopped = false;
  const killChild = () => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  };

  // Safety net: never leave an orphan anvil behind if the runner exits abruptly.
  const onExit = () => killChild();
  process.once("exit", onExit);

  const stop = async () => {
    process.removeListener("exit", onExit);
    if (stopped) return;
    stopped = true;

    // Already gone: nothing to signal, and `exited` is already resolved (or
    // will resolve from the queued 'exit' event). Await it so callers always
    // observe a settled promise after `stop()`.
    if (child.exitCode !== null || child.signalCode !== null) {
      await exited;
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // Bounded grace period, then force.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 2_000);
    await exited;
    clearTimeout(timer);
  };

  const url = `http://127.0.0.1:${port}`;
  const rpc = new RpcClient(url);

  try {
    // Bounded readiness: poll chainId until anvil answers. Also abort as soon
    // as the child is known to be gone, so a failed spawn fails fast instead
    // of waiting out the whole timeout.
    const readyMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    await rpc.waitFor(
      async () => {
        if (child.exitCode !== null) throw new Error(`anvil exited early with code ${child.exitCode}`);
        if (child.signalCode !== null) throw new Error(`anvil exited early with signal ${child.signalCode}`);
        const id = await rpc.chainId();
        return id === `0x${chainId.toString(16)}` ? id : undefined;
      },
      readyMs,
      "anvil readiness"
    );

    const accounts = await rpc.accounts();
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("anvil returned no unlocked accounts");

    const pid = child.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      throw new Error(`anvil child has no usable pid (got ${String(pid)})`);
    }

    return { rpc, url, port, chainId, accounts, pid, exited, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
