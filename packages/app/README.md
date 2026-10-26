# @muo/app

The MUO portal: a Next.js front end for the Mezo Upbeat Oracle. It lists assertions, lets a
connected wallet create and dispute them, and lets an arbiter resolve disputes.

Everything on-chain goes through **Mezo** (EVM). There is no Stacks or Clarity code path in this
package.

## What it does

- **Wallet** -- discovers injected wallets via EIP-6963 (falling back to a single `window.ethereum`),
  connects over EIP-1193, and refuses to transact unless the wallet is on the configured Mezo chain.
- **Reads** -- assertions come from the versioned `GET /v2/assertions` endpoint and are validated
  with the strict native schema from `@muo/core/native`. MUSD and BTC balances are read directly
  from the chain (`balanceOf` and `eth_getBalance`), both 18-decimal, both `bigint`.
- **Block height** -- polled over the configured HTTP RPC. No WebSocket endpoint is assumed, and
  the UI marks the feed as *not live* when it is stale or erroring.
- **Writes** -- `assertClaim`, `dispute`, `settle`, and `resolve` via viem. Each write is simulated
  first, then submitted, then confirmed only when a successful receipt carries the expected MuoCore
  event. Anything else is reported as *uncertain* with its transaction hash and a reconciliation
  prompt -- never as success, and never auto-retried.
- **Bonds** -- `dispute` and `assertClaim` pull a bond, so the portal approves the exact amount
  (never an unbounded allowance), waits for the approval receipt to succeed, then re-verifies the
  account and chain before prompting for the core call. `settle` and `resolve` pull nothing from the
  caller and request no approval.

## Configuration

Copy `.env.example` to `.env.local` and set the values. All variables are public
(`NEXT_PUBLIC_*`) and are inlined at build time.

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_MEZO_CHAIN_ID` | no | `31611` (testnet, default) or `31612` (mainnet). Anything else is rejected. |
| `NEXT_PUBLIC_MEZO_RPC_URL` | no | Defaults to the allowlisted endpoint for the chain. Must be `http(s)`. |
| `NEXT_PUBLIC_MEZO_EXPLORER_URL` | no | Defaults to the allowlisted explorer. Must be `http(s)`. |
| `NEXT_PUBLIC_MUO_CORE_CONTRACT` | **yes** | Lowercase 20-byte address. Missing or malformed blocks every write with a visible error. |
| `NEXT_PUBLIC_MUSD_ADDRESS` | **yes** | Lowercase 20-byte address. Same blocking behaviour. |
| `NEXT_PUBLIC_API_BASE_URL` | no | Defaults to `http://localhost:8787`. |

Configuration is resolved lazily, so a missing variable cannot crash `next build`. It does block
financial actions at runtime, with the specific problem shown in the UI.

## Commands

```bash
bun run dev      # next dev --webpack
bun run build    # next build --webpack
bun test         # bun test (from this package directory)
bun run lint     # biome check
```

Run tests from `packages/app`. The repository root `bunfig.toml` points the test root elsewhere.

## Current limitations

- **No permit path.** `assertWithPermit` and `disputeWithPermit` exist on the contract but the portal
  always uses the two-step `approve` + call flow. There is no gasless or one-click mode, and none is
  promised.
- **No WalletConnect / Passport / mobile deep links.** Only injected browser wallets are supported.
  Passport currently pins React 18 and wagmi 2 peers, so it is deferred rather than half-integrated.
- **No live event streaming.** The assertion list refreshes from the API on query invalidation and,
  while the view is active, on a bounded 5-second interval. It does not subscribe to chain logs. The
  block height is polled.
- **Single-page surface.** Only the Verify page exists.
- **Public deployment not updated.** Nothing here claims a deployed environment has been migrated.

## Active-view refresh

The indexer is an explicit operator action, so nothing pushes a newly indexed row into an open page.
A page opened before an indexing run would otherwise keep rendering the pre-index snapshot, showing
stale money state as if it were live.

`useAssertions` therefore subscribes the **active view** with
`refetchInterval: ASSERTIONS_REFETCH_INTERVAL_MS` (5 s), via the pure `activeAssertionsQuery()` in
`lib/assertions-query.ts`.

Deliberate properties:

- **The timer lives in the client observer, not the shared options.** `app/page.tsx` prefetches
  `assertionsQuery` in a Server Component; that option set carries no `refetchInterval`. There is no
  module-level `setInterval` anywhere in `src`.
- **Lifecycle is the library's.** The interval is a plain number that TanStack Query turns into a
  timer owned by the observer, so unmounting the view stops polling. Nothing to leak.
- **No background polling.** `refetchIntervalInBackground: false`, so a hidden tab stops hitting the
  API. `refetchOnWindowFocus: true` gives a cheap refetch when the user returns.
- **One cache entry.** The active view uses the same namespaced key as the server prefetch, so
  concurrent observers coalesce onto a single in-flight request.
- **Still fresh, still honest.** Reads keep `cache: "no-store"`; API and malformed-schema errors stay
  visible; there is no empty-healthy fallback.
- **Visible refresh.** The list shows a muted `Updating ...` status line while a background refetch
  is in flight, so a row cannot silently swap under the reader.

This bounds staleness to roughly 5 seconds. It is **not** a push channel and does not claim to be
real-time.

**Proven in the browser:** with the page left open, an assert and then a dispute were indexed and the
UI picked up each change **without a reload and without any manual client refetch** — the row
appeared after 4.78 s and the status flipped to Disputed after 4.94 s, each within one interval, with
the page's own request counter incrementing across the wait.

**Distinguish the two identifiers.** An assertion has an *id* and a *transaction hash*, and they are
different values. For the polling run the id is
`0xe97ca1a97277c272b3137e0a4a697679c1057c599c5d1d715a016459d5ae5aac` — which is also the
`Asserted` event's `topics[1]` and the `/v2/assertions` row `id` — while the transaction that mined it
is `0xec1b917d…8e33`. The authoritative field table for every run lives in
`outputs/continuation-20261028/browser/browser-proof-summary.json`.

## Testing notes

**240 tests across 18 files**, all passing (`bun --no-env-file run test` from this package). Of
those, 15 are real local-anvil integration tests; the rest are unit tests. A further 43 tests cover
the test-only browser harness (`bun --no-env-file run test:harness`).

The suite covers configuration validation, EIP-1193 connect/cancel/wrong-chain/account-change paths,
exact bond scaling, approval skipping and ordering, simulation and revert handling, receipt and
missing-event uncertainty, strict receipt-payload confirmation (wrong id, wrong actor, wrong bond,
malformed payload), `MuoError(uint256)` decoding, the v2 schema including legacy-row rejection, form
bounds, dispute-window boundaries, and server-rendered component output.

### Real local-anvil integration tests

`src/lib/__tests__/mezo-tx.anvil.test.ts` runs the portal's **actual** orchestration
(`lib/mezo-tx.ts`) against a real local anvil chain, using real MuoCore and MockMUSD deployments and
real viem clients. It asserts, among other things:

- `approve` is sent exactly once before the core write, and the core call consumes the allowance;
- MUSD balances and escrow move by exact deltas (bond conservation);
- `resolve` with status 2/3/4 pays 2x to the asserter, 2x to the disputer, or refunds one bond each;
- expiry `settle` reverts inside the window and succeeds after it;
- `settle`/`resolve` request **no** approval;
- an account or chain change after approval blocks the write;
- a success receipt without the expected event, or a receipt timeout, is reported as `uncertain`
  with its hash and is **not** resubmitted.

Anvil is spawned once per file by `@muo/integration`'s fixture and torn down in `afterAll`. Accounts
are anvil's unlocked dev accounts driven through `eth_sendTransaction`; **no private key is ever
handled or logged**, and anvil's stdio is discarded.

**What these tests do not prove:** this is a local JSON-RPC provider adapter, not a browser
extension. EIP-6963 discovery, real wallet UX, and live Mezo network behaviour are all outside what
this suite exercises.

The packed assertion-ID layout is pinned by a golden vector in
`src/lib/__tests__/assertion-id.test.ts`. That digest must not change: `MuoCore.deriveAssertionId`
hashes the same bytes, and the layout deliberately preserves the Clarity `0x01` uint tags.

### Browser acceptance harness (test-only)

`src/test-support/browser/` drives the **real UI** against a **real local anvil chain**. It is not
part of the app bundle and is never imported by production code; a static guard test
(`__tests__/isolation.test.ts`) fails if that ever changes.

**What is real:** the shipped Next production build, a real anvil chain with real MuoCore +
MockMUSD deployments, the real `AppProviders` EIP-6963 discovery and chain check, the real
`useCoreTx` hook wiring behind the Assert dialog — and, since the continuation stage, the **real
API**: the actual Hono app (`@muo/api` `app.fetch`) over a real **SQLite-backed D1** adapter with
real migrations and real transactions, fed by the **real native indexer** (`runIndexerCycle` through
the authenticated `POST /v2/indexer/run`). Rows are never injected: they exist only after the
indexer ingests a real chain log.

**What is fake:** only the wallet. `wallet-inject.js` is a clearly labelled fake local wallet
injected by a test-only proxy — **not** a browser extension and **not** MetaMask. The browser itself
is driven externally; the harness never spawns Chromium.

So this is a **mixed proof**: real portal transaction path, real local chain, real API and real
indexing; fake wallet transport. It is **not** evidence of a live Mezo deployment, a real extension
flow, or production D1 behaviour — `bun:sqlite` shares SQLite semantics but not D1's network and
proxy behaviour.

#### Real-pipeline evidence

With the real API wired in, the harness observed:

- `GET /v2/assertions` returning `[]` with `/v2/status` reporting `never_run` and `counts 0/0`
  before any chain write — no fixture rows exist;
- after a browser-driven 10 MUSD assert, one bounded indexer cycle reporting
  `status: "advanced", applied: 1`;
- `GET /v2/assertions` then serving exactly one row whose `id` is **byte-identical to the on-chain
  `Asserted` event id**, with `bondMusd: "10"` and the correct asserter.

#### Known gap in this harness

On a second run the **anvil child died while `serve.ts` and Next stayed alive**. The proxy logged
repeated `ECONNREFUSED`, and the real indexer correctly **halted** (`reason: "rpc"`) rather than
fabricating rows. The cause of that death is **unknown**; a concurrent worker's cleanup may have
signalled a non-owned process, which is unproven and not asserted.

That gap is now **closed in code**. `@muo/integration`'s fixture exposes the child's real `pid` and
an `exited` promise (eagerly captured, resolves exactly once, never rejects). The harness sets a
`plannedStopping` flag *before* it signals the child, and treats **any** exit while that flag is
unset as a crash — **including `{code: 0, signal: null}`**, because anvil traps SIGTERM and exits 0,
so a zero code is not evidence of a deliberate stop. On detection it records a reason, tears every
owned resource down immediately instead of waiting for the TTL, and `serve.ts` exits **1** even
though its own teardown succeeded. A 1-second watchdog also shuts down on chain loss.

This is **unit-proven, not browser-proven**: 12 tests in
`src/test-support/browser/__tests__/lifecycle.test.ts` drive the classification and supervisor
wiring with mock `exited` promises and never spawn a child. Inducing a real mid-session anvil death
would require killing an owned chain inside a live run, which was not done.

Dispute/resolve/settle indexing through the real pipeline is still **not** proven; only the assert
leg is. See "Status of this harness" below.

#### Why the build happens inside the harness

Next inlines `NEXT_PUBLIC_*` at **build** time, not at `next start`. The fixture's RPC, API, and
contract addresses only exist after anvil boots, so the harness boots the fixture first, then runs a
real production build with those exact values in the environment, then starts the server with the
same environment. Passing them only to `next start` would leave the browser chunks pointing at
whatever was baked earlier.

This has a matching constraint in the app itself: `lib/config.ts` must read the public environment
through **literal** `process.env.NEXT_PUBLIC_*` member expressions. Next only replaces that exact
text; a dynamic `process.env[name]` lookup survives into the browser bundle and reads `undefined`,
which makes the portal report itself unconfigured even though the build had the values.

The proxy fronts the app, the anvil RPC (`/__rpc`), and the API fixture (`/__api`) on **one origin**,
so the browser never leaves it and CORS never applies.

#### Running it

The harness needs a shell that can host long-lived children.

```bash
# from packages/app
bun --no-env-file run harness:smoke   # boot + verify HTML injection, then exit
bun --no-env-file run harness:serve   # long-running; writes a readiness file, then waits
```

`harness:serve` writes a readiness JSON file (default `/tmp/muo-harness-ready.json`, override with
`MUO_HARNESS_READY_FILE`) containing its **real PID**, the **real anvil child PID** (`chainPid`),
`proxyUrl`, `apiUrl`, `rpcUrl`, `coreAddress`, `musdAddress`, and `accounts`. Read that file once the
work is up; do not poll in a busy loop. Open `proxyUrl` in the browser under test.

Lifetime is bounded: the process self-terminates after a 10-minute acceptance window, and SIGTERM /
SIGINT tear down the proxy, Next, the real API, and anvil. Shutdown is idempotent, and the signal
handlers are installed **before** startup begins, so a signal during the multi-minute build cancels
cleanly instead of leaking a build child. If the chain dies unexpectedly, the harness tears down
immediately and exits **1** rather than idling until the TTL.

Stop it by the exact PID from the readiness file. Do not use broad `pkill` patterns, and do not use
`setsid`/`nohup`/`&`. If your tool supports a detached background job, prefer a mechanism that keeps
the process attached to a live parent so its children are reaped; verify teardown afterwards (no
`anvil`, no `next-server`, no `serve.ts`, ports released, readiness file removed).

Everything binds `127.0.0.1` only. No public RPC, no deploy, no real environment file.

#### Status of this harness

- **Implemented and executed** against a local anvil chain with a fake injected wallet and the
  **real** API (real Hono app + real SQLite D1 + real indexer).
- Verified in the browser: wallet injection before app scripts, config resolution, connect on chain
  31611, the assert form defaulting to `10` MUSD with an `MUSD` unit label, a real
  approve + `assertClaim` pair, escrow moving to exactly 10 MUSD with the user balance 1000 → 990,
  one `Asserted` event at the expected block, account drift updating the UI and surfacing Dispute,
  and chain drift being blocked with **zero** on-chain writes.
- Verified through the **real** pipeline, end to end, in one harness run on one chain:
  - **assert** — UI submit mined `Asserted` at block 7; one bounded indexer cycle took the cursor
    5 → 7 (`counts.assertions` 0 → 1, `appliedLogs` 0 → 1); `GET /v2/assertions` served one row whose
    id is **byte-identical to the on-chain event id**, `status: "open"`, `bondMusd: "10"`. Escrow 10,
    asserter 1000 → 990.
  - **dispute** — UI click as the disputer mined `Disputed` at block 9; indexer `advanced`,
    `applied: 1`, `rebuilt: 1`, `reorg: false`; the fresh read served `status: "disputed"` with the
    disputer and `disputedTxId` set. Escrow 20, disputer 1000 → 990.
  - **resolve(settled = 2)** — UI click as the arbiter mined `Settled` at block 10; indexer advanced
    again; the fresh read served `status: "settled"` with `resolver` and `resolvedTxId` set.
    **Escrow returned to exactly 0**, the asserter went 990 → **1010** (+20 = two bonds), and the
    disputer and arbiter were unchanged — matching `MuoCore`'s payout rule.
  - Every read used `cache: "no-store"` and the indexer `POST` body was awaited before each `GET`.
- **UI rendering:** the portal invalidates its assertions query at *write* time, which is before the
  indexer runs, so a warm page legitimately still shows the pre-index snapshot. The UI is therefore
  proven by reloading **after** the indexer commits; the card rendered the claim and each status in
  turn, the asserter saw no self-dispute action, and the terminal row dropped the Dispute action.
- **Chain-death supervision, proven end to end:** SIGTERM was sent to the **owned** anvil child pid
  only. Anvil traps SIGTERM and exits **0**, and the supervisor logged
  `anvil exited unexpectedly (code 0, signal null)`, tore down Next/API/proxy, removed the readiness
  file, and exited **1**. This is exactly the case a nonzero-code or signal-based check would miss.
- **Not proven:** the optional uncontested `settle` case was not run, and only `resolve(settled = 2)`
  was exercised in-browser — `resolve(3)` and `resolve(4)` are covered by the local-anvil suite only.
- **Not exercised in the browser:** the uncertain / no-resubmit path. That behaviour is covered by
  unit tests and the local-anvil suite; triggering it in-browser would need a production backdoor,
  which is deliberately not built.
- This remains a **mixed proof**: real portal transaction path, real local chain, real API and real
  indexing; fake wallet adapter. `bun:sqlite` is **not** production D1, and nothing here is evidence
  of live Mezo behaviour or a public deployment.

### Typechecking

`tsconfig.json` covers shipped code only, so `next build` never pulls test-only imports into its
typecheck. `tsconfig.test.json` extends it and additionally covers `src/**` including tests.

```bash
bun x tsc --noEmit -p tsconfig.json        # shipped code
bun x tsc --noEmit -p tsconfig.test.json   # shipped code + tests
```
