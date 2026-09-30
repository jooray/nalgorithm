import { DatabaseSync } from 'node:sqlite'
import type { CachedScore, LearnedState, PipelineStore } from 'nalgorithm'

export type Db = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  npub TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  npub TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  npub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_npub ON sessions (npub);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS learned (
  npub TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_like_ts INTEGER
);
CREATE TABLE IF NOT EXISTS scores (
  npub TEXT NOT NULL,
  key TEXT NOT NULL,
  score REAL NOT NULL,
  justification TEXT,
  post_created_at INTEGER NOT NULL,
  scorer TEXT,
  PRIMARY KEY (npub, key)
);
CREATE INDEX IF NOT EXISTS scores_created ON scores (npub, post_created_at);
`

export function openDb(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  return db
}

const CHUNK = 500

/** How long a cached score is kept, by the post's own time. */
export const SCORE_TTL_SECONDS = 30 * 86_400

/**
 * The library's persistence interface, backed by SQLite and scoped to one npub.
 * Every query carries the npub, so one user's cache can never serve another.
 */
export function createSqliteStore(db: Db, npub: string, now: () => number = () => Math.floor(Date.now() / 1000)): PipelineStore {
  return {
    async getLearned() {
      const row = db.prepare('SELECT prompt, updated_at, last_like_ts FROM learned WHERE npub = ?').get(npub) as
        | { prompt: string; updated_at: string; last_like_ts: number | null }
        | undefined
      if (!row) return null
      const state: LearnedState = { prompt: row.prompt, updatedAt: row.updated_at }
      if (row.last_like_ts !== null) state.lastLikeTimestamp = row.last_like_ts
      return state
    },
    async putLearned(state) {
      db.prepare(
        `INSERT INTO learned (npub, prompt, updated_at, last_like_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT (npub) DO UPDATE SET prompt = excluded.prompt, updated_at = excluded.updated_at, last_like_ts = excluded.last_like_ts`,
      ).run(npub, state.prompt, state.updatedAt, state.lastLikeTimestamp ?? null)
    },
    async getScores(keys) {
      const out: Record<string, CachedScore> = {}
      const cutoff = now() - SCORE_TTL_SECONDS
      for (let i = 0; i < keys.length; i += CHUNK) {
        const chunk = keys.slice(i, i + CHUNK)
        const rows = db
          .prepare(
            `SELECT key, score, justification, post_created_at, scorer FROM scores
             WHERE npub = ? AND post_created_at >= ? AND key IN (${chunk.map(() => '?').join(',')})`,
          )
          .all(npub, cutoff, ...chunk) as Array<{
          key: string
          score: number
          justification: string | null
          post_created_at: number
          scorer: string | null
        }>
        for (const r of rows) {
          out[r.key] = {
            score: r.score,
            ...(r.justification !== null ? { justification: r.justification } : {}),
            createdAt: r.post_created_at,
            ...(r.scorer === 'decision' ? { scorer: 'decision' as const } : {}),
          }
        }
      }
      return out
    },
    async putScores(entries) {
      const stmt = db.prepare(
        `INSERT INTO scores (npub, key, score, justification, post_created_at, scorer) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (npub, key) DO UPDATE SET score = excluded.score, justification = excluded.justification,
           post_created_at = excluded.post_created_at, scorer = excluded.scorer`,
      )
      db.exec('BEGIN')
      try {
        for (const [key, e] of Object.entries(entries)) {
          stmt.run(npub, key, e.score, e.justification ?? null, e.createdAt, e.scorer ?? null)
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}

/** Delete scores older than the TTL for everyone. Returns rows removed. */
export function pruneScores(db: Db, nowSec = Math.floor(Date.now() / 1000)): number {
  return Number(db.prepare('DELETE FROM scores WHERE post_created_at < ?').run(nowSec - SCORE_TTL_SECONDS).changes)
}
