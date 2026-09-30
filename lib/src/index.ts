/**
 * Nalgorithm — Nostr Relevance Library
 *
 * Rank your Nostr timeline by what matters to you.
 *
 * @module nalgorithm
 */

export { createFetcher, pubkeyToHex, parseProfileEvents } from './fetcher.js'
export { sanitizeRelayUrl, isAcceptableRelayUrl } from './relay-url.js'
export { collectPostPubkeys, extractReferencedPubkeys, MAX_PROFILE_PUBKEYS } from './pubkeys.js'
export {
  createRanker,
  sortByRelevance,
  scoreCacheKey,
  buildDecisionRequest,
  DECISION_RUBRIC,
} from './ranker.js'
export { decisionCompletion, decisionCompletionWithRetry, createPacer } from './decision.js'
export type { DecisionRequest, DecisionResponse, DecisionScoreAnswer, DecisionScoreQuestion } from './decision.js'
export { createLearner } from './learner.js'
export { chatCompletion, chatCompletionWithRetry, chatCompletionStream } from './llm.js'
export { synthesizeSpeech, splitTextForTTS, DEFAULT_TTS_MAX_CHARS } from './tts.js'
export {
  humanizeText,
  buildHumanizeMessages,
  HUMANIZER_SKILL,
  HUMANIZER_SKILL_VERSION,
} from './humanizer.js'
export type { HumanizeOptions } from './humanizer.js'
export {
  generateDigest,
  buildDigestMessages,
  digestSourceNotes,
  FAITHFULNESS_RULES,
  SPOKEN_SIGN_OFF,
  DIGEST_NOTE_MAX_CHARS,
  buildDigestSystemPrompt,
  formatPostForDigest,
  DEFAULT_DIGEST_SYSTEM_PROMPT,
  DEFAULT_DIGEST_PROMPT,
  HUMANIZER_APPENDIX,
  SPEECH_APPENDIX,
} from './digest.js'
export type { DigestOptions } from './digest.js'
export type { SynthesizeOptions } from './tts.js'
export {
  evolveLearnedPrompt,
  refreshLearnedPrompt,
  scorePostsCached,
  writeDigest,
  silentLogger,
} from './pipeline.js'
export type {
  CachedScore,
  LearnedState,
  PipelineStore,
  PipelineLogger,
  RefreshLearnedOptions,
  ScoreCachedOptions,
  ScoreCachedInput,
  DigestModel,
  WriteDigestOptions,
} from './pipeline.js'

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
  DigestSourceNote,
  ScoreOptions,
  DebugEntry,
  ScorerKind,
  DecisionShape,

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
