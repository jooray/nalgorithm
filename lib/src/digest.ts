/**
 * Nalgorithm — digest generation
 *
 * Turns a set of scored posts into a spoken-word narrative. Lives in the
 * library rather than the CLI so the web app and the digest tool share one
 * set of prompts — in particular the humanizer rules, which are the kind of
 * thing that silently drifts apart when copied.
 */

import { chatCompletionWithRetry } from './llm.js'
import { sortByRelevance } from './ranker.js'
import type { ChatMessage, LLMConfig, ProfileData, ScoredPost } from './types.js'

export const DEFAULT_DIGEST_SYSTEM_PROMPT = `You are a witty, knowledgeable radio host delivering a spoken-word digest of what happened on Nostr in the last 24 hours. Always open with "Good morning, nostrich!" Your style is conversational, warm, and engaging — like a smart friend catching you up over coffee. You weave posts together into a narrative rather than reading them one by one. Add context, make connections between topics, and keep the energy up. Aim for 5-10 minutes of spoken content (roughly 1000-2000 words).`

export const DEFAULT_DIGEST_PROMPT = `Create a spoken-word radio digest from these top Nostr posts. Group related topics together, add transitions, and make it flow naturally as if someone is listening to it being read aloud. Don't just list posts — tell the story of what happened today. Include attribution (mention who said what) but keep it natural. Skip any posts that are too short or low-quality to be worth mentioning.`

/**
 * Humanizer rules — always appended to the system prompt.
 * Prevents the most common AI writing tells in voice output.
 * Based on https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
 */
export const HUMANIZER_APPENDIX = `
WRITING STYLE (mandatory — apply before finalizing):
- No significance inflation: avoid "pivotal", "testament", "evolving landscape", "underscores", "enduring"
- No promotional language: avoid "groundbreaking", "vibrant", "stunning", "nestled", "breathtaking"
- No vague attributions: avoid "experts believe", "observers note", "industry reports suggest"
- No superficial -ing phrases tacked on for fake depth: avoid "highlighting...", "showcasing...", "reflecting...", "contributing to..."
- No em dash overuse — prefer commas or short sentences
- No staccato "Not X. Not Y." contrast pattern
- No copula avoidance: use "is"/"are" instead of "serves as", "stands as", "functions as"
- No filler: cut "In order to", "At this point in time", "It is important to note that"
- No generic upbeat conclusions: avoid "the future looks bright", "exciting times ahead", "continuing this journey"
- No rule of three where it feels forced
- Vary sentence length. Short punchy ones. Then longer ones that take their time. Mix them.
- Have opinions. React to things. Be specific rather than vague.`

/**
 * Extra instructions for output that goes straight into a speech engine.
 * Opt-in, because a digest meant to be read on screen wants markdown and
 * real version numbers.
 */
export const SPEECH_APPENDIX = `

SPOKEN OUTPUT (this will be read aloud by a text-to-speech engine):
- Output ONLY plain text. No markdown, no headers, no bullet points, no asterisks.
- Spell out version numbers: "one dot five dot three" not "1.5.3"
- Spell out abbreviations on first use: "N I P nineteen" not "NIP-19"
- Write URLs as spoken descriptions: "on their GitHub" not "github.com/foo/bar"
- No hashtags, no emoji, no special unicode characters.
- Use short paragraphs separated by blank lines as natural pause points.`

/**
 * Compose the final system prompt.
 *
 * The humanizer rules are always appended, whether the caller supplied a custom
 * prompt or not — they are corrections to how these models write by default,
 * not a stylistic preference the caller should have to remember to include.
 */
export function buildDigestSystemPrompt(custom?: string, forSpeech = false): string {
  return (custom ?? DEFAULT_DIGEST_SYSTEM_PROMPT) + HUMANIZER_APPENDIX + (forSpeech ? SPEECH_APPENDIX : '')
}

function resolveAuthorName(pubkey: string, profiles?: Map<string, ProfileData>): string {
  const profile = profiles?.get(pubkey)
  if (profile?.name) return profile.name
  return pubkey.slice(0, 8) + '...'
}

/**
 * Format one scored post for the digest prompt.
 *
 * Includes the score and the ranker's justification so the writing model knows
 * which posts matter and why, rather than treating the list as flat.
 */
export function formatPostForDigest(
  post: ScoredPost,
  index: number,
  profiles?: Map<string, ProfileData>
): string {
  const authorName = resolveAuthorName(post.author, profiles)
  const justification = post.justification ?? ''
  const time = new Date(post.createdAt * 1000).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  let content: string
  if (post.type === 'boost' && post.originalPost) {
    const origAuthor = resolveAuthorName(post.originalPost.author, profiles)
    content = `[Boosted by ${authorName}] Originally by ${origAuthor}: ${post.originalPost.content}`
  } else if (post.type === 'quote' && post.quotedPost) {
    const quotedAuthor = resolveAuthorName(post.quotedPost.author, profiles)
    content = `${authorName} quoted ${quotedAuthor}: "${post.content}" — Original: "${post.quotedPost.content}"`
  } else {
    content = `${authorName}: ${post.content}`
  }

  if (content.length > 800) {
    content = content.slice(0, 800) + '...'
  }

  return `${index + 1}. [Score: ${post.score}/10, ${time}] ${content}${justification ? `\n   Relevance: ${justification}` : ''}`
}

export interface DigestOptions {
  /** Scored posts. Sorted and trimmed to `topN` internally. */
  posts: ScoredPost[]
  /** Profile metadata, for author names instead of hex prefixes. */
  profiles?: Map<string, ProfileData>
  /** The user's own interest description. */
  userPrompt: string
  /** Learned preferences, if any. */
  learnedPrompt?: string
  /** Override the built-in system prompt. Humanizer rules are appended regardless. */
  systemPrompt?: string
  /** Override the built-in instruction block. */
  digestPrompt?: string
  /** How many top posts to include (default: 15). */
  topN?: number
  /** Append the text-to-speech instructions (default: false). */
  forSpeech?: boolean
  /** Sampling temperature (default: 0.5). */
  temperature?: number
}

/** Build the chat messages for a digest run, without sending them. */
export function buildDigestMessages(options: DigestOptions): ChatMessage[] {
  const topN = options.topN ?? 15
  const topPosts = sortByRelevance(options.posts).slice(0, topN)

  const postsBlock = topPosts
    .map((post, i) => formatPostForDigest(post, i, options.profiles))
    .join('\n\n')

  const userMessage = `${options.digestPrompt ?? DEFAULT_DIGEST_PROMPT}

=== User's Interests ===
${options.userPrompt}
${options.learnedPrompt ? `\n=== Learned Preferences ===\n${options.learnedPrompt}` : ''}

=== Top ${topPosts.length} Posts (ranked by relevance) ===

${postsBlock}`

  return [
    { role: 'system', content: buildDigestSystemPrompt(options.systemPrompt, options.forSpeech) },
    { role: 'user', content: userMessage },
  ]
}

/**
 * Generate a digest from scored posts.
 *
 * @param config - The LLM to write with. Usually a stronger model than the one
 *                 used for scoring, since this runs once over ~15 posts.
 */
export async function generateDigest(config: LLMConfig, options: DigestOptions): Promise<string> {
  if (options.posts.length === 0) {
    throw new Error('Nothing to summarize — no scored posts')
  }
  const messages = buildDigestMessages(options)
  return chatCompletionWithRetry(config, messages, false, 3, 2000, options.temperature ?? 0.5)
}
