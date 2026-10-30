import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

export type Row = Record<string, unknown>;
export type Recorded = { sql: string; params: unknown[]; method: "run" | "all" | "raw" | "first" };
type Meta = { changed_db: boolean; changes: number; duration: number; last_row_id: number; rows_read: number; rows_written: number; size_after: number };
export type D1Result<T> = { success: true; meta: Meta & Record<string, unknown>; results: T[] };
const DIR = new URL("../../.migrations", import.meta.url).pathname;
const SQL = readdirSync(DIR)
  .sort()
  .reduce((s, f) => (f.endsWith(".sql") ? `${s}\n${readFileSync(`${DIR}/${f}`, "utf8")}` : s), "");
const meta = (c = 0, l = 0, r = 0) => ({ changed_db: c > 0, changes: c, duration: 0, last_row_id: l, rows_read: r, rows_written: c, size_after: 0 });
export const ADDR = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
export const CID = `${ADDR}.muo-core`;

/**
 * True when a statement mutates data.
 *
 * `INSERT ... SELECT ... WHERE EXISTS (...)` is a write even though it starts
 * with `insert` and contains a `select`; matching on the leading keyword is what
 * makes the mock route it through `run()` and report real `changes`.
 */
const isWriteSql = (sql: string): boolean => /^\s*(?:with\b[\s\S]*?\b)?(insert|update|delete|replace)\b/i.test(sql.trim());

const ENV0 = { MUO_CORE_CONTRACT: CID, WEBHOOK_SECRET: "webhook-secret", CHAINHOOKS_SECRET: "chainhooks-secret" };
export class MockD1PreparedStatement {
  readonly sql: string;
  readonly params: unknown[];
  readonly db: MockD1Database;
  constructor(sql: string, params: unknown[], db: MockD1Database) {
    [this.sql, this.params, this.db] = [sql, params, db];
  }
  bind = (...values: unknown[]) => new MockD1PreparedStatement(this.sql, values, this.db);
  /**
   * Execute one statement.
   *
   * Faithfulness notes:
   *   - a WRITE is detected by SQL text, not by which method the caller used, so
   *     `all()` on an INSERT still reports the real `changes`/`last_row_id`
   *     (D1 does; an `all()`-always-0 shim does not, and that would make a CAS
   *     regression test unable to tell a working guard from a broken one)
   *   - writes go through SQLite `run()` because only `run()` yields `changes`
   */
  private exec<T = Row>(write: boolean, method: Recorded["method"]): D1Result<T> {
    this.db.log.push({ sql: this.sql, params: this.params, method });
    if (!this.db.sqlite) return { success: true, meta: meta(write ? 1 : 0), results: (write ? [] : this.db.rows) as T[] };
    const [stmt, p] = [this.db.sqlite.query(this.sql), this.params as never[]];
    if (isWriteSql(this.sql)) {
      const info = stmt.run(...p);
      return { success: true, meta: meta(info.changes, Number(info.lastInsertRowid)), results: [] };
    }
    const results = stmt.all(...p) as T[];
    return { success: true, meta: meta(0, 0, results.length), results };
  }
  run = async <T = Row>(): Promise<D1Result<T>> => this.exec(true, "run");
  all = async <T = Row>(): Promise<D1Result<T>> => this.exec(false, "all");
  first = async <T = Row>(): Promise<T | null> => this.exec<T>(false, "first").results[0] ?? null;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const { results: rows } = this.exec<Row>(false, "raw");
    const [cols, vals] = [rows[0] ? Object.keys(rows[0]) : [], rows.map((r) => Object.keys(r).map((c) => r[c]))];
    return options?.columnNames ? ([cols, ...vals] as [string[], ...T[]]) : (vals as T[]);
  }
}
export class MockD1Database {
  readonly log: Recorded[] = [];
  rows: Row[] = [];
  readonly sqlite?: Database;
  constructor(sqlite = false) {
    if (sqlite) this.sqlite = new Database(":memory:");
    this.sqlite?.run(SQL);
  }
  prepare = (query: string) => new MockD1PreparedStatement(query, [], this);
  batch = async <T = unknown>(statements: MockD1PreparedStatement[]): Promise<D1Result<T>[]> => Promise.all(statements.map((s) => s.all<T>()));
  exec = async (q?: string) => {
    if (q) this.sqlite?.run(q);
    return { count: 0, duration: 0 };
  };
  dump = async (): Promise<ArrayBuffer> => new ArrayBuffer(0);
}
export const createEnv = (opts: { sqlite?: boolean; env?: Record<string, unknown> } = {}) => ({
  MUO_DB: new MockD1Database(Boolean(opts.sqlite)),
  ...ENV0,
  ...(opts.env ?? {}),
});
