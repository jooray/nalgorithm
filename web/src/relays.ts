/**
 * Nalgorithm Web — relay traffic for note actions
 *
 * One shared SimplePool. Finds people's relay lists (NIP-65, from the indexer
 * relays), publishes signed events and says plainly how many relays took them,
 * fetches single events, and watches for zap receipts.
 *
 * Nothing here signs anything. A relay that is down, slow or refuses an event
 * is a normal result, reported per relay, not an exception.
 */

import { SimplePool } from 'nostr-tools/pool'
import type { Event as NostrEvent, Filter } from 'nostr-tools'
import { loadSettings } from './settings.js'
import { normalizeRelay, parseRelayList, selectPublishRelays, type RelayList, type RelayResult } from './note-logic.js'

/** Relays that index kind 10002 and kind 0 widely. */
export const INDEXER_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://relay.primal.net']

const PUBLISH_TIMEOUT_MS = 8000
const FETCH_TIMEOUT_MS = 5000
const LIST_TIMEOUT_MS = 3500

let pool: SimplePool | null = null
function getPool(): SimplePool {
  pool ??= new SimplePool()
  return pool
}

/** The relays the reader configured for reading the feed; the fallback for everything. */
export function defaultRelays(): string[] {
  return loadSettings().relays.map(normalizeRelay).filter(Boolean)
}

// ─── Relay lists ─────────────────────────────────────────────────────────────

const lists = new Map<string, { at: number; list: Promise<RelayList | null> }>()
const LISTS_MAX = 1000
/** A miss is asked again after this long; a relay may have been down. */
const MISS_TTL_MS = 10 * 60_000

/** A person's relay list, or null when none was found. Cached for the session; misses for ten minutes. */
export function getRelayList(pubkey: string): Promise<RelayList | null> {
  const cached = lists.get(pubkey)
  if (cached && Date.now() - cached.at > MISS_TTL_MS) {
    void cached.list.then((list) => {
      if (!list && lists.get(pubkey) === cached) lists.delete(pubkey)
    })
  }
  let hit = cached?.list
  if (!hit) {
    hit = (async () => {
      try {
        const events = await getPool().querySync(
          INDEXER_RELAYS,
          { kinds: [10002], authors: [pubkey], limit: 3 },
          { maxWait: LIST_TIMEOUT_MS }
        )
        const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
        if (!newest) return null
        const list = parseRelayList(newest)
        return list.read.length + list.write.length > 0 ? list : null
      } catch {
        return null
      }
    })()
    lists.set(pubkey, { at: Date.now(), list: hit })
    if (lists.size > LISTS_MAX) lists.delete(lists.keys().next().value!)
  }
  return hit
}

/**
 * Where an event from `self` goes: their write relays (configured relays when
 * unknown) plus the read relays of `parent`, the person being replied to or
 * boosted, when those are known.
 */
export async function publishRelaysFor(self: string, parent?: string): Promise<string[]> {
  const [mine, theirs] = await Promise.all([getRelayList(self), parent && parent !== self ? getRelayList(parent) : Promise.resolve(null)])
  return selectPublishRelays({ ownWrite: mine?.write, defaults: defaultRelays(), parentRead: theirs?.read })
}

/** Relays to ask for a note: hints, then the author's write relays, then the configured ones. */
export async function readRelaysFor(author?: string, hints: string[] = []): Promise<string[]> {
  const theirs = author ? await getRelayList(author) : null
  const out = [...hints, ...(theirs?.write ?? []).slice(0, 3), ...defaultRelays()].map(normalizeRelay).filter(Boolean)
  return [...new Set(out)].slice(0, 8)
}

// ─── Publish ─────────────────────────────────────────────────────────────────

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })

/**
 * Publish to every relay and resolve with one result per relay, once all have
 * answered or timed out. `onResult` fires as each one lands, so a UI can show
 * "Sent" at the first success and keep counting.
 */
export async function publishEvent(
  event: NostrEvent,
  relays: string[],
  onResult?: (result: RelayResult, all: RelayResult[]) => void
): Promise<RelayResult[]> {
  const results: RelayResult[] = []
  const p = getPool()
  await Promise.all(
    relays.map(async (relay) => {
      let result: RelayResult
      try {
        // Publish to one relay at a time so each has its own verdict.
        const [attempt] = p.publish([relay], event)
        await withTimeout(attempt, PUBLISH_TIMEOUT_MS, 'timed out')
        result = { relay, ok: true }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        result = { relay, ok: false, error: text.replace(/^connection failure: /, '').slice(0, 160) }
      }
      results.push(result)
      onResult?.(result, [...results])
    })
  )
  return results
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

/** One event by id, or null. */
export async function fetchEvent(id: string, relays: string[]): Promise<NostrEvent | null> {
  try {
    return await getPool().get(relays, { ids: [id] }, { maxWait: FETCH_TIMEOUT_MS })
  } catch {
    return null
  }
}

export async function queryEvents(relays: string[], filter: Filter): Promise<NostrEvent[]> {
  try {
    return await getPool().querySync(relays, filter, { maxWait: FETCH_TIMEOUT_MS })
  } catch {
    return []
  }
}

/** The newest kind 0 metadata of a person, parsed, or null. */
export async function fetchMetadata(pubkey: string, relays: string[]): Promise<Record<string, unknown> | null> {
  const events = await queryEvents([...new Set([...relays, ...INDEXER_RELAYS])], { kinds: [0], authors: [pubkey], limit: 5 })
  const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
  if (!newest) return null
  try {
    const meta = JSON.parse(newest.content)
    return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Watch for events. Returns a function that stops the watch. */
export function watchEvents(relays: string[], filter: Filter, onEvent: (event: NostrEvent) => void): () => void {
  const sub = getPool().subscribeMany(relays, filter, { onevent: onEvent })
  return () => {
    try {
      sub.close()
    } catch {
      // already closed
    }
  }
}
