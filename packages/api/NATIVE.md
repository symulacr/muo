# `@muo/api` — native Mezo backend

The Stacks/Clarity ingestion path is **retired**. Assertions are indexed from
`MuoCore` EVM logs on Mezo. The legacy `assertions` table and its rows are
preserved read-only; nothing was converted or deleted.

## Routes

These are implemented local-source routes, not a record of an updated public deployment.

| Route | Auth | Status |
|---|---|---|
| `GET /health` | none | live |
| `GET /assertions` | none | **historical, read-only** — legacy Stacks rows |
| `POST /webhook` | — | **retired → 410 Gone** |
| `POST /webhook/chainhooks` | — | **retired → 410 Gone** |
| `POST /webhook/indexer` | — | **retired → 410 Gone** |
| `GET /v2/assertions` | none | live — native rows, `bondMusd` string, chain order |
| `GET /v2/status` | none | live — honest indexer state |
| `POST /v2/indexer/run` | `INDEXER_ADMIN_SECRET` | live — one bounded cycle |

### Why 410, not 404 or 401

A retired endpoint must tell a client that it *existed and was retired*, not
that it mistyped a URL. `401` would be worse: it would imply that the right
token still works. The 410 body is machine-readable:

```json
{
  "error": "gone",
  "code": "v1_stacks_ingest_retired",
  "message": "The Stacks/Clarity ingestion path was retired. ...",
  "replacement": { "read": "GET /v2/assertions", "status": "GET /v2/status", "trigger": "POST /v2/indexer/run" },
  "legacyReadOnly": "GET /assertions"
}
```

### The legacy read route

`GET /assertions` still serves the v1 `assertions` table with `bondSats`. It is
**historical**: those rows use the previous Stacks-oriented schema, not the
Mezo-native index. They are deliberately *not* converted, because rewriting a row's bond
would break the assertion-id preimage it is stored under. New consumers must use
`/v2/assertions`.

## Data model (migration `0003`)

Four new tables. `0000`–`0002` are untouched.

| Table | Role |
|---|---|
| `mezo_assertions` | projection, PK `(chain_id, core_address, assertion_id)` |
| `mezo_applied_logs` | ledger, PK `(chain_id, core_address, tx_hash, log_index)` |
| `mezo_indexer_cursor` | position + `version` (CAS witness) + lease + `last_error` |
| `mezo_block_hashes` | observed boundary hashes for reorg detection |

`bond_musd` is a canonical whole-MUSD **decimal string** — never a JS number,
never raw 1e18 units. Use `bondToUnits()` from `@muo/core/native` for raw units.

## Atomicity and concurrency

One `db.batch()` is the commit unit; D1 `batch()` is transactional.

### The witness token

Each `commit()` mints a **unique token** (`crypto.randomUUID()`, inside
`commit()`, never caller-supplied) and writes it into
`mezo_indexer_cursor.lease_owner` as the **first** statement — the cursor CAS.
Every later statement is guarded by

```sql
EXISTS (SELECT 1 FROM mezo_indexer_cursor
         WHERE chain_id = ? AND core_address = ? AND lease_owner = ?)
```

The token is the witness that *this* transaction is the one that won the CAS.

A position+version guard is **not** a unique witness. A stale run that happens
to compute the exact same next position (same version, block, hash and
logIndex) would satisfy such a guard, write its projection, and report success.
The token cannot collide, so a stale run's writes are always no-ops.

### Success is the CAS's own `meta.changes`

`commit()` returns `{ ok, applied }`. `ok` is the **first statement's**
`meta.changes === 1`. It is *not* a post-read of the cursor: a later commit may
legitimately advance the cursor between our batch and our read, which would make
a genuine winner look like a loser — and a loser that matched the winner's
position look like a winner.

`applied` is the sum of `meta.changes` over the ledger inserts, so a duplicate
re-delivery reports **0**, not the number of rows attempted.

### Every write is guarded

The projection upsert is `INSERT ... SELECT ... WHERE <guard>`, **not**
`VALUES`. An unguarded `VALUES` upsert ignores the CAS entirely: a lost commit
would still write the projection even though every ledger statement was
correctly skipped. This is covered by a regression test that fails if the guard
is removed.

The token is released **in the same transaction**, so a successful run never
blocks the next one for `leaseMs`. A trigger
(`mezo_indexer_cursor_cas_guard`) additionally aborts any position change that
does not bump `version`.

Nothing here claims a D1 transaction across separate HTTP requests. The only
transaction boundary is the single `batch()`.

## Cursor semantics

The cursor records the **end of the last fully validated RPC range**, not the
last event seen. A range whose only event sits early and whose tail is empty
still advances to the range end; otherwise the next cycle re-fetches the same
event forever and never progresses. `logIndex` is the highest committed log at
that end block, or `-1` when the end block produced none.

When the cursor reaches the safe head the cycle reports `caught-up` instead of
re-fetching the single head block indefinitely.

## Reorg handling

No `finalized` / `safe` block-tag assumption. Each cycle re-reads the cursor's
own `block_hash` and compares it with the chain. **Two** shapes are detected:

1. a different hash at the same height (a replacement block), and
2. **no block at that height at all** (the chain rewound past the cursor).

On detection the indexer performs a **bounded common-ancestor search**: it walks
down from the cursor (at most `reorgLookback` blocks, default 128) comparing each
stored anchor against the chain, and takes the highest height that still
matches. Rewinding to the old cursor height alone is wrong — a multi-block fork
leaves ledger rows and projections *above the ancestor* orphaned, and those
would remain canonical.

Everything above the ancestor is then removed (ledger rows, anchors) and the
affected assertions are rebuilt from the surviving ledger plus a bounded
re-read, all in the same transaction. If the `asserted` log itself is orphaned,
the projection row is deleted.

**No ancestor within budget ⇒ HALT.** The cycle returns
`reorg-unresolved` and records an error asking for an operator rebuild. It never
reports `caught-up` while holding known orphans. A chain that rewinds below
`startBlock` while a cursor exists also halts, for the same reason.

## Canonicality during a fetch

`eth_getLogs` is bracketed by two reads of the range-end block hash. A change
means the chain moved under the fetch, so the page is discarded
(`unstable-range`) rather than committed under a cursor that no longer describes
it. Every fetched log's block hash is also checked against the canonical
observation at that height, bounded by `reorgLookback` distinct blocks per page.

A `removed` MuoCore log arriving inside a requested canonical range means the
provider's view is inconsistent with the range asked for. That halts
(`unstable-range`); it is not safe to skip the log and advance past it.

## Bounded work

| Limit | Value | Where |
|---|---|---|
| blocks per run | `MEZO_MAX_BLOCKS_PER_RUN` (default 500) | `indexer.ts` |
| blocks per `eth_getLogs` | 2 000 | `RPC_LIMITS.MAX_BLOCK_RANGE` |
| logs per call | 1 000 (exceeding is an error, not a truncation) | `RPC_LIMITS.MAX_LOGS_PER_CALL` |
| reorg ancestor lookback | 128 blocks | `IndexerConfig.reorgLookback` |
| RPC timeout | 10 s | `MezoRpc` |
| RPC retries | 2–3, transient only | `MezoRpc` |

`eth_chainId` is validated before any log is trusted.

### CPU budget — a measurement gate, not a backfill promise

Workers **Free** grants roughly **10 ms CPU per Cron invocation**. The handler
does network I/O (not counted) plus decode and projection work (counted). A full
backfill from block `16380473` is **not** claimed to fit on Free.

**Scheduled indexing is disabled** (no `triggers.crons` entry). Until CPU is
measured, drive ingestion with the authenticated `POST /v2/indexer/run`
controller in bounded slices. Do not enable a cron on the assumption that it
fits.

## Configuration

`wrangler.jsonc` sets `MEZO_CHAIN_ID`, `MEZO_CORE_ADDRESS`,
`MEZO_START_BLOCK`, `MEZO_CONFIRMATIONS`, `MEZO_MAX_BLOCKS_PER_RUN` as prepared
testnet defaults.

`MEZO_RPC_URL` and `INDEXER_ADMIN_SECRET` are intentionally absent from `vars`:

```bash
wrangler secret put MEZO_RPC_URL
wrangler secret put INDEXER_ADMIN_SECRET
```

`WEBHOOK_SECRET` / `CHAINHOOKS_SECRET` are retained as *optional* bindings so an
existing deployment keeps booting, but **no handler reads them** any more.

## Entry contract

`src/index.ts` exports **only** `default { fetch, scheduled }`. No named exports
of any kind. Tests import the Hono app from `src/app.ts`.

## Commands

```bash
cd packages/api
bun test                    # unit, route, indexer, and real-anvil e2e
bun run test:runtime        # minified Workers bundle, real D1, aliases
bun run check:mezo          # read-only testnet probe (public RPC, 12 calls)
bunx tsc --noEmit -p tsconfig.json
bunx biome check src scripts
```

`package.json` scripts: `dev`, `deploy`, `test`, `test:runtime`, `check:mezo`.
Only `dev` and the test/lint commands are safe to run without the approvals
listed further down; `deploy` is remote.

## Results (historical snapshot — not the current gate)

> **Read counts from the root gate, not from this file.** The authoritative
> full-suite figures live in the root worker's verification summary. This table
> is a point-in-time snapshot from an earlier pass and is deliberately **not**
> updated by hand, because a hand-copied count goes stale the moment any other
> worker lands a test.

| Check | Result at that snapshot |
|---|---|
| `bun test` | pass (count superseded — see root gate summary) |
| `bun run test:runtime` | **pass** — 131.89 KiB / 41.21 KiB gzip |
| `tsc --noEmit` | **exit 0** |
| `biome check src` | **exit 0** |
| real-anvil e2e | **18 pass** — assert/dispute/resolve/unresolved, expiry settle, restart, reorg, atomicity |
| real-SQL commit protocol | **19 pass** — witness guards, exact-position CAS loss, rollback, anchor cleanup |

Last **narrow** observation made by the API worker, scoped only to the eight
pure suites (no anvil, no network): **171 pass, 0 fail**, with `tsc --noEmit`
exit 0 and `biome check src scripts` exit 0 and zero warnings. That is a subset,
not the full gate, and it is not a substitute for the root summary.

Bundle: **136.92 KiB** (Clarity era) → **128.79 KiB** (native) → **131.89 KiB**
after the commit-protocol hardening. The net change vs. the Clarity build is
still negative; the +3.1 KiB is the guarded `INSERT ... SELECT` forms and the
witness-token predicates.

### What the SQL regression suite actually proves

`store-sql.test.ts` runs against real SQLite through `sqlite-d1.ts`, which
implements `batch()` as a genuine `BEGIN IMMEDIATE ... COMMIT` and reports real
`meta.changes` / `last_row_id` for writes. It asserts:

- a stale version writes **no** projection, ledger or anchor row
- a stale run targeting the **exact winner position** still writes nothing
- a lost CAS blocks projection INSERT, UPDATE and DELETE, ledger DELETE, and
  anchor cleanup
- the winner's projection survives byte-for-byte
- a mid-batch failure rolls back everything and a retry then succeeds
- the CAS trigger rejects an unversioned position change

These are **regression** tests, not merely coverage: removing the projection
guard makes 10 of them fail. That was verified by temporarily reverting the
guard and observing the failures, then restoring it.

## Read-only testnet compatibility (observed)

A bounded read-only probe was run against the real public Mezo testnet node.

```bash
cd packages/api
bun --no-env-file run scripts/check-mezo-readonly.ts
```

**Result: PASS, 12 calls, all read-only.** Observed against
`https://rpc.test.mezo.org` (chain `31611`):

> **Revision note.** The probe has two revisions and **both have now been run
> against the live chain**. v1 used hand-written selectors and word readers; v2
> — the current file — encodes/decodes through `viem` against
> `muoCoreAbi`/`musdAbi`. v2 ran after `viem` was linked into this package and
> reproduced v1's 12 method outcomes exactly, at head `16417845`.
> Offline checks additionally confirm v2 emits the same selectors as v1 and
> decodes the `Assertion` struct by field.

| Check | Observed (v1, reproduced by v2) |
|---|---|
| chain id | `31611` |
| latest block | head `16417233` (v1) / `16417845` (v2), hash `0x7c0ac6…9ee5` (v1) |
| `MuoCore` bytecode | 7440 bytes present |
| MUSD bytecode | 6437 bytes present |
| `getMinBondMusd()` | `10` whole MUSD |
| `MUSD_UNIT()` | `1000000000000000000` |
| `musd()` | `0x118917a40faf1cd7a13db0ef56c86de7973ac503` |
| `MUSD.decimals()` | `18` |
| `Asserted` sample | 3 logs in 1 page, scanned to block `16380872` |
| SDK strict decode | `asserted`, `bondMusd = "10"`, id `0x00d707e8…9278` |
| `getAssertion` cross-check | `exists = true`, `status = 2` |

Method counts: `eth_chainId=1, eth_blockNumber=1, eth_getBlockByNumber=1,
eth_getCode=2, eth_call=6, eth_getLogs=1`.

Full report: `outputs/continuation-20261028/mezo-readonly/probe-report.json`
(v2, current). The v1 record is preserved at
`outputs/continuation-20261028/verification/probe-report-v1-historical.json`;
the v2 copy is `.../verification/probe-report-v2-viem.json`.

### Scope of that result — read it narrowly

- **Read-only.** `MezoRpc` enforces a hard method allowlist in `call()`, so
  `eth_sendTransaction`, `eth_sendRawTransaction`, `eth_sign*`, `wallet_*`,
  `personal_*`, `evm_*` and faucet methods are refused before a request is sent.
  There is no send/sign/permit method on the client at all.
- **Not a wallet flow.** No transaction, signature, permit or faucet was used.
- **Not source verification.** Bytecode *presence* was checked, nothing more.
  Compiler metadata, constructor-baked immutables and library links mean the
  deployed bytes will not equal a local artifact hash even for correct source.
  **Explorer verification remains pending.**
- **Not a backfill.** Three pages of 400 blocks maximum from the deploy block.
  Absence of a log in that window is absence, not zero assertions.
- **Not an indexer throughput measurement.** The 128-block reorg lookback and the
  Workers Free ~10 ms CPU Cron budget are still **unmeasured against real load**.
  Scheduled indexing remains disabled; drive ingestion with the authenticated
  `POST /v2/indexer/run` controller in bounded slices.

Not done: no deploy, no cron invocation, no production D1 write, no
state-changing chain call.

## HTTP cache policy — native reads are fresh by default

`GET /v2/assertions` and `GET /v2/status` send **`Cache-Control: no-store`**.

Native assertion and status reads are financial state. A stale body can show
`open` for an assertion that is already `disputed` or `settled`, which breaks the
wallet flow that reads this endpoint immediately after a write. The previous
`public, max-age=5, stale-while-revalidate=30` policy permitted exactly that for
up to 35 seconds.

`packages/api/src/routes/v2.ts` sets the header **unconditionally after
`await next()`** in the `/v2/*` middleware, so it applies to success, error
(400/503) and pagination variants alike. There is deliberately no `max-age` and
no `stale-while-revalidate`: both permit serving known-stale data.

The historical v1 `GET /assertions` route is **unchanged** and still emits no
`Cache-Control`. The v1 middleware is mounted on `/assertions/*`, which does not
match the bare route. That surface is read-only historical data.

The portal additionally sends `cache: "no-store"` client-side. Both layers are
intentional; neither is a substitute for the other.

Regression coverage: `src/__tests__/v2-consistency.test.ts` (real SQLite, mock
RPC, no network) asserts `no-store` on real rows, on `/v2/status`, on 400
bad-limit/bad-offset, on 503 unconfigured and on the POST trigger; asserts
`max-age` / `stale-while-revalidate` / `public` are absent; asserts the v1 bare
route still emits no header; and asserts an awaited POST followed by an immediate
GET flips the row for asserted→disputed and disputed→rejected.

## Operator runbook (local only)

Everything below is **local**. None of it has been executed against a remote
environment by this change.

### 1. Install and typecheck

```bash
cd packages/api
bun install                 # workspace; viem 2.57.7 is already pinned
bunx tsc --noEmit -p tsconfig.json
bunx biome check src scripts
```

### 2. Run the tests

```bash
bun --no-env-file test src/__tests__/v2-consistency.test.ts   # pure SQLite, no network
bun --no-env-file test src/__tests__/store-sql.test.ts        # pure SQLite
bun --no-env-file test src/__tests__/rpc-readonly.test.ts     # allowlist, no network
bun --no-env-file test src/__tests__/probe-abi.test.ts        # ABI boundary, no network
bun test                                                      # everything, incl. real-anvil e2e
```

`bun test` spawns a local anvil on an ephemeral port. Use the narrow suites when
you do not want a chain process.

### 3. Local dev server

```bash
bun run dev        # wrangler dev, local workerd
```

Local bindings come from `wrangler.jsonc`. `MEZO_RPC_URL` and
`INDEXER_ADMIN_SECRET` are **not** in `vars`; supply them per environment:

```bash
wrangler secret put MEZO_RPC_URL            # value typed at the prompt
wrangler secret put INDEXER_ADMIN_SECRET    # value typed at the prompt
```

Never commit either value. `.env.example` contains placeholders only. Leaving
`MEZO_CHAIN_ID` / `MEZO_CORE_ADDRESS` unset makes `/v2/*` answer **503
`native_index_not_configured`** rather than a healthy-looking empty `200`.

### 4. Read-only probe against the public testnet

```bash
cd packages/api
bun --no-env-file run scripts/check-mezo-readonly.ts          # human-readable
bun --no-env-file run scripts/check-mezo-readonly.ts --json   # machine-readable only
```

Exit codes: `0` all checks passed, `1` a check failed, `2` RPC unavailable.
Budget: 20 calls, 3 log pages × 400 blocks, 8 s timeout, 1 retry, serial. It
writes `outputs/continuation-20261028/mezo-readonly/probe-report.json`.

This probe is **read-only by construction**: `MezoRpc.call()` refuses any method
outside `READ_ONLY_METHODS` (`eth_chainId`, `eth_blockNumber`,
`eth_getBlockByNumber`, `eth_getLogs`, `eth_getCode`, `eth_call`), and the client
has no send/sign/permit method at all. It reads no secret and no wallet.

### 5. Manual indexer controller

Scheduled indexing is disabled (no `triggers.crons`). Drive ingestion by hand:

```bash
curl -X POST "$API_BASE/v2/indexer/run" \
  -H "Authorization: Bearer $INDEXER_ADMIN_SECRET"
```

The route takes **no caller payload** — a non-empty body is rejected. It runs
exactly one bounded cycle and **awaits** `runIndexerCycle` → `store.commit` →
the single transactional `db.batch()`. When it returns `applied: N`, the
projection is already committed, so an immediate `GET /v2/assertions` is
consistent. Reading *before* awaiting the POST is a caller bug and will
legitimately show the pre-commit row.

Auth: `INDEXER_ADMIN_SECRET` unset ⇒ **503**, so the route can never be
triggered anonymously. A wrong or empty bearer ⇒ **401**, via a length-equal,
constant-time-ish compare (the source comment's own wording — it is not a
hardened constant-time primitive). Auth is checked **before** the body is read,
and the body cap is `0`, so a non-empty body is rejected.

Response status: `200` for a completed cycle, **`502`** when the cycle returns
`halted` (for example `reorg-unresolved`). A halt is never reported as success.

## Approvals required before anything remote

Each item below needs **its own explicit approval**. None is implied by the
others, and none has been performed.

| Action | Why it needs separate approval |
|---|---|
| Apply migration `0003` to the **remote** D1 database | Creates four tables in a live database; `0000`–`0002` are untouched but this is still a one-way schema change |
| Deploy the **API** worker | Replaces the running backend |
| Deploy the **app** / site | Changes what users are served |
| Enable **Cron** (`triggers.crons`) | Only after an **actual CPU measurement** on the target plan; Workers Free grants roughly 10 ms CPU per tick and a full backfill from block `16380473` is not claimed to fit |
| Any **public wallet transaction** | Spends real funds and is irreversible; this repo has never sent one |

Local tests, the read-only probe and a local `wrangler dev` do not require these
approvals. A remote `wrangler deploy`, `wrangler d1 migrations apply --remote`,
a Cron enable, or a signed transaction **do**.

## Guarantees about legacy data

These are invariants, not measurements.

| Guarantee | Meaning |
|---|---|
| Legacy rows are **historical and read-only** | `GET /assertions` serves the v1 `assertions` table. It is never written, converted or deleted. |
| `bond_sats` is **never converted** | Those rows keep the Stacks-oriented schema and their original `bondSats` integer. Rewriting a row's bond would break the assertion-id preimage it is stored under. |
| Retired writes answer **410 Gone** | `POST /webhook`, `/webhook/chainhooks` and `/webhook/indexer` return `410` with `code: "v1_stacks_ingest_retired"` and a machine-readable pointer to the native replacement. Not `404` (which would imply a typo) and not `401` (which would imply the right token still works). |
| Native and legacy are **separate surfaces** | `bondMusd` (whole-MUSD decimal string) lives only on `/v2/*`. `bondSats` lives only on `/assertions`. There is no conversion path in either direction. |

## What is NOT proven

Keep these attached to any status claim.

- **Not source-verified.** `eth_getCode` proves bytecode is *present*, nothing
  more. Compiler metadata, constructor-baked immutables and library links mean
  deployed bytes will not equal a local artifact hash even for correct source.
  **Explorer source verification remains pending.**
- **Not a public-deployment health claim.** Routes here are implemented in local
  source. This document is not evidence that a public deployment is healthy,
  current, or even running this revision. No SSA, uptime or "health" claim is
  made about any public environment.
- **Not a D1 measurement.** The SQL suites run on real SQLite via `sqlite-d1.ts`
  (genuine `BEGIN IMMEDIATE ... COMMIT`), which is a faithful but not identical
  substrate. D1 latency, contention and limits are unmeasured.
- **Not a reorg measurement.** The 128-block common-ancestor lookback is
  exercised by tests, not by a real deep fork on a live chain.
- **Not a wallet flow.** No transaction, signature, permit or faucet was used
  anywhere in this work.
- **Not a CPU measurement.** The Cron budget is a gate, not a result.

## Deliberately not changed

- The Drizzle/Hono aliases and the `Subquery`/`WithSubquery`/`TrieRouter`
  constructor re-exports in `stub-locales.js` stay. Only the **Stacks-only**
  crypto aliases (`c32check`, `@noble/secp256k1`, `@noble/hashes/*`,
  `lodash.clonedeep`, `./base58check`) were removed, because they shadowed the
  real `@noble/hashes` that viem needs.
- Hono's empty-token rejection, malformed-JSON handling and timing-safe bearer
  comparison are existing behaviour and were not "re-fixed".
- Migrations `0000`–`0002` are byte-identical. `0003` is unchanged by this pass;
  the witness token reuses the existing `lease_owner` column, so no new
  migration was needed.
