# `@muo/sdk` — native MuoCore log decoder

`@muo/sdk` (default export) and `@muo/sdk/native` are the same native decoder.
The legacy Clarity decoder and its Stacks transport have been **removed**: the
portal, the API and the listener are all native, so a second event
representation could only drift.

## API

```ts
import { decodeMuoLog, MUO_TOPIC0, MuoLogDecodeError } from "@muo/sdk";

const event = decodeMuoLog(log, 31611, "0x61c41cd7299fd668c3a7aae62f12c017fe654cb0");
// AssertionEvent | null
```

| Input | Result |
|---|---|
| wrong `log.address` | `null` — out of scope, safe to skip |
| unknown `topics[0]` (e.g. `ArbiterAdded`) | `null` — out of scope |
| `log.removed === true` | `null` — a reorg signal, not an event to apply |
| in-scope but malformed | **throws `MuoLogDecodeError`** |

The throw is the point: a recognised-but-malformed log must **halt** the caller
so it cannot advance a cursor past it. `null` is reserved for "not ours".

## ABI source of truth

Event names, argument names and `topics[0]` are derived from the **compiler ABI**
(`muoCoreAbi` from `@muo/core/abi`) via viem's `getAbiItem` / `toEventSelector`.
There is no hand-written signature string and no hand-written topic constant, so
a contract change cannot silently drift from the decoder.

`MUO_TOPIC0` is computed, not frozen. The test suite re-derives every topic from
`MUO_EVENT_SIGNATURES` with `keccak_256` **and** asserts equality with
`toEventSelector(getAbiItem(...))`.

## The trailing-bytes hole

viem's `decodeEventLog` is strict about **truncated** data but permissive about
**trailing** data: a log with a valid prefix and junk appended decodes
"successfully". The decoder therefore computes the canonical ABI length for each
event and requires an exact match:

- `Asserted`: `5 head words + 1 length word + ceil(claimBytes / 32) data words`
- the four outcome events: exactly 32 bytes

There is an explicit regression test that shows viem accepting the junk and the
decoder rejecting it.

## What it validates

- all five events, decoded through viem against the compiler ABI
- prefixes normalised to lowercase `0x`
- `Asserted` id **recomputed** with `computeAssertionId` (SHA-256 over
  `identifier || claim || 0x01 || uint128(bond) || 0x01 || uint128(liveness) ||
  0x01 || uint128(block)`) and compared to `topics[1]`
- the claimed `*AtBlock` must equal the log's own `blockNumber`
- `bondMusd` is a decimal **string**, `10 .. 2^128-1`
- `liveness` is `1 .. 52560`
- block/log/tx indices are safe integers
- `claim` is 1..2048 bytes of canonical hex, preserved byte-for-byte (including
  non-UTF-8 bytes)

The decoder does **not** require `identifier === sha256(claim)`. The contract
accepts any `bytes32` identifier, so another client's convention must not be
rejected.

## Why viem is a real dependency, not a wrapper

The decoder was previously hand-written to avoid a bundle dependency. That
reason was speculative and has been withdrawn: measured against the minified
Worker, the native build is **smaller** than the Clarity build it replaced
(136.92 → 128.79 KiB), because viem tree-shakes to the three ABI helpers used
while the removed `@stacks/*` code was larger.

## Commands

```bash
cd packages/sdk
bun test
bunx tsc --noEmit -p tsconfig.json
```

## Results (this pass, local only)

**42 pass, 0 fail.** Covers: topic derivation from the compiler ABI, the
documented golden digest `0xc7ad84cd…41b5`, all five events, `bondMusd` as a
string, a bond above 2^53 preserved exactly, 1-byte and 2048-byte claims,
non-UTF-8 claim bytes, uppercase normalisation, string block numbers,
out-of-scope skips, the trailing-bytes regression, and 18 in-scope malformed
cases that must throw.
