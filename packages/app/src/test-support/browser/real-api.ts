// REAL API fixture for the browser harness: the actual Hono app + a real
// SQLite-backed D1 + the real native indexer.
//
// This replaces the earlier in-process fixture that returned canned rows. The
// rows the browser reads now come from the same pipeline production uses:
//
//   local anvil chain
//     -> real `runIndexerCycle` (via the authenticated POST /v2/indexer/run)
//     -> real `D1IndexerStore` writes into a real SQLite database
//     -> real `GET /v2/assertions` on the real Hono app
//
// Scope and honesty:
//  - LOCAL TEST ONLY. `bun:sqlite` is not D1: it shares SQLite semantics but not
//    D1's network/proxy behaviour. Nothing here is evidence about production D1.
//  - The admin secret below is a LOCAL PLACEHOLDER, not a real credential.
//  - No production Cron is enabled; the indexer is triggered explicitly and
//    boundedly by the test.
//  - The API source is imported READ-ONLY. Nothing in packages/api is modified.

import { SqliteD1 } from "../../../../api/src/__tests__/sqlite-d1";

import { app as honoApp } from "../../../../api/src/app";

/** Local-only admin bearer for POST /v2/indexer/run. Not a real credential. */
export const TEST_ADMIN_SECRET = "local-test-admin-secret-not-a-credential";

export type RealApiOptions = {
  chainId: number;
  coreAddress: string;
  rpcUrl: string;
  startBlock: number;
  /** 0 so a freshly mined block is indexable immediately in a local test. */
  confirmations?: number;
};

export type RealApi = {
  /** Base URL of the local HTTP server fronting the real Hono app. */
  url: string;
  /** Underlying SQLite handle, for direct assertions in tests. */
  db: InstanceType<typeof SqliteD1>;
  /** Runs one bounded real indexer cycle. Returns the indexer's own result. */
  runIndexer: () => Promise<{ status: string; [k: string]: unknown }>;
  /** GET /v2/assertions with the HTTP cache bypassed (never returns a stale body). */
  readAssertions: () => Promise<unknown[]>;
  /** Reads rows straight from D1, bypassing HTTP (for cross-checks). */
  countRows: () => Promise<number>;
  stop: () => Promise<void>;
};

/**
 * Starts the real API on a loopback port.
 *
 * The Hono app is invoked through `app.fetch`, exactly as the Worker entry does,
 * with an explicit test binding set. No fixture rows are injected anywhere.
 */
export const startRealApi = async (opts: RealApiOptions): Promise<RealApi> => {
  const db = new SqliteD1(":memory:");

  const env = {
    MUO_DB: db as unknown as D1Database,
    INDEXER_ADMIN_SECRET: TEST_ADMIN_SECRET,
    MEZO_CHAIN_ID: String(opts.chainId),
    MEZO_CORE_ADDRESS: opts.coreAddress.toLowerCase(),
    MEZO_RPC_URL: opts.rpcUrl,
    MEZO_START_BLOCK: String(opts.startBlock),
    MEZO_CONFIRMATIONS: String(opts.confirmations ?? 0),
    MEZO_MAX_BLOCKS_PER_RUN: "500",
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      // Hand the request to the real Hono app with the test bindings.
      return honoApp.fetch(request, env as never, { waitUntil() {}, passThroughOnException() {} } as never);
    },
  });

  const url = `http://127.0.0.1:${server.port}`;

  /**
   * Reads `/v2/assertions` with the HTTP cache bypassed.
   *
   * The API sets `Cache-Control: public, max-age=5`. A plain GET issued right
   * after an indexer run can therefore return the PREVIOUS body, which makes a
   * real DB update look like a failed write. Always read fresh when diagnosing.
   */
  const readAssertions = async (): Promise<unknown[]> => {
    const res = await fetch(`${url}/v2/assertions`, { cache: "no-store" });
    if (!res.ok) throw new Error(`GET /v2/assertions failed: HTTP ${res.status}`);
    return (await res.json()) as unknown[];
  };

  const runIndexer = async () => {
    const res = await fetch(`${url}/v2/indexer/run`, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${TEST_ADMIN_SECRET}` },
    });
    const body = (await res.json()) as { status?: string; [k: string]: unknown };
    if (!res.ok && res.status !== 502) {
      throw new Error(`indexer run failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    }
    return { status: body.status ?? "unknown", ...body };
  };

  const countRows = async () => {
    const row = await db
      .prepare(`select count(*) as n from "mezo_assertions" where "chain_id" = ? and "core_address" = ?`)
      .bind(opts.chainId, opts.coreAddress.toLowerCase())
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  };

  return {
    url,
    db,
    runIndexer,
    readAssertions,
    countRows,
    stop: async () => {
      await server.stop(true);
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
};
