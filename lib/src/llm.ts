/**
 * Nalgorithm — Generic OpenAI-compatible chat completion helper
 */

import type { ChatMessage, LLMConfig } from './types.js'
import { ProviderBusy, withProviderSlot } from './provider-budget.js'

/** Fail a stalled request rather than hanging a scheduled run forever. */
const DEFAULT_TIMEOUT_MS = 120_000

export class ProviderError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs = 0) { super(message); this.name = 'ProviderError' }
  get retryable(): boolean { return this.status === 429 || this.status >= 500 }
}
export function providerHeaders(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey}` } : {}) }
}
function responseError(res: Response): ProviderError {
  const hint = res.status === 401 || res.status === 403 ? 'Check your model API key and permissions.' : res.status === 400 || res.status === 404 ? 'Check the model name and API endpoint.' : res.status === 429 ? 'The model provider is rate-limiting requests.' : 'The model provider is temporarily unavailable.'
  return new ProviderError(res.status, `Model request failed (${res.status}). ${hint}`, Math.min(60_000, Math.max(0, Number(res.headers.get('retry-after')) * 1000 || 0)))
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string
    }
    finish_reason: string
  }>
}

/**
 * Call an OpenAI-compatible chat completions endpoint.
 *
 * @param config - API base URL, key, and model name
 * @param messages - Array of chat messages (system/user/assistant)
 * @param jsonMode - Request JSON response format (default: false)
 * @param temperature - Sampling temperature (default: 0.3)
 * @returns The assistant's response content string
 */
async function chatCompletionRaw(
  config: LLMConfig,
  messages: ChatMessage[],
  jsonMode = false,
  temperature = 0.3
): Promise<string> {
  const url = `${config.apiBaseUrl}/chat/completions`

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature,
  }

  // Only sent when configured — models without reasoning-effort support reject
  // or ignore the field, so an unset value must not appear in the request.
  if (config.reasoningEffort) {
    body.reasoning_effort = config.reasoningEffort
  }

  if (jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: providerHeaders(config.apiKey),
      body: JSON.stringify(body),
      signal: config.signal ? AbortSignal.any([config.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    // Surface a timeout as a normal error so the retry path can handle it,
    // rather than letting the call hang indefinitely.
    if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
      throw new Error(`LLM API timed out after ${timeoutMs}ms`)
    }
    throw err
  }

  if (!res.ok) {
    await res.body?.cancel()
    throw responseError(res)
  }

  const data = (await res.json()) as ChatCompletionResponse

  if (!data.choices?.[0]?.message?.content) {
    throw new Error('LLM API returned empty response')
  }

  return data.choices[0].message.content
}

export function chatCompletion(config: LLMConfig, messages: ChatMessage[], jsonMode = false, temperature = 0.3): Promise<string> {
  return withProviderSlot(config, () => chatCompletionRaw(config, messages, jsonMode, temperature))
}

/**
 * Call an OpenAI-compatible chat completions endpoint with streaming.
 *
 * Calls `onDelta` with each text fragment as it arrives and resolves with the
 * assembled result. Worth the extra code for anything a person waits on: a
 * digest takes tens of seconds, and without streaming there is no way to tell a
 * working request from a hung one.
 *
 * @param onDelta - Receives each fragment of content as it arrives.
 */
async function chatCompletionStreamRaw(
  config: LLMConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  temperature = 0.5
): Promise<string> {
  const url = `${config.apiBaseUrl}/chat/completions`

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature,
    stream: true,
  }
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort

  // For a stream this is an *idle* timeout, not a total-duration one: it resets
  // on every chunk. A digest can legitimately run for minutes, and killing a
  // healthy stream because the whole generation outlasted a fixed budget is
  // exactly the wrong behaviour. What we actually want to catch is a stall.
  const idleMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  // Guards the request up to response headers; once the body is streaming,
  // readWithIdleLimit takes over per-chunk.
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, idleMs)
  }
  const clearIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
  }

  let full = ''

  try {
    resetIdle()

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: providerHeaders(config.apiKey),
        body: JSON.stringify(body),
        signal: config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal,
      })
    } catch (err) {
      if (timedOut) throw new Error(`LLM API sent nothing for ${idleMs}ms`)
      throw err
    }

    if (!res.ok) {
      await res.body?.cancel()
      throw responseError(res)
    }
    if (!res.body) throw new Error('LLM API returned no response body')

    clearIdle()

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    /**
     * Read one chunk, giving up if nothing arrives within the idle budget.
     *
     * The timer is raced against the read rather than left to the abort signal:
     * aborting a fetch is *supposed* to error its body stream, but making
     * stall detection depend on that is depending on someone else's plumbing.
     * Racing makes it explicit and deterministic. The abort still fires, to
     * release the connection.
     */
    const readWithIdleLimit = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(
            new Error(
              full
                ? `LLM stream stalled for ${idleMs}ms after ${full.length} characters`
                : `LLM API sent nothing for ${idleMs}ms`
            )
          )
        }, idleMs)
      })
      try {
        return await Promise.race([reader.read(), stalled])
      } catch (err) {
        // A propagated abort arrives as a bare DOMException whose message
        // ("The operation timed out.") says nothing about what timed out.
        if (timedOut && !/stalled|sent nothing/.test((err as Error).message)) {
          throw new Error(
            full
              ? `LLM stream stalled for ${idleMs}ms after ${full.length} characters`
              : `LLM API sent nothing for ${idleMs}ms`
          )
        }
        throw err
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    for (;;) {
      const chunk = await readWithIdleLimit()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      // Server-sent events are separated by blank lines; a chunk can split one,
      // so keep the trailing partial in the buffer.
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''

      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>
            }
            const piece = parsed.choices?.[0]?.delta?.content
            if (piece) {
              full += piece
              onDelta(piece)
            }
          } catch {
            // A malformed frame is not worth aborting a good stream over.
          }
        }
      }
    }
  } finally {
    clearIdle()
  }

  if (!full) throw new Error('LLM API returned empty response')
  return full
}

export function chatCompletionStream(config: LLMConfig, messages: ChatMessage[], onDelta: (text: string) => void, temperature = 0.5): Promise<string> {
  return withProviderSlot(config, () => chatCompletionStreamRaw(config, messages, onDelta, temperature))
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Call chatCompletion with exponential-backoff retries.
 * Retries on any error (network, 429, 500, etc.) up to maxAttempts times.
 */
export async function chatCompletionWithRetry(
  config: LLMConfig,
  messages: ChatMessage[],
  jsonMode = false,
  maxAttempts = 3,
  baseDelayMs = 2000,
  temperature = 0.3
): Promise<string> {
  let lastErr: Error | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    config.signal?.throwIfAborted()
    try {
      return await chatCompletion(config, messages, jsonMode, temperature)
    } catch (err) {
      lastErr = err as Error
      if ((err instanceof ProviderError && !err.retryable) || err instanceof ProviderBusy) break
      if (attempt < maxAttempts) {
        const delay = err instanceof ProviderError && err.retryAfterMs ? err.retryAfterMs : baseDelayMs * Math.pow(2, attempt - 1)
        console.warn(`LLM call failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`, lastErr.message)
        await sleep(delay)
      }
    }
  }
  throw lastErr
}
