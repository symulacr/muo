// Native Mezo sync controller.
//
// REPLACES the Stacks WebSocket listener for the native path. The legacy
// Clarity listener in ./legacy.ts is preserved and still exported from the
// package root until the portal cutover, so `packages/api`'s existing tests and
// the v1 route keep working.
//
// This controller does NOT post individual normalized events and does NOT keep
// a client-side cursor. It triggers the API's bounded, atomic indexer and reads
// back the committed cursor. The single source of truth for "how far have we
// indexed" is the D1 cursor that the server commits in the same transaction as
// the ledger and the projection.
//
// Why that matters: a client that advances its own cursor after each HTTP post
// can end up ahead of the data if a post is lost or a batch partially applies.
// Here the client has no cursor to lose — it only observes the server's.

import { hc } from "hono/client";

export type SyncConfig = {
  /** Base URL of the API, e.g. `https://muo-api.example`. */
  apiUrl: string;
  /** Bearer for `POST /v2/indexer/run`. */
  adminSecret: string;
  /** Poll interval between trigger attempts. */
  intervalMs: number;
  /** Give up after this many consecutive failures. */
  maxConsecutiveFailures: number;
  /** Per-request timeout. */
  timeoutMs: number;
};

export const DEFAULT_SYNC_CONFIG: Omit<SyncConfig, "apiUrl" | "adminSecret"> = {
  intervalMs: 15_000,
  maxConsecutiveFailures: 5,
  timeoutMs: 30_000,
};

/** The subset of the server's `/v2/status` body this controller reads. */
export type IndexerStatus = {
  configured: boolean;
  state?: "never_run" | "no_events" | "ok" | "error";
  cursor?: { blockNumber: number; blockHash: string; logIndex: number; version: number } | null;
  lastError?: string | null;
  counts?: { assertions: number; appliedLogs: number };
};

export type SyncTickResult =
  | { kind: "advanced"; applied: number; rebuilt: number; reorg: boolean; blockNumber: number }
  | { kind: "idle"; reason: string }
  | { kind: "halted"; reason: string; error: string }
  | { kind: "http_error"; status: number; detail: string };

export type SyncDeps = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });

/**
 * One sync tick: ask the server to run one bounded indexer cycle, then read the
 * committed status. Never advances any client-side position.
 */
export async function syncTick(cfg: SyncConfig, deps: SyncDeps = {}): Promise<SyncTickResult> {
  const f = deps.fetchImpl ?? fetch;
  const base = cfg.apiUrl.replace(/\/+$/, "");

  const runRes = await f(`${base}/v2/indexer/run`, {
    method: "POST",
    headers: bearer(cfg.adminSecret),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  if (!runRes.ok) {
    const detail = await runRes.text().catch(() => "");
    return { kind: "http_error", status: runRes.status, detail: detail.slice(0, 300) };
  }

  const body = (await runRes.json()) as {
    status?: string;
    applied?: number;
    rebuilt?: number;
    reorg?: boolean;
    to?: { blockNumber?: number };
    reason?: string;
    error?: string;
  };

  switch (body.status) {
    case "advanced":
      return {
        kind: "advanced",
        applied: body.applied ?? 0,
        rebuilt: body.rebuilt ?? 0,
        reorg: body.reorg === true,
        blockNumber: body.to?.blockNumber ?? -1,
      };
    case "idle":
      return { kind: "idle", reason: body.reason ?? "unknown" };
    case "halted":
      return { kind: "halted", reason: body.reason ?? "unknown", error: body.error ?? "" };
    default:
      return { kind: "halted", reason: "unexpected_response", error: JSON.stringify(body).slice(0, 300) };
  }
}

/** Read the server's committed status. Read-only; never triggers a write. */
export async function readStatus(cfg: Pick<SyncConfig, "apiUrl" | "timeoutMs">, deps: SyncDeps = {}): Promise<IndexerStatus> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${cfg.apiUrl.replace(/\/+$/, "")}/v2/status`, {
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  return (await res.json()) as IndexerStatus;
}

/**
 * Run the controller until `stop()` is called or the failure budget is spent.
 *
 * A `halted` result is fatal for the loop: the server did not advance, so
 * retrying immediately would spin. It is reported and the loop stops, leaving
 * the operator to fix the cause (usually a malformed log or an RPC problem).
 */
export function startSyncController(cfg: SyncConfig, deps: SyncDeps = {}) {
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string) => console.error(l));
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let stopped = false;
  let failures = 0;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const result = await syncTick(cfg, deps);
        if (result.kind === "advanced") {
          failures = 0;
          log(JSON.stringify({ sync: "advanced", applied: result.applied, rebuilt: result.rebuilt, reorg: result.reorg, block: result.blockNumber }));
        } else if (result.kind === "idle") {
          failures = 0;
          log(JSON.stringify({ sync: "idle", reason: result.reason }));
        } else if (result.kind === "halted") {
          error(JSON.stringify({ sync: "halted", reason: result.reason, error: result.error.slice(0, 300) }));
          stopped = true;
          return;
        } else {
          failures++;
          error(JSON.stringify({ sync: "http_error", status: result.status, failures, detail: result.detail }));
          if (failures >= cfg.maxConsecutiveFailures) {
            error(JSON.stringify({ sync: "giving_up", failures }));
            stopped = true;
            return;
          }
        }
      } catch (err) {
        failures++;
        error(JSON.stringify({ sync: "exception", failures, error: (err as Error).message.slice(0, 300) }));
        if (failures >= cfg.maxConsecutiveFailures) {
          stopped = true;
          return;
        }
      }
      if (!stopped) await sleep(cfg.intervalMs);
    }
  };

  return {
    run: loop,
    stop: () => {
      stopped = true;
    },
  };
}

export type SyncApi = typeof syncTick;
export { hc };

// ---------------------------------------------------------------------------
// Standalone runner
// ---------------------------------------------------------------------------
//
// `bun run start` / `bun run dev` reach this. Configuration comes from the
// environment only; no secret is ever logged.
//
// A scheduled Worker cron is PREFERRED over this process, because the cron
// colocates the cursor with the D1 database and therefore with the transaction.
// This runner exists for environments where a cron is unavailable.

if (import.meta.main) {
  const env = Bun.env;
  const apiUrl = env.MUO_API_URL ?? env.API_URL;
  const adminSecret = env.INDEXER_ADMIN_SECRET;
  if (!apiUrl) throw new Error("Set MUO_API_URL (e.g. http://localhost:8787).");
  if (!adminSecret) throw new Error("Set INDEXER_ADMIN_SECRET.");

  const cfg: SyncConfig = {
    apiUrl,
    adminSecret,
    ...DEFAULT_SYNC_CONFIG,
    intervalMs: Number(env.SYNC_INTERVAL_MS ?? DEFAULT_SYNC_CONFIG.intervalMs),
    maxConsecutiveFailures: Number(env.SYNC_MAX_FAILURES ?? DEFAULT_SYNC_CONFIG.maxConsecutiveFailures),
  };

  const controller = startSyncController(cfg);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      console.info(`Received ${sig}; stopping after the current tick.`);
      controller.stop();
    });
  }
  console.info(`Native sync controller started against ${cfg.apiUrl} (interval ${cfg.intervalMs}ms).`);
  await controller.run();
  console.info("Native sync controller stopped.");
}
