// Bounded browser-level acceptance harness for the portal.
//
// NOT a bun test: it spawns a real Next server and a real anvil. An external
// browser session drives it. It is operator-run (see README) because it needs a browser binary and
// a shell that can host long-running children.
//
// WHAT IS REAL
//  - the shipped Next production build, unmodified
//  - a real anvil chain with real MuoCore + MockMUSD deployments
//  - real `AppProviders` wallet discovery (EIP-6963), chain check, and the real
//    `useCoreTx` hook wiring behind the Assert dialog
//  - real approvals, real receipts, real escrow movement
//
// WHAT IS FAKE
//  - the wallet. `wallet-inject.js` is a fake local wallet injected by a
//    test-only proxy. It is NOT a browser extension and NOT MetaMask.
//  - the assertions API. `/v2/assertions` is served from an in-process fixture,
//    because the real backend belongs to another worker.
//  - the browser itself is driven EXTERNALLY (an agent-browser session). This
//    module never spawns Chromium.
//
// Therefore: a MIXED PROOF. Real portal transaction path and real local chain;
// fake wallet transport and fixture API. Not evidence of a live Mezo deployment.
//
// BUILD-TIME CONFIG NOTE (important)
//  Next inlines `NEXT_PUBLIC_*` at BUILD time, not at `next start`. Because the
//  fixture's RPC/API/core addresses only exist after anvil boots, this harness
//  allocates the proxy port and boots the fixture FIRST, then runs a real
//  production build with those exact values in the environment, then starts the
//  server with the same environment. Passing them only to `next start` would
//  leave the browser chunks pointing at whatever was baked earlier.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Fixture } from "@muo/integration/fixture";
import { MuoCoreClient, MusdClient } from "@muo/integration/contracts";
import { deploy, loadArtifact, mockMusdArtifact, send } from "@muo/integration/deploy";
import { startAnvil } from "@muo/integration/fixture";

import type { InjectProxy } from "./inject-proxy";
import { API_PREFIX, RPC_PREFIX, startInjectProxy } from "./inject-proxy";
import { startRealApi } from "./real-api";

const APP_DIR = join(import.meta.dir, "..", "..", "..");
const CHAIN_ID = 31611;
const MUSD_UNIT = 10n ** 18n;

/** How long a spawned child gets to exit after SIGTERM before SIGKILL. */
const CHILD_GRACE_MS = 5_000;

export type Harness = {
  fixture: Fixture;
  coreAddress: string;
  musdAddress: string;
  /** Origin a browser should open. Serves the app, the RPC, and the real API. */
  proxyUrl: string;
  /** Base URL of the REAL Hono API (real SQLite D1 + real indexer). */
  apiUrl: string;
  rpcUrl: string;
  accounts: readonly string[];
  /** The real anvil child pid, for ownership-scoped teardown and post-mortems. */
  chainPid: number;
  /** Non-null once the chain died unexpectedly; the harness is then unusable. */
  chainLostReason: () => string | null;
  /**
   * Runs one bounded REAL indexer cycle against the local chain.
   * Call this after chain writes so `GET /v2/assertions` reflects them.
   */
  runIndexer: () => Promise<{ status: string; [k: string]: unknown }>;
  /** Rows currently in the real D1 store, read directly (bypasses HTTP). */
  countIndexedRows: () => Promise<number>;
  /** Idempotent. Safe to call more than once and after a partial startup. */
  stop: () => Promise<void>;
};

const resolveBun = (): string => {
  const fromPath = Bun.which("bun");
  if (fromPath) return fromPath;
  const fallback = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(fallback)) return fallback;
  throw new Error("bun not found on PATH or at ~/.bun/bin/bun");
};

/** Allocate a free loopback TCP port. */
const freePort = async (): Promise<number> => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  if (typeof port !== "number" || port <= 0) throw new Error("failed to allocate a free port");
  return port;
};

const waitForHttp = async (url: string, timeoutMs: number, label: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${last}`);
};

/**
 * Terminates a child and resolves only once it has ACTUALLY exited.
 *
 * Handles the case where the child already exited (no listener will fire) and
 * escalates to SIGKILL after a bounded grace period. The exit listener is
 * registered BEFORE the liveness check so a child that exits in between cannot
 * leave us waiting on an event that was already emitted.
 */
export const stopChild = async (child: ChildProcess | null, graceMs = CHILD_GRACE_MS): Promise<void> => {
  if (!child) return;

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      clearTimeout(deadline);
      child.off("exit", onExit);
      child.off("close", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = () => {
      if (child.pid === undefined) finish(); // failed spawn, no child to reap
    };
    child.once("exit", onExit);
    child.once("close", onExit);
    child.on("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) return finish();
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* enforce the deadline below */
      }
      deadline = setTimeout(() => finish(new Error("Owned harness child did not exit after SIGKILL")), 1_000);
    }, graceMs);
    try {
      child.kill("SIGTERM");
    } catch {
      /* escalation remains bounded */
    }
  });
};

/**
 * The exact public env the app must be BUILT with, so browser chunks agree.
 */
export const buildPublicEnv = (opts: { proxyPort: number; coreAddress: string; musdAddress: string; apiUrl: string }) => ({
  NEXT_PUBLIC_MEZO_CHAIN_ID: String(CHAIN_ID),
  // Same-origin: the proxy fronts anvil, so no CORS and no external RPC.
  NEXT_PUBLIC_MEZO_RPC_URL: `http://localhost:${opts.proxyPort}${RPC_PREFIX}`,
  NEXT_PUBLIC_MEZO_EXPLORER_URL: "http://localhost:1",
  NEXT_PUBLIC_MUO_CORE_CONTRACT: opts.coreAddress.toLowerCase(),
  NEXT_PUBLIC_MUSD_ADDRESS: opts.musdAddress.toLowerCase(),
  // Same-origin API fixture, so the browser never leaves this origin.
  NEXT_PUBLIC_API_BASE_URL: `http://localhost:${opts.proxyPort}${API_PREFIX}`,
});

/**
 * Runs a bounded child to completion, capturing output for error reporting.
 *
 * `onSpawn` is called with the child immediately, so the caller can register it
 * for teardown. Without that, a SIGTERM during the (multi-minute) build would
 * leave the Next build child orphaned.
 */
const runToCompletion = async (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onSpawn?: (child: ChildProcess) => void
): Promise<void> => {
  const child = spawn(cmd, args, { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  onSpawn?.(child);
  let log = "";
  const capture = (buf: Buffer) => {
    log += buf.toString();
    if (log.length > 20_000) log = log.slice(-10_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", (c) => resolve(c));
    child.once("error", () => resolve(null));
  });
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${args.join(" ")} failed with code ${code}\n--- log ---\n${log}`);
};

/**
 * Boots the full harness.
 *
 * Every resource is registered for cleanup the moment it is created, so a
 * failure at ANY later stage still tears down everything already started.
 */
export const startHarness = async (opts: { skipBuild?: boolean; signal?: AbortSignal } = {}): Promise<Harness> => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let stopped = false;
  /**
   * Set BEFORE `fixture.stop()` runs, so a deliberate teardown is not mistaken
   * for a crash. Anvil traps SIGTERM and exits `{code: 0, signal: null}`, so a
   * zero exit code is NOT evidence of a normal shutdown -- only this flag is.
   */
  let plannedStopping = false;
  /** Non-null once the chain died while we were not shutting down. */
  let chainLostReason: string | null = null;

  const stop = async () => {
    if (stopped) return; // idempotent: a second call is a no-op
    stopped = true;
    plannedStopping = true;
    // Reverse order, and never let one failure skip the rest.
    for (const fn of [...cleanups].reverse()) {
      try {
        await fn();
      } catch {
        /* keep tearing down */
      }
    }
  };

  /** Throws if the caller aborted while a long step was running. */
  const checkAborted = () => {
    if (opts.signal?.aborted) throw new Error("Harness startup aborted by caller");
    if (chainLostReason !== null) throw new Error(chainLostReason);
  };

  try {
    // 1. Chain first: the contract addresses must exist before the build.
    const fixture = await startAnvil({ chainId: CHAIN_ID });
    cleanups.push(async () => {
      // Flag first: a deliberate stop must never look like a crash.
      plannedStopping = true;
      await fixture.stop();
    });

    // Supervise the chain for the whole lifetime.
    //
    // ANY exit while `plannedStopping` is false is UNEXPECTED -- including
    // `{code: 0, signal: null}`. Anvil traps SIGTERM and exits 0, so gating on a
    // nonzero code or a signal would miss the most likely real death. The only
    // trustworthy signal of "we meant this" is our own flag.
    void fixture.exited.then((exit) => {
      if (plannedStopping || stopped) return;
      const detail = exit.error ? `spawn error: ${exit.error.message}` : `code ${String(exit.code)}, signal ${String(exit.signal)}`;
      chainLostReason = `anvil exited unexpectedly (${detail}); the local chain is gone and the harness is unusable`;
      // Tear everything down immediately rather than waiting for the TTL, so a
      // dead chain can never be advertised as READY.
      void stop();
    });

    const [owner, asserter, disputer, arbiter] = fixture.accounts as [string, string, string, string];

    const musdArtifact = mockMusdArtifact();
    const musdAddress = await deploy(fixture.rpc, owner, musdArtifact.abi, musdArtifact.bytecode);
    const musd = new MusdClient(fixture.rpc, musdAddress as `0x${string}`, musdArtifact.abi);

    const coreArtifact = loadArtifact("MuoCore", "MuoCore");
    const coreAddress = await deploy(fixture.rpc, owner, coreArtifact.abi, coreArtifact.bytecode, [musdAddress]);
    const core = new MuoCoreClient(fixture.rpc, coreAddress as `0x${string}`);

    await send(fixture.rpc, owner, coreAddress, core.addArbiterData(arbiter));
    await send(fixture.rpc, owner, musdAddress, musd.mintData(asserter, 1_000n * MUSD_UNIT));
    await send(fixture.rpc, owner, musdAddress, musd.mintData(disputer, 1_000n * MUSD_UNIT));

    // 2. REAL API: the actual Hono app + real SQLite-backed D1 + real indexer.
    //    No fixture rows: rows only exist once the real indexer ingests them.
    const api = await startRealApi({
      chainId: CHAIN_ID,
      coreAddress,
      rpcUrl: fixture.url,
      startBlock: Number(BigInt(await fixture.rpc.blockNumber())),
      confirmations: 0,
    });
    cleanups.push(() => api.stop());

    // 3. Reserve the proxy port BEFORE building, because the build inlines it.
    //
    // KNOWN LIMITATION: `freePort` binds then releases, and the build then runs
    // for minutes before the proxy claims the port, so a concurrent process could
    // take it in between. The failure is a clear EADDRINUSE from the proxy rather
    // than a silent misconfiguration. Acceptable for a single-operator loopback
    // harness; it is not a general-purpose port broker.
    const proxyPort = await freePort();
    const publicEnv = buildPublicEnv({ proxyPort, coreAddress, musdAddress, apiUrl: api.url });

    const baseEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? homedir(),
      TZ: "UTC",
      ...publicEnv,
    };

    // 4. Real production build with the fixture's public env baked in.
    //
    // `skipBuild` exists only for iterating on harness code against an existing
    // build. It is UNSAFE for correctness runs: an existing `.next` carries
    // whatever `NEXT_PUBLIC_*` values were baked by a previous build, which will
    // not match this run's fixture addresses or proxy port.
    if (!opts.skipBuild) {
      checkAborted();
      await runToCompletion(resolveBun(), ["--no-env-file", "run", "build"], { ...baseEnv, NODE_ENV: "production" }, 600_000, (child) =>
        cleanups.push(() => stopChild(child))
      );
      checkAborted();
    }

    // 5. Start the built app on a loopback port.
    const nextPort = await freePort();
    const next = spawn(resolveBun(), ["--no-env-file", "run", "start", "--", "-p", String(nextPort), "-H", "127.0.0.1"], {
      cwd: APP_DIR,
      env: { ...baseEnv, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => stopChild(next));

    let serverLog = "";
    const capture = (buf: Buffer) => {
      serverLog += buf.toString();
      if (serverLog.length > 20_000) serverLog = serverLog.slice(-10_000);
    };
    next.stdout?.on("data", capture);
    next.stderr?.on("data", capture);

    const upstream = `http://127.0.0.1:${nextPort}`;
    try {
      await waitForHttp(upstream, 90_000, "next server");
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- next log ---\n${serverLog}`);
    }

    // 6. Injecting proxy on the pre-reserved port.
    let proxy: InjectProxy | null = null;
    try {
      proxy = startInjectProxy({
        port: proxyPort,
        upstream,
        rpcUrl: fixture.url,
        apiUrl: api.url,
        accounts: [asserter, disputer, arbiter],
        chainId: CHAIN_ID,
      });
    } catch (error) {
      throw new Error(`failed to start the inject proxy on port ${proxyPort}: ${error instanceof Error ? error.message : String(error)}`);
    }
    cleanups.push(() => proxy.stop());
    await waitForHttp(proxy.url, 20_000, "inject proxy");

    return {
      fixture,
      coreAddress,
      musdAddress,
      proxyUrl: proxy.url,
      apiUrl: api.url,
      rpcUrl: fixture.url,
      accounts: [asserter, disputer, arbiter],
      chainPid: fixture.pid,
      chainLostReason: () => chainLostReason,
      runIndexer: api.runIndexer,
      countIndexedRows: api.countRows,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};
