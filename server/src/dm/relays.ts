import { sanitizeRelayUrl, isAcceptableRelayUrl } from 'nalgorithm'
import type { Event } from 'nostr-tools/pure'
import type { AbstractSimplePool } from 'nostr-tools/pool'

export const KIND_DM_RELAYS = 10050
export const KIND_RELAY_LIST = 10002

export const DEFAULT_INDEXERS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
export const DEFAULT_FALLBACK = ['wss://nostr.cypherpunk.today', 'wss://relay.damus.io', 'wss://nos.lol']

const MAX_TARGETS = 6
const MAX_EXTRA = 3
const CACHE_TTL_MS = 10 * 60 * 1000
/** A fallback answer may only mean the indexers were down, so it is not worth remembering for long. */
const FALLBACK_TTL_MS = 60 * 1000
const LOOKUP_WAIT_MS = 4000

export { sanitizeRelayUrl, isAcceptableRelayUrl }

export type RelayTier = 'inbox' | 'nip65' | 'fallback'

function uniqueAcceptable(urls: Iterable<unknown>, allowInsecure: boolean, max: number): string[] {
  const out: string[] = []
  for (const raw of urls) {
    const url = sanitizeRelayUrl(raw, allowInsecure)
    if (url && !out.includes(url)) out.push(url)
    if (out.length >= max) break
  }
  return out
}

function newest(events: Event[], kind: number, pubkey: string): Event | undefined {
  // A relay can return anything; only the peer's own event of this kind counts.
  return events.filter((e) => e.kind === kind && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0]
}

export interface RelayResolverOptions {
  pool: Pick<AbstractSimplePool, 'querySync'>
  indexers?: string[]
  fallback?: string[]
  /** Milliseconds; injectable for the cache tests. */
  now?: () => number
  allowInsecureRelays?: boolean
  /** How long to wait for the indexers, in milliseconds. */
  lookupWaitMs?: number
}

export interface ResolvedRelays {
  relays: string[]
  tier: RelayTier
}

export interface RelayResolver {
  resolve(pubkey: string, extra?: string[]): Promise<ResolvedRelays>
}

export function createRelayResolver(opts: RelayResolverOptions): RelayResolver {
  const { pool } = opts
  const indexers = opts.indexers ?? DEFAULT_INDEXERS
  const insecure = opts.allowInsecureRelays ?? false
  const fallback = uniqueAcceptable(opts.fallback ?? DEFAULT_FALLBACK, insecure, MAX_TARGETS)
  const now = opts.now ?? Date.now
  const cache = new Map<string, { expires: number; value: ResolvedRelays }>()
  const inflight = new Map<string, Promise<ResolvedRelays>>()

  async function lookup(pubkey: string): Promise<{ value: ResolvedRelays; found: boolean }> {
    let events: Event[] = []
    try {
      events = await pool.querySync(indexers, { kinds: [KIND_DM_RELAYS, KIND_RELAY_LIST], authors: [pubkey] }, { maxWait: opts.lookupWaitMs ?? LOOKUP_WAIT_MS })
    } catch {
      // No answer is the same as no list: fall through to the fallback tier.
    }
    const dm = newest(events, KIND_DM_RELAYS, pubkey)
    const inbox = dm ? uniqueAcceptable(dm.tags.filter((t) => t[0] === 'relay').map((t) => t[1]), insecure, MAX_TARGETS) : []
    if (inbox.length) return { value: { relays: inbox, tier: 'inbox' }, found: true }

    const list = newest(events, KIND_RELAY_LIST, pubkey)
    const read = list
      ? uniqueAcceptable(
          list.tags.filter((t) => t[0] === 'r' && (t[2] === undefined || t[2] === 'read')).map((t) => t[1]),
          insecure,
          MAX_TARGETS,
        )
      : []
    if (read.length) return { value: { relays: read, tier: 'nip65' }, found: true }
    return { value: { relays: fallback, tier: 'fallback' }, found: false }
  }

  return {
    async resolve(pubkey, extra = []) {
      let base: ResolvedRelays
      const hit = cache.get(pubkey)
      if (hit && hit.expires > now()) {
        base = hit.value
      } else {
        // Concurrent sends to one peer share a single lookup.
        let pending = inflight.get(pubkey)
        if (!pending) {
          pending = lookup(pubkey).then(({ value, found }) => {
            cache.set(pubkey, { expires: now() + (found ? CACHE_TTL_MS : FALLBACK_TTL_MS), value })
            return value
          })
          inflight.set(pubkey, pending)
          const clear = () => inflight.delete(pubkey)
          pending.then(clear, clear)
        }
        base = await pending
      }
      const extras = uniqueAcceptable(extra, insecure, Infinity).filter((url) => !base.relays.includes(url)).slice(0, MAX_EXTRA)
      return { relays: [...base.relays, ...extras], tier: base.tier }
    },
  }
}
