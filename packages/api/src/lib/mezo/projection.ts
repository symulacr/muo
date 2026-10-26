// Native projection: ledger → assertion state.
//
// The ledger (`mezo_applied_logs`) is the source of truth. Assertion state is
// DERIVED from the surviving canonical logs, never from a fixed reverse patch.
// That matters for reorgs: if a `settled` log is orphaned but its `disputed`
// ancestor survives, the correct state is `disputed`; if both are orphaned, the
// correct state is `open` or absent. Only the ledger can answer.
//
// All functions here are pure so they can be tested without D1.

import type { AssertionEvent, Hex } from "@muo/core/native";

export type EventKind = AssertionEvent["event"];

/** One applied log, in the shape the ledger stores it. */
export type LedgerEntry = {
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
  blockHash: Hex;
  transactionIndex: number;
  assertionId: Hex;
  event: AssertionEvent;
};

/** The projected row for one assertion. */
export type ProjectedAssertion = {
  assertionId: Hex;
  identifier: Hex;
  claim: Hex;
  bondMusd: string;
  liveness: number;
  status: "open" | "disputed" | "settled" | "rejected" | "unresolved";
  asserter: Hex;
  disputer: Hex | null;
  settler: Hex | null;
  resolver: Hex | null;
  assertedAtBlock: number;
  assertedTxId: Hex;
  disputedAtBlock: number | null;
  disputedTxId: Hex | null;
  settledAtBlock: number | null;
  settledTxId: Hex | null;
  resolvedAtBlock: number | null;
  resolvedTxId: Hex | null;
  blockNumber: number;
  blockHash: Hex;
  transactionIndex: number;
  logIndex: number;
};

/** Canonical EVM order: block, then transaction position, then log position. */
export const compareLedger = (a: LedgerEntry, b: LedgerEntry): number =>
  a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;

export const ledgerKey = (e: { txHash: string; logIndex: number }): string => `${e.txHash.toLowerCase()}:${e.logIndex}`;

/**
 * Fold a set of ledger entries into at most one projected assertion.
 *
 * Returns `null` when the surviving set has no `asserted` event — e.g. the
 * `asserted` log itself was orphaned. In that case the projection row must be
 * deleted, not patched.
 *
 * Transition rules mirror `MuoCore`:
 *   - `asserted` only ever opens a row.
 *   - `disputed` requires `open`.
 *   - `settled` from `open` records a settler; from `disputed` records a
 *     resolver (arbiter resolution).
 *   - `rejected` / `unresolved` require `disputed` and record a resolver.
 *
 * A log that cannot legally follow its predecessor is skipped rather than
 * corrupting the row: the chain would not have produced it, so the ledger has
 * a duplicate or the provider replayed a stale log.
 */
export function projectAssertion(entries: readonly LedgerEntry[]): ProjectedAssertion | null {
  const ordered = [...entries].sort(compareLedger);
  const asserted = ordered.find((e) => e.event.event === "asserted");
  if (asserted?.event.event !== "asserted") return null;

  const a = asserted.event.data;
  const row: ProjectedAssertion = {
    assertionId: a.assertionId,
    identifier: a.identifier,
    claim: a.claim,
    bondMusd: a.bondMusd,
    liveness: a.liveness,
    status: "open",
    asserter: a.assertedBy,
    disputer: null,
    settler: null,
    resolver: null,
    assertedAtBlock: a.assertedAtBlock,
    assertedTxId: a.assertedTxId,
    disputedAtBlock: null,
    disputedTxId: null,
    settledAtBlock: null,
    settledTxId: null,
    resolvedAtBlock: null,
    resolvedTxId: null,
    blockNumber: asserted.blockNumber,
    blockHash: asserted.blockHash,
    transactionIndex: asserted.transactionIndex,
    logIndex: asserted.logIndex,
  };

  for (const entry of ordered) {
    const ev = entry.event;
    if (ev.event === "asserted") continue;

    if (ev.event === "disputed") {
      if (row.status !== "open") continue;
      row.status = "disputed";
      row.disputer = ev.data.disputedBy;
      row.disputedAtBlock = ev.data.disputedAtBlock;
      row.disputedTxId = ev.data.disputedTxId;
      continue;
    }

    if (ev.event === "settled") {
      if (row.status === "open") {
        row.status = "settled";
        row.settler = ev.data.settledBy;
        row.settledAtBlock = ev.data.settledAtBlock;
        row.settledTxId = ev.data.settledTxId;
        continue;
      }
      if (row.status === "disputed") {
        row.status = "settled";
        row.resolver = ev.data.settledBy;
        row.resolvedAtBlock = ev.data.settledAtBlock;
        row.resolvedTxId = ev.data.settledTxId;
      }
      continue;
    }

    if (row.status !== "disputed") continue;
    if (ev.event === "rejected") {
      row.status = "rejected";
      row.resolver = ev.data.rejectedBy;
      row.resolvedAtBlock = ev.data.rejectedAtBlock;
      row.resolvedTxId = ev.data.rejectedTxId;
      continue;
    }
    if (ev.event === "unresolved") {
      row.status = "unresolved";
      row.resolver = ev.data.unresolvedBy;
      row.resolvedAtBlock = ev.data.unresolvedAtBlock;
      row.resolvedTxId = ev.data.unresolvedTxId;
    }
  }

  return row;
}

/** Group ledger entries by assertion id, preserving canonical order within each group. */
export function groupByAssertion(entries: readonly LedgerEntry[]): Map<Hex, LedgerEntry[]> {
  const out = new Map<Hex, LedgerEntry[]>();
  for (const e of [...entries].sort(compareLedger)) {
    const list = out.get(e.assertionId);
    if (list) list.push(e);
    else out.set(e.assertionId, [e]);
  }
  return out;
}

/**
 * Which assertion ids are affected by a set of incoming entries and/or a set of
 * removed ledger keys. The projection must be recomputed for exactly these.
 */
export function affectedAssertions(incoming: readonly LedgerEntry[], removed: readonly { assertionId: Hex }[]): Set<Hex> {
  const ids = new Set<Hex>();
  for (const e of incoming) ids.add(e.assertionId);
  for (const r of removed) ids.add(r.assertionId);
  return ids;
}
