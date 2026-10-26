// Hono application: all HTTP routes.
//
// Split out of index.ts so tests can call `app.request(...)` directly while the
// Worker entry (`src/index.ts`) exports ONLY `{ fetch, scheduled }`.
//
// v1 routes (`/assertions`, `/webhook`, `/webhook/chainhooks`,
// `/webhook/indexer`) are unchanged and stay live until the portal cutover.
// v2 routes (`/v2/assertions`, `/v2/status`) are additive and serve only
// native `mezo_assertions` rows.

/// <reference types="@cloudflare/workers-types" />

import type { Context } from "hono";
import { getTableColumns } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";

import { retiredV1Routes } from "./handlers/retired-v1";
import { assertions } from "./lib/db/schema";
import { readCappedBody } from "./lib/http";
import { MAX_BODY_BYTES, MAX_OFFSET, PAGE_LIMIT } from "./lib/limits";
import { registerV2Routes } from "./routes/v2";

export { readCappedBody };

/**
 * Bindings.
 *
 * `WEBHOOK_SECRET` and `CHAINHOOKS_SECRET` are retained as OPTIONAL only so an
 * existing deployment does not fail to boot while its secrets are being removed
 * from `wrangler.jsonc`. Nothing reads them any more: the v1 write routes are
 * retired and answer 410 unconditionally.
 */
export type Bind = { MUO_DB: D1Database; RATE_LIMITER?: RateLimit; CORS_ORIGINS?: string } & {
  WEBHOOK_SECRET?: string;
  CHAINHOOKS_SECRET?: string;
  MUO_CORE_CONTRACT?: string;
  MEZO_CHAIN_ID?: string;
  MEZO_RPC_URL?: string;
  MEZO_CORE_ADDRESS?: string;
  MEZO_START_BLOCK?: string;
  MEZO_CONFIRMATIONS?: string;
  MEZO_MAX_BLOCKS_PER_RUN?: string;
  /** Bearer for the manual `/v2/indexer/run` trigger. Unset => route is 503. */
  INDEXER_ADMIN_SECRET?: string;
};
export type Env = { Bindings: Bind; Variables: Record<string, never> };
type PreparedList = { all: () => Promise<unknown> };
const PREFLIGHT = { "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" };
const HK = ["Cross-Origin-Resource-Policy", "Strict-Transport-Security", "X-Content-Type-Options"];
const HV = ["same-origin", "max-age=31536000; includeSubDomains", "nosniff"];
const [ORIGINS, FIRST, PAGES] = [new Map<string, string[]>(), new WeakMap<D1Database, PreparedList>(), new WeakMap<D1Database, Map<number, PreparedList>>()];
const { createdAt: _, ...cols } = getTableColumns(assertions);
const [KEYS, colList] = [Object.keys(cols), Object.values(cols)];
const COLS = colList.map((c) => `"${c.name}"`).join(", ");
const TAIL = `order by "assertions"."created_at" desc, "assertions"."asserted_at_block" desc, "assertions"."id" desc limit ?`;
const SQL = `select ${COLS} from "assertions" ${TAIL}`;
const split = (s: string) => s.split(",").map((o) => o.trim());
const fail = (c: Context<Env>, err: Error) => {
  console.error(JSON.stringify({ path: c.req.path, method: c.req.method, error: String(err) }));
  return c.json({ error: "unexpected_error" }, 500);
};
const parseOrigins = (raw?: string) => {
  if (raw === undefined) return undefined;
  if (ORIGINS.size >= 8) ORIGINS.clear();
  return ORIGINS.get(raw) ?? (ORIGINS.set(raw, split(raw)).get(raw) as string[]);
};
const toRow = (r: unknown) => Object.fromEntries(KEYS.map((k, i) => [k, (r as unknown[])[i]]));
const prep = (s: D1PreparedStatement): PreparedList => ({ all: async () => (await s.raw()).map(toRow) });
const listAt = (d1: D1Database, offset: number): PreparedList => {
  if (!offset) return FIRST.get(d1) ?? (FIRST.set(d1, prep(d1.prepare(SQL).bind(PAGE_LIMIT))).get(d1) as PreparedList);
  const m = PAGES.get(d1) ?? (PAGES.set(d1, new Map()).get(d1) as Map<number, PreparedList>);
  if (m.has(offset)) return m.get(offset) as PreparedList;
  if (m.size >= 4) m.clear();
  return m.set(offset, prep(d1.prepare(`${SQL} offset ?`).bind(PAGE_LIMIT, offset))).get(offset) as PreparedList;
};

// `readCappedBody` is implemented in ./lib/http and re-exported above so
// `routes/v2.ts` can use it without a cycle through this module.

const securityHeaders = (h: Headers) => {
  for (let i = 0; i < HK.length; i++) h.set(HK[i] as string, HV[i] as string);
};

const app = new Hono<Env>()
  .use(async (c, next) => {
    const { req, env } = c;
    const ip = req.header("CF-Connecting-IP") ?? req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "local";
    const limited = req.method !== "OPTIONS" && env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key: `${ip}:${req.path.replace(/\/$/, "")}` })).success;
    if (limited) {
      const res = c.json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      securityHeaders(res.headers);
      return res;
    }
    if (req.method === "POST" && Number(req.header("content-length")) > MAX_BODY_BYTES) {
      const res = c.json({ error: "payload_too_large" }, 413);
      securityHeaders(res.headers);
      return res;
    }
    await next();
    securityHeaders(c.res.headers);
  })
  .use(trimTrailingSlash())
  .use("/assertions/*", async (c, next) => {
    const [origins, origin, h] = [parseOrigins(c.env.CORS_ORIGINS), c.req.header("Origin"), c.res.headers];
    const allow = !origins ? "*" : origin && origins.includes(origin) ? origin : null;
    if (allow !== "*") h.append("Vary", "Origin");
    if (allow) h.set("Access-Control-Allow-Origin", allow);
    if (c.req.method === "OPTIONS") {
      for (const [k, v] of Object.entries(PREFLIGHT)) h.set(k, v);
      for (const k of ["Content-Length", "Content-Type"]) h.delete(k);
      return new Response(null, { headers: h, status: 204, statusText: "No Content" });
    }
    await next();
    if (c.req.method === "GET" && c.res.status === 200) h.set("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
  })
  .get("/health", (c) => c.json({ ok: true }, 200))
  // HISTORICAL, READ-ONLY. The legacy `assertions` table is the record of the
  // retired Stacks deployment. It is served here for provenance and is never
  // written, converted or deleted. Native data lives at `GET /v2/assertions`.
  .get("/assertions", async (c) => {
    const raw = c.req.query("offset");
    const offset = raw === undefined ? 0 : Number(raw);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET || raw === "") return c.json({ error: "bad_offset" }, 400);
    return c.json(await listAt(c.env.MUO_DB, offset).all(), 200);
  })
  // Retired v1 Stacks write surface: 410 with an explicit native pointer.
  .route("/webhook", retiredV1Routes)
  .onError((err, c) => {
    const res = err instanceof HTTPException ? err.getResponse() : fail(c, err);
    securityHeaders(res.headers);
    return res;
  });

// v2 native routes: additive, CORS-scoped to /v2/*.
registerV2Routes(app);

export { app as default, app };
