import { SimplePool } from 'nostr-tools/pool'
import type { AbstractSimplePool, SubCloser } from 'nostr-tools/pool'
import type { Event, Filter } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'
import * as nip04 from 'nostr-tools/nip04'
import { DmRejectedError, KIND_GIFT_WRAP, MAX_CIPHERTEXT_LENGTH, unwrapGiftWrap } from './wrap.js'
import { silentLogger, type DmLogger, type IncomingDm } from './types.js'

const KIND_NIP04 = 4
/** Gift-wrap timestamps are randomised up to 2 days into the past, so the window must cover that. */
const SINCE_WINDOW_S = 3 * 24 * 3600
const FUTURE_CLAMP_S = 15 * 60
const MEMORY_SEEN_LIMIT = 5000
const RECONNECT_BASE_MS = 5000
const RECONNECT_MAX_MS = 60_000

/** Persistent record of processed event ids, so a restart does not answer three days of history again. */
export interface SeenStore {
  has(id: string): Promise<boolean>
  add(id: string): Promise<void>
}

export function createMemorySeenStore(): SeenStore {
  const ids = new Set<string>()
  return {
    async has(id) {
      return ids.has(id)
    },
    async add(id) {
      ids.add(id)
    },
  }
}

/** Pool settings the inbox relies on: it must survive dropped connections and dead peers. */
export function createDmPool(): SimplePool {
  return new SimplePool({ enableReconnect: true, enablePing: true })
}

export interface DmInboxOptions {
  pool: Pick<AbstractSimplePool, 'subscribeMap' | 'close'>
  secretKey: Uint8Array
  relays: string[]
  seen: SeenStore
  log?: DmLogger
  onMessage: (dm: IncomingDm) => void | Promise<void>
  /** Unix seconds; injectable for tests. */
  now?: () => number
}

export interface DmInbox {
  start(): void
  /** Closes every subscription, socket and timer this inbox opened. */
  stop(): Promise<void>
}

export function createDmInbox(opts: DmInboxOptions): DmInbox {
  const { pool, secretKey, seen, onMessage } = opts
  const log = opts.log ?? silentLogger
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const botPubkey = getPublicKey(secretKey)
  const relays = [...new Set(opts.relays)]

  // Small in-memory front for the store: the same wrap arrives once per relay.
  const recent = new Set<string>()
  const closers = new Map<string, SubCloser>()
  const timers = new Set<NodeJS.Timeout>()
  const attempts = new Map<string, number>()
  let running = false

  function remember(id: string): boolean {
    if (recent.has(id)) return false
    recent.add(id)
    if (recent.size > MEMORY_SEEN_LIMIT) recent.delete(recent.values().next().value as string)
    return true
  }

  async function deliver(dm: IncomingDm): Promise<void> {
    try {
      await onMessage(dm)
    } catch (err) {
      log.warn(`dm handler failed: ${(err as Error).message}`)
    }
  }

  // Ids are marked seen before the handler runs: a message is handled at most
  // once, because answering it twice is worse than missing it after a crash.
  async function handleEvent(event: Event, relay: string): Promise<void> {
    if (!remember(event.id)) return
    try {
      if (await seen.has(event.id)) return
    } catch (err) {
      log.warn(`dm seen-store read failed: ${(err as Error).message}`)
    }

    let dm: IncomingDm | null = null
    const receivedAt = now()
    if (event.kind === KIND_GIFT_WRAP) {
      try {
        const { rumor, senderPubkey } = unwrapGiftWrap(event, secretKey)
        // Our own send copies come back through the same subscription.
        if (senderPubkey !== botPubkey) {
          dm = {
            senderPubkey,
            content: rumor.content,
            protocol: 'nip17',
            rumorId: rumor.id,
            createdAt: Math.min(rumor.created_at, receivedAt + FUTURE_CLAMP_S),
            receivedAt,
            relay,
          }
        }
      } catch (err) {
        if (err instanceof DmRejectedError) log.warn(`dm wrap ${event.id.slice(0, 8)} dropped (${err.reason}) via ${relay}`)
        else log.warn(`dm wrap ${event.id.slice(0, 8)} failed: ${(err as Error).message}`)
      }
    } else if (event.kind === KIND_NIP04) {
      try {
        if (event.content.length > MAX_CIPHERTEXT_LENGTH) throw new Error('oversized')
        dm = {
          senderPubkey: event.pubkey,
          content: nip04.decrypt(secretKey, event.pubkey, event.content),
          protocol: 'nip04',
          rumorId: event.id,
          createdAt: Math.min(event.created_at, receivedAt + FUTURE_CLAMP_S),
          receivedAt,
          relay,
        }
      } catch (err) {
        log.warn(`dm nip04 ${event.id.slice(0, 8)} dropped (${(err as Error).message}) via ${relay}`)
      }
    }

    try {
      await seen.add(event.id)
    } catch (err) {
      log.warn(`dm seen-store write failed: ${(err as Error).message}`)
    }
    if (dm) await deliver(dm)
  }

  function open(url: string): void {
    if (!running) return
    const since = now() - SINCE_WINDOW_S
    const filters: Filter[] = [
      { kinds: [KIND_GIFT_WRAP], '#p': [botPubkey], since },
      { kinds: [KIND_NIP04], '#p': [botPubkey], since },
    ]
    // One subscription call per relay. The pool drops an event id it has already
    // passed on from any relay in the same call, which would hide which relay
    // each copy came from.
    const closer = pool.subscribeMap(
      filters.map((filter) => ({ url, filter })),
      {
        onevent: (event) => {
          void handleEvent(event, url).catch((err: Error) => log.warn(`dm processing failed: ${err.message}`))
        },
        oneose: () => attempts.set(url, 0),
        onclose: (reasons) => {
          if (closers.get(url) !== closer || !running) return
          closers.delete(url)
          // nostr-tools does not retry a relay that failed on first connect, and
          // gives up on one whose reconnection fails, so retry here with backoff.
          const n = attempts.get(url) ?? 0
          attempts.set(url, n + 1)
          const delay = Math.min(RECONNECT_BASE_MS * 2 ** n, RECONNECT_MAX_MS)
          log.warn(`dm inbox relay ${url} closed (${reasons.join(', ')}); retrying in ${delay / 1000}s`)
          const timer = setTimeout(() => {
            timers.delete(timer)
            open(url)
          }, delay)
          timers.add(timer)
        },
      },
    )
    closers.set(url, closer)
  }

  return {
    start() {
      if (running) return
      running = true
      for (const url of relays) open(url)
    },
    async stop() {
      running = false
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      const active = [...closers.values()]
      closers.clear()
      await Promise.allSettled(active.map((c) => c.close('inbox stopped')))
      pool.close(relays)
    },
  }
}
