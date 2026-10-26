-- 0003 — native Mezo index tables (additive).
--
-- Creates three NEW tables. It does not touch `assertions` or
-- `transaction_events`; 0000, 0001 and 0002 remain exactly as applied.
-- No legacy row is converted and `bond_sats` is never reinterpreted.
--
-- Namespace: every row is keyed by (chain_id, core_address) so a testnet row
-- can never be read as a mainnet row, and a second MuoCore deployment cannot
-- collide with the first.
--
-- Wire: ids/hashes are lowercase 0x + 64 hex; addresses lowercase 0x + 40;
-- bond_musd is a canonical whole-MUSD decimal STRING (never a number, never
-- raw 1e18 units). Raw units are derived with bondToUnits() when needed.

CREATE TABLE `mezo_assertions` (
	`chain_id` integer NOT NULL,
	`core_address` text NOT NULL,
	`assertion_id` text NOT NULL,
	`identifier` text NOT NULL,
	`claim` text NOT NULL,
	`bond_musd` text NOT NULL,
	`liveness` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`asserter` text NOT NULL,
	`disputer` text,
	`settler` text,
	`resolver` text,
	`asserted_at_block` integer NOT NULL,
	`asserted_tx_id` text NOT NULL,
	`disputed_at_block` integer,
	`disputed_tx_id` text,
	`settled_at_block` integer,
	`settled_tx_id` text,
	`resolved_at_block` integer,
	`resolved_tx_id` text,
	`block_number` integer NOT NULL,
	`block_hash` text NOT NULL,
	`transaction_index` integer NOT NULL,
	`log_index` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `mezo_assertions_pk` PRIMARY KEY(`chain_id`, `core_address`, `assertion_id`),
	CONSTRAINT `mezo_assertions_status_ck` CHECK (`status` IN ('open', 'disputed', 'settled', 'rejected', 'unresolved')),
	CONSTRAINT `mezo_assertions_bond_ck` CHECK (length(`bond_musd`) BETWEEN 1 AND 39 AND `bond_musd` NOT GLOB '*[^0-9]*'),
	CONSTRAINT `mezo_assertions_liveness_ck` CHECK (`liveness` BETWEEN 1 AND 52560)
);
--> statement-breakpoint
CREATE INDEX `mezo_assertions_chain_order_idx` ON `mezo_assertions` (`chain_id`, `core_address`, `block_number` DESC, `transaction_index` DESC, `log_index` DESC);
--> statement-breakpoint
CREATE INDEX `mezo_assertions_asserter_idx` ON `mezo_assertions` (`chain_id`, `core_address`, `asserter`);
--> statement-breakpoint
CREATE TABLE `mezo_applied_logs` (
	`chain_id` integer NOT NULL,
	`core_address` text NOT NULL,
	`tx_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`block_number` integer NOT NULL,
	`block_hash` text NOT NULL,
	`transaction_index` integer NOT NULL,
	`assertion_id` text NOT NULL,
	`event_kind` text NOT NULL,
	`payload` text NOT NULL,
	`applied_at` integer NOT NULL,
	CONSTRAINT `mezo_applied_logs_pk` PRIMARY KEY(`chain_id`, `core_address`, `tx_hash`, `log_index`),
	CONSTRAINT `mezo_applied_logs_kind_ck` CHECK (`event_kind` IN ('asserted', 'disputed', 'settled', 'rejected', 'unresolved'))
);
--> statement-breakpoint
CREATE INDEX `mezo_applied_logs_assertion_idx` ON `mezo_applied_logs` (`chain_id`, `core_address`, `assertion_id`);
--> statement-breakpoint
CREATE INDEX `mezo_applied_logs_block_idx` ON `mezo_applied_logs` (`chain_id`, `core_address`, `block_number`, `log_index`);
--> statement-breakpoint
CREATE TABLE `mezo_indexer_cursor` (
	`chain_id` integer NOT NULL,
	`core_address` text NOT NULL,
	`block_number` integer NOT NULL,
	`block_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `mezo_indexer_cursor_pk` PRIMARY KEY(`chain_id`, `core_address`),
	CONSTRAINT `mezo_indexer_cursor_version_ck` CHECK (`version` >= 0)
);
--> statement-breakpoint
CREATE TABLE `mezo_block_hashes` (
	`chain_id` integer NOT NULL,
	`core_address` text NOT NULL,
	`block_number` integer NOT NULL,
	`block_hash` text NOT NULL,
	`observed_at` integer NOT NULL,
	CONSTRAINT `mezo_block_hashes_pk` PRIMARY KEY(`chain_id`, `core_address`, `block_number`)
);
--> statement-breakpoint
-- CAS guard (defence in depth). The cursor update is
--   SET version = version + 1, block_number = ?, ... WHERE version = ?
-- and it runs FIRST in the batch; every later write is guarded by
-- `EXISTS (... WHERE version = <new version>)`, so a lost CAS makes the whole
-- batch a no-op instead of committing a stale projection.
--
-- This trigger additionally rejects any position change that does not bump
-- `version`, which would mean a writer bypassed the CAS. `recordError` updates
-- only `last_error`, so it is unaffected.
CREATE TRIGGER `mezo_indexer_cursor_cas_guard`
BEFORE UPDATE ON `mezo_indexer_cursor`
WHEN NEW.`version` = OLD.`version`
	AND (NEW.`block_number` <> OLD.`block_number`
		OR NEW.`block_hash` <> OLD.`block_hash`
		OR NEW.`log_index` <> OLD.`log_index`)
BEGIN
	SELECT RAISE(ABORT, 'mezo_indexer_cursor_cas_lost');
END;
