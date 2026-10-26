// v2 native routes: `/v2/assertions` and `/v2/status`.
//
// Additive. v1 `/assertions` keeps serving the legacy `assertions` table.
//
// Every row is validated against `assertionSchema` from @muo/core/native before
// it is serialized, so a malformed D1 row is a 500 with a logged reason rather
// than a plausible-looking row with a wrong bond or a truncated id.
//
// Ordering is canonical chain order: block, then transaction position, then log
// position. Never ingestion time.

import type { Hono } from "hono";

import type { Assertion, Hex } from "@muo/core/native";
import { assertionSchema, isAddress, isChainId } from "@muo/core/native";

import type { Env } from "../app";
import type { IndexerConfig } from "../lib/mezo/indexer";
import { readCappedBody } from "../lib/http";
import { MAX_OFFSET } from "../lib/limits";
import { DEFAULT_INDEXER_CONFIG, runIndexerCycle } from "../lib/mezo/indexer";
import { MezoRpc } from "../lib/mezo/rpc";
import { D1IndexerStore } from "../lib/mezo/store";

export const V2_PAGE_LIMIT = 100;
/** Hard cap on `limit`; the client cannot ask for more. */
export const V2_MAX_LIMIT = 200;

const PREFLIGHT = {
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "600",
};

const ROW_COLUMNS = [
  "chain_id",
  "core_address",
  "assertion_id",
  "identifier",
  "claim",
  "bond_musd",
  "liveness",
  "status",
  "asserter",
  "disputer",
  "settler",
  "resolver",
  "asserted_at_block",
  "asserted_tx_id",
  "disputed_at_block",
  "disputed_tx_id",
  "settled_at_block",
  "settled_tx_id",
  "resolved_at_block",
  "resolved_tx_id",
  "block_number",
  "block_hash",
  "transaction_index",
  "log_index",
] as const;

const SELECT_ROWS = `select ${ROW_COLUMNS.map((c) => `"${c}"`).join(", ")} from "mezo_assertions"`;

type RawRow = Record<(typeof ROW_COLUMNS)[number], unknown>;

/** Map a D1 row to the native wire shape, then validate it. Throws on a bad row. */
export const toNativeAssertion = (raw: RawRow): Assertion => {
  const candidate = {
    id: raw.assertion_id,
    identifier: raw.identifier,
    claim: raw.claim,
    bondMusd: raw.bond_musd,
    liveness: raw.liveness,
    status: raw.status,
    asserter: raw.asserter,
    disputer: raw.disputer,
    settler: raw.settler,
    resolver: raw.resolver,
    assertedAtBlock: raw.asserted_at_block,
    assertedTxId: raw.asserted_tx_id,
    disputedAtBlock: raw.disputed_at_block,
    disputedTxId: raw.disputed_tx_id,
    settledAtBlock: raw.settled_at_block,
    settledTxId: raw.settled_tx_id,
    resolvedAtBlock: raw.resolved_at_block,
    resolvedTxId: raw.resolved_tx_id,
    chainId: raw.chain_id,
    coreAddress: raw.core_address,
    blockNumber: raw.block_number,
    blockHash: raw.block_hash,
    transactionIndex: raw.transaction_index,
    logIndex: raw.log_index,
  };
  return assertionSchema.parse(candidate);
};

/** Resolve the configured (chainId, coreAddress) namespace, or null when unset. */
export const configuredNamespace = (env: Env["Bindings"]): { chainId: number; coreAddress: string } | null => {
  const rawChain = env.MEZO_CHAIN_ID;
  const rawCore = env.MEZO_CORE_ADDRESS ?? env.MUO_CORE_CONTRACT;
  if (rawChain === undefined || rawCore === undefined) return null;
  const chainId = Number(rawChain);
  if (!isChainId(chainId)) return null;
  const coreAddress = rawCore.toLowerCase();
  if (!isAddress(coreAddress)) return null;
  return { chainId, coreAddress };
};

export const indexerConfigFromEnv = (env: Env["Bindings"]): IndexerConfig | null => {
  const ns = configuredNamespace(env);
  if (ns === null) return null;
  const num = (v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
  };
  const base = DEFAULT_INDEXER_CONFIG();
  return {
    ...base,
    chainId: ns.chainId as IndexerConfig["chainId"],
    coreAddress: ns.coreAddress as IndexerConfig["coreAddress"],
    startBlock: num(env.MEZO_START_BLOCK, base.startBlock),
    confirmations: num(env.MEZO_CONFIRMATIONS, base.confirmations),
    maxBlocksPerRun: num(env.MEZO_MAX_BLOCKS_PER_RUN, base.maxBlocksPerRun),
  };
};

export function registerV2Routes(app: Hono<Env>): void {
  app
    .use("/v2/*", async (c, next) => {
      const origin = c.req.header("Origin");
      const raw = c.env.CORS_ORIGINS;
      const origins = raw === undefined ? undefined : raw.split(",").map((o) => o.trim());
      const allow = origins === undefined ? "*" : origin && origins.includes(origin) ? origin : null;
      if (allow !== "*") c.res.headers.append("Vary", "Origin");
      if (allow) c.res.headers.set("Access-Control-Allow-Origin", allow);
      if (c.req.method === "OPTIONS") {
        for (const [k, v] of Object.entries(PREFLIGHT)) c.res.headers.set(k, v);
        return new Response(null, { status: 204, headers: c.res.headers });
      }
      await next();
      // Native assertion/status reads are FINANCIAL state. A stale body is a
      // correctness bug, not a performance trade-off: it can show `open` for an
      // assertion that is already `disputed` or `settled`, which breaks the
      // native wallet flow that reads this endpoint immediately after a write.
      //
      // `no-store` is applied to EVERY /v2/* response — success, error, and
      // pagination variants alike — so no layer (browser, proxy, CDN) may retain
      // a copy. There is deliberately no `max-age` and no
      // `stale-while-revalidate`: both permit serving known-stale data.
      c.res.headers.set("Cache-Control", "no-store");
    })
    .get("/v2/assertions", async (c) => {
      const ns = configuredNamespace(c.env);
      if (ns === null) {
        // Explicitly unconfigured, not "empty". A 503 is honest; a 200 [] would
        // look like "no assertions exist".
        return c.json({ error: "native_index_not_configured" }, 503);
      }
      const rawLimit = c.req.query("limit");
      const limit = rawLimit === undefined ? V2_PAGE_LIMIT : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > V2_MAX_LIMIT) return c.json({ error: "bad_limit" }, 400);
      const rawOffset = c.req.query("offset");
      const offset = rawOffset === undefined ? 0 : Number(rawOffset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET || rawOffset === "") {
        return c.json({ error: "bad_offset" }, 400);
      }

      const { results } = await c.env.MUO_DB.prepare(
        `${SELECT_ROWS} where "chain_id" = ? and "core_address" = ?
         order by "block_number" desc, "transaction_index" desc, "log_index" desc
         limit ? offset ?`
      )
        .bind(ns.chainId, ns.coreAddress, limit, offset)
        .all<RawRow>();

      const rows: Assertion[] = [];
      for (const r of results ?? []) {
        try {
          rows.push(toNativeAssertion(r));
        } catch (err) {
          // Never serve a partially-valid row. Log and fail loudly.
          console.error(JSON.stringify({ route: "/v2/assertions", error: "invalid_row", detail: String(err) }));
          return c.json({ error: "stored_row_invalid" }, 500);
        }
      }
      return c.json(rows, 200);
    })
    .get("/v2/status", async (c) => {
      const ns = configuredNamespace(c.env);
      if (ns === null) return c.json({ configured: false, error: "native_index_not_configured" }, 503);

      const cursor = await c.env.MUO_DB.prepare(
        `select "block_number", "block_hash", "log_index", "version", "lease_owner", "lease_expires_at", "last_error", "updated_at"
         from "mezo_indexer_cursor" where "chain_id" = ? and "core_address" = ?`
      )
        .bind(ns.chainId, ns.coreAddress)
        .first<{
          block_number: number;
          block_hash: string;
          log_index: number;
          version: number;
          lease_owner: string | null;
          lease_expires_at: number | null;
          last_error: string | null;
          updated_at: number;
        }>();

      const counts = await c.env.MUO_DB.prepare(
        `select
           (select count(*) from "mezo_assertions" where "chain_id" = ? and "core_address" = ?) as assertions,
           (select count(*) from "mezo_applied_logs" where "chain_id" = ? and "core_address" = ?) as logs`
      )
        .bind(ns.chainId, ns.coreAddress, ns.chainId, ns.coreAddress)
        .first<{ assertions: number; logs: number }>();

      const head = await c.env.MUO_DB.prepare(`select 1`)
        .first<{ 1: number }>()
        .catch(() => null);
      const cfg = indexerConfigFromEnv(c.env);

      // Honest status: a cursor at startBlock with zero logs is NOT healthy.
      const indexedLogs = counts?.logs ?? 0;
      const state =
        cursor === null
          ? "never_run"
          : cursor.last_error !== null
            ? "error"
            : indexedLogs === 0 && cursor.block_number <= (cfg?.startBlock ?? 0)
              ? "no_events"
              : "ok";

      return c.json(
        {
          configured: true,
          chainId: ns.chainId,
          coreAddress: ns.coreAddress,
          state,
          cursor: cursor
            ? {
                blockNumber: cursor.block_number,
                blockHash: cursor.block_hash,
                logIndex: cursor.log_index,
                version: cursor.version,
                updatedAt: cursor.updated_at,
              }
            : null,
          lease: cursor ? { owner: cursor.lease_owner, expiresAt: cursor.lease_expires_at } : null,
          lastError: cursor?.last_error ?? null,
          counts: { assertions: counts?.assertions ?? 0, appliedLogs: indexedLogs },
          config: cfg
            ? {
                startBlock: cfg.startBlock,
                confirmations: cfg.confirmations,
                maxBlocksPerRun: cfg.maxBlocksPerRun,
              }
            : null,
          dbReachable: head !== null,
        },
        200
      );
    })
    // Manual, authenticated, bounded trigger. Runs at most `maxBlocksPerRun`
    // blocks and never accepts a caller-supplied log payload: it reads the chain
    // itself, so it cannot be used to write arbitrary normalized events.
    .post("/v2/indexer/run", async (c) => {
      const secret = c.env.INDEXER_ADMIN_SECRET;
      if (typeof secret !== "string" || secret.length === 0) {
        return c.json({ error: "indexer_admin_not_configured" }, 503);
      }
      const auth = c.req.header("Authorization") ?? "";
      const expected = `Bearer ${secret}`;
      // Length-equal, constant-time-ish compare. Hono's bearerAuth already does
      // this for v1; this route is separate so it gets its own check.
      if (auth.length !== expected.length) return c.json({ error: "unauthorized" }, 401);
      let diff = 0;
      for (let i = 0; i < auth.length; i++) diff |= auth.charCodeAt(i) ^ expected.charCodeAt(i);
      if (diff !== 0) return c.json({ error: "unauthorized" }, 401);

      // Auth is checked BEFORE the body is read.
      const body = await readCappedBody(c.req.raw, 0);
      if (body instanceof Response) return body;

      const cfg = indexerConfigFromEnv(c.env);
      if (cfg === null) return c.json({ error: "native_index_not_configured" }, 503);
      const rpcUrl = c.env.MEZO_RPC_URL;
      if (typeof rpcUrl !== "string" || rpcUrl.length === 0) return c.json({ error: "rpc_not_configured" }, 503);

      const rpc = new MezoRpc({ url: rpcUrl, timeoutMs: 10_000, maxRetries: 2, backoffMs: 200 });
      const store = new D1IndexerStore(c.env.MUO_DB);
      const result = await runIndexerCycle(cfg, { rpc, store });
      return c.json(result, result.status === "halted" ? 502 : 200);
    });
}

export type { Hex };
