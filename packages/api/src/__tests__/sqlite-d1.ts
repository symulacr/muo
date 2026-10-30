// A real-SQLite D1 adapter for tests.
//
// Why this exists: the older `MockD1Database.batch` is `Promise.all`, which is
// NOT a transaction. Any test that relies on rollback semantics through it is
// testing the mock, not D1. This adapter implements `batch` as an actual
// `BEGIN IMMEDIATE ... COMMIT` over `bun:sqlite`, so:
//
//   - a failing statement rolls the whole batch back
//   - the CAS trigger (`RAISE(ABORT)`) aborts the batch for real
//   - the witness-token guards observe the in-transaction token
//   - `meta.changes` and `last_row_id` are REAL, so a test can prove the CAS
//     actually matched (or did not)
//
// It applies the real migration files from `.migrations`, in order, so the
// schema under test is the shipped schema.
//
// Scope: LOCAL TEST ONLY. `bun:sqlite` is not D1; it shares SQLite semantics but
// not D1's network/proxy behaviour. That is enough to prove transactional
// atomicity and CAS semantics of the generated SQL, and is not evidence about
// production D1.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

export type Row = Record<string, unknown>;

const MIGRATIONS_DIR = new URL("../../.migrations", import.meta.url).pathname;

/**
 * True when a statement mutates data.
 *
 * Used to route writes through SQLite's `run()` (which reports `changes`) rather
 * than `all()` (which does not). `WITH` is included because a CTE can prefix an
 * INSERT/UPDATE/DELETE.
 */
export const isWriteStatement = (sql: string): boolean => /^\s*(?:with\b[\s\S]*?\b)?(insert|update|delete|replace)\b/i.test(sql.trim());

/** Apply every `.sql` migration in filename order. Throws on the first failure. */
export function applyMigrations(db: Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8");
    for (const part of sql.split("--> statement-breakpoint")) {
      const stmt = part.trim();
      if (stmt) db.run(stmt);
    }
  }
}

type D1Meta = {
  changed_db: boolean;
  changes: number;
  duration: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  size_after: number;
};

export type D1Result<T> = { success: true; meta: D1Meta; results: T[] };

const meta = (changes = 0, lastRowId = 0, rowsRead = 0): D1Meta => ({
  changed_db: changes > 0,
  changes,
  duration: 0,
  last_row_id: lastRowId,
  rows_read: rowsRead,
  rows_written: changes,
  size_after: 0,
});

export class SqliteD1Statement {
  constructor(
    readonly db: Database,
    readonly sql: string,
    readonly params: readonly unknown[] = []
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.db, this.sql, values);
  }

  /** Run a write. Returns D1-shaped metadata. */
  runSync<T = Row>(): D1Result<T> {
    const info = this.db.query(this.sql).run(...(this.params as never[]));
    return { success: true, meta: meta(info.changes, Number(info.lastInsertRowid)), results: [] };
  }

  /**
   * Execute and report D1-shaped metadata.
   *
   * CRITICAL: this must report the REAL `changes` and `last_row_id` for writes.
   * The indexer decides whether its CAS won from `meta.changes` of the FIRST
   * statement in a batch. An adapter that returned `changes: 0` for every write
   * (as an `all()`-based shim does) would make every commit look like a lost
   * CAS, and a regression test could then not distinguish a real guard from a
   * broken one.
   *
   * SQLite's `run()` yields both values; `all()`/`get()` do not. So a write is
   * always executed through `run()` here, and only reads use `all()`.
   */
  allSync<T = Row>(): D1Result<T> {
    if (isWriteStatement(this.sql)) {
      const info = this.db.query(this.sql).run(...(this.params as never[]));
      return { success: true, meta: meta(info.changes, Number(info.lastInsertRowid)), results: [] };
    }
    const rows = this.db.query(this.sql).all(...(this.params as never[])) as T[];
    return { success: true, meta: meta(0, 0, rows.length), results: rows };
  }

  firstSync<T = Row>(): T | null {
    if (isWriteStatement(this.sql)) {
      const info = this.db.query(this.sql).run(...(this.params as never[]));
      return { success: true, meta: meta(info.changes, Number(info.lastInsertRowid)), results: [] } as unknown as T;
    }
    return (this.db.query(this.sql).get(...(this.params as never[])) as T | null) ?? null;
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    return this.runSync<T>();
  }
  async all<T = Row>(): Promise<D1Result<T>> {
    return this.allSync<T>();
  }
  async first<T = Row>(): Promise<T | null> {
    return this.firstSync<T>();
  }
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const { results } = this.allSync<Row>();
    const cols = results[0] ? Object.keys(results[0]) : [];
    const vals = results.map((r) => Object.keys(r).map((c) => r[c]));
    return options?.columnNames ? ([cols, ...vals] as [string[], ...T[]]) : (vals as T[]);
  }
}

/**
 * A D1-shaped database backed by a real SQLite file/`:memory:` handle.
 *
 * `batch` is a genuine transaction. `failNextBatch` lets a test inject a
 * mid-batch failure to prove atomicity.
 */
export class SqliteD1 {
  readonly db: Database;
  /** When set, the next `batch()` throws after applying this many statements. */
  failNextBatchAfter = -1;
  /** Count of `batch()` calls, for assertions about retry behaviour. */
  batchCalls = 0;

  constructor(filename = ":memory:", opts: { migrate?: boolean } = {}) {
    this.db = new Database(filename);
    this.db.run("PRAGMA foreign_keys = ON");
    if (opts.migrate !== false) applyMigrations(this.db);
  }

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  /**
   * Execute all statements in ONE transaction. Any throw rolls everything back.
   *
   * This is the property the indexer's correctness argument depends on, and it
   * is the property the old `Promise.all` mock could not exercise.
   */
  async batch<T = unknown>(statements: SqliteD1Statement[]): Promise<D1Result<T>[]> {
    this.batchCalls++;
    const failAfter = this.failNextBatchAfter;
    this.failNextBatchAfter = -1;

    this.db.run("BEGIN IMMEDIATE");
    try {
      const out: D1Result<T>[] = [];
      for (const [i, statement] of statements.entries()) {
        if (failAfter >= 0 && i >= failAfter) throw new Error("injected D1 batch failure");
        out.push(statement.allSync<T>());
      }
      this.db.run("COMMIT");
      return out;
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }
  }

  async exec(q?: string) {
    if (q) this.db.run(q);
    return { count: 0, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  close(): void {
    this.db.close();
  }
}
