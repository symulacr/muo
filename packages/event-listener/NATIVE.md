# `@muo/event-listener` — native sync controller

The default export is the native controller. The legacy Stacks WebSocket
listener has been **removed**: the API no longer has a Stacks ingestion route to
deliver to, so keeping it would be a dead path that could only mislead an
operator into thinking it still worked.

## Why it is a controller, not a poster

The old listener posted one normalized event per HTTP request and advanced an
in-memory cursor. That is not atomic: a lost post or a partial batch leaves the
cursor ahead of the data.

This controller has **no client-side cursor**. It calls
`POST /v2/indexer/run`, which triggers a server-side chain read, and the server
commits the ledger, the projection and the cursor in one D1 `batch()`. The
client only observes the server's committed position.

The trigger route takes **no caller payload** — it reads the chain itself — so
it cannot be used to write arbitrary normalized events.

## API

```ts
import { syncTick, readStatus, startSyncController } from "@muo/event-listener";

await syncTick({ apiUrl, adminSecret, ...DEFAULT_SYNC_CONFIG });
// { kind: "advanced" | "idle" | "halted" | "http_error", ... }
```

`startSyncController` stops on the first `halted` result (the server did not
advance, so retrying would spin) and after `maxConsecutiveFailures` consecutive
transport failures. A success resets the counter.

## Deployment

A **scheduled Worker cron is preferred**, because the cron colocates the cursor
with the D1 database and therefore with the transaction. Scheduled indexing is
currently **disabled** in `wrangler.jsonc` pending a measured CPU budget; this
controller is the supported way to drive ingestion until then.

## Configuration

| Env | Meaning |
|---|---|
| `MUO_API_URL` (or `API_URL`) | API base URL, e.g. `http://localhost:8787` |
| `INDEXER_ADMIN_SECRET` | bearer for `POST /v2/indexer/run` |
| `SYNC_INTERVAL_MS` | poll interval (default 15 000) |
| `SYNC_MAX_FAILURES` | consecutive-failure budget (default 5) |

No secret is ever logged.

## Commands

```bash
cd packages/event-listener
bun test                 # 12 tests, no network
bun run start            # native controller
bun run dev              # native controller, hot reload
bunx tsc --noEmit -p tsconfig.json
```

## Results (this pass, local only)

**12 pass, 0 fail.** Covers: correct URL/method/bearer with no body, trailing
slash handling, idle/halted mapping, `401` as an error rather than success,
unexpected body as halted, read-only status with no trigger, stop-on-halt,
failure budget, counter reset after success, and `stop()`.

Not done: no live controller run, no cron invocation, no public RPC call.
