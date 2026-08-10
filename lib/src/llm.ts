/**
 * Nalgorithm — Generic OpenAI-compatible chat completion helper
 */

import type { ChatMessage, LLMConfig } from './types.js'

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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  })

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
