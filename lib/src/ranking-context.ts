import { getEventHash } from 'nostr-tools/pure'

/** A SHA-256 content fingerprint; no event is signed or published. Never includes API keys. */
export function fingerprint(value: unknown): string {
  return getEventHash({ pubkey: '0'.repeat(64), kind: 1, created_at: 0, tags: [], content: JSON.stringify(value) })
}

/** Learned taste evolves prospectively. Explicit policy/model changes invalidate existing scores. */
export function rankingContext(input: { userPrompt: string; model: string; scorer?: string; apiBaseUrl?: string; learnFromLikes?: boolean }): string {
  return fingerprint(['ranking-v2', input.userPrompt.trim(), input.scorer ?? 'chat', input.model.trim(), input.apiBaseUrl?.replace(/\/+$/, '') ?? '', input.learnFromLikes !== false])
}

export function contextualScoreKey(id: string, context?: string): string {
  return context ? fingerprint([context, id]) : id
}
