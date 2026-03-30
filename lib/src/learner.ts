/**
 * Nalgorithm — Learner module
 *
 * Analyzes a user's liked posts and generates a "learned prompt"
 * summarizing their interests and preferences.
 */

import { chatCompletionWithRetry } from './llm.js'
import type { LearnerConfig, Learner, LikedPostContent, LLMConfig } from './types.js'

/**
 * Strip nostr: references from content for cleaner input.
 */
function stripNostrRefs(content: string): string {
  return content.replace(/nostr:n(event|ote|pub|profile|addr)1[a-z0-9]+/gi, '').trim()
}

/**
 * Truncate text.
 */
function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\n+/g, ' ').trim()
  if (clean.length <= maxLen) return clean
  return clean.slice(0, maxLen) + '...'
}

/**
 * Build the prompt for summarizing liked posts.
 */
function buildSummarizationPrompt(posts: LikedPostContent[]): string {
  const postList = posts
    .map((p, i) => `${i + 1}. "${truncate(stripNostrRefs(p.content), 300)}"`)
    .join('\n')

  return `Analyze these Nostr posts that a user has liked/reacted positively to. Based on these posts, summarize the user's interests, preferences, and the types of content they engage with.

Be specific about:
- Topics they care about
- Tone and style they prefer (philosophical, technical, casual, etc.)
- Types of content (longform, short thoughts, links, media, etc.)
- Any recurring themes

Write 2-4 concise sentences. Do not list the posts back. Just describe the user's taste.

Liked posts:
${postList}

Summary:`
}

/**
 * Create a Learner instance.
 */
export function createLearner(config: LearnerConfig): Learner {
  const llmConfig: LLMConfig = {
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    model: config.model,
  }

  async function summarizeLikes(likedPosts: LikedPostContent[]): Promise<string> {
    if (likedPosts.length === 0) {
      return ''
    }

    // Use at most 100 posts to avoid exceeding context limits
    const postsToAnalyze = likedPosts.slice(0, 100)

    const prompt = buildSummarizationPrompt(postsToAnalyze)

    try {
      const response = await chatCompletionWithRetry(llmConfig, [
        {
          role: 'system',
          content:
            'You are an analyst that summarizes user preferences based on their social media engagement. Be concise and specific. Output only the summary text, no JSON, no markdown formatting.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ])

      return response.trim()
    } catch (err) {
      console.warn('Failed to summarize likes:', (err as Error).message)
      return ''
    }
  }

  return { summarizeLikes }
}
