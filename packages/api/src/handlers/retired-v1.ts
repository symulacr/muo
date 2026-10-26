// Retired v1 (Stacks) write routes.
//
// The Stacks ingestion path is gone: the API no longer decodes Clarity, no
// longer accepts chainhook envelopes, and no longer writes the legacy
// `assertions` table. The legacy table and its rows are PRESERVED read-only —
// they are the only record of what the Stacks deployment did, and this change
// neither converts nor deletes them.
//
// Each retired route answers `410 Gone` with an explicit, machine-readable
// pointer to the native replacement. `410` (not `404`) is deliberate: a client
// that still posts here must learn that the endpoint existed and was retired,
// not conclude it mistyped a URL.
//
// The read-only legacy projection stays available at `GET /assertions` and is
// documented as historical (see `app.ts` and `NATIVE.md`).

import { Hono } from "hono";

import type { Env } from "../app";

/** Body returned by every retired v1 write route. */
export const GONE_BODY = {
  error: "gone",
  code: "v1_stacks_ingest_retired",
  message: "The Stacks/Clarity ingestion path was retired. Assertions are now indexed from MuoCore EVM logs on Mezo.",
  replacement: {
    read: "GET /v2/assertions",
    status: "GET /v2/status",
    trigger: "POST /v2/indexer/run",
  },
  /** The legacy table is still readable at `GET /assertions`; it is not writable. */
  legacyReadOnly: "GET /assertions",
} as const;

const gone = (c: { json: (b: unknown, s: 410) => Response }) => c.json(GONE_BODY, 410);

/**
 * The retired v1 write surface.
 *
 * Mounted at `/webhook`, so it covers `/webhook`, `/webhook/chainhooks` and
 * `/webhook/indexer` — the three paths that could previously mutate state.
 * No auth is checked: the route is gone for everyone, and answering `401` would
 * falsely imply that a correct token still works.
 */
export const retiredV1Routes = new Hono<Env>().all("/", gone).all("/chainhooks", gone).all("/indexer", gone);

export type RetiredV1Api = typeof retiredV1Routes;
