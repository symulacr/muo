// Long-running harness host for external browser driving.
//
// HOW TO RUN (bounded, non-detached):
//   Start this inside a functions.Script with `startInBackground: true`, whose
//   body runs a NORMAL awaited foreground Execute of this file with a generous
//   timeout (~900s). The Execute stays live for the whole session, so nothing is
//   detached. Do NOT use fireAndForget, setsid, nohup, or a trailing `&`.
//
// READINESS: normal Execute output only arrives at completion, so this writes a
// readiness file the moment the harness is up. External readers poll that file
// once after doing real other work -- never in a busy loop.
//
// SHUTDOWN: SIGTERM/SIGINT/TTL stop ONLY the resources this process owns. The
// handlers are installed BEFORE startup begins, so a signal during the
// multi-minute Next build cancels cleanly instead of leaking a build child.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { startHarness } from "./harness";

/** Readiness file path. Written on READY, removed on shutdown. */
const READY_FILE = process.env.MUO_HARNESS_READY_FILE ?? "/tmp/muo-harness-ready.json";

/** Acceptance window. Long enough for a human-driven browser pass. */
const TTL_MS = 10 * 60_000;

const abort = new AbortController();
let harness: Awaited<ReturnType<typeof startHarness>> | null = null;
let shuttingDown = false;
let lifetime: ReturnType<typeof setTimeout> | undefined;
/** Set when the chain died unexpectedly; the exit code must be nonzero. */
let chainLost = false;

const removeReadyFile = () => {
  try {
    rmSync(READY_FILE, { force: true });
  } catch {
    /* best effort */
  }
};

const shutdown = async (reason: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (lifetime) clearTimeout(lifetime);
  abort.abort();
  try {
    await harness?.stop();
  } finally {
    removeReadyFile();
    // A lost chain is always a failure, even though the process is exiting cleanly.
    const code = chainLost ? 1 : reason === "TTL" ? 0 : reason === "SIGINT" ? 130 : 143;
    process.exit(code);
  }
};

// Installed BEFORE startup so a signal during the build still tears down.
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  console.error("harness uncaught exception:", error instanceof Error ? error.message : String(error));
  void shutdown("ERROR");
});
process.on("unhandledRejection", (reason) => {
  console.error("harness unhandled rejection:", reason instanceof Error ? reason.message : String(reason));
  void shutdown("ERROR");
});

try {
  harness = await startHarness({ signal: abort.signal });
} catch (error) {
  // Startup failed (or was aborted): make sure nothing we started survives.
  console.error("harness startup failed:", error instanceof Error ? error.message : String(error));
  await shutdown("ERROR");
}

if (harness && !shuttingDown) {
  lifetime = setTimeout(() => void shutdown("TTL"), TTL_MS);

  const ready = {
    READY: true,
    pid: process.pid,
    /** Real anvil child pid, for ownership-scoped teardown and post-mortems. */
    chainPid: harness.chainPid,
    proxyUrl: harness.proxyUrl,
    apiUrl: harness.apiUrl,
    rpcUrl: harness.rpcUrl,
    coreAddress: harness.coreAddress,
    musdAddress: harness.musdAddress,
    accounts: harness.accounts,
    readyFile: READY_FILE,
    ttlMs: TTL_MS,
    // The API is the REAL Hono app + real SQLite D1 + real indexer.
    // Call POST {apiUrl}/v2/indexer/run (or the harness runIndexer) after writes.
    apiKind: "real-hono-sqlite-d1",
  };

  mkdirSync(dirname(READY_FILE), { recursive: true });
  writeFileSync(READY_FILE, JSON.stringify(ready, null, 2), "utf8");
  console.log(JSON.stringify(ready));

  // Watch for an unexpected chain death and fail loudly instead of idling to TTL.
  const watchdog = setInterval(() => {
    const lost = harness?.chainLostReason() ?? null;
    if (lost === null || shuttingDown) return;
    clearInterval(watchdog);
    chainLost = true;
    console.error(`harness: ${lost}`);
    void shutdown("CHAIN_LOST");
  }, 1_000);

  // Stay alive until signalled. The browser session is driven externally.
  await new Promise(() => {});
}
