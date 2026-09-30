/**
 * A small async database adapter with two implementations: SQLite (the
 * default, `node:sqlite`) and MariaDB (the `mariadb` connector). SQL is written
 * once with `?` placeholders; the few statements that differ between the two
 * (upserts, insert-ignore, locking) go through the helpers at the bottom.
 *
 * Choose with a URL: `sqlite:./billing.db`, a bare path, `:memory:`, or
 * `mariadb://user:password@host:3306/database`.
 */

import type { DatabaseSync } from 'node:sqlite'

export type Dialect = 'sqlite' | 'mariadb'
export type Param = string | number | bigint | null

export interface RunResult {
  /** Rows changed. For an ignored insert this is 0. */
  changes: number
  lastInsertId: number
}

export interface Database {
  readonly dialect: Dialect
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | undefined>
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>
  run(sql: string, params?: Param[]): Promise<RunResult>
  exec(sql: string): Promise<void>
  /** Run `fn` in one transaction. The `tx` it receives must be used for every statement inside. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>
  close(): Promise<void>
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

/**
 * SQLite has one connection, so two overlapping async transactions would
 * interleave their statements. Everything therefore goes through one queue, and
 * a transaction holds it until it commits or rolls back.
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve()
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => (release = r))
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

function sqliteStatements(db: DatabaseSync): Omit<Database, 'transaction' | 'close' | 'dialect'> {
  return {
    async get<T>(sql: string, params: Param[] = []) {
      return db.prepare(sql).get(...params) as T | undefined
    },
    async all<T>(sql: string, params: Param[] = []) {
      return db.prepare(sql).all(...params) as T[]
    },
    async run(sql: string, params: Param[] = []) {
      const r = db.prepare(sql).run(...params)
      return { changes: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) }
    },
    async exec(sql: string) {
      db.exec(sql)
    },
  }
}

async function openSqlite(path: string): Promise<Database> {
  // Loaded on demand, so a MariaDB-only deployment never touches node:sqlite
  // (which is still flagged experimental on some Node versions).
  const { DatabaseSync: Sqlite } = await import('node:sqlite')
  const db = new Sqlite(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const mutex = new Mutex()
  const inner = sqliteStatements(db)

  // Outside a transaction every statement waits its turn on the mutex.
  const queued: Omit<Database, 'transaction' | 'close' | 'dialect'> = {
    get: (sql, params) => mutex.run(() => inner.get(sql, params)) as never,
    all: (sql, params) => mutex.run(() => inner.all(sql, params)) as never,
    run: (sql, params) => mutex.run(() => inner.run(sql, params)),
    exec: (sql) => mutex.run(() => inner.exec(sql)),
  }

  return {
    dialect: 'sqlite',
    ...queued,
    transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      return mutex.run(async () => {
        db.exec('BEGIN IMMEDIATE')
        // Inside the transaction the mutex is already held, so statements go straight through.
        const tx: Database = {
          dialect: 'sqlite',
          ...inner,
          transaction: (nested) => nested(tx),
          close: async () => {},
        }
        try {
          const result = await fn(tx)
          db.exec('COMMIT')
          return result
        } catch (err) {
          db.exec('ROLLBACK')
          throw err
        }
      })
    },
    async close() {
      db.close()
    },
  }
}

// ─── MariaDB ─────────────────────────────────────────────────────────────────

interface MariaQueryable {
  query(sql: string, params?: unknown[]): Promise<any>
}

function mariaStatements(q: MariaQueryable): Omit<Database, 'transaction' | 'close' | 'dialect'> {
  return {
    async get<T>(sql: string, params: Param[] = []) {
      const rows = (await q.query(sql, params)) as T[]
      return rows[0]
    },
    async all<T>(sql: string, params: Param[] = []) {
      return (await q.query(sql, params)) as T[]
    },
    async run(sql: string, params: Param[] = []) {
      const r = await q.query(sql, params)
      return { changes: Number(r.affectedRows ?? 0), lastInsertId: Number(r.insertId ?? 0) }
    },
    async exec(sql: string) {
      await q.query(sql)
    },
  }
}

async function openMariadb(url: string): Promise<Database> {
  const u = new URL(url)
  const mariadb = await import('mariadb')
  const pool = mariadb.createPool({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectionLimit: 8,
    // Unix-second timestamps and counters are BIGINT; hand them back as numbers.
    bigIntAsNumber: true,
    insertIdAsNumber: true,
    decimalAsNumber: true,
    charset: 'utf8mb4',
  })
  const pooled = mariaStatements(pool)
  return {
    dialect: 'mariadb',
    ...pooled,
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const tx: Database = {
          dialect: 'mariadb',
          ...mariaStatements(conn),
          transaction: (nested) => nested(tx),
          close: async () => {},
        }
        try {
          const result = await fn(tx)
          await conn.commit()
          return result
        } catch (err) {
          await conn.rollback()
          throw err
        }
      } finally {
        conn.release()
      }
    },
    async close() {
      await pool.end()
    },
  }
}

// ─── Entry point and dialect helpers ─────────────────────────────────────────

export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith('mariadb://') || url.startsWith('mysql://')) return openMariadb(url)
  return openSqlite(url.startsWith('sqlite:') ? url.slice('sqlite:'.length) : url)
}

/** `INSERT` that does nothing on a duplicate key. Check `changes` to see whether it inserted. */
export function insertIgnore(db: Database, table: string, columns: string[]): string {
  const verb = db.dialect === 'sqlite' ? 'INSERT OR IGNORE' : 'INSERT IGNORE'
  return `${verb} INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
}

/**
 * `INSERT` that updates `updateColumns` when `keyColumns` already exist.
 * Parameters are the `columns` in order.
 */
export function upsert(db: Database, table: string, columns: string[], keyColumns: string[], updateColumns: string[]): string {
  const insert = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  if (db.dialect === 'sqlite') {
    return `${insert} ON CONFLICT (${keyColumns.join(', ')}) DO UPDATE SET ${updateColumns.map((c) => `${c} = excluded.${c}`).join(', ')}`
  }
  return `${insert} ON DUPLICATE KEY UPDATE ${updateColumns.map((c) => `${c} = VALUES(${c})`).join(', ')}`
}

/** Column definitions that differ by dialect. */
export const ddl = {
  pk: (d: Dialect): string => (d === 'sqlite' ? 'INTEGER PRIMARY KEY' : 'BIGINT AUTO_INCREMENT PRIMARY KEY'),
  text: (d: Dialect, length: number): string => (d === 'sqlite' ? 'TEXT' : `VARCHAR(${length})`),
  real: (d: Dialect): string => (d === 'sqlite' ? 'REAL' : 'DOUBLE'),
  /** Appended after a MariaDB table definition: case-sensitive keys, real UTF-8. */
  tableOptions: (d: Dialect): string => (d === 'sqlite' ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin'),
}
