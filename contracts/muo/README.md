# MuoCore contracts

Foundry project for `MuoCore.sol`, the Mezo-native optimistic-assertion contract.

## Build status — VERIFIED

The suite compiles and passes. Actual captured results:

| Check | Result |
|---|---|
| `forge build --offline` | **Success**, 4 files compiled |
| Compiler | **Solc 0.8.28** (`0.8.28+commit.7893614a`) from the local `~/.svm` cache |
| `evm_version` | `london` (confirmed in artifact metadata) |
| Optimizer | `enabled: true, runs: 200` (confirmed in artifact metadata) |
| `metadata.bytecodeHash` | `ipfs` — Foundry default **preserved**, not overridden |
| `forge test --offline` | **75 passed, 0 failed, 0 skipped (75 total)** |
| Clean rebuild reproducibility | Artifact SHA-256 identical across `rm -rf out cache` + rebuild |
| ABI regeneration | Idempotent — re-running `emit-abi.mjs` produces a byte-identical `abi.ts` |
| `packages/core/src/abi.ts` | **Exact match** to `out/MuoCore.sol/MuoCore.json` ABI (64 entries, 55 functions) |
| `contracts/MuoCore.sol` | **Unchanged**, SHA-256 `b188e69030fea5a98b03e612e08f06759cbf0342330372de8d548039bb7275e9` |

`MuoCore.sol` was never edited. The source under test is the deployed source.

### Two real bugs this suite caught on first execution

Both were in the *tests*, not the contract, and both are now fixed:

1. **Golden digest claim length.** The pinned vector uses a claim of `cc` × **64
   bytes** (128 hex chars), not 32 bytes. Using 32 bytes produced
   `75c3b97f…` instead of the expected `c7ad84cd…`. The test now builds 64 bytes.
2. **Permit signature value mismatch.** `testPermitDoesNotSurviveFailedAssert`
   signed a permit for `10 * UNIT` while the contract requested `9 * UNIT`
   (sized from `bondMusd`), so `MockMUSD` correctly rejected it with
   "invalid signature" before `assertClaim` could run. The signature now matches
   the contract's requested value.

### Corrected assumption

An earlier draft of this README warned that `vm.expectRevert` followed by
`vm.prank` might need inverting. **That concern was unfounded** — all such tests
pass as written. Foundry's `expectRevert` correctly targets the next non-cheatcode
call. No reordering was needed.

## Commands

Run from **this directory** (`contracts/muo`), not the repo root:

```bash
cd contracts/muo

# Compile the real source with the pinned settings.
forge build --offline

# Run the full regression suite (75 tests).
forge test --offline -vvv

# Regenerate packages/core/src/abi.ts from the compiled artifact.
forge build --offline && bun scripts/emit-abi.mjs
```

`--offline` forces use of the cached `~/.svm/0.8.28/solc-0.8.28` compiler and
prevents any network fetch. Omit it if the cache is cold and a download is
acceptable.

Use absolute tool paths if `PATH` is unreliable in your shell:

```bash
/home/eya/.foundry/bin/forge build --offline
/home/eya/.foundry/bin/forge test --offline -vvv
/home/eya/.bun/bin/bun scripts/emit-abi.mjs
```

### Workspace `test` alias

The root runs `bun run --filter '*' test`, which only invokes a script named
exactly `test`. This package previously exposed only `test:forge`, so the
contracts were **silently excluded** from the workspace-wide run.

`scripts/forge.mjs` is a small Node wrapper that resolves `forge` from `PATH`
first, then `~/.foundry/bin/forge` (never mutating `PATH`), and exposes:

| Script | Runs |
|---|---|
| `test` | `forge test` — this is what the root filter calls |
| `test:forge` | `forge test -vvv` (verbose) |
| `build:forge` | `forge build` |
| `abi:forge` | `forge build` then `bun scripts/emit-abi.mjs` |

The wrapper accepts **only** `build`, `test`, and `abi`. Any other verb (for
example `deploy`) is refused with a non-zero-intent message, so it can never be
used to deploy or broadcast.

Verified: `bun run --filter '*' test` from the repo root now reports
`@muo/contracts test: Ran 75 tests ... 75 tests passed, 0 failed`.

> Note on exit codes: reading `$?` **inside** a `bash -lc` string passed through
> `wsl.exe` reports 0 regardless of the real status, which makes it look as if
> exit codes are lost. They are not. Use `$LASTEXITCODE` from PowerShell, which
> reports the true status (`wsl.exe ... -- bash -lc 'exit 7'` yields 7). The
> wrapper's refusal path was additionally confirmed by its message:
> `node scripts/forge.mjs deploy` prints
> `Refusing unknown mode "deploy". Allowed: build, test, abi`.

### Compiler

`foundry.toml` pins `solc_version = "0.8.28"`. Foundry resolves this through its
own compiler cache (`~/.svm/0.8.28/solc-0.8.28` was present on this host), or
downloads it from the trusted Foundry/SVM endpoint if absent.

**Do not** substitute `/home/eya/.local/bin/solc` — that binary is `0.8.37` and
will fail the `pragma solidity 0.8.28;` pin.

### Settings and why they are pinned

| Setting | Value | Rationale |
|---|---|---|
| `solc_version` | `0.8.28` | Exact pragma in `MuoCore.sol`. |
| `evm_version` | `london` | Documented deployment target (README.md:19). |
| `optimizer` | `true` | Documented. |
| `optimizer_runs` | `200` | Documented (README.md:19). |
| `bytecode_hash` | **not set** | Deliberately left at Foundry's default. Setting it to `"none"` would change the compiled bytecode and break any future reproduction of the deployed artifact. |
| `libs` | `[]` | `MuoCore.sol` has zero imports. No forge-std, no vendored deps. |

## Test suite design

The suite is deliberately **self-contained**:

- No `forge-std`. `test/Vm.sol` declares only the seven cheatcodes the tests use
  (`prank`, `startPrank`, `stopPrank`, `roll`, `warp`, `expectRevert`, `sign`,
  `addr`), so there is no library to install or audit.
- No network, no fork, no RPC. Everything runs against a local `MockMUSD`.
- Deterministic: fixed private keys (`0xA11CE`, `0xB0B`), explicit block numbers
  (`vm.roll(900_000)` in `setUp`).
- Assertions are plain `require(cond, "message")` reverts, so failures name the
  broken invariant without a custom assertion library.

`MockMUSD` implements ordinary EIP-2612 semantics (domain separator, nonce
increment, deadline check, `ecrecover` validation) plus two test-only knobs
(`setForceReturnFalse`, `setForceRevert`) used to exercise `MuoCore`'s
`ERR_TRANSFER_FAILED` mapping. It is a local mock, **not** the real MUSD.

### Coverage map

| Requirement | Test(s) |
|---|---|
| Assert / dispute / permissionless settle | `testAssertStoresRecordAndEscrowsBond`, `testSettleIsPermissionlessAndReturnsBond`, `testDisputePullsMatchingBondAndSetsState` |
| Resolve 2 → asserter 2 bonds | `testResolveSettledPaysAsserterDoubleBond` |
| Resolve 3 → disputer 2 bonds | `testResolveRejectedPaysDisputerDoubleBond` |
| Resolve 4 → one bond each | `testResolveUnresolvedRefundsOneBondEach` |
| Escrow conservation | `testEscrowConservationSettlePath`, `testEscrowConservationResolvePaths`, `testEscrowConservationSumOfPayoutsEqualsPool` |
| Role / conflict checks, immutable owner | `testDeployerIsOwnerAndArbiter`, `testOwnerIsImmutableInSource`, `testAddArbiterOnlyOwner`, `testRemoveOwnerArbiterReverts`, `testArbiterCannotResolveOwnDispute`, `testArbiterCannotResolveWhenDisputer`, `testNonArbiterCannotResolve` |
| Missing / duplicate IDs | `testDisputeUnknownIdReverts`, `testDuplicateAssertionInSameBlockReverts`, `testSameClaimDifferentBlockIsDistinct`, `testUnknownAssertionLookupsAreEmpty` |
| Transfer false / revert rollback | `testPullBondFalseReturnRevertsAndRollsBack`, `testPullBondRevertIsMappedAndRollsBack`, `testPushBondFalseReturnRevertsAndKeepsEscrow`, `testInsufficientAllowanceRevertsAndRollsBack` |
| Default liveness 0 → 1440, bounds 1..52560 | `testZeroLivenessDefaultsTo1440`, `testLivenessLowerBoundAccepted`, `testLivenessUpperBoundAccepted`, `testLivenessAboveMaxReverts` |
| Claim 1..2048 / zero / 2049 | `testClaimOneByteAccepted`, `testClaim2048BytesAccepted`, `testClaimZeroBytesReverts`, `testClaim2049BytesReverts` |
| Dispute at exactly expiry, settle only after | `testDisputeAllowedExactlyAtExpiry`, `testDisputeRevertsOneBlockAfterExpiry`, `testSettleRevertsWhileWindowOpen`, `testWindowPredicatesAreComplements` |
| uint128 deriveAssertionId bound | `testDeriveAssertionIdRejectsBondAboveUint128`, `testDeriveAssertionIdAcceptsUint128Max`, `testDeriveAssertionIdRejectsLivenessAboveUint128`, `testDeriveAssertionIdRejectsBlockAboveUint128` |
| Golden digest | `testGoldenAssertionIdMatchesPinnedDigest`, `testGoldenDigestIsSha256NotKeccak`, `testGoldenPreimageLayoutIsBigEndian` |
| Permit paths | `testAssertWithPermitSucceeds`, `testAssertWithPermitExpiredDeadlineReverts`, `testAssertWithPermitReplayedNonceReverts`, `testDisputeWithPermitSucceeds`, `testPermitDoesNotSurviveFailedAssert` |
| Compatibility surface retained | `testBondFloorsExposed` (asserts `getMinBondSats() == 10000`), `testStatusConstantsMatchOffChainTable`, `testErrorConstantsMatchOffChainTable` |

## Assertion-ID encoding — do not change

`deriveAssertionId` is:

```
sha256( identifier(32) || claim(1..2048) || 0x01 || uint128(bond) || 0x01 || uint128(liveness) || 0x01 || uint128(block) )
```

- **SHA-256, not keccak256.** `packages/docs/developers/architecture.md` currently
  says keccak256; that document is wrong and is out of scope for this directory.
- The `0x01` bytes are Clarity `uint` type tags, not padding.
- Each `uint128` is **16 big-endian bytes**.
- `claim` has **no length prefix**. Do not add one; it would change every digest.
- `_requireU128` enforces the ceiling on all three integers *before* encoding, so
  `abi.encodePacked(uint128(x))` never truncates silently.

Golden vector (also asserted in the TS suite at
`packages/app/src/hooks/__tests__/resolve-result-map.test.ts`):

| Input | Value |
|---|---|
| identifier | `bb` × 32 bytes (`"bb".repeat(32)`, 64 hex chars) |
| claim | `cc` × 64 bytes (`"cc".repeat(64)`, 128 hex chars) |
| bond | 10000 |
| liveness | 1440 |
| assertedAtBlock | 900000 |
| **expected digest** | `c7ad84cdbc859160151cf23a7cfe5aaf67115a58447971c926292aab113741b5` |

Note the asymmetry: the identifier is 32 *bytes* (64 hex chars) but the claim is
64 *bytes* (128 hex chars). Getting this wrong silently produces a different
digest — it was caught by this suite's golden test on first execution.

## ABI generation

`packages/core/src/abi.ts` exports:

- `muoCoreAbi` — the full `MuoCore` ABI, **solc output verbatim**.
- `musdAbi` — a minimal ERC-20 + EIP-2612 surface (`balanceOf`, `allowance`,
  `approve`, `decimals`, `nonces`, `name`, `DOMAIN_SEPARATOR`, `permit`,
  `transfer`, `transferFrom`, plus `Transfer`/`Approval` events).

The committed `abi.ts` **is compiler output**, generated by `scripts/emit-abi.mjs`
from `out/MuoCore.sol/MuoCore.json` and verified byte-for-byte equal to the
artifact's ABI array (64 entries: 55 functions, 7 events, 1 error, 1 constructor).
`getMinBondSats` and `deriveAssertionId` are both present, preserving the deployed
ABI surface.

Regenerate after any contract change:

```bash
cd contracts/muo && forge build --offline && bun scripts/emit-abi.mjs
```

The script is idempotent: re-running it against an unchanged artifact produces a
byte-identical file.

## Assumptions and non-claims

- `MuoCore.sol` is treated as **frozen**. It must remain byte-identical to the
  deployed source. Any behavioural change requires a separate, reviewed decision.
- The tests assume `MUSD` is a well-behaved 18-decimal ERC-20 with ordinary
  EIP-2612 semantics. Fee-on-transfer, rebasing, and blacklisting tokens are
  **not** modelled and are out of scope.
- `CONTRACT_OWNER` is assumed honest. Owner-arbiter centralization is a known
  design property, not a bug this suite tests against.
- **No claim is made** that the deployed bytecode at
  `0x61c41cD7299fD668c3a7aAE62F12c017fE654Cb0` matches this source. That requires
  an explorer/RPC verification step which has not been performed.
- **No claim is made** that any Mezo testnet end-to-end wallet flow works.

## Related: local EVM integration harness

`packages/integration` deploys these same compiled artifacts onto a **local
anvil dev chain** and drives them over JSON-RPC, decoding the resulting logs with
`@muo/sdk/native`. It is the place to look for end-to-end contract behaviour
(escrow accounting, event wire shape, assertion-id cross-check against
`@muo/utils/native`). It uses viem against `muoCoreAbi` for all ABI
encoding/decoding.

```bash
bun install                                        # links workspace deps
bun run --filter @muo/integration test             # 33 tests; auto-builds artifacts if needed
```

Its `test` script is wired into the root workspace filter, so
`bun run --filter '*' test` includes it. That script builds missing artifacts via
`contracts/muo/scripts/forge.mjs build` (the safe wrapper above) and never
deploys.

That harness is **local-only**: an anvil dev chain is not Mezo, and it is not
evidence of live testnet behaviour or a real wallet flow. See
`packages/integration/README.md` for its exact scope and non-claims.
