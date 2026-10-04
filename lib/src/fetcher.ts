/**
 * Nalgorithm — Fetcher module
 *
 * Connects to Nostr relays and retrieves events:
 * - Follow list (kind 3)
 * - Posts from follows (kind 1 originals + kind 1 quotes + kind 6 boosts)
 * - User's likes (kind 7) with resolved content
 *
 * Filters out replies. Resolves embedded posts for quotes and boosts.
 */

import { SimplePool } from 'nostr-tools/pool'
import * as nip19 from 'nostr-tools/nip19'
import * as nip10 from 'nostr-tools/nip10'
import type { Event as NostrEvent } from 'nostr-tools/pure'
import { sanitizeRelayUrl } from './relay-url.js'
import { mapConcurrent } from './work-pool.js'

import type {
  FetcherConfig,
  Fetcher,
  FetchedPost,
  FetchPostsOptions,
  FetchLikesOptions,
  LikedPostContent,
  FetchLikesResult,
  EmbeddedPost,
  ProfileData,
} from './types.js'

const DEFAULT_HOURS_BACK = 24
const DEFAULT_MAX_POSTS = 500
const DEFAULT_LIKES_LIMIT = 200
// Max pubkeys per relay filter to avoid relay rejections
const FILTER_AUTHOR_CHUNK = 200
// Timeout for relay queries (ms)
const QUERY_TIMEOUT = 8_000
// Public relays that index kind 0 widely; asked only for pubkeys nobody else knew.
const DEFAULT_PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io']
// Indexers are flaky with big author filters; small batches answer reliably.
const PROFILE_RETRY_CHUNK = 25
// Outbox pass: each author's own write relays, bounded so it cannot stall a run.
const OUTBOX_MAX_RELAYS_PER_AUTHOR = 3
const OUTBOX_MAX_RELAYS = 12
const OUTBOX_BUDGET_MS = 15_000
const OUTBOX_QUERY_TIMEOUT = 6_000

/**
 * Turn kind 0 events into profiles, keeping the newest event per pubkey.
 * The name is display_name, else name. Events with unparseable content are skipped.
 */
export function parseProfileEvents(events: Array<Pick<NostrEvent, 'pubkey' | 'created_at' | 'content'>>): Map<string, ProfileData> {
  const latest = new Map<string, Pick<NostrEvent, 'pubkey' | 'created_at' | 'content'>>()
  for (const event of events) {
    const existing = latest.get(event.pubkey)
    if (!existing || event.created_at > existing.created_at) latest.set(event.pubkey, event)
  }
  const out = new Map<string, ProfileData>()
  for (const [pubkey, event] of latest) {
    try {
      const meta = JSON.parse(event.content) as Record<string, unknown>
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
      out.set(pubkey, {
        pubkey,
        name: str(meta.display_name) ?? str(meta.name),
        picture: str(meta.picture),
        nip05: str(meta.nip05),
      })
    } catch {
      // Invalid JSON in kind 0 content: skip.
    }
  }
  return out
}

/**
 * Decode an npub or hex pubkey to hex. Passes through hex strings unchanged.
 */
export function pubkeyToHex(input: string): string {
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase()
  try {
    const decoded = nip19.decode(input)
    if (decoded.type === 'npub') return decoded.data as string
    if (decoded.type === 'nprofile') return (decoded.data as { pubkey: string }).pubkey
    throw new Error(`Unexpected nip19 type: ${decoded.type}`)
  } catch {
    throw new Error(`Invalid pubkey or npub: ${input}`)
  }
}

/**
 * Check if a kind 1 event is a reply (has root or reply e-tags).
 */
function isReply(event: NostrEvent): boolean {
  const refs = nip10.parse(event)
  return !!(refs.reply || refs.root)
}

/**
 * Check if a kind 1 event is a quote post (has nostr: references in content
 * or e-tags with "mention" marker).
 */
function isQuotePost(event: NostrEvent): boolean {
  // Check for nostr:nevent or nostr:note references in content
  if (/nostr:n(event|ote)1[a-z0-9]+/i.test(event.content)) return true
  // Check for e-tags with "mention" marker
  return event.tags.some(
    (t: string[]) => t[0] === 'e' && t[3] === 'mention'
  )
}

/**
 * Extract the embedded/mentioned event ID from a quote post.
 * Returns the first mention e-tag ID, or tries to decode a nostr: reference.
 */
function getQuotedEventId(event: NostrEvent): string | null {
  // First check q tags (NIP-18 quote reposts)
  const qTag = event.tags.find((t: string[]) => t[0] === 'q')
  if (qTag?.[1]) return qTag[1]

  // Then check e-tags with "mention" marker
  const mentionTag = event.tags.find(
    (t: string[]) => t[0] === 'e' && t[3] === 'mention'
  )
  if (mentionTag?.[1]) return mentionTag[1]

  // Try to decode nostr: references from content
  const match = event.content.match(/nostr:(nevent1[a-z0-9]+|note1[a-z0-9]+)/i)
  if (match) {
    try {
      const decoded = nip19.decode(match[1])
      if (decoded.type === 'nevent') return (decoded.data as { id: string }).id
      if (decoded.type === 'note') return decoded.data as string
    } catch {
      // Ignore decode failures
    }
  }

  return null
}

/**
 * Extract the original event ID from a kind 6 repost.
 */
function getRepostedEventId(event: NostrEvent): string | null {
  const eTag = event.tags.find((t: string[]) => t[0] === 'e')
  return eTag?.[1] ?? null
}

/**
 * Try to parse the original event from a kind 6 repost's content field.
 */
function parseRepostContent(event: NostrEvent): EmbeddedPost | null {
  if (!event.content || event.content.trim() === '') return null
  try {
    const parsed = JSON.parse(event.content) as NostrEvent
    if (parsed.id && parsed.pubkey && typeof parsed.content === 'string') {
      return {
        id: parsed.id,
        author: parsed.pubkey,
        content: parsed.content,
      }
    }
  } catch {
    // Content is not valid JSON
  }
  return null
}

/**
 * Query relays with a timeout. Returns events or empty array on timeout.
 */
async function queryWithTimeout(
  pool: SimplePool,
  relays: string[],
  filter: Record<string, unknown>,
  timeout = QUERY_TIMEOUT
): Promise<NostrEvent[]> {
  // The loser of the race must be cleaned up: a pending setTimeout keeps the
  // Node event loop alive, so leaving it armed means the process lingers for
  // the full timeout after its work is finished. A digest run makes eight of
  // these queries, so the strays outlive the run and delay exit by up to 30s.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pool.querySync(relays, filter as Parameters<SimplePool['querySync']>[1], { maxWait: timeout }),
      new Promise<NostrEvent[]>((resolve) => {
        timer = setTimeout(() => resolve([]), timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Chunk an array into smaller arrays of the given size.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

/**
 * Create a Fetcher instance.
 */
export function createFetcher(config: FetcherConfig): Fetcher {
  const pool = (config.pool ?? new SimplePool()) as SimplePool
  const { relays } = config
  const fallbackRelays = config.profileFallbackRelays ?? DEFAULT_PROFILE_RELAYS
  const opened = new Set(relays)
  let destroyed = false
  const query = (urls: string[], filter: Record<string, unknown>, timeout = QUERY_TIMEOUT): Promise<NostrEvent[]> => {
    if (destroyed || timeout <= 0) return Promise.resolve([])
    urls.forEach((url) => opened.add(url))
    return queryWithTimeout(pool, urls, filter, timeout)
  }

  async function getFollows(pubkey: string): Promise<string[]> {
    const hex = pubkeyToHex(pubkey)

    const event = await pool.get(relays, {
      kinds: [3],
      authors: [hex],
    }, { maxWait: QUERY_TIMEOUT })

    if (!event) return []

    return event.tags
      .filter((t: string[]) => t[0] === 'p' && t[1])
      .map((t: string[]) => t[1])
  }

  async function getPosts(
    follows: string[],
    options: FetchPostsOptions = {}
  ): Promise<FetchedPost[]> {
    const hoursBack = options.hoursBack ?? DEFAULT_HOURS_BACK
    const maxPosts = options.maxPosts ?? DEFAULT_MAX_POSTS
    const since = Math.floor(Date.now() / 1000) - hoursBack * 3600

    if (follows.length === 0) return []

    // Fetch kind 1 + kind 6 from follows, chunked by author count
    const authorChunks = chunk(follows, FILTER_AUTHOR_CHUNK)
    const allEvents: NostrEvent[] = []

    const fetchDeadline = Date.now() + 30_000
    await mapConcurrent(authorChunks, 3, async (authorBatch) => {
      const events = await query(relays, {
        kinds: [1, 6],
        authors: authorBatch,
        since,
        limit: maxPosts,
      }, Math.min(QUERY_TIMEOUT, Math.max(1, fetchDeadline - Date.now())))
      allEvents.push(...events)
    }, fetchDeadline)

    // Deduplicate by event ID
    const seen = new Set<string>()
    const unique = allEvents.filter((e) => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      return true
    })

    // Classify events
    const results: FetchedPost[] = []
    const idsToResolve: Array<{ eventId: string; forPostIndex: number; field: 'quotedPost' | 'originalPost' }> = []

    const candidates = unique.filter((event) => event.kind === 6 || (event.kind === 1 && !isReply(event)))
      .sort((a, b) => b.created_at - a.created_at).slice(0, maxPosts)
    for (const event of candidates) {
      if (event.kind === 6) {
        // Boost/repost
        const originalFromContent = parseRepostContent(event)
        const post: FetchedPost = {
          id: event.id,
          type: 'boost',
          author: event.pubkey,
          content: originalFromContent?.content ?? '',
          createdAt: event.created_at,
          originalPost: originalFromContent ?? undefined,
          rawEvent: event,
        }
        const idx = results.length
        results.push(post)

        // If we couldn't parse original from content, we need to fetch it
        if (!originalFromContent) {
          const origId = getRepostedEventId(event)
          if (origId) {
            idsToResolve.push({ eventId: origId, forPostIndex: idx, field: 'originalPost' })
          }
        }
      } else if (event.kind === 1) {
        // Skip replies
        if (isReply(event)) continue

        if (isQuotePost(event)) {
          // Quote post
          const quotedId = getQuotedEventId(event)
          const post: FetchedPost = {
            id: event.id,
            type: 'quote',
            author: event.pubkey,
            content: event.content,
            createdAt: event.created_at,
            rawEvent: event,
          }
          const idx = results.length
          results.push(post)

          if (quotedId) {
            idsToResolve.push({ eventId: quotedId, forPostIndex: idx, field: 'quotedPost' })
          }
        } else {
          // Original post
          results.push({
            id: event.id,
            type: 'original',
            author: event.pubkey,
            content: event.content,
            createdAt: event.created_at,
            rawEvent: event,
          })
        }
      }
    }

    // Resolve embedded posts that we need to fetch
    if (idsToResolve.length > 0) {
      const uniqueIds = [...new Set(idsToResolve.map((r) => r.eventId))]
      const idChunks = chunk(uniqueIds, 50)
      const resolvedMap = new Map<string, EmbeddedPost>()

      const embedDeadline = Date.now() + 12_000
      await mapConcurrent(idChunks, 3, async (idBatch) => {
        const events = await query(relays, {
          ids: idBatch,
        }, Math.min(QUERY_TIMEOUT, Math.max(1, embedDeadline - Date.now())))
        for (const e of events) {
          resolvedMap.set(e.id, {
            id: e.id,
            author: e.pubkey,
            content: e.content,
          })
        }
      }, embedDeadline)

      // Attach resolved posts
      for (const resolve of idsToResolve) {
        const resolved = resolvedMap.get(resolve.eventId)
        if (resolved) {
          const post = results[resolve.forPostIndex]
          if (resolve.field === 'quotedPost') {
            post.quotedPost = resolved
          } else {
            post.originalPost = resolved
            // Also set main content if it was empty (boost with no inline content)
            if (!post.content) {
              post.content = resolved.content
            }
          }
        }
      }
    }

    // Sort by time descending and limit
    results.sort((a, b) => b.createdAt - a.createdAt)
    return results.slice(0, maxPosts)
  }

  async function getLikes(
    pubkey: string,
    options: FetchLikesOptions = {}
  ): Promise<FetchLikesResult> {
    const hex = pubkeyToHex(pubkey)
    const limit = options.limit ?? DEFAULT_LIKES_LIMIT

    // Fetch kind 7 reactions by the user
    const filter: Record<string, unknown> = {
      kinds: [7],
      authors: [hex],
      limit,
    }
    if (options.since != null) {
      filter.since = options.since
    }
    if (options.until != null) filter.until = options.until
    const reactions = await query(relays, filter)
    const page = { reactionCount: reactions.length, nextUntil: reactions.length ? Math.min(...reactions.map((r) => r.created_at)) - 1 : undefined }

    // Extract liked event IDs (only positive reactions)
    const likedEventIds: string[] = []
    for (const reaction of reactions) {
      // Only positive reactions ("+", "", or emoji that isn't "-")
      if (reaction.content === '-') continue
      const eTag = reaction.tags.find((t: string[]) => t[0] === 'e')
      if (eTag?.[1]) likedEventIds.push(eTag[1])
    }

    if (likedEventIds.length === 0) return Object.assign([], page)

    // Fetch the liked posts
    const uniqueIds = [...new Set(likedEventIds)]
    const idChunks = chunk(uniqueIds, 50)
    const likedPosts: LikedPostContent[] = []

    for (const idBatch of idChunks) {
        const events = await query(relays, {
        ids: idBatch,
      })
      for (const e of events) {
        // Only include kind 1 text notes with actual content
        if (e.kind === 1 && e.content && e.content.trim().length > 0) {
          likedPosts.push({
            id: e.id,
            author: e.pubkey,
            content: e.content,
            reactionId: reactions.find((r) => r.tags.some((t) => t[0] === 'e' && t[1] === e.id))?.id,
            reactedAt: reactions.find((r) => r.tags.some((t) => t[0] === 'e' && t[1] === e.id))?.created_at,
          })
        }
      }
    }

    return Object.assign(likedPosts, page)
  }

  async function getProfiles(pubkeys: string[]): Promise<Map<string, ProfileData>> {
    const profiles = new Map<string, ProfileData>()
    if (pubkeys.length === 0) return profiles

    const uniquePubkeys = [...new Set(pubkeys)]
    const profileDeadline = Date.now() + 15_000

    // One failed chunk must not lose the profiles the others found.
    async function fetchInto(relayList: string[], wanted: string[], size = FILTER_AUTHOR_CHUNK, timeout = QUERY_TIMEOUT): Promise<void> {
      await mapConcurrent(chunk(wanted, size), 3, async (batch) => {
        if (destroyed || Date.now() >= profileDeadline) return
        try {
          const events = await query(relayList, { kinds: [0], authors: batch }, Math.min(timeout, Math.max(1, profileDeadline - Date.now())))
          for (const [pubkey, profile] of parseProfileEvents(events)) profiles.set(pubkey, profile)
        } catch {
          // Relay error: leave these unresolved, the fallback pass may cover them.
        }
      }, profileDeadline)
    }

    async function outboxPass(missing: string[], indexers: string[]): Promise<void> {
      if (missing.length === 0 || indexers.length === 0) return
      const deadline = Math.min(profileDeadline, Date.now() + OUTBOX_BUDGET_MS)
      const left = () => Math.max(0, deadline - Date.now())

      // kind 10002 from the indexers, in small batches.
      const newestList = new Map<string, NostrEvent>()
      for (const batch of chunk(missing, PROFILE_RETRY_CHUNK)) {
        if (left() === 0) return
        try {
          const events = await query(indexers, { kinds: [10002], authors: batch }, Math.min(OUTBOX_QUERY_TIMEOUT, left()))
          for (const e of events) {
            if (e.kind !== 10002 || !batch.includes(e.pubkey)) continue
            const prev = newestList.get(e.pubkey)
            if (!prev || e.created_at > prev.created_at) newestList.set(e.pubkey, e)
          }
        } catch {
          // Try the next batch.
        }
      }

      // Group authors by write relay, preferring relays many authors share.
      const writeRelays = new Map<string, string[]>()
      const popularity = new Map<string, number>()
      for (const [pubkey, event] of newestList) {
        const urls: string[] = []
        for (const t of event.tags) {
          if (t[0] !== 'r' || (t[2] !== undefined && t[2] !== 'write')) continue
          const url = sanitizeRelayUrl(t[1])
          if (url && !urls.includes(url)) urls.push(url)
        }
        writeRelays.set(pubkey, urls)
        for (const u of urls) popularity.set(u, (popularity.get(u) ?? 0) + 1)
      }
      const byRelay = new Map<string, string[]>()
      for (const [pubkey, urls] of writeRelays) {
        const pick = [...urls].sort((a, b) => (popularity.get(b) ?? 0) - (popularity.get(a) ?? 0)).slice(0, OUTBOX_MAX_RELAYS_PER_AUTHOR)
        for (const u of pick) byRelay.set(u, [...(byRelay.get(u) ?? []), pubkey])
      }
      const targets = [...byRelay.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, OUTBOX_MAX_RELAYS)

      for (const [url, authors] of targets) {
        for (const batch of chunk(authors.filter((pk) => !profiles.has(pk)), PROFILE_RETRY_CHUNK)) {
          if (left() === 0) return
          await fetchInto([url], batch, PROFILE_RETRY_CHUNK, Math.min(OUTBOX_QUERY_TIMEOUT, left()))
        }
      }
    }

    await fetchInto(relays, uniquePubkeys)

    // The configured relays often lack kind 0 for people the follow list points at.
    const stillMissing = () => uniquePubkeys.filter((pk) => !profiles.has(pk))
    const extra = fallbackRelays.filter((r) => !relays.includes(r))
    // Big author filters get partial answers from indexers, so ask in small
    // batches and ask twice: a second attempt picks up what the first skipped.
    for (let attempt = 0; attempt < 2 && extra.length > 0; attempt++) {
      const missing = stillMissing()
      if (missing.length === 0) break
      await fetchInto(extra, missing, PROFILE_RETRY_CHUNK)
    }

    // Outbox: ask each author's own write relays.
    try {
      await outboxPass(stillMissing(), extra.length > 0 ? extra : fallbackRelays)
    } catch {
      // Never throw from a best-effort pass; keep whatever resolved.
    }

    return profiles
  }

  function destroy(): void {
    destroyed = true
    if (!config.pool) pool.destroy()
    else pool.close([...opened])
  }

  return { getFollows, getPosts, getLikes, getProfiles, destroy }
}
