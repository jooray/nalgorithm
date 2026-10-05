/**
 * Private reader feedback on single notes ("more like this" / "less like this").
 *
 * It is explicit, so it applies whether or not learning from likes is on. It
 * travels with the learned preferences rather than the written interests: like
 * them it steers future scores without invalidating the scores already cached.
 */

export interface FeedbackRule {
  kind: 'more' | 'less'
  /** A short excerpt of the note the reader reacted to. */
  excerpt: string
}

/** How many rules reach the model, newest first; older ones stay listed but stop steering. */
export const FEEDBACK_RULES_MAX = 20
export const FEEDBACK_EXCERPT_MAX = 200

/** The rules as a prompt block, or '' when there are none. */
export function feedbackPrompt(rules: readonly FeedbackRule[]): string {
  const lines = rules
    .slice(0, FEEDBACK_RULES_MAX)
    .map((r) => {
      const excerpt = r.excerpt.replace(/\s+/g, ' ').trim().slice(0, FEEDBACK_EXCERPT_MAX)
      return excerpt ? `- ${r.kind === 'more' ? 'More like this' : 'Less like this'}: "${excerpt}"` : ''
    })
    .filter(Boolean)
  if (lines.length === 0) return ''
  return [
    '=== Private feedback on specific notes ===',
    'The reader marked these notes. Score similar notes accordingly; their written interests still come first.',
    ...lines,
  ].join('\n')
}

/** Learned preferences with the feedback block after them; undefined when both are empty. */
export function withFeedback(learnedPrompt: string | undefined, rules: readonly FeedbackRule[]): string | undefined {
  const block = feedbackPrompt(rules)
  const parts = [learnedPrompt?.trim() ?? '', block].filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}
