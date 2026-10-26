// Cloudflare Worker entry.
//
// Exports ONLY the default module-worker handler object: `{ fetch, scheduled }`.
// There is no named export of any kind — not the Hono app, not a constant, not a
// numeric value. A module Worker's default export is the entrypoint contract;
// extra named exports are at best dead weight and at worst mistaken for
// additional entrypoints.
//
// Tests import the Hono application from `./app` directly. Nothing in the test
// suite imports this file.

/// <reference types="@cloudflare/workers-types" />

import type { Env } from "./app";
import app from "./app";
import { runIndexerCycle } from "./lib/mezo/indexer";
import { MezoRpc } from "./lib/mezo/rpc";
import { D1IndexerStore } from "./lib/mezo/store";
import { indexerConfigFromEnv } from "./routes/v2";

/**
 * Scheduled (Cron) handler: one bounded indexer cycle.
 *
 * Bounded by construction:
 *   - `maxBlocksPerRun` caps the block span per invocation
 *   - `RPC_LIMITS.MAX_BLOCK_RANGE` caps each `eth_getLogs`
 *   - `RPC_LIMITS.MAX_LOGS_PER_CALL` rejects an oversized page
 *   - every RPC call has a timeout and a retry budget
 *
 * MEASUREMENT GATE: the Workers Free plan gives a Cron invocation ~10 ms of CPU.
 * This handler does network I/O (which does not count) but its decode and
 * projection work does. On Free, expect to ingest only a small range per tick;
 * a full backfill from block 16380473 is NOT claimed to fit. Run the backfill
 * on a paid plan, a local `wrangler dev` loop, or the authenticated
 * `/v2/indexer/run` endpoint in bounded slices, and record the measured CPU
 * time before raising `maxBlocksPerRun`.
 */
const scheduled: ExportedHandlerScheduledHandler<Env["Bindings"]> = async (controller, env) => {
  const cfg = indexerConfigFromEnv(env);
  if (cfg === null) {
    console.error(JSON.stringify({ scheduled: "skipped", reason: "native_index_not_configured" }));
    return;
  }
  const rpcUrl = env.MEZO_RPC_URL;
  if (typeof rpcUrl !== "string" || rpcUrl.length === 0) {
    console.error(JSON.stringify({ scheduled: "skipped", reason: "rpc_not_configured" }));
    return;
  }
  const rpc = new MezoRpc({ url: rpcUrl, timeoutMs: 10_000, maxRetries: 2, backoffMs: 200 });
  const store = new D1IndexerStore(env.MUO_DB);
  const result = await runIndexerCycle(cfg, { rpc, store });
  // Structured, one line, no secrets.
  console.log(JSON.stringify({ scheduled: "indexer", result: summarize(result) }));
  if (result.status === "halted") {
    // Surface a halt to the platform so the invocation is marked failed and the
    // operator sees it. The cursor did not move, so the next tick retries.
    throw new Error(`indexer halted: ${result.reason}: ${result.error}`);
  }
  void controller;
};

const summarize = (r: Awaited<ReturnType<typeof runIndexerCycle>>): Record<string, unknown> =>
  r.status === "advanced"
    ? {
        status: r.status,
        applied: r.applied,
        rebuilt: r.rebuilt,
        reorg: r.reorg,
        // Present only on a reorg: the common ancestor the cycle rewound to.
        ancestor: r.ancestor,
        to: r.to.blockNumber,
      }
    : r.status === "idle"
      ? { status: r.status, reason: r.reason }
      : { status: r.status, reason: r.reason, error: r.error.slice(0, 200) };

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env["Bindings"]>;
