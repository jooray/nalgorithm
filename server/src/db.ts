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
    `CREATE TABLE IF NOT EXISTS schedules (
      npub ${t(64)} PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      hour INTEGER NOT NULL DEFAULT 7,
      minute INTEGER NOT NULL DEFAULT 0,
      tz ${t(64)} NOT NULL DEFAULT 'UTC',
      voice ${t(32)} NULL,
      dm_format ${t(8)} NULL,
      next_run_at BIGINT NULL,
      last_run_at BIGINT NULL,
      last_status ${t(24)} NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expired_notice_at BIGINT NULL${d === 'sqlite' ? '' : ', KEY schedules_due (enabled, next_run_at)'}
    )${opts}`,
    d === 'sqlite' ? 'CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at)' : '',
    `CREATE TABLE IF NOT EXISTS digests (
      id ${ddl.pk(d)},
      npub ${t(64)} NOT NULL,
      created_at BIGINT NOT NULL,
      body TEXT NOT NULL,
      audio_url ${t(500)} NULL,
      status ${t(24)} NOT NULL,
      notes TEXT NULL,
      duration_s ${ddl.real(d)} NULL${d === 'sqlite' ? '' : ', KEY digests_npub (npub, created_at)'}
    )${opts}`,
    d === 'sqlite' ? 'CREATE INDEX IF NOT EXISTS digests_npub ON digests (npub, created_at)' : '',
    `CREATE TABLE IF NOT EXISTS deliveries (
      id ${ddl.pk(d)},
      npub ${t(64)} NOT NULL,
      digest_id BIGINT NULL,
      created_at BIGINT NOT NULL,
      protocol ${t(8)} NOT NULL,
      delivered INTEGER NOT NULL,
      tier ${t(12)} NULL,
      detail TEXT NULL${d === 'sqlite' ? '' : ', KEY deliveries_npub (npub, created_at)'}
    )${opts}`,
    d === 'sqlite' ? 'CREATE INDEX IF NOT EXISTS deliveries_npub ON deliveries (npub, created_at)' : '',
    `CREATE TABLE IF NOT EXISTS seen_wraps (
      id ${t(64)} PRIMARY KEY,
      seen_at BIGINT NOT NULL
    )${opts}`,
    `CREATE TABLE IF NOT EXISTS peers (
      npub ${t(64)} PRIMARY KEY,
      dm_kind ${t(8)} NOT NULL,
      last_seen_at BIGINT NOT NULL,
      relays TEXT NULL
    )${opts}`,
    // Public page metadata, shared by everyone: nothing here is per user.
    `CREATE TABLE IF NOT EXISTS link_previews (
      url_hash ${t(64)} PRIMARY KEY,
      found INTEGER NOT NULL,
      data TEXT NULL,
      fetched_at BIGINT NOT NULL
    )${opts}`,
    // Public kind 0 metadata, shared by everyone. `missing` rows remember a failed lookup.
    `CREATE TABLE IF NOT EXISTS profiles (
      pubkey ${t(64)} PRIMARY KEY,
      name TEXT NULL,
      picture TEXT NULL,
      nip05 TEXT NULL,
      missing INTEGER NOT NULL DEFAULT 0,
      fetched_at BIGINT NOT NULL
    )${opts}`,
    // One digest at a time per npub: the row is the claim, and it carries what the UI needs.
    `CREATE TABLE IF NOT EXISTS digest_jobs (
      npub ${t(64)} PRIMARY KEY,
      started_at BIGINT NOT NULL,
      running INTEGER NOT NULL DEFAULT 0,
      finished_at BIGINT NULL,
      last_duration BIGINT NULL,
      last_status ${t(24)} NULL
    )${opts}`,
    // The last ranked feed per npub, so a reload can show it without re-ranking.
    // MariaDB TEXT holds 64 KB, which a feed does not fit in.
    `CREATE TABLE IF NOT EXISTS feed_snapshots (
      npub ${t(64)} PRIMARY KEY,
      created_at BIGINT NOT NULL,
      json ${d === 'sqlite' ? 'TEXT' : 'MEDIUMTEXT'} NOT NULL
    )${opts}`,
    `CREATE TABLE IF NOT EXISTS pipeline_jobs (npub ${t(64)} PRIMARY KEY, owner ${t(64)} NOT NULL, lease_until BIGINT NOT NULL)${opts}`,
    `CREATE TABLE IF NOT EXISTS dm_outbox (cache_key ${t(64)} PRIMARY KEY, npub ${t(64)} NOT NULL, state_json TEXT NOT NULL, created_at BIGINT NOT NULL)${opts}`,
  ].filter(Boolean)
}

/** Open the database named by `url` (`sqlite:path`, a path, `:memory:` or `mariadb://...`) and create the tables. */
export async function openDb(url: string): Promise<Db> {
  const db = await openDatabase(url)
  for (const statement of schema(db.dialect)) await db.exec(statement)
  await migrate(db)
  return db
}

/** Add a column to a table created by an earlier version. No-op when it exists. */
async function addColumn(db: Db, table: string, column: string, definition: string): Promise<void> {
  if (db.dialect === 'mariadb') {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`)
    return
  }
  const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (!columns.some((c) => c.name === column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/** CREATE TABLE IF NOT EXISTS leaves old tables alone, so columns added later are added here. */
async function migrate(db: Db): Promise<void> {
  await addColumn(db, 'digests', 'notes', 'TEXT NULL')
  // Exact length of the audio, measured from its frames. Older digests have none.
  await addColumn(db, 'digests', 'duration_s', `${ddl.real(db.dialect)} NULL`)
  await addColumn(db, 'learned', 'processed_reactions', 'TEXT NULL')
  await addColumn(db, 'digest_jobs', 'lease_at', 'BIGINT NULL')
  await addColumn(db, 'digest_jobs', 'owner', `${ddl.text(db.dialect, 64)} NULL`)
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
      const row = await db.get<{ prompt: string; updated_at: string; last_like_ts: number | null; processed_reactions?: string | null }>(
        'SELECT prompt, updated_at, last_like_ts, processed_reactions FROM learned WHERE npub = ?',
        [npub],
      )
      if (!row) return null
      const state: LearnedState = { prompt: row.prompt, updatedAt: row.updated_at }
      if (row.last_like_ts !== null) state.lastLikeTimestamp = Number(row.last_like_ts)
      if (row.processed_reactions) {
        try {
          const parsed = JSON.parse(row.processed_reactions)
          if (Array.isArray(parsed)) state.processedReactionIds = parsed
          else { state.processedReactionIds = parsed.ids; state.backfillUntil = parsed.until; state.latestReactionTimestamp = parsed.latest }
        } catch { /* old/corrupt state remains usable */ }
      }
      return state
    },
    async putLearned(state) {
      await db.run(upsert(db, 'learned', ['npub', 'prompt', 'updated_at', 'last_like_ts', 'processed_reactions'], ['npub'], ['prompt', 'updated_at', 'last_like_ts', 'processed_reactions']), [
        npub,
        state.prompt,
        state.updatedAt,
        state.lastLikeTimestamp ?? null,
        state.processedReactionIds ? JSON.stringify({ ids: state.processedReactionIds, until: state.backfillUntil, latest: state.latestReactionTimestamp }) : null,
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
/**
 * Retention for operational records, run once a day. What a reader keeps (settings, digests,
 * learned taste) is not here: it stays until they delete their hosted data.
 */
export const RETENTION = {
  /** Delivery attempts: enough to explain a missed DM, then gone. */
  deliveriesDays: 180,
  /** Signed DMs waiting for a relay; resending after a month is pointless. */
  outboxDays: 30,
  /** Public profile metadata, refetched when needed. */
  profilesDays: 90,
} as const

export async function pruneOperational(db: Db, now = Math.floor(Date.now() / 1000)): Promise<Record<string, number>> {
  const day = 86_400
  const run = async (sql: string, params: number[]): Promise<number> => (await db.run(sql, params)).changes
  return {
    sessions: await run('DELETE FROM sessions WHERE expires_at < ?', [now]),
    nonces: await run('DELETE FROM nonces WHERE expires_at < ?', [now]),
    deliveries: await run('DELETE FROM deliveries WHERE created_at < ?', [now - RETENTION.deliveriesDays * day]),
    outbox: await run('DELETE FROM dm_outbox WHERE created_at < ?', [now - RETENTION.outboxDays * day]),
    profiles: await run('DELETE FROM profiles WHERE fetched_at < ?', [now - RETENTION.profilesDays * day]),
    // A claim whose owner died long ago; live owners renew theirs every 30 seconds.
    pipelineClaims: await run('DELETE FROM pipeline_jobs WHERE lease_until < ?', [now - 3600]),
  }
}

export async function pruneScores(db: Db, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  return (await db.run('DELETE FROM scores WHERE post_created_at < ?', [nowSec - SCORE_TTL_SECONDS])).changes
}

export { insertIgnore }
