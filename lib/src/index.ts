/**
 * Nalgorithm — Nostr Relevance Library
 *
 * Rank your Nostr timeline by what matters to you.
 *
 * @module nalgorithm
 */

export { createFetcher, pubkeyToHex } from './fetcher.js'
export { createRanker, sortByRelevance, scoreCacheKey } from './ranker.js'
export { createLearner } from './learner.js'
export { chatCompletion, chatCompletionWithRetry, chatCompletionStream } from './llm.js'
export { synthesizeSpeech, splitTextForTTS, DEFAULT_TTS_MAX_CHARS } from './tts.js'
export {
  generateDigest,
  buildDigestMessages,
  buildDigestSystemPrompt,
  formatPostForDigest,
  DEFAULT_DIGEST_SYSTEM_PROMPT,
  DEFAULT_DIGEST_PROMPT,
  HUMANIZER_APPENDIX,
  SPEECH_APPENDIX,
} from './digest.js'
export type { DigestOptions } from './digest.js'
export type { SynthesizeOptions } from './tts.js'

export type {
  // Config
  NalgorithmConfig,
  FetcherConfig,
  RankerConfig,
  LearnerConfig,
  LLMConfig,

  // Fetcher
  Fetcher,
  FetchedPost,
  FetchPostsOptions,
  FetchLikesOptions,
  LikedPostContent,
  EmbeddedPost,
  PostType,

  // Ranker
  Ranker,
  ScoredPost,
  ScoreOptions,
  DebugEntry,

  // Learner
  Learner,

  // Profile
  ProfileData,

  // LLM
  ChatMessage,
  ReasoningEffort,

  // TTS
  TTSConfig,
  TTSFormat,

  // Nostr
  NostrEvent,
} from './types.js'
