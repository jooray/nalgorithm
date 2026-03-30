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

import type {
  FetcherConfig,
  Fetcher,
  FetchedPost,
  FetchPostsOptions,
  FetchLikesOptions,
  LikedPostContent,
  EmbeddedPost,
  ProfileData,
} from './types.js'

const DEFAULT_HOURS_BACK = 24
const DEFAULT_MAX_POSTS = 500
const DEFAULT_LIKES_LIMIT = 200
// Max pubkeys per relay filter to avoid relay rejections
const FILTER_AUTHOR_CHUNK = 200
// Timeout for relay queries (ms)
const QUERY_TIMEOUT = 30_000

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
  return Promise.race([
    pool.querySync(relays, filter as Parameters<SimplePool['querySync']>[1]),
    new Promise<NostrEvent[]>((resolve) =>
      setTimeout(() => resolve([]), timeout)
    ),
  ])
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
  const pool = new SimplePool()
  const { relays } = config

  async function getFollows(pubkey: string): Promise<string[]> {
    const hex = pubkeyToHex(pubkey)

    const event = await pool.get(relays, {
      kinds: [3],
      authors: [hex],
    })

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

    for (const authorBatch of authorChunks) {
      const events = await queryWithTimeout(pool, relays, {
        kinds: [1, 6],
        authors: authorBatch,
        since,
        limit: maxPosts,
      })
      allEvents.push(...events)
    }

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

    for (const event of unique) {
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

      for (const idBatch of idChunks) {
        const events = await queryWithTimeout(pool, relays, {
          ids: idBatch,
        })
        for (const e of events) {
          resolvedMap.set(e.id, {
            id: e.id,
            author: e.pubkey,
            content: e.content,
          })
        }
      }

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
  ): Promise<LikedPostContent[]> {
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
    const reactions = await queryWithTimeout(pool, relays, filter)

    // Extract liked event IDs (only positive reactions)
    const likedEventIds: string[] = []
    for (const reaction of reactions) {
      // Only positive reactions ("+", "", or emoji that isn't "-")
      if (reaction.content === '-') continue
      const eTag = reaction.tags.find((t: string[]) => t[0] === 'e')
      if (eTag?.[1]) likedEventIds.push(eTag[1])
    }

    if (likedEventIds.length === 0) return []

    // Fetch the liked posts
    const uniqueIds = [...new Set(likedEventIds)]
    const idChunks = chunk(uniqueIds, 50)
    const likedPosts: LikedPostContent[] = []

    for (const idBatch of idChunks) {
      const events = await queryWithTimeout(pool, relays, {
        ids: idBatch,
      })
      for (const e of events) {
        // Only include kind 1 text notes with actual content
        if (e.kind === 1 && e.content && e.content.trim().length > 0) {
          likedPosts.push({
            id: e.id,
            author: e.pubkey,
            content: e.content,
          })
        }
      }
    }

    return likedPosts
  }

  async function getProfiles(pubkeys: string[]): Promise<Map<string, ProfileData>> {
    const profiles = new Map<string, ProfileData>()
    if (pubkeys.length === 0) return profiles

    const uniquePubkeys = [...new Set(pubkeys)]
    const pubkeyChunks = chunk(uniquePubkeys, FILTER_AUTHOR_CHUNK)

    for (const batch of pubkeyChunks) {
      const events = await queryWithTimeout(pool, relays, {
        kinds: [0],
        authors: batch,
      })

      // Kind 0 can have multiple events per pubkey; use the most recent
      const latestByPubkey = new Map<string, NostrEvent>()
      for (const event of events) {
        const existing = latestByPubkey.get(event.pubkey)
        if (!existing || event.created_at > existing.created_at) {
          latestByPubkey.set(event.pubkey, event)
        }
      }

      for (const [pubkey, event] of latestByPubkey) {
        try {
          const meta = JSON.parse(event.content) as Record<string, unknown>
          profiles.set(pubkey, {
            pubkey,
            name: (meta.display_name as string) || (meta.name as string) || undefined,
            picture: (meta.picture as string) || undefined,
            nip05: (meta.nip05 as string) || undefined,
          })
        } catch {
          // Invalid JSON in kind 0 content — skip
        }
      }
    }

    return profiles
  }

  function destroy(): void {
    pool.close(relays)
  }

  return { getFollows, getPosts, getLikes, getProfiles, destroy }
}
