import { collectPostPubkeys } from 'nalgorithm'
import { upsert } from './database.js'
import type { Db } from './db.js'

/** The last ranked result for one npub, as the client renders it. */
export interface FeedSnapshot {
  posts: Array<Record<string, unknown>>
  profiles: Record<string, unknown>
  fetched: number
  hoursBack: number
  learnedPrompt?: string
  /** Fingerprint of the settings the ranking used, so a changed prompt or window is noticed. */
  sig: string
}

export interface StoredSnapshot extends FeedSnapshot {
  createdAt: number
}

/** A snapshot younger than this is served instead of rerunning, unless the client forces it. */
export const SNAPSHOT_FRESH_SECONDS = 120

/** Upper bound on the stored JSON. Posts beyond it are dropped from the low-ranked end. */
export const SNAPSHOT_MAX_BYTES = 1_500_000

export function settingsSignature(s: { userPrompt: string; hoursBack: number }): string {
  return `${s.hoursBack}|${s.userPrompt}`
}

/**
 * Fit the snapshot under `maxBytes`. The posts are already in rank order, so the
 * tail is the least relevant and goes first. Profiles are re-filtered to the
 * posts that remain.
 */
export function trimSnapshot(snap: FeedSnapshot, maxBytes = SNAPSHOT_MAX_BYTES): FeedSnapshot {
  const size = (s: FeedSnapshot): number => Buffer.byteLength(JSON.stringify(s))
  if (size(snap) <= maxBytes) return snap
  let posts = snap.posts
  const build = (p: typeof posts): FeedSnapshot => {
    const keep = new Set(collectPostPubkeys(p as never, Infinity))
    return { ...snap, posts: p, profiles: Object.fromEntries(Object.entries(snap.profiles).filter(([k]) => keep.has(k))) }
  }
  let out = build(posts)
  // Halve the overshoot each round rather than measuring after every single post.
  while (posts.length > 0 && size(out) > maxBytes) {
    const over = size(out) / maxBytes
    posts = posts.slice(0, Math.max(0, Math.min(posts.length - 1, Math.floor(posts.length / over))))
    out = build(posts)
  }
  return out
}

export async function saveSnapshot(db: Db, npub: string, snap: FeedSnapshot, now: number): Promise<void> {
  const json = JSON.stringify(trimSnapshot(snap))
  await db.run(upsert(db, 'feed_snapshots', ['npub', 'created_at', 'json'], ['npub'], ['created_at', 'json']), [npub, now, json])
}

export async function loadSnapshot(db: Db, npub: string): Promise<StoredSnapshot | null> {
  const row = await db.get<{ created_at: number; json: string }>('SELECT created_at, json FROM feed_snapshots WHERE npub = ?', [npub])
  if (!row) return null
  try {
    const data = JSON.parse(row.json) as FeedSnapshot
    if (!data || !Array.isArray(data.posts)) return null
    return { ...data, profiles: data.profiles ?? {}, createdAt: Number(row.created_at) }
  } catch {
    return null
  }
}

/** Mark posts that were not in the previous snapshot. With no previous snapshot nothing is new. */
export function flagNew(posts: Array<Record<string, unknown>>, previous: StoredSnapshot | null): Array<Record<string, unknown>> {
  const seen = new Set(previous?.posts.map((p) => p.id))
  return posts.map((p) => ({ ...p, isNew: previous !== null && !seen.has(p.id) }))
}
