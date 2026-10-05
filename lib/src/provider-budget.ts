import type { LLMConfig } from './types.js'

interface Budget { active: number; queue: Array<() => void>; limit: number; rpm: number; next: number; requests: number }
const budgets = new Map<string, Budget>()
const keyOf = (config: Pick<LLMConfig, 'apiBaseUrl' | 'apiKey'>): string => `${config.apiBaseUrl.replace(/\/+$/, '')}\n${config.apiKey}`
function budgetFor(config: Pick<LLMConfig, 'apiBaseUrl' | 'apiKey'>): Budget {
  const key = keyOf(config)
  let budget = budgets.get(key)
  if (!budget) { budget = { active: 0, queue: [], limit: 10, rpm: Infinity, next: 0, requests: 0 }; budgets.set(key, budget) }
  return budget
}
export function configureProviderBudget(config: Pick<LLMConfig, 'apiBaseUrl' | 'apiKey'>, options: { concurrency: number; requestsPerMinute: number }): void {
  const budget = budgetFor(config)
  budget.limit = Math.max(1, Math.min(10, options.concurrency))
  budget.rpm = Math.max(1, options.requestsPerMinute)
}
/** The shared queue is full: the provider is busy, so retrying now only lengthens the queue. */
export class ProviderBusy extends Error {
  constructor() { super('The model queue is full. Try again shortly.'); this.name = 'ProviderBusy' }
}
/** Shared across scoring, writing, learning, editing and TTS for the same key. */
export async function withProviderSlot<T>(config: Pick<LLMConfig, 'apiBaseUrl' | 'apiKey'> & { signal?: AbortSignal }, work: () => Promise<T>): Promise<T> {
  const b = budgetFor(config)
  config.signal?.throwIfAborted()
  if (b.active >= b.limit) {
    if (b.queue.length >= 64) throw new ProviderBusy()
    // An aborted caller leaves the queue at once instead of holding a place until a slot frees.
    const signal = config.signal
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const i = b.queue.indexOf(wake)
        if (i >= 0) b.queue.splice(i, 1)
        reject(signal!.reason)
      }
      const wake = (): void => { signal?.removeEventListener('abort', onAbort); resolve() }
      signal?.addEventListener('abort', onAbort, { once: true })
      b.queue.push(wake)
    })
  } else b.active++
  try {
    config.signal?.throwIfAborted()
    const slot = Math.max(Date.now(), b.next)
    b.next = slot + 60_000 / b.rpm
    if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()))
    config.signal?.throwIfAborted()
    b.requests++
    return await work()
  } finally {
    const next = b.queue.shift()
    if (next) next(); else b.active--
  }
}
/** Aggregate diagnostics only: no keys, prompts or user identities. */
export function providerBudgetStats(): { active: number; queued: number; requests: number } {
  return [...budgets.values()].reduce((out, b) => ({ active: out.active + b.active, queued: out.queued + b.queue.length, requests: out.requests + b.requests }), { active: 0, queued: 0, requests: 0 })
}
