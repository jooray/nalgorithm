/**
 * Nalgorithm — client for typed-decision endpoints (Venice `/decisions`)
 *
 * A decision model (Venice's `jev-latest`) is not a chat model. It takes a
 * `state` and a map of typed questions and returns probability distributions,
 * not text: no prompt to follow, no JSON to parse, no justification. What it
 * gives instead is a score that is continuous, reproducible across runs, and
 * about a second per request however many questions ride on it.
 *
 * The endpoint is beta and rate-limited per key (100 requests a minute on
 * Venice), and Venice locks a key out for 30 seconds after 50 non-success
 * responses. So requests are paced client-side rather than retried into a 429
 * wall, and retries are few.
 */

import type { LLMConfig } from './types.js'

const DEFAULT_TIMEOUT_MS = 60_000

/** Venice allows 100/min; stay under it so a concurrent caller has headroom. */
const DEFAULT_REQUESTS_PER_MINUTE = 90

export interface DecisionScoreQuestion {
  type: 'score'
  instructions: string
  /** Ordered level descriptions, lowest first (2 to 10 levels). */
  criteria: string[]
}

export interface DecisionScoreAnswer {
  type: 'score'
  /** Probability-weighted level index, 0 .. levels-1. */
  score: number
  confidence: number
  /** Level index (as a string) → probability. */
  probabilities: Record<string, number>
  legend: Record<string, string>
}

export interface DecisionResponse {
  model: string
  answers: Record<string, DecisionScoreAnswer>
  usage?: { input_tokens: number; output_tokens: number }
}

export interface DecisionRequest {
  state: string | Record<string, unknown> | unknown[]
  questions: Record<string, DecisionScoreQuestion>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Spaces request *starts* at least `60s / rpm` apart.
 *
 * A token bucket would allow a burst of 100 and then stall; even spacing
 * never trips the per-minute window, which matters more here than latency
 * because every 429 counts toward the provider's lockout.
 */
export function createPacer(requestsPerMinute = DEFAULT_REQUESTS_PER_MINUTE): () => Promise<void> {
  const interval = 60_000 / Math.max(1, requestsPerMinute)
  let next = 0
  return async () => {
    const now = Date.now()
    const slot = Math.max(now, next)
    next = slot + interval
    if (slot > now) await sleep(slot - now)
  }
}

/**
 * One call to `POST {apiBaseUrl}/decisions`.
 *
 * Throws with the status in the message so the caller can tell a 429 from a
 * schema change (400), which on a beta endpoint is the failure to expect.
 */
export async function decisionCompletion(
  config: LLMConfig,
  request: DecisionRequest
): Promise<DecisionResponse> {
  const url = `${config.apiBaseUrl}/decisions`
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, ...request }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
      throw new Error(`Decision API timed out after ${timeoutMs}ms`)
    }
    throw err
  }

  if (!res.ok) {
    const errorBody = await res.text()
    const error = new Error(`Decision API error (${res.status}): ${errorBody.slice(0, 500)}`) as Error & {
      status?: number
      retryAfterMs?: number
    }
    error.status = res.status
    const retryAfter = Number(res.headers.get('retry-after'))
    if (retryAfter > 0) error.retryAfterMs = retryAfter * 1000
    throw error
  }

  const data = (await res.json()) as DecisionResponse
  if (!data.answers || typeof data.answers !== 'object') {
    throw new Error('Decision API returned no answers')
  }
  return data
}

/**
 * `decisionCompletion` with pacing and a short retry.
 *
 * Only 429s, 5xx and network errors are retried. A 400 means the request
 * shape was refused, and asking again will not change that.
 */
export async function decisionCompletionWithRetry(
  config: LLMConfig,
  request: DecisionRequest,
  pace: () => Promise<void>,
  maxAttempts = 3
): Promise<DecisionResponse> {
  let lastErr: Error | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await pace()
    try {
      return await decisionCompletion(config, request)
    } catch (err) {
      lastErr = err as Error
      const status = (err as { status?: number }).status
      const retryable = status === undefined || status === 429 || status >= 500
      if (!retryable || attempt === maxAttempts) break
      // A 429 here means someone else is spending the same key's budget, so
      // wait out a real fraction of the window instead of hammering it.
      const delay =
        (err as { retryAfterMs?: number }).retryAfterMs ??
        (status === 429 ? 15_000 * attempt : 2000 * attempt)
      console.warn(
        `Decision call failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`,
        lastErr.message
      )
      await sleep(delay)
    }
  }
  throw lastErr
}
