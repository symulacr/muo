import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

const c0 = { id: text("id").primaryKey(), identifier: text("identifier").notNull(), claim: text("claim").notNull(), bondSats: int("bond_sats").notNull() };
const c1 = { liveness: int("liveness").notNull(), asserter: text("asserter").notNull(), disputer: text("disputer"), settler: text("settler") };
const status = text("status", { enum: ["open", "disputed", "settled", "rejected", "unresolved"] })
  .notNull()
  .default("open");
const c2 = { resolver: text("resolver"), status, assertedTxId: text("asserted_tx_id").notNull(), assertedAtBlock: int("asserted_at_block").notNull() };
const c3 = { disputedTxId: text("disputed_tx_id"), disputedAtBlock: int("disputed_at_block"), settledTxId: text("settled_tx_id") };
const c4 = { settledAtBlock: int("settled_at_block"), resolvedTxId: text("resolved_tx_id"), resolvedAtBlock: int("resolved_at_block") };
const createdAt = int("created_at", { mode: "timestamp_ms" })
  .notNull()
  .$defaultFn(() => new Date());
export const assertions = sqliteTable("assertions", { ...c0, ...c1, ...c2, ...c3, ...c4, createdAt });
