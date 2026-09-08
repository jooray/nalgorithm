/**
 * Nalgorithm — humanizer pass
 *
 * A second LLM call over the finished digest that rewrites out the tells of AI
 * writing. The digest prompt already carries a short rules appendix
 * (`HUMANIZER_APPENDIX` in digest.ts), but rules in a system prompt compete with
 * everything else the writer is being asked to do; a dedicated editing pass on
 * text that already exists is a different, easier job.
 *
 * The prompt is the humanizer skill from github.com/jooray/humanizer, vendored
 * at lib/skills/humanizer/SKILL.md. See that directory's README before changing
 * anything here.
 */

import { chatCompletionWithRetry } from './llm.js'
import { HUMANIZER_SKILL } from './humanizer-skill.generated.js'
import type { ChatMessage, LLMConfig } from './types.js'

export { HUMANIZER_SKILL }

/** Version of the vendored humanizer skill, for logs and diagnostics. */
export const HUMANIZER_SKILL_VERSION = HUMANIZER_SKILL.version

/**
 * Constraints the skill does not know about.
 *
 * The skill is written for prose on a page. A spoken digest has already been
 * stripped of markdown, digits and abbreviations for the speech engine, and a
 * rewrite that puts them back produces audio that reads out asterisks.
 */
const SPEECH_CONSTRAINTS = `
This text is about to be read aloud by a speech engine, so the rewrite must stay speakable:
- Plain text only. No markdown, no headings, no bullet points, no asterisks, no emoji.
- Keep numbers, versions and abbreviations spelled out the way the draft spells them.
- Keep URLs as spoken descriptions, never as addresses.
- Keep short paragraphs separated by blank lines; they are the reader's pauses.`

export interface HumanizeOptions {
  /** Add the spoken-output constraints (default: false). */
  forSpeech?: boolean
  /**
   * Sampling temperature. Defaults to the value in the skill's frontmatter,
   * which is deliberately low — this is an edit, not a new draft.
   */
  temperature?: number
  /**
   * Reject a rewrite shorter than this fraction of the input (default: 0.6).
   *
   * The realistic failure here is not a bad rewrite, it is a truncated or
   * refused one: a model that answers with "Here is the revised text:" and
   * stops, or returns a two-line summary of an eight-paragraph digest. Both
   * look like success to the caller.
   */
  minLengthRatio?: number
}

/** Build the messages for a humanizer pass, without sending them. */
export function buildHumanizeMessages(text: string, options: HumanizeOptions = {}): ChatMessage[] {
  const instructions = [
    'Rewrite the text below following your editing rules.',
    'Return only the rewritten text: no preamble, no notes on what you changed, no labels.',
    options.forSpeech ? SPEECH_CONSTRAINTS : '',
  ]
    .filter(Boolean)
    .join('\n')

  return [
    { role: 'system', content: HUMANIZER_SKILL.prompt },
    { role: 'user', content: `${instructions}\n\n${text}` },
  ]
}

/** Strip the wrapper a model adds when it ignores "return only the text". */
function unwrap(text: string): string {
  let out = text.trim()

  // A whole-response fenced block, with or without a language tag.
  const fenced = /^```[a-zA-Z]*\n([\s\S]*)\n```$/.exec(out)
  if (fenced) out = fenced[1].trim()

  // A single leading label line ("Final rewrite:", "Here is the revised text:").
  // Matched narrowly on purpose — a digest can legitimately open with a short
  // line ending in a colon, and eating it would lose content.
  out = out.replace(
    /^[^\n]{0,60}\b(?:rewrite|revised text|revised version|final version|humanized text)\b[^\n]{0,20}:[ \t]*\n+/i,
    ''
  )

  return out.trim()
}

/**
 * Rewrite `text` with the humanizer skill.
 *
 * Never throws for a bad result: a digest that has already been paid for is
 * worth more than a failed edit of it, so a refusal, a truncation or an API
 * error returns the original text and reports why through `onWarning`.
 *
 * @param config - The LLM to edit with. A capable writing model, not the scorer.
 */
export async function humanizeText(
  config: LLMConfig,
  text: string,
  options: HumanizeOptions & { onWarning?: (message: string) => void } = {}
): Promise<string> {
  const warn = options.onWarning ?? (() => {})
  const minRatio = options.minLengthRatio ?? 0.6

  let raw: string
  try {
    raw = await chatCompletionWithRetry(
      config,
      buildHumanizeMessages(text, options),
      false,
      3,
      2000,
      options.temperature ?? HUMANIZER_SKILL.temperature
    )
  } catch (err) {
    warn(`humanizer pass failed (${(err as Error).message}) — keeping the original`)
    return text
  }

  const humanized = unwrap(raw)

  if (!humanized) {
    warn('humanizer returned nothing — keeping the original')
    return text
  }

  if (humanized.length < text.length * minRatio) {
    warn(
      `humanizer returned ${humanized.length} chars against ${text.length} ` +
        `(below the ${minRatio} floor, likely truncated) — keeping the original`
    )
    return text
  }

  return humanized
}
