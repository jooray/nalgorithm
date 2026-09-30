import { ddl, insertIgnore, openDatabase, upsert } from './database.js'
import type { Database, Dialect } from './database.js'
import type { CachedScore, LearnedState, PipelineStore } from 'nalgorithm'

export type Db = Database

/** Column names avoid words MariaDB reserves, so the same SQL runs on both databases. */
function schema(d: Dialect): string[] {
  const t = (n: number): string => ddl.text(d, n)
  const opts = ddl.tableOptions(d)
  return [
    `CREATE TABLE IF NOT EXISTS accounts (
      npub ${t(64)} PRIMARY KEY,
      created_at BIGINT NOT NULL
    )${opts}`,
    `CREATE TABLE IF NOT EXISTS settings (
      npub ${t(64)} PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    )${opts}`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash ${t(64)} PRIMARY KEY,
      npub ${t(64)} NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL${d === 'sqlite' ? '' : ', KEY sessions_npub (npub)'}
    )${opts}`,
    d === 'sqlite' ? 'CREATE INDEX IF NOT EXISTS sessions_npub ON sessions (npub)' : '',
    `CREATE TABLE IF NOT EXISTS nonces (
      nonce ${t(64)} PRIMARY KEY,
      expires_at BIGINT NOT NULL
    )${opts}`,
    `CREATE TABLE IF NOT EXISTS learned (
      npub ${t(64)} PRIMARY KEY,
      prompt TEXT NOT NULL,
      updated_at ${t(40)} NOT NULL,
      last_like_ts BIGINT NULL
    )${opts}`,
    `CREATE TABLE IF NOT EXISTS scores (
      npub ${t(64)} NOT NULL,
      cache_key ${t(128)} NOT NULL,
      score ${ddl.real(d)} NOT NULL,
      justification TEXT NULL,
      post_created_at BIGINT NOT NULL,
      scorer ${t(16)} NULL,
      PRIMARY KEY (npub, cache_key)${d === 'sqlite' ? '' : ', KEY scores_created (npub, post_created_at)'}
    )${opts}`,
    d === 'sqlite' ? 'CREATE INDEX IF NOT EXISTS scores_created ON scores (npub, post_created_at)' : '',
  ].filter(Boolean)
}

/** Open the database named by `url` (`sqlite:path`, a path, `:memory:` or `mariadb://...`) and create the tables. */
export async function openDb(url: string): Promise<Db> {
  const db = await openDatabase(url)
  for (const statement of schema(db.dialect)) await db.exec(statement)
  return db
}

const CHUNK = 500

/** How long a cached score is kept, by the post's own time. */
export const SCORE_TTL_SECONDS = 30 * 86_400

/**
 * The library's persistence interface, backed by the database and scoped to one
 * npub. Every query carries the npub, so one user's cache can never serve another.
 */
export function createStore(db: Db, npub: string, now: () => number = () => Math.floor(Date.now() / 1000)): PipelineStore {
  return {
    async getLearned() {
      const row = await db.get<{ prompt: string; updated_at: string; last_like_ts: number | null }>(
        'SELECT prompt, updated_at, last_like_ts FROM learned WHERE npub = ?',
        [npub],
      )
      if (!row) return null
      const state: LearnedState = { prompt: row.prompt, updatedAt: row.updated_at }
      if (row.last_like_ts !== null) state.lastLikeTimestamp = Number(row.last_like_ts)
      return state
    },
    async putLearned(state) {
      await db.run(upsert(db, 'learned', ['npub', 'prompt', 'updated_at', 'last_like_ts'], ['npub'], ['prompt', 'updated_at', 'last_like_ts']), [
        npub,
        state.prompt,
        state.updatedAt,
        state.lastLikeTimestamp ?? null,
      ])
    },
    async getScores(keys) {
      const out: Record<string, CachedScore> = {}
      const cutoff = now() - SCORE_TTL_SECONDS
      for (let i = 0; i < keys.length; i += CHUNK) {
        const chunk = keys.slice(i, i + CHUNK)
        const rows = await db.all<{
          cache_key: string
          score: number
          justification: string | null
          post_created_at: number
          scorer: string | null
        }>(
          `SELECT cache_key, score, justification, post_created_at, scorer FROM scores
           WHERE npub = ? AND post_created_at >= ? AND cache_key IN (${chunk.map(() => '?').join(',')})`,
          [npub, cutoff, ...chunk],
        )
        for (const r of rows) {
          out[r.cache_key] = {
            score: Number(r.score),
            ...(r.justification !== null ? { justification: r.justification } : {}),
            createdAt: Number(r.post_created_at),
            ...(r.scorer === 'decision' ? { scorer: 'decision' as const } : {}),
          }
        }
      }
      return out
    },
    async putScores(entries) {
      const sql = upsert(
        db,
        'scores',
        ['npub', 'cache_key', 'score', 'justification', 'post_created_at', 'scorer'],
        ['npub', 'cache_key'],
        ['score', 'justification', 'post_created_at', 'scorer'],
      )
      await db.transaction(async (tx) => {
        for (const [key, e] of Object.entries(entries)) {
          await tx.run(sql, [npub, key, e.score, e.justification ?? null, e.createdAt, e.scorer ?? null])
        }
      })
    },
  }
}

/** Delete scores older than the TTL for everyone. Returns rows removed. */
export async function pruneScores(db: Db, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  return (await db.run('DELETE FROM scores WHERE post_created_at < ?', [nowSec - SCORE_TTL_SECONDS])).changes
}

export { insertIgnore }
