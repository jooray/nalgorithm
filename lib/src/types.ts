/**
 * Nalgorithm — shared types
 */

import type { Event as NostrEvent } from 'nostr-tools/pure'

// ─── Configuration ───────────────────────────────────────────────────────────

export interface NalgorithmConfig {
  /** Relay WebSocket URLs */
  relays: string[]
  /** OpenAI-compatible API base URL (e.g. "https://api.venice.ai/api/v1") */
  apiBaseUrl: string
  /** API key for the LLM endpoint */
  apiKey: string
  /** Model name (e.g. "grok-3-mini") */
  model: string
  /** Posts per LLM scoring batch (default: 20) */
  batchSize?: number
}

export interface FetcherConfig {
  /** Relay WebSocket URLs */
  relays: string[]
}

export interface RankerConfig {
  /** OpenAI-compatible API base URL */
  apiBaseUrl: string
  /** API key */
  apiKey: string
  /** Model name */
  model: string
  /**
   * Reasoning budget, for models that support it. Scoring is a high-volume,
   * low-difficulty job, so `low` (or `none`) keeps latency and cost down.
   */
  reasoningEffort?: ReasoningEffort
  /** Posts per batch (default: 20) */
  batchSize?: number
  /**
   * Send `response_format: {type: 'json_object'}` with scoring calls
   * (default: **false**).
   *
   * Off by default because the mode requires a top-level *object* while the
   * scoring prompt asks for an *array*, so models are pulled two ways and drift
   * into wrapper shapes — or, on reasoning models, leak their `<think>` block
   * into the JSON and destroy the batch.
   *
   * Measured on Venice over 5 runs of a 20-post batch, counting runs where all
   * 20 posts were scored:
   *
   * | Model                              | JSON mode on | off |
   * |------------------------------------|-------------:|----:|
   * | `deepseek-v4-flash` (0423)         |          4/5 | 5/5 |
   * | `deepseek-v4-flash-0731` + `low`   |          0/5 | 5/5 |
   * | `google-gemma-3-27b-it`            |          5/5 | 5/5 |
   *
   * Never better on, sometimes catastrophically worse. The prose- and
   * fence-tolerance that JSON mode used to provide now lives in the response
   * parser instead. Set true only if a specific provider needs it.
   */
  jsonMode?: boolean
  /**
   * Number of batches to score in parallel (default: 1 = sequential).
   *
   * Runs as a worker pool, so this many requests stay in flight for the whole
   * run rather than moving in lockstep. There is no imposed ceiling — pick a
   * value your provider's rate limits will tolerate.
   */
  concurrency?: number
}

export interface LearnerConfig {
  /** OpenAI-compatible API base URL */
  apiBaseUrl: string
  /** API key */
  apiKey: string
  /** Model name */
  model: string
}

// ─── Fetcher types ───────────────────────────────────────────────────────────

export type PostType = 'original' | 'quote' | 'boost'

export interface EmbeddedPost {
  /** Event ID (hex) */
  id: string
  /** Author pubkey (hex) */
  author: string
  /** Text content */
  content: string
}

export interface FetchedPost {
  /** Event ID (hex) */
  id: string
  /** Classification of the post */
  type: PostType
  /** Pubkey of the follow who posted/boosted/quoted (hex) */
  author: string
  /** Text content of the post */
  content: string
  /** Unix timestamp (seconds) */
  createdAt: number
  /** For quote posts: the embedded/mentioned post */
  quotedPost?: EmbeddedPost
  /** For boosts: the original reposted content */
  originalPost?: EmbeddedPost
  /** The raw Nostr event */
  rawEvent: NostrEvent
}

export interface FetchPostsOptions {
  /** How many hours back to fetch (default: 24) */
  hoursBack?: number
  /** Maximum number of posts to return (default: 500) */
  maxPosts?: number
}

export interface FetchLikesOptions {
  /** Maximum number of likes to fetch (default: 200) */
  limit?: number
  /** Only include likes created after this Unix timestamp (seconds) */
  since?: number
}

// ─── Ranker types ────────────────────────────────────────────────────────────

export interface ScoredPost extends FetchedPost {
  /** Relevance score from LLM (0-10) */
  score: number
  /** Short justification from the LLM explaining the score */
  justification?: string
  /** True if the LLM failed and this post got the fallback score (5) */
  defaultScore?: boolean
}

export interface ScoreOptions {
  /** User-supplied prompt describing interests */
  userPrompt: string
  /** Auto-generated prompt from liked posts (may be empty) */
  learnedPrompt?: string
  /** Profile data for resolving author display names in prompts */
  profiles?: Map<string, ProfileData>
  /** If provided, debug info (raw LLM responses, errors) will be pushed here */
  debug?: DebugEntry[]
  /** Called after each batch completes with (scoredSoFar, totalPosts) */
  onProgress?: (scored: number, total: number) => void
}

export interface DebugEntry {
  /** Which batch (0-indexed) this came from */
  batch: number
  /** The raw LLM response string */
  rawResponse?: string
  /** Validation error message if any */
  error?: string
  /** Number of posts in this batch */
  postCount: number
  /** Number of posts that got real scores (not default) */
  scoredCount: number
}

// ─── Learner types ───────────────────────────────────────────────────────────

export interface LikedPostContent {
  /** Event ID of the liked post */
  id: string
  /** Text content of the liked post */
  content: string
  /** Author pubkey of the liked post */
  author: string
}

// ─── Profile types ───────────────────────────────────────────────────────────

export interface ProfileData {
  /** Hex pubkey */
  pubkey: string
  /** Display name (from profile metadata) */
  name?: string
  /** Profile picture URL */
  picture?: string
  /** NIP-05 identifier */
  nip05?: string
}

// ─── LLM types ───────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Reasoning budget for models that support it.
 *
 * Sent as OpenAI's `reasoning_effort`. Venice honours it on models whose
 * `supportsReasoningEffort` is true (e.g. `deepseek-v4-flash-0731`, which
 * otherwise defaults to `high`); models without support ignore the field.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max'

export interface LLMConfig {
  apiBaseUrl: string
  apiKey: string
  model: string
  /** Omitted from the request entirely when unset, so non-supporting models are unaffected. */
  reasoningEffort?: ReasoningEffort
  /**
   * Abort a request that produces no response within this many milliseconds
   * (default: 120000).
   *
   * `fetch` has no timeout of its own: a connection the provider accepts and
   * then stalls on will hang forever. In a scheduled run that is worse than an
   * error, because a `Type=oneshot` unit stays "activating" and systemd skips
   * every subsequent trigger.
   */
  timeoutMs?: number
}

// ─── TTS types ───────────────────────────────────────────────────────────────

/** Audio container requested from the `/audio/speech` endpoint. */
export type TTSFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'

export interface TTSConfig {
  /** OpenAI-compatible API base URL (e.g. "https://api.venice.ai/api/v1") */
  apiBaseUrl: string
  /** API key for the TTS endpoint */
  apiKey: string
  /** Model name (e.g. "tts-kokoro") */
  model: string
  /** Voice id, provider-specific (e.g. "af_sky" on Venice's Kokoro) */
  voice?: string
  /** Playback rate multiplier (default: provider's own, usually 1.0) */
  speed?: number
  /** Output format (default: "mp3" — the only one safe to join across chunks) */
  format?: TTSFormat
  /**
   * Maximum characters per request (default: 4096, Venice's limit).
   * Longer text is split on natural boundaries and the audio is joined.
   */
  maxChars?: number
  /** Abort a chunk that produces no response within this many ms (default: 180000). */
  timeoutMs?: number
}

// ─── Fetcher interface ───────────────────────────────────────────────────────

export interface Fetcher {
  /** Get the list of pubkeys a user follows (from kind 3) */
  getFollows(pubkey: string): Promise<string[]>
  /** Fetch posts from followed users, classified and with resolved embeds */
  getPosts(follows: string[], options?: FetchPostsOptions): Promise<FetchedPost[]>
  /** Fetch the user's liked posts' content */
  getLikes(pubkey: string, options?: FetchLikesOptions): Promise<LikedPostContent[]>
  /** Fetch profile metadata (kind 0) for a list of pubkeys */
  getProfiles(pubkeys: string[]): Promise<Map<string, ProfileData>>
  /** Close all relay connections */
  destroy(): void
}

// ─── Ranker interface ────────────────────────────────────────────────────────

export interface Ranker {
  /** Score an array of posts using the LLM */
  score(posts: FetchedPost[], options: ScoreOptions): Promise<ScoredPost[]>
}

// ─── Learner interface ───────────────────────────────────────────────────────

export interface Learner {
  /** Summarize liked post contents into a learned preference prompt */
  summarizeLikes(likedPosts: LikedPostContent[]): Promise<string>
}

// ─── Utility ─────────────────────────────────────────────────────────────────

export { NostrEvent }
