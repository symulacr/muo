// Native Mezo index tables (migration 0003).
//
// Deliberately separate from ./index.ts (the legacy `assertions` table) so the
// v1 Drizzle schema and its `/assertions` projection stay byte-identical until
// the portal cutover.
//
// Wire contract: see @muo/core/native. `bond_musd` is a canonical whole-MUSD
// decimal STRING; ids and hashes are lowercase 0x + 64 hex; addresses are
// lowercase 0x + 40.

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const namespace = {
  chainId: integer("chain_id").notNull(),
  coreAddress: text("core_address").notNull(),
};

export const mezoAssertions = sqliteTable(
  "mezo_assertions",
  {
    ...namespace,
    assertionId: text("assertion_id").notNull(),
    identifier: text("identifier").notNull(),
    claim: text("claim").notNull(),
    bondMusd: text("bond_musd").notNull(),
    liveness: integer("liveness").notNull(),
    status: text("status", { enum: ["open", "disputed", "settled", "rejected", "unresolved"] })
      .notNull()
      .default("open"),
    asserter: text("asserter").notNull(),
    disputer: text("disputer"),
    settler: text("settler"),
    resolver: text("resolver"),
    assertedAtBlock: integer("asserted_at_block").notNull(),
    assertedTxId: text("asserted_tx_id").notNull(),
    disputedAtBlock: integer("disputed_at_block"),
    disputedTxId: text("disputed_tx_id"),
    settledAtBlock: integer("settled_at_block"),
    settledTxId: text("settled_tx_id"),
    resolvedAtBlock: integer("resolved_at_block"),
    resolvedTxId: text("resolved_tx_id"),
    blockNumber: integer("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    transactionIndex: integer("transaction_index").notNull(),
    logIndex: integer("log_index").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.coreAddress, t.assertionId], name: "mezo_assertions_pk" }),
    index("mezo_assertions_chain_order_idx").on(t.chainId, t.coreAddress, t.blockNumber, t.transactionIndex, t.logIndex),
    index("mezo_assertions_asserter_idx").on(t.chainId, t.coreAddress, t.asserter),
  ]
);

export const mezoAppliedLogs = sqliteTable(
  "mezo_applied_logs",
  {
    ...namespace,
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: integer("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    transactionIndex: integer("transaction_index").notNull(),
    assertionId: text("assertion_id").notNull(),
    eventKind: text("event_kind", { enum: ["asserted", "disputed", "settled", "rejected", "unresolved"] }).notNull(),
    payload: text("payload").notNull(),
    appliedAt: integer("applied_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.coreAddress, t.txHash, t.logIndex], name: "mezo_applied_logs_pk" }),
    index("mezo_applied_logs_assertion_idx").on(t.chainId, t.coreAddress, t.assertionId),
    index("mezo_applied_logs_block_idx").on(t.chainId, t.coreAddress, t.blockNumber, t.logIndex),
  ]
);

export const mezoIndexerCursor = sqliteTable(
  "mezo_indexer_cursor",
  {
    ...namespace,
    blockNumber: integer("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    version: integer("version").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.coreAddress], name: "mezo_indexer_cursor_pk" })]
);

export const mezoBlockHashes = sqliteTable(
  "mezo_block_hashes",
  {
    ...namespace,
    blockNumber: integer("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    observedAt: integer("observed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.coreAddress, t.blockNumber], name: "mezo_block_hashes_pk" })]
);

export type MezoAssertionRow = typeof mezoAssertions.$inferSelect;
export type MezoAppliedLogRow = typeof mezoAppliedLogs.$inferSelect;
export type MezoCursorRow = typeof mezoIndexerCursor.$inferSelect;
