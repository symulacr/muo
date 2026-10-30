import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(join(tmpdir(), "muo-worker-test-"));
const origin = "https://mezo-upbeat-oracle.vercel.app";
const server = createTestHarness({
  root,
  workers: [
    {
      configPath: "./wrangler.jsonc",
      prebuiltWorkerDir: output,
      secrets: { WEBHOOK_SECRET: "runtime-webhook-secret", CHAINHOOKS_SECRET: "runtime-chainhooks-secret" },
    },
  ],
});
try {
  execFileSync(process.execPath, [fileURLToPath(import.meta.resolve("wrangler")), "deploy", "--dry-run", "--minify", "--outdir", output], {
    cwd: root,
    stdio: "inherit",
  });
  await server.listen();
  await server.getWorker().applyD1Migrations("MUO_DB");
  const health = await server.fetch("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const list = await server.fetch("/assertions", { headers: { Origin: origin } });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("Access-Control-Allow-Origin"), origin);
  assert.deepEqual(await list.json(), []);
  const blocked = await server.fetch("/assertions", { headers: { Origin: "https://untrusted.example" } });
  assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), null);
  const preflight = await server.fetch("/assertions", { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  // Retired v1 Stacks write routes: 410 Gone with an explicit native pointer.
  // NOT 401 — a retired endpoint must not imply that a token would work.
  for (const path of ["/webhook", "/webhook/chainhooks", "/webhook/indexer"]) {
    const res = await server.fetch(path, { method: "POST", body: "{}" });
    assert.equal(res.status, 410, `${path} must be 410 Gone`);
    const body = await res.json();
    assert.equal(body.code, "v1_stacks_ingest_retired");
    assert.equal(body.replacement.read, "GET /v2/assertions");
  }

  // The legacy read route is preserved and still serves its (empty) table.
  const legacy = await server.fetch("/assertions");
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json(), []);

  // --- native v2 surface -------------------------------------------------
  // wrangler.jsonc configures MEZO_CHAIN_ID/MEZO_CORE_ADDRESS, so the native
  // routes are live. They must serve an empty, schema-valid array (no legacy
  // rows are ever exposed here) and report honest status.
  const v2List = await server.fetch("/v2/assertions");
  assert.equal(v2List.status, 200, "configured /v2/assertions must be 200");
  assert.deepEqual(await v2List.json(), [], "native projection starts empty; legacy rows must not leak");

  const v2Status = await server.fetch("/v2/status");
  assert.equal(v2Status.status, 200);
  const status = await v2Status.json();
  assert.equal(status.configured, true);
  assert.equal(status.chainId, 31611);
  assert.equal(status.coreAddress, "0x61c41cd7299fd668c3a7aae62f12c017fe654cb0");
  assert.equal(status.cursor, null, "no indexer run has happened");
  assert.equal(status.state, "never_run", "an unrun indexer must not report ok");
  assert.equal(status.counts.appliedLogs, 0);

  // The admin trigger must reject an unauthenticated call before reading a body.
  const v2Run = await server.fetch("/v2/indexer/run", { method: "POST", body: "{}" });
  assert.equal(v2Run.status, 503, "no INDEXER_ADMIN_SECRET configured -> 503, never an open trigger");

  // The new tables exist and the legacy table is untouched.
  const d1 = (await server.getWorker().getEnv()).MUO_DB;
  const tables = await d1
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all()
    .then((r) => r.results.map((x) => x.name));
  for (const t of ["mezo_assertions", "mezo_applied_logs", "mezo_indexer_cursor", "mezo_block_hashes", "assertions"]) {
    assert.ok(tables.includes(t), `expected table ${t}, got ${tables.join(",")}`);
  }

  // The CAS guard trigger must be installed.
  const triggers = await d1
    .prepare("select name from sqlite_master where type = 'trigger' order by name")
    .all()
    .then((r) => r.results.map((x) => x.name));
  assert.ok(triggers.includes("mezo_indexer_cursor_cas_guard"), `expected CAS trigger, got ${triggers.join(",")}`);

  // The legacy table must still be writable by direct SQL (it is preserved, not
  // frozen) and the retired HTTP route must not be the way to do it.
  await d1
    .prepare(
      `insert into "assertions" ("id","identifier","claim","bond_sats","liveness","asserter","status","asserted_tx_id","asserted_at_block","created_at")
       values (?,?,?,?,?,?,?,?,?,?)`
    )
    .bind("aa".repeat(32), "bb".repeat(32), "cc".repeat(32), 10000, 1440, "ST1legacy", "open", "dd".repeat(32), 900000, 1)
    .run();
  const legacyCount = await d1.prepare("select count(*) as c from assertions").first();
  assert.equal(legacyCount.c, 1, "legacy row survives; the table is preserved, not migrated");

  console.log(
    "Workers runtime passed: minified bundle, retained Drizzle/Hono aliases, D1, CORS, preflight, retired v1 routes (410), legacy read route, v2 routes, 0003 migration, CAS trigger."
  );
} finally {
  await server.close();
  await rm(output, { recursive: true, force: true });
}
