# Mezo-native implementation record

Local implementation status after the completed written audit. This is **not** a deployment record and **not** a statement that the public deployments changed.

## Scope

- Work is on branch `submission`, **dirty and uncommitted**. No commit, push, tag or Git staging is implied by this document.
- Preserve `theme/theme.css`, the deployed Solidity source and the assertion-ID consensus bytes.
- No public-chain transaction, deployment, key rotation, archive deletion or real environment/key read is authorized by this local implementation phase.
- The existing public deployments still run their previously deployed versions. Nothing here changed them.

## Local implementation: complete

The local Mezo-native implementation is finished and gated. The public production deployments are **unchanged**.

| Component | Local change | Final local gate |
|---|---|---|
| Native shared model | Default `@muo/core`, assertion/event subpaths and `@muo/core/native` select the native model: canonical prefixed EVM hex, exact decimal-string whole-MUSD bonds, provenance and five event schemas | 26 tests; TypeScript passed; scoped lint passed |
| Native pure helpers | `@muo/utils/native`: SHA-256 consensus ID, bounded uint128/hex writers, exact whole-bond and 18-decimal formatting; unused Stacks utility dependency removed | 9 tests; TypeScript passed |
| Contracts | Pinned Foundry 0.8.28 / London / optimizer 200; compiler-generated ABI; deployed Solidity untouched | 75 tests passed offline; ABI regeneration byte-identical |
| Local contract/SDK integration | Real compiled contracts on local Anvil with unlocked accounts, mined receipts, escrow accounting, compiler-ABI viem helpers and native SDK log decoding | 33 tests, 131 assertions; TypeScript passed |
| Native portal | EIP-1193/EIP-6963 discovery, bounded approvals, native transactions/receipts, strict v2 API reads, exact units, active-view polling (5 s, client observer only) | 240 tests across 18 files, including real-Anvil and harness tests; both app TypeScript configs passed; production webpack build passed |
| Native indexing | Compiler-ABI decoder, guarded atomic ledger/projection/cursor, unique CAS witnesses, completed-range cursors, bounded common-ancestor reorg recovery, native GET `Cache-Control: no-store` | 192 API tests; TypeScript passed; minified Workers runtime passed. Probe revision v2 (viem ABI) adds 15 offline ABI tests and 29 read-only-safety tests |
| Native SDK | Default compiler-ABI viem decoder with strict payload, ID and provenance checks | 42 tests; TypeScript passed |
| Event listener | Native authenticated manual sync controller; scheduled ingestion deliberately disabled | 12 tests; TypeScript passed |
| Landing site | Existing design preserved | No unit suite; TypeScript, lint and production webpack build passed |
| Artifact staging | Allowlisted Git-tracked source staging, mandatory redacted scanner, manifest; rejects real env/key files and symlinks | 7 Node tests passed |
| Workspace verification | Serial Node runner disables Bun environment autoload, uses every child exit status, and fails on a missing test script instead of skipping a package. `verify:local` packages the whole local gate into one command | 5 runner tests, plus 16 verifier tests = **28 Node guard tests**; wired into the root `test` script |
| Dependency graph | Removed the `@stacks/*`, `@reown/*`, `@base-org/*` and `base-x` graph plus the unused inert stub and patch; compatible transitive updates only, no new root direct dependencies and no blanket override | Frozen install with lifecycle scripts disabled passed; `bun audit --json` returned `{}` exit 0 |

### Current local gate (recorded, 2026-10-28)

`bun --no-env-file run verify:local` — **17/17 steps PASS, exit 0**. Evidence: `outputs/continuation-20261028/verification/final-gate.log` and `gate-summary.json`.

- **634 workspace/contract tests** plus **28 Node guard tests** = **662 total, 0 failed.**
- Per suite: contracts 75, API 192, app 240, core 26, event-listener 12, integration 38, SDK 42, utils 9. `packages/www` has no unit suite and is covered by TypeScript, lint and its production build.
- All **nine** TypeScript configs pass: api, app, app.test, core, event-listener, integration, sdk, utils, www.
- Biome over the repo: **174 files, exit 0, zero errors and zero warnings.**
- Both `app` and `www` production webpack builds passed.
- API Workers runtime (minified): exit 0, 132.43 KiB, gzip 41.32 KiB.
- Frozen install preflight: 144 installs across 229 packages, no changes.

`bun audit --json` returning `{}` is a registry advisory check, **not** a security guarantee.

Toolchain: Bun 1.4.4, Node v26.11.1, Biome 2.5.15, Foundry 1.8.6.

#### Gate defect found and fixed during this run

The first gate run **failed at `biome check` (exit 1)**. Cause: repo-wide `biome check .` demanded reformatting `theme/theme.css` — a protected file whose bytes must not change, untouched since the initial commit and not referenced in any Biome config. Fixed by adding a formatter-only override for `theme/theme.css` in `biome.json`, mirroring the existing `packages/core/src/abi.ts` override for a frozen artifact. The theme hash was verified unchanged after the fix.

#### Superseded baseline

An earlier dated snapshot recorded 554 (542 + 12) with API 135 and app 210. That figure is superseded by the run above. Note a reporting error in an intermediate draft: an "API 213" figure was cited, but 213 was never an observed API count — the measured API count in this gate is **192**.

### Frozen protocol details

The assertion digest is **SHA-256**, not keccak256:

`identifier32 || claimBytes || 0x01 || uint128(bond) || 0x01 || uint128(liveness) || 0x01 || uint128(assertedAtBlock)`

Integers are big-endian. A textual `0x` marker is decoded before hashing and is not a protocol byte. The legacy golden digest remains `c7ad84cdbc859160151cf23a7cfe5aaf67115a58447971c926292aab113741b5`.

`bondMusd` is whole MUSD, minimum 10; the contract scales transfers once by 1e18. Native Mezo BTC and MUSD balances both use 18 decimals. Dispute is allowed at expiry; settlement starts strictly after expiry.

Protected hashes, verified unchanged:

| Artifact | SHA-256 |
|---|---|
| `contracts/muo/contracts/MuoCore.sol` | `b188e69030fea5a98b03e612e08f06759cbf0342330372de8d548039bb7275e9` |
| `theme/theme.css` | `cfa25464141d3dadfea2c3fecfc6daf0ee558e43798115946659aa78f9ad1531` |
| `packages/core/src/abi.ts` | `78355aadbf3eabbc3cf0ed5e8a10bb4868de9c6fdcaaf735d1148c416db88070` |

The generated ABI is 64 entries: 55 functions, 7 events, 1 error, 1 constructor.

## What local acceptance proved

- A real browser click-through against a **fake injected local wallet**, a real Next production build, local Anvil `MuoCore` + `MockMUSD`, and a **fixture API** (honest mixed proof). Chain 31611; 10 MUSD approve/assert across blocks 5 to 7; escrow 10; user balance 1000 to 990; 1 `Asserted` event. Account change updated the UI and self-dispute was rejected; chain change blocked a new write and retained the form; still 1 assertion.
- A **real, unmocked** Hono + SQLite/indexer API driven through the same UI, in two separate runs on different chains with different assertion ids. Authoritative field table: `outputs/continuation-20261028/browser/browser-proof-summary.json`.
  - **Resolve run** — assertion `0x021eabdd…74fd`: assert escrow `10`, dispute escrow `20` (asserter `1000 → 990`), resolve(2) escrow `0` (asserter `990 → 1010`, disputer `990`, arbiter `0`). Terminal `settled`.
  - **Polling run** — assertion `0xe97ca1a9…5aac`: ended **`disputed`**, escrow `0 → 10 → 20`. Proved active-view polling: row appeared 4780 ms, status flipped 4943 ms, no reload, no manual refetch, `Cache-Control: no-store`.
  - An assertion id is **not** a transaction hash. An earlier prose report mislabelled `0xec1b917d…8e33` as the polling run's assertion id; it is that run's asserted **transaction hash**. The captured JSON always kept them distinct. Escrow `20` (intermediate, polling) and `0` (terminal, resolve) are not comparable.
- **Quiet-death detection proven in a real harness.** The portal worker sent `SIGTERM` to its own anvil pid and observed exit **code 0** classified as **unexpected**, with `serve` exiting 1, readiness removed and the proxy API unreachable. This confirms the `plannedStopping` intent flag is the correct discriminator — an exit code of 0 alone would have read as success.
- Receipt checks decode the **actual** ABI and compare assertion ID, identifier, claim, bond, liveness, actor and real receipt block, plus outcome ID/actor/block. A mismatch is treated as uncertain: no hash submission and no resubmit.
- The uncertain-receipt flow is covered by unit tests and a real-Anvil test.
- A **read-only public testnet probe** (revision v2, viem ABI) passed against `https://rpc.test.mezo.org`: 12 bounded read calls, all 12 checks green. Chain 31611, head `16417845`, `MuoCore` 7440 bytes, MUSD 6437 bytes, `getMinBondMusd = 10`, `MUSD_UNIT = 1e18`, `MuoCore.musd()` matching the expected MUSD, `decimals = 18`, 3 `Asserted` logs in one page, and a strictly decoded assertion id cross-checked on chain (`exists = true`, `status = 2`). Method mix `eth_chainId=1, eth_blockNumber=1, eth_getBlockByNumber=1, eth_getCode=2, eth_call=6, eth_getLogs=1`, identical to the earlier v1 run. Evidence: `outputs/continuation-20261028/verification/`.

The read-only probe is **not** a wallet flow and **not** source verification. It performs no transaction, signature, permit or faucet call; `MezoRpc` refuses any non-allowlisted method at the boundary.

## Current limits

These are real and unresolved. They are not scheduling notes.

- **No real wallet and no live Mezo cycle.** Both browser proofs used a fake injected provider. No browser extension, no Passport, no WalletConnect and no permit path was exercised; the portal uses the exact-approve two-transaction flow. The uncertain-receipt flow is **not** covered in a real browser. Browser coverage is assert → dispute → resolve(2) plus the polling observation; uncontested settle, resolve(3) and resolve(4) remain local Anvil unit coverage only. No polling screenshots were produced; the dated `outputs/acceptance-20261028/browser-final.png` is from an older wrong-chain-guard run and is not current polling proof.
- **Deployed.** The portal, landing site and API Worker are public on Mezo Testnet, and `0003_mezo_native_index` is applied to D1 `muo-testnet`.
- **Cron is enabled** at `*/1 * * * *`, committed in `wrangler.jsonc`. Measured CPU on catch-up ticks spanning the full 500 blocks was 9–11 ms with `outcome: ok`. A bounded authenticated manual controller (`POST /v2/indexer/run`) remains available for backfills.
- **Deep reorgs halt.** Common-ancestor recovery is bounded at 128 blocks; deeper or unresolved forks halt for operator action. No assumed Ethereum finality tags are used.
- **Historical archive question is unresolved.** Contents/access of the historical Vercel secret archive and any potential key exposure remain operator follow-up. This is **not** solved.
- **Source verification: published, flagged partial.** `forge verify-contract --verifier blockscout` submitted against `https://api.explorer.test.mezo.org/api`; the explorer reports `is_verified: true` with 18,405 bytes of source and the 64-entry ABI. It also reports `is_partially_verified: true` because the metadata CBOR hash differs from the deployed artifact, while `is_changed_bytecode: false` confirms the compiled logic matches on-chain bytecode. The mismatch is in source metadata, not behaviour.
- **Scanning is not proof.** A clean Gitleaks scan does not prove historical archives were clean, inaccessible or never read.

## Release gates (all still open)

Local implementation being complete does **not** authorize a release. Each item below is a separate human decision.

0. **Local gate.** `bun --no-env-file run verify:local` must pass as a single invocation on the exact tree being staged. It runs a frozen-install preflight, the workspace suites, the guard tests, nine TypeScript configs, Biome, the Workers runtime test, both production builds and `bun audit`, and it checks the protected hashes and ABI shape first. It starts no servers and performs no deploy, Git or secret operation. **Recorded pass:** 17/17 steps, exit 0, 662 aggregate checks, 0 failed (`outputs/continuation-20261028/verification/`). Re-run it on the exact tree being staged.
1. **Reviewed Git source.** New source files must be reviewed and added to Git by a human. Release staging refuses eligible untracked source. No `git add`, commit, push or artifact staging was performed.
2. **Mandatory redacted scanner artifact.** A fresh, fully redacted Gitleaks CLI report must accompany the staged source. See [ARTIFACT-STAGING.md](ARTIFACT-STAGING.md).
3. **Fresh public-environment build.** Build the staged source with the real public configuration, not fixture values baked into a browser bundle.
4. **Explicit approval for each remote action**, individually:
   - applying D1 migration `0003` to the remote database,
   - deploying the API Worker,
   - deploying the app and landing site,
   - any public wallet transaction.
5. **Operator measurement** of Workers CPU and backfill before enabling Cron.

No public production transaction or deployment is authorized by the local implementation phase.

## Retired and preserved

- Retired: v1 webhook writes return `410`; `@stacks/*` runtime in the SDK; scheduled ingestion; the unused Base Account stub and `base-x` patch.
- Preserved deliberately: historical `/assertions` reads remain read-only; unrelated Drizzle/Hono aliases and constructors; SQL migrations `0000` to `0002` unchanged, with `0003` additive only; the existing staged listener rename.

## Verification environment

Bun `1.4.4-canary.1` with environment autoload disabled (`--no-env-file`). Windows-to-WSL checks propagate the native exit code; a deliberate failing probe returned exit 1. Validation is serial. No build servers are left running; the final process scan returned an empty list.
