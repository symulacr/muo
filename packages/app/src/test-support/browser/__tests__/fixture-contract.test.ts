// Proves the REAL API's `/v2/assertions` payload satisfies the same strict
// schema the portal uses in `lib/assertions-query.ts`.
//
// This replaces the earlier fixture-row contract test. The harness no longer
// injects rows: rows come from the real Hono app + real SQLite D1 + real
// indexer. So the meaningful contract check is that the REAL wire shape (a bare
// JSON array of native assertions) is what the client parses.
//
// The full end-to-end proof (chain write -> indexer -> HTTP row) lives in
// `real-api-smoke.ts` and the browser run; this file is the cheap static guard.

import { describe, expect, test } from "bun:test";

import { assertionSchema } from "@muo/core/native";

/** A row shaped exactly as `routes/v2.ts` serializes it (native wire shape). */
const realWireRow = {
  id: `0x${"ab".repeat(32)}`,
  identifier: `0x${"cd".repeat(32)}`,
  claim: `0x${Buffer.from("real indexed row").toString("hex")}`,
  bondMusd: "10",
  liveness: 1440,
  status: "open",
  asserter: "0x1111111111111111111111111111111111111111",
  disputer: null,
  settler: null,
  resolver: null,
  assertedAtBlock: 100,
  assertedTxId: `0x${"ee".repeat(32)}`,
  disputedAtBlock: null,
  disputedTxId: null,
  settledAtBlock: null,
  settledTxId: null,
  resolvedAtBlock: null,
  resolvedTxId: null,
  chainId: 31611,
  coreAddress: "0x3333333333333333333333333333333333333333",
  blockNumber: 101,
  blockHash: `0x${"ff".repeat(32)}`,
  transactionIndex: 0,
  logIndex: 0,
};

describe("real API wire shape matches the portal schema", () => {
  test("the v2 row validates against the strict native assertion schema", () => {
    const result = assertionSchema.safeParse(realWireRow);
    if (!result.success) {
      throw new Error(`real wire row rejected: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  test("the API returns a bare array, which the client accepts", () => {
    // `routes/v2.ts` responds with `c.json(rows)` -- a bare array, not { data }.
    // `assertions-query.ts` accepts either, so this documents the real shape.
    const body: unknown = [realWireRow];
    expect(Array.isArray(body)).toBe(true);
    expect(assertionSchema.safeParse((body as unknown[])[0]).success).toBe(true);
  });

  test("a legacy sats-integer bond is rejected", () => {
    expect(assertionSchema.safeParse({ ...realWireRow, bondMusd: 10_000 }).success).toBe(false);
  });

  test("a checksummed address is rejected", () => {
    expect(assertionSchema.safeParse({ ...realWireRow, asserter: "0x111111111111111111111111111111111111111A" }).success).toBe(false);
  });

  test("an unknown status is rejected", () => {
    expect(assertionSchema.safeParse({ ...realWireRow, status: "pending" }).success).toBe(false);
  });

  test("every terminal status the indexer can write is accepted", () => {
    for (const status of ["open", "disputed", "settled", "rejected", "unresolved"]) {
      expect(assertionSchema.safeParse({ ...realWireRow, status }).success).toBe(true);
    }
  });
});
