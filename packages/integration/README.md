# @muo/integration — local EVM integration harness

End-to-end tests that drive the **real compiled MuoCore contract** over JSON-RPC
against a **local anvil dev chain**, and decode the resulting logs with the
**real native SDK decoder**.

## What this proves — and what it does not

**Proves (locally):**

- The compiled `MuoCore` artifact deploys and executes correctly on an EVM chain.
- `assertClaim` escrows exactly `bondMusd * 1e18` MUSD and emits an `Asserted`
  log whose assertion id, decoded from a **mined receipt**, equals
  `computeAssertionId` from `@muo/utils/native` computed at the **real receipt block**.
- `dispute` pulls a matching bond; `resolve(2|3|4)` distributes 2x / 2x / 1x+1x
  and conserves escrow to zero every time.
- Uncontested `settle` reverts while the window is open and pays the asserter
  after the mined expiry.
- `decodeMuoLog` from `@muo/sdk/native` decodes every MuoCore event into the
  `AssertionEvent` envelope, and the envelope satisfies the native zod schema.
- The decoder's rejection surface: wrong address → `null`, unknown topic0 →
  `null`, reorg-removed → `null`, unsupported chain id → throws, malformed
  in-scope payload → throws (never a silent skip).
- `bondMusd` crosses the wire as a **decimal string** (`"10"`), ids/hashes are
  lowercase `0x` + 64 hex, addresses are lowercase `0x` + 40 hex.

**Does NOT prove:**

- Any live Mezo testnet or mainnet behaviour. This is an anvil dev chain.
- Equivalence with Mezo's real RPC, block production, or gas semantics.
- A real end-to-end wallet flow (no wallet, no signing, no Passport).
- That the deployed bytecode at `0x61c41cD7299fD668c3a7aAE62F12c017fE654Cb0`
  matches this source. That needs explorer verification, not done here.
- Anything about the API, indexer, or portal.

## Commands

From the repo root:

```bash
bun install                                              # once: links workspace deps
bun run --filter @muo/integration test                   # standard script (see below)
bun run --filter @muo/integration test:integration       # raw bun test, no prereq check
bun run --filter @muo/integration typecheck
```

From this directory:

```bash
cd packages/integration
node scripts/test.mjs        # ensures artifacts, then runs the suite
bun test --timeout 120000    # raw, assumes artifacts already built
bun run typecheck
```

### The standard `test` script

`scripts/test.mjs` is the package's `test` entry point, so the root workspace
verification (`bun run --filter '*' test`) **actually includes these tests**.

It does two things:

1. **Ensures the compiled artifacts exist.** If `contracts/muo/out/MuoCore.sol/MuoCore.json`
   or `.../MockMUSD.sol/MockMUSD.json` is missing, it invokes the *existing* safe
   contracts wrapper (`contracts/muo/scripts/forge.mjs build`). That wrapper only
   permits `build`, `test`, and `abi` — it can never deploy or broadcast.
2. **Runs `bun test --timeout 120000`** in this package.

No deploy, no network write, no private key, no env auto-load. The tests
themselves start a local anvil on `127.0.0.1` and tear it down.

Prerequisites:

1. `contracts/muo/out/` — auto-built by the `test` script if absent.
2. `anvil` on `PATH` or at `~/.foundry/bin/anvil` (resolved automatically;
   `PATH` is never mutated).
3. Workspace links (`bun install`). Without them the suite fails with
   `Cannot find module '@muo/core/native'`.

## Fixture design

`src/fixture.ts` — `startAnvil()`:

| Property | Implementation |
|---|---|
| Bind | `127.0.0.1` only, ephemeral port chosen by binding port 0 then releasing |
| Chain id | `31611` (Mezo testnet id) |
| Hardfork | `london` |
| Quiet | `-q` **and** `stdio: ["ignore","ignore","ignore"]` — anvil's stdout/stderr are discarded, so its dev private keys can never reach logs |
| Env | Explicit minimal env passed to the child; no shell dotenv auto-load |
| Readiness | Bounded poll of `eth_chainId` (default 20 s), aborts early if the child exits or is signalled |
| Teardown | `stop()` sends SIGTERM, waits ≤2 s, then SIGKILL; idempotent; also registered on `process.once("exit")` |
| No collateral damage | Only the child it spawned is ever signalled; no `pkill`, no pre-existing process is touched |

### Lifecycle interface (for supervisors)

`startAnvil()` returns two additional members so a supervisor can watch the chain
and abort its own work if the chain dies, instead of continuing against a dead RPC.

```ts
type FixtureExit = {
  code: number | null;                 // exit code, null when signalled
  signal: NodeJS.Signals | null;       // terminating signal, null on normal exit
  error?: Error;                       // set only when the spawn itself failed
};

type Fixture = {
  // ...rpc, url, port, chainId, accounts, stop()
  pid: number;                         // real OS pid of the spawned anvil child
  exited: Promise<FixtureExit>;        // resolves once, on ANY termination
};
```

Contract, as implemented and tested:

| Guarantee | Detail |
|---|---|
| `pid` is real and positive | The actual child pid, validated as a positive integer. `startAnvil` throws rather than returning a fixture with an unusable pid. |
| `exited` never rejects | It is created immediately after spawn and resolves on every termination path. A caller that ignores it cannot cause an unhandled rejection. |
| `exited` covers unexpected death | A crash, an external `SIGTERM`, or a `SIGKILL` all resolve it with the real facts. It reports *what happened*, not *whether it was intended* — see "Zero exit is NOT proof of a planned shutdown" below. |
| Failed spawn does not hang | A spawn `error` settles `exited` immediately with `error` set, `code: null`, `signal: null`; readiness aborts instead of waiting out its timeout. |
| `stop()` is idempotent | Safe to call repeatedly, and safe after the child already exited. It resolves only after the child has actually exited. |

**Observed anvil behaviour (verified against the binary, not assumed):** anvil
installs a `SIGTERM` handler and shuts down cleanly, so a `SIGTERM` produces
`{ code: 0, signal: null }` rather than a signal death. Only an untrappable signal
such as `SIGKILL` yields `{ code: null, signal: "SIGKILL" }`.

### Zero exit is NOT proof of a planned shutdown

This is the trap. Because anvil traps `SIGTERM` and exits **0**, an *external*
`SIGTERM` — another process, a stray `kill`, a cross-agent cleanup — produces
`{ code: 0, signal: null }`, which is **byte-for-byte identical** to the result of
our own `stop()`. The exit facts alone cannot distinguish them.

Not every unexpected death looks like that, and the differences matter:

| Cause | Trappable? | Reported as |
|---|---|---|
| our own `stop()` (SIGTERM) | yes | `{ code: 0, signal: null }` |
| external `SIGTERM` | yes | `{ code: 0, signal: null }` — **identical to a planned stop** |
| OOM kill / external `SIGKILL` | no | `{ code: null, signal: "SIGKILL" }` |
| crash / non-zero exit | — | `{ code: <non-zero>, signal: null }` |
| spawn failure | — | `error` set; `startAnvil()` throws, no fixture exists |

So an OOM kill is **not** reported as `code: 0`. `SIGKILL` cannot be trapped, so
the process dies from the signal and the kernel reports `code: null,
signal: "SIGKILL"`. Only the *trappable* signals collapse to a clean zero exit.

That asymmetry is exactly why exit facts are an unsafe discriminator: the
dangerous case (external `SIGTERM`) is the one that looks clean, while the
obvious case (`SIGKILL`) looks abnormal. A predicate built on exit facts would
catch the second and miss the first.

So a supervisor must **not** decide "was this unexpected?" from `code` or
`signal`. Any predicate like `error || code !== 0 || signal` is wrong: it misses
an unexpected `SIGTERM` entirely and the harness keeps talking to a dead RPC.

The only reliable discriminator is **intent**: did *we* ask the child to stop?

### Supervisor pattern

Track a `plannedStopping` flag, set it **before** calling `stop()`, and treat
**any** `exited` resolution while it is still `false` as unexpected — regardless
of exit code or signal.

```ts
let plannedStopping = false;

const fixture = await startAnvil();

void fixture.exited.then((exit) => {
  // ANY resolution we did not ask for is unexpected, including code 0.
  if (!plannedStopping) {
    // The chain died on its own. Abort this harness, its Next server and its
    // API — do not keep issuing RPC against a dead endpoint.
    abortHarness(exit); // exit.code / exit.signal / exit.error are diagnostic only
  }
});

try {
  // ...work against fixture.rpc
} finally {
  plannedStopping = true; // MUST precede stop(): stop() sends SIGTERM, which
  await fixture.stop();   // resolves `exited` before stop() returns.
}
```

Why the flag must be set **before** `stop()`: `stop()` signals the child, and
`exited` resolves as soon as the child dies — which is *during* `stop()`, not
after it. Setting the flag afterwards would race, and the handler would fire
while the flag was still `false`, producing a false "unexpected death" abort.

Why `error` is not the discriminator either: `error` is set only when the
**spawn itself** failed, in which case `startAnvil()` throws and there is no
fixture to supervise. Once a fixture exists, `error` is always `undefined`.

Use `exit.code`, `exit.signal` and `exit.error` for **diagnostics** — logging why
the chain died — never as the trigger condition.

Never discover processes by name (`pgrep anvil`); signal only `fixture.pid`.

**Parallel safety:** each test *file* starts and owns its own anvil on its own
ephemeral port, so files are safe to run concurrently. Within a file, tests
share one chain and are therefore ordered — which is why every balance assertion
is expressed as a **delta** rather than an absolute total. There is currently one
test file; adding a second is safe, adding order-dependent tests inside a file is
not.

`src/deploy.ts` — deployment uses **`eth_accounts` + `eth_sendTransaction`** from
anvil's unlocked dev accounts. **No private key is ever read, derived, or passed.**

> **Important harness subtlety:** anvil accepts a transaction that will revert and
> mines it with `receipt.status === "0x0"` instead of raising a JSON-RPC error.
> `send()` therefore throws on any non-`0x1` status; without that check, every
> "must revert" assertion would pass vacuously. `sendRaw()` is available when a
> failed receipt is genuinely wanted. This was a real bug found while building
> the suite — the first `settle`-must-revert check passed for the wrong reason.

## ABI encoding and decoding — viem is the source of truth

`viem@2.57.7` is installed and is the encoder/decoder of record. There are **no
hand-written ABI layouts, no hand-computed selectors, and no signature strings**
in this package.

| Concern | Implementation |
|---|---|
| MuoCore calldata | `encodeFunctionData({ abi: muoCoreAbi, ... })` — `muoCoreAbi` is solc output from `@muo/core/abi` |
| MuoCore return data | `decodeFunctionResult({ abi: muoCoreAbi, ... })` |
| Deploy calldata | `encodeDeployData({ abi, bytecode, args })` |
| MockMUSD ABI | the locally compiled artifact (`contracts/muo/out/MockMUSD.sol`), since the mock is test-only and not an `@muo/core` export |
| Transport | `src/rpc.ts` — a small raw JSON-RPC client |

`src/rpc.ts` is now **transport only**. It exists because the suite drives
anvil-specific methods (`evm_mine`, `evm_setNextBlockTimestamp`) and inspects raw
receipts and logs, and because it keeps the fixture's readiness probe
dependency-light. It could be replaced by viem's `custom` transport later.

### Address casing

viem returns **EIP-55 checksummed** addresses. The native wire contract in
`@muo/core/native` requires **lowercase** `0x` + 40 hex. `src/contracts.ts`
normalizes at the client boundary so callers never have to remember which
representation they hold. This was caught by a real test failure after the viem
migration, not by inspection.

### Decode hardening (measured, not assumed)

`ABI decode hardening (viem)` in the test file pins what viem actually does:

| Input | Behaviour |
|---|---|
| Empty `0x` | throws |
| Truncated (one word short) | throws |
| Non-hex (`0xzzzz`) | throws |
| **Over-long (trailing bytes)** | **is accepted; trailing bytes are ignored** |
| Unknown function name | throws at encode time |
| Wrong arg type / count / out-of-range `uint8` | throws at encode time |

The over-long case is recorded as a **known viem property**, not asserted as an
error, because asserting a throw there would encode a false expectation. Callers
needing strict length checking must compare `data.length` themselves.

## Assertion-id rule (do not "fix" this)

The id is **SHA-256** over the Clarity-compatible layout:

```
sha256( identifier(32) || claim(1..2048) || 0x01 || uint128(bond) || 0x01 || uint128(liveness) || 0x01 || uint128(block) )
```

- SHA-256, **not** keccak256.
- `uint128` is **16 big-endian bytes**; the `0x01` bytes are Clarity `uint` tags.
- `claim` has **no length prefix**.

The tests take the id from the **mined receipt's log**, never from an
`eth_call` simulation (a simulated call runs against the pending block and its id
is not final), then cross-check it against `computeAssertionId` using the actual
receipt block number.

## Reuse for later API / browser integration

`startAnvil()` / `deploy()` / `MuoCoreClient` / `MusdClient` are exported from
`src/index.ts` and are intentionally API-agnostic, so a later browser or API
integration test can reuse the same fixture. They do **not** depend on any
unsettled API internal export.

## Known limitations

- **Gas is not asserted.** Gas is set generously (30M deploy, 3M call) and is not
  treated as a spec.
- **One anvil per test file**, each on its own ephemeral port. Files are
  parallel-safe; tests within a file share a chain and are ordered, which is why
  all balance assertions are deltas.
- **`@muo/app` is currently red** in the root workspace run. It has its own
  `real anvil` tests failing; that is a different worker's area and unrelated to
  this package. `@muo/{core,utils,contracts,api,event-listener,integration}` all
  exit 0.
- **No live-chain verification.** Nothing here contacts Mezo testnet or mainnet.

## Exit codes

`bun test` returns non-zero on failure and the `test` script forwards it. Verified
in this environment via `$LASTEXITCODE` (which is the reliable signal; reading
`$?` inside a `bash -lc` string passed through `wsl.exe` reports 0 regardless).
