/**
 * Nalgorithm Web — digest records and their show notes
 *
 * Pure logic (no DOM, no storage, no network) shared by hosted and
 * bring-your-own-key mode. A digest is its text, an optional audio link, and
 * the ordered list of notes it was composed from: the show notes.
 *
 * Imports only types, so it runs under plain node for tests.
 */

import type { ScoredPost } from 'nalgorithm'

/** One note a digest was built from, with enough of it to render offline. */
export interface DigestSourceNote {
  /** Event id (hex). */
  id: string
  /** Author pubkey (hex). */
  pubkey: string
  /** Unix seconds. */
  createdAt: number
  content: string
  score: number
  reason?: string
  kind?: number
  relay?: string
}

/** Profile fields kept alongside a local digest so its notes render without a network. */
export interface ProfileSnapshot {
  name?: string
  picture?: string
  nip05?: string
}

export interface DigestRecord {
  /** Server id (hosted) or `local-<ms>` (bring your own key). */
  id: string
  /** Unix seconds. */
  createdAt: number
  text: string
  audioUrl: string | null
  /** Exact length of the audio in seconds, measured by the server. Absent for older digests. */
  durationSeconds?: number
  /** Undefined means "not loaded / not known", distinct from an empty list. */
  notes?: DigestSourceNote[]
  profiles?: Record<string, ProfileSnapshot>
}

const HEX_64 = /^[0-9a-f]{64}$/i
const MAX_NOTE_CHARS = 4000
const MAX_TEXT_CHARS = 60_000

/** Validate one untrusted source note (from the server or from storage). */
export function readSourceNote(value: unknown): DigestSourceNote | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !HEX_64.test(v.id)) return null
  if (typeof v.pubkey !== 'string' || !HEX_64.test(v.pubkey)) return null
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return null
  if (typeof v.content !== 'string') return null
  if (typeof v.score !== 'number' || !Number.isFinite(v.score)) return null
  const note: DigestSourceNote = {
    id: v.id.toLowerCase(),
    pubkey: v.pubkey.toLowerCase(),
    createdAt: v.createdAt,
    content: v.content.slice(0, MAX_NOTE_CHARS),
    score: Math.min(10, Math.max(0, v.score)),
  }
  if (typeof v.reason === 'string' && v.reason.trim()) note.reason = v.reason.trim()
  if (typeof v.kind === 'number' && Number.isInteger(v.kind) && v.kind >= 0) note.kind = v.kind
  if (typeof v.relay === 'string' && /^wss?:\/\/[^\s]+$/i.test(v.relay)) note.relay = v.relay
  return note
}

function readProfiles(value: unknown): Record<string, ProfileSnapshot> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, ProfileSnapshot> = {}
  for (const [pk, p] of Object.entries(value as Record<string, unknown>)) {
    if (!HEX_64.test(pk) || !p || typeof p !== 'object') continue
    const r = p as Record<string, unknown>
    const snap: ProfileSnapshot = {}
    if (typeof r.name === 'string') snap.name = r.name.slice(0, 200)
    if (typeof r.picture === 'string') snap.picture = r.picture.slice(0, 1000)
    if (typeof r.nip05 === 'string') snap.nip05 = r.nip05.slice(0, 200)
    out[pk.toLowerCase()] = snap
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Validate one untrusted digest. Notes stay undefined when the source had none. */
export function readDigest(value: unknown): DigestRecord | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const id = typeof v.id === 'number' || typeof v.id === 'string' ? String(v.id) : ''
  if (!id) return null
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return null
  const rec: DigestRecord = {
    id,
    createdAt: v.createdAt,
    text: typeof v.text === 'string' ? v.text.slice(0, MAX_TEXT_CHARS) : '',
    audioUrl: typeof v.audioUrl === 'string' ? v.audioUrl : null,
  }
  if (typeof v.durationSeconds === 'number' && Number.isFinite(v.durationSeconds) && v.durationSeconds > 0) {
    rec.durationSeconds = v.durationSeconds
  }
  if (Array.isArray(v.notes)) {
    rec.notes = v.notes.map(readSourceNote).filter((n): n is DigestSourceNote => n !== null)
  }
  const profiles = readProfiles(v.profiles)
  if (profiles) rec.profiles = profiles
  return rec
}

/**
 * The notes a digest is composed from, for a set of scored posts.
 *
 * Mirrors the selection in lib's `buildDigestMessages`: sort by score, then
 * newest first, keep the top N. A boost is recorded as the note it boosts.
 */
export function digestSourceNotes(posts: ScoredPost[], topN: number): DigestSourceNote[] {
  const sorted = [...posts].sort((a, b) => (b.score !== a.score ? b.score - a.score : b.createdAt - a.createdAt))
  const notes: DigestSourceNote[] = []
  for (const post of sorted.slice(0, topN)) {
    const boosted = post.type === 'boost' && post.originalPost?.id ? post.originalPost : null
    const note = readSourceNote({
      id: boosted ? boosted.id : post.id,
      pubkey: boosted ? boosted.author : post.author,
      createdAt: post.createdAt,
      content: boosted ? boosted.content : post.content,
      score: post.score,
      reason: post.justification,
      kind: boosted ? 1 : post.rawEvent?.kind,
    })
    if (note) notes.push(note)
  }
  return notes
}

/** A note as the renderer wants it: a scored post with no raw event beyond its kind. */
export type SnapshotPost = ScoredPost & { relay?: string }

export function toScoredPost(note: DigestSourceNote): SnapshotPost {
  return {
    id: note.id,
    type: 'original',
    author: note.pubkey,
    content: note.content,
    createdAt: note.createdAt,
    score: note.score,
    justification: note.reason,
    relay: note.relay,
    rawEvent: {
      id: note.id,
      pubkey: note.pubkey,
      created_at: note.createdAt,
      kind: note.kind ?? 1,
      tags: [],
      content: note.content,
      sig: '',
    },
  } as SnapshotPost
}

/** Unique author pubkeys across a digest's notes, in first-seen order. */
export function notePubkeys(notes: DigestSourceNote[]): string[] {
  return [...new Set(notes.map((n) => n.pubkey))]
}

/** Build the record stored after a digest is generated in the browser. */
export function makeLocalDigest(input: {
  text: string
  posts: ScoredPost[]
  topN: number
  profiles?: Map<string, ProfileSnapshot>
  now?: number
}): DigestRecord {
  const now = input.now ?? Date.now()
  const notes = digestSourceNotes(input.posts, input.topN)
  const snap: Record<string, ProfileSnapshot> = {}
  for (const pk of notePubkeys(notes)) {
    const p = input.profiles?.get(pk)
    if (p) snap[pk] = { name: p.name, picture: p.picture, nip05: p.nip05 }
  }
  return {
    id: `local-${now}`,
    createdAt: Math.floor(now / 1000),
    text: input.text.trim(),
    audioUrl: null,
    notes,
    ...(Object.keys(snap).length > 0 ? { profiles: snap } : {}),
  }
}

// ─── Lengths and lines ───────────────────────────────────────────────────────

/** Spoken words per second at 1x, for estimating a length nobody has measured. */
const WORDS_PER_SECOND = 2.6

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

export function estimateSeconds(text: string): number {
  return Math.round(wordCount(text) / WORDS_PER_SECOND)
}

/** "3 min 52 s", or "about 4 min" when only an estimate exists. */
export function formatLength(seconds: number, approx = false): string {
  const s = Math.max(0, Math.round(seconds))
  if (approx) return `about ${Math.max(1, Math.round(s / 60))} min`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m === 0) return `${r} s`
  return r === 0 ? `${m} min` : `${m} min ${r} s`
}

/**
 * The length a digest shows, most trustworthy first: the server's exact figure (measured from the
 * MP3's frames, so it is right before anything plays), then what the player measured (still "about"
 * until the audio has played through once, since a streamed MP3 only guesses), then a guess from
 * the word count.
 */
export function digestLengthLabel(i: { knownSeconds: number; played: boolean; serverSeconds?: number; text: string }): string {
  if (i.serverSeconds !== undefined && i.serverSeconds > 0) return formatLength(i.serverSeconds)
  if (i.knownSeconds > 0) return formatLength(i.knownSeconds, !i.played)
  return formatLength(estimateSeconds(i.text), true)
}

/** The first `n` non-empty lines of a digest, for a list entry. */
export function firstLines(text: string, n = 2): string {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' ')
}

/** Resume and played marks are keyed by the audio link, else by the digest id. */
export function digestKey(d: Pick<DigestRecord, 'id' | 'audioUrl'>): string {
  return d.audioUrl ? `audio:${d.audioUrl}` : `digest:${d.id}`
}

/** Newest first; ties keep their order. */
export function newestFirst<T extends { createdAt: number }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => b.item.createdAt - a.item.createdAt || a.i - b.i)
    .map((x) => x.item)
}
