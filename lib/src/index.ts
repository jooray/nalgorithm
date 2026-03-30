/**
 * Nalgorithm — Nostr Relevance Library
 *
 * Rank your Nostr timeline by what matters to you.
 *
 * @module nalgorithm
 */

export { createFetcher, pubkeyToHex } from './fetcher.js'
export { createRanker, sortByRelevance } from './ranker.js'
export { createLearner } from './learner.js'
export { chatCompletion, chatCompletionWithRetry } from './llm.js'

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

  // Nostr
  NostrEvent,
} from './types.js'
