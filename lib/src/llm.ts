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
 * @returns The assistant's response content string
 */
export async function chatCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
  jsonMode = false
): Promise<string> {
  const url = `${config.apiBaseUrl}/chat/completions`

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.3,
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
 * Call chatCompletion with a single retry on failure.
 */
export async function chatCompletionWithRetry(
  config: LLMConfig,
  messages: ChatMessage[],
  jsonMode = false
): Promise<string> {
  try {
    return await chatCompletion(config, messages, jsonMode)
  } catch (err) {
    console.warn('LLM call failed, retrying once:', (err as Error).message)
    return await chatCompletion(config, messages, jsonMode)
  }
}
