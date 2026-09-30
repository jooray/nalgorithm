import type { Event } from 'nostr-tools/pure'
import type { AbstractSimplePool } from 'nostr-tools/pool'
import type { RelayOutcome } from './types.js'

export const MAX_PUBLISH_RELAYS = 8

export interface PublishOptions {
  /** Per attempt, per relay: connecting plus waiting for the OK. Default 10 s. */
  timeoutMs?: number
  /** Pauses before the 2nd and 3rd attempt. Default 500 ms then 2 s. */
  backoffMs?: number[]
  /** Injectable so tests need not wait. */
  sleep?: (ms: number) => Promise<void>
}

export interface PublishResult {
  /** At least one relay answered OK. */
  delivered: boolean
  eventId: string
  relays: Record<string, RelayOutcome>
}

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function classify(err: unknown): RelayOutcome {
  const message = err instanceof Error ? err.message : String(err)
  if (message === 'publish timed out' || message === 'connection timed out') return { status: 'timeout', reason: message }
  // nostr-tools rejects with the relay's own text for OK=false, and with these
  // fixed phrases when the socket dies underneath the publish. Only the former
  // is a refusal that retrying cannot fix.
  const transport = /^(relay connection|connection failure|connection skipped|Tried to send|duplicate url|websocket closed)/i.test(message)
  if (err instanceof Error && !transport) return { status: 'rejected', reason: message }
  return { status: 'error', reason: message }
}

async function attempt(pool: Pick<AbstractSimplePool, 'ensureRelay'>, event: Event, url: string, timeoutMs: number): Promise<RelayOutcome> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<RelayOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout', reason: 'no answer' }), timeoutMs)
  })
  const work = (async (): Promise<RelayOutcome> => {
    try {
      const relay = await pool.ensureRelay(url, { connectionTimeout: timeoutMs })
      // nostr-tools defaults to 4.4 s for the OK, shorter than our budget.
      relay.publishTimeout = timeoutMs
      await relay.publish(event)
      return { status: 'ok' }
    } catch (err) {
      return classify(err)
    }
  })()
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Send one event to up to 8 relays at once and report each relay's answer,
 * matched by event id. Timeouts and transport errors are retried (3 attempts
 * in all); a relay that answered OK=false has decided and is left alone.
 * Never throws: every failure becomes a per-relay outcome.
 */
export async function publishToRelays(
  pool: Pick<AbstractSimplePool, 'ensureRelay'>,
  event: Event,
  relays: string[],
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const backoff = opts.backoffMs ?? [500, 2000]
  const sleep = opts.sleep ?? sleepReal
  const targets = [...new Set(relays)].slice(0, MAX_PUBLISH_RELAYS)
  const outcomes: Record<string, RelayOutcome> = {}

  let pending = targets
  for (let round = 0; pending.length > 0 && round <= backoff.length; round++) {
    if (round > 0) await sleep(backoff[round - 1])
    const results = await Promise.all(pending.map((url) => attempt(pool, event, url, timeoutMs)))
    pending.forEach((url, i) => {
      outcomes[url] = results[i]
    })
    pending = pending.filter((_, i) => results[i].status === 'timeout' || results[i].status === 'error')
  }
  return { delivered: Object.values(outcomes).some((o) => o.status === 'ok'), eventId: event.id, relays: outcomes }
}
