/**
 * Nalgorithm — Generic OpenAI-compatible chat completion helper
 */

import type { ChatMessage, LLMConfig } from './types.js'

/** Fail a stalled request rather than hanging a scheduled run forever. */
const DEFAULT_TIMEOUT_MS = 120_000

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
export async function chatCompletion(
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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
    const errorBody = await res.text()
    throw new Error(`LLM API error (${res.status}): ${errorBody}`)
  }

  const data = (await res.json()) as ChatCompletionResponse

  if (!data.choices?.[0]?.message?.content) {
    throw new Error('LLM API returned empty response')
  }

  return data.choices[0].message.content
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
export async function chatCompletionStream(
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

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const name = (err as Error).name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`LLM API timed out after ${timeoutMs}ms`)
    }
    throw err
  }

  if (!res.ok) {
    const errorBody = await res.text()
    throw new Error(`LLM API error (${res.status}): ${errorBody}`)
  }
  if (!res.body) throw new Error('LLM API returned no response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

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

  if (!full) throw new Error('LLM API returned empty response')
  return full
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
    try {
      return await chatCompletion(config, messages, jsonMode, temperature)
    } catch (err) {
      lastErr = err as Error
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1) // 2s, 4s
        console.warn(`LLM call failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`, lastErr.message)
        await sleep(delay)
      }
    }
  }
  throw lastErr
}
