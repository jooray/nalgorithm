/**
 * Nalgorithm Web — the stored feed (pure)
 *
 * The ranked feed outlives a page load: it is kept on this device and, in
 * hosted mode, on the server. These are the decisions around it: how old it is,
 * when to refresh it without being asked, and whether a fresh result may
 * replace what the reader is looking at. No DOM here.
 */

/** A feed older than this is refreshed on open. */
export const STALE_AFTER_SECONDS = 10 * 60
/** How often an open, visible app looks at whether it is due. */
export const CHECK_EVERY_MS = 5 * 60_000
/** Scrolled less than this far, the reader counts as "at the top". */
export const TOP_SCROLL_PX = 80
/** Cap on what one device keeps: roughly 1.5 MB of JSON, and never more than this many posts. */
export const LOCAL_MAX_BYTES = 1_500_000
export const LOCAL_MAX_POSTS = 200

export interface StoredPost {
  id: string
  [key: string]: unknown
}

export interface LocalSnapshot {
  v: 1
  /** Unix seconds of the run the ranking came from. */
  createdAt: number
  hoursBack?: number
  fetched?: number
  /** Fingerprint of the settings the ranking used (bring your own key); a mismatch means the ranking is out of date. */
  sig?: string
  /** Notes (folded ids) that came with this run and were not in the one before; drawn above the rest. */
  fresh?: string[]
  posts: StoredPost[]
  profiles: Record<string, unknown>
}

// ─── age ─────────────────────────────────────────────────────────────────────

export function ageSeconds(createdAt: number, nowSec: number): number {
  return Math.max(0, Math.floor(nowSec - createdAt))
}

export function isStale(createdAt: number | null, nowSec: number, settingsChanged = false): boolean {
  if (createdAt === null || settingsChanged) return true
  return ageSeconds(createdAt, nowSec) >= STALE_AFTER_SECONDS
}

/** The feed header line: "Updated just now", "Updated 12 min ago", "Updated 3 h ago", "Updated 2 d ago". */
export function ageLabel(createdAt: number | null, nowSec: number): string {
  if (createdAt === null) return ''
  const s = ageSeconds(createdAt, nowSec)
  const min = Math.floor(s / 60)
  if (min < 1) return 'Updated just now'
  if (min < 60) return `Updated ${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 48) return `Updated ${h} h ago`
  return `Updated ${Math.floor(h / 24)} d ago`
}

// ─── when to run by itself ───────────────────────────────────────────────────

export interface AutoRunInput {
  /** The reader allows it (hosted: always; bring your own key: the Tune setting). */
  enabled: boolean
  /** Signed in, prompt set, key present, not paywalled: everything a run needs. */
  ready: boolean
  running: boolean
  /** The app is in the background: do not spend anything there. */
  hidden: boolean
  createdAt: number | null
  nowSec: number
  /** The prompt or window changed since the stored ranking was made. */
  settingsChanged?: boolean
  /** After a daily cap or an outage: do not ask again before this time (unix seconds). */
  pausedUntil?: number
  /** An automatic attempt already failed this page load and nothing has changed since. */
  attemptFailed?: boolean
}

export function shouldAutoRun(i: AutoRunInput): boolean {
  if (!i.enabled || !i.ready || i.running || i.hidden || i.attemptFailed) return false
  if ((i.pausedUntil ?? 0) > i.nowSec) return false
  return isStale(i.createdAt, i.nowSec, i.settingsChanged)
}

// ─── merging a result into what is on screen ─────────────────────────────────

export type MergeAction =
  /** Nothing was on screen: draw it. */
  | 'render'
  /** Replace the list now. */
  | 'merge'
  /** Show "N new notes" and wait for a tap. */
  | 'pill'
  /** Nothing the reader can see changes. */
  | 'keep'

export interface MergeInput {
  shownIds: readonly string[]
  incomingIds: readonly string[]
  scrollY: number
  /** The Feed tab is the one on screen. Another tab's scroll position says nothing about reading. */
  feedVisible: boolean
  /** The reader asked for this run (the button), so it replaces the list whatever the scroll. */
  manual?: boolean
}

export interface MergeDecision {
  action: MergeAction
  newCount: number
  /** The incoming list is exactly what is shown, in the same order. */
  same: boolean
}

export function countNew(shownIds: readonly string[], incomingIds: readonly string[]): number {
  const shown = new Set(shownIds)
  let n = 0
  for (const id of new Set(incomingIds)) if (!shown.has(id)) n++
  return n
}

export function decideMerge(i: MergeInput): MergeDecision {
  const newCount = countNew(i.shownIds, i.incomingIds)
  if (i.shownIds.length === 0) return { action: 'render', newCount, same: i.incomingIds.length === 0 }
  const same = i.shownIds.length === i.incomingIds.length && i.shownIds.every((id, k) => id === i.incomingIds[k])
  if (same) return { action: 'keep', newCount: 0, same: true }
  if (i.manual) return { action: 'merge', newCount, same: false }
  if (!i.feedVisible || i.scrollY <= TOP_SCROLL_PX) return { action: 'merge', newCount, same: false }
  // A reader mid-scroll keeps their list. New notes are offered; a pure re-rank waits for the next open.
  return newCount > 0 ? { action: 'pill', newCount, same: false } : { action: 'keep', newCount: 0, same: false }
}

// ─── what came with the latest run ───────────────────────────────────────────

/**
 * The notes to put above the rest of the feed: those in `incoming` that were not
 * on screen before. A run that brings nothing new keeps the earlier set, so a
 * quiet re-rank does not bury what the reader has not seen yet. No split on a
 * first draw, or when everything is new: there is no "rest" to set it apart from.
 * All ids are folded (display) ids, in rank order.
 */
export function freshIds(shown: readonly string[], incoming: readonly string[], carried: readonly string[] = []): string[] {
  if (shown.length === 0) return []
  const before = new Set(shown)
  const added = incoming.filter((id) => !before.has(id))
  if (added.length === incoming.length) return []
  if (added.length > 0) return added
  const keep = new Set(carried)
  const still = incoming.filter((id) => keep.has(id))
  return still.length === incoming.length ? [] : still
}

/** Fresh notes first, then the rest, each in rank order. `fresh` is empty when there is nothing to set apart. */
export function splitFresh<T extends { id: string }>(posts: readonly T[], fresh: ReadonlySet<string>): { fresh: T[]; rest: T[] } {
  const top = posts.filter((p) => fresh.has(p.id))
  if (top.length === 0 || top.length === posts.length) return { fresh: [], rest: [...posts] }
  return { fresh: top, rest: posts.filter((p) => !fresh.has(p.id)) }
}

/** The most recent posts one run ranks (the library's and server's cap). */
export const RANKED_CAP = 500

/**
 * What the status line says about a ranking: how many notes it covers, from how many
 * ranked posts in which window, and in what order. "Ranked" is an estimate of relevance
 * to the reader's words, not a measured certainty, so nothing here claims more.
 */
export function coverageText(i: { shown: number; ranked: number; hoursBack: number; order: 'new' | 'best'; unranked?: number }): string {
  const notes = i.shown === 1 ? '1 note' : `${i.shown} notes`
  const window = i.hoursBack % 24 === 0 && i.hoursBack >= 48 ? `${i.hoursBack / 24} days` : `${i.hoursBack} h`
  const order = i.order === 'best' ? 'best match first' : 'new arrivals first, then best match'
  const posts = i.ranked === 1 ? '1 post' : `${i.ranked} posts`
  let text = `${notes} from ${posts} ranked in the last ${window}, ${order}.`
  if (i.ranked >= RANKED_CAP) text += ` A busy window: only the newest ${RANKED_CAP} posts were ranked.`
  if (i.unranked) text += ` ${i.unranked} not ranked yet; check the model connection.`
  return text
}

export function pillLabel(n: number): string {
  return n === 1 ? '1 new note' : `${n} new notes`
}

// ─── quiet failures ──────────────────────────────────────────────────────────

export interface QuietNotice {
  text: string
  /** Seconds before an automatic run may try again. */
  pauseSeconds: number
}

/**
 * Failures that must not replace a feed the reader can still use with an error
 * card. Null means the failure needs its normal handling (sign in, paywall, ...).
 */
export function quietNotice(status: number, code?: string): QuietNotice | null {
  if (status === 429 && code === 'daily_cap') {
    return { text: 'Daily limit for ranking reached. Showing your last ranking.', pauseSeconds: 3600 }
  }
  if (status === 429 && code === 'in_progress') return { text: '', pauseSeconds: 60 }
  if (status === 503 && code === 'busy') return { text: 'Ranking is busy right now. Showing your last ranking; it tries again in a minute.', pauseSeconds: 60 }
  if (status === 503) return { text: 'Ranking is unavailable right now. Showing your last ranking.', pauseSeconds: 300 }
  if (status === 0) return { text: 'Offline. Showing your last ranking.', pauseSeconds: 60 }
  if (status >= 500) return { text: 'Ranking hit a problem. Showing your last ranking.', pauseSeconds: 300 }
  return null
}

// ─── storage on this device ──────────────────────────────────────────────────

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const encoder = new TextEncoder()
const bytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length

/**
 * Fit a snapshot under the caps. Posts are in rank order, so the tail goes first.
 * Each post (and each profile it brings) is measured once, in encoded bytes.
 */
export function trimLocalSnapshot(
  snap: LocalSnapshot,
  maxBytes = LOCAL_MAX_BYTES,
  maxPosts = LOCAL_MAX_POSTS,
  collectKeep: (posts: StoredPost[]) => Set<string> = () => new Set(Object.keys(snap.profiles))
): LocalSnapshot {
  const posts = snap.posts.slice(0, maxPosts)
  let total = bytesOf({ ...snap, posts: [], profiles: {} })
  let kept = 0
  const people = new Set<string>()
  for (const post of posts) {
    const added = [...collectKeep([post])].filter((k) => !people.has(k) && k in snap.profiles)
    const size = bytesOf(post) + 1 + added.reduce((n, k) => n + bytesOf(k) + bytesOf(snap.profiles[k]) + 2, 0)
    if (total + size > maxBytes) break
    total += size
    kept++
    for (const k of added) people.add(k)
  }
  const keep = collectKeep(posts.slice(0, kept))
  return { ...snap, posts: posts.slice(0, kept), profiles: Object.fromEntries(Object.entries(snap.profiles).filter(([k]) => keep.has(k))) }
}

export function validSnapshot(v: unknown): v is LocalSnapshot {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<LocalSnapshot>
  return s.v === 1 && typeof s.createdAt === 'number' && Array.isArray(s.posts) && typeof s.profiles === 'object' && s.profiles !== null
}

/** Returns false when the device refused (quota, blocked storage): the feed then simply is not remembered. */
export function saveLocalSnapshot(store: KeyValueStore | null, key: string, snap: LocalSnapshot, collectKeep?: (posts: StoredPost[]) => Set<string>): boolean {
  if (!store) return false
  try {
    store.setItem(key, JSON.stringify(trimLocalSnapshot(snap, LOCAL_MAX_BYTES, LOCAL_MAX_POSTS, collectKeep)))
    return true
  } catch {
    try {
      store.removeItem(key)
    } catch {
      // nothing more to do
    }
    return false
  }
}

export function loadLocalSnapshot(store: KeyValueStore | null, key: string): LocalSnapshot | null {
  if (!store) return null
  try {
    const raw = store.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return validSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function clearLocalSnapshot(store: KeyValueStore | null, key: string): void {
  try {
    store?.removeItem(key)
  } catch {
    // nothing stored to clear
  }
}
