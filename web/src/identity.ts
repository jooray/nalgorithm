/**
 * Nalgorithm Web — who a post is by, and how boosts fold into it
 *
 * Pure logic (no DOM) shared by the bring-your-own-key and hosted views.
 * Rule: nothing user-facing ever shows a hex key. A person is either a profile
 * name or their npub.
 */

import * as nip19 from 'nostr-tools/nip19'

// ─── Identity ────────────────────────────────────────────────────────────────

const HEX_64 = /^[0-9a-f]{64}$/i

interface NameSource {
  name?: string
}

/** npub for a hex pubkey, or '' when it is not a valid key. Never returns hex. */
export function npubOf(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey)
  } catch {
    return ''
  }
}

/**
 * nprofile with up to three relay hints. Only relays passed in are used:
 * a hint we did not learn from somewhere would be invented.
 */
export function nprofileOf(pubkey: string, relays: string[] = []): string {
  const hints = [...new Set(relays.filter((r) => /^wss?:\/\/[^\s]+$/i.test(r)))].slice(0, 3)
  try {
    return nip19.nprofileEncode({ pubkey, relays: hints })
  } catch {
    return ''
  }
}

/** The profile's name, unless it is missing or is itself a bare key. */
export function profileName(profile?: NameSource): string | undefined {
  const name = profile?.name?.trim()
  if (!name || HEX_64.test(name)) return undefined
  return name
}

export interface AuthorLabel {
  /** What to print. A profile name, or the complete npub. */
  text: string
  /** True when `text` is an npub, so the view can use a monospace, ellipsised element. */
  isNpub: boolean
}

/** Name if known, otherwise the full npub (truncation is CSS's job, so copy gets everything). */
export function authorLabel(pubkey: string, profile?: NameSource): AuthorLabel {
  const name = profileName(profile)
  if (name) return { text: name, isNpub: false }
  return { text: npubOf(pubkey), isNpub: true }
}

/** One letter for an avatar placeholder, or a neutral glyph when the name is unknown. */
export function avatarInitial(profile?: NameSource): string {
  const name = profileName(profile)
  const first = name ? Array.from(name).find((ch) => /[\p{L}\p{N}]/u.test(ch)) : undefined
  return first ? first.toUpperCase() : '?'
}

// ─── Boost folding ───────────────────────────────────────────────────────────

/** The parts of a post this file needs; ScoredPost satisfies it. */
export interface FoldablePost {
  id: string
  type: 'original' | 'boost' | 'quote'
  author: string
  content: string
  createdAt: number
  score: number
  justification?: string
  defaultScore?: boolean
  originalPost?: { id: string; author: string; content: string }
  quotedPost?: { id: string; author: string; content: string }
}

export type Folded<T extends FoldablePost> = T & {
  /** Pubkeys of everyone who boosted this note, in the order first seen. */
  boostedBy?: string[]
}

/**
 * Fold boosts into the note they boost.
 *
 * A boost has no commentary of its own, so it should never be a card of its
 * own. Grouping uses the same key as the score cache (the boosted event's id
 * for a boost, the post's own id otherwise), which means:
 *
 *  - a note and boosts of it become one card showing the note, with `boostedBy`;
 *  - several boosts of a note not itself in the list become one card built from
 *    the embedded original (author, text and id are the original's);
 *  - quote posts stay as they are, and a boost of a quote folds into the quote.
 *
 * Score: the highest of the group wins, with its justification, since the
 * ranker judges each copy separately and the best judgement of the content is
 * the useful one.
 *
 * Time: when the note itself is in the list the card shows the note's own
 * time, because that is what a reader takes a timestamp to mean. When only
 * boosts are present the embedded original has no time, so the most recent
 * boost time stands in ("when it reached your feed").
 *
 * Order: first appearance, except that if a merge raised a score the list is
 * stably re-sorted by score, so a note lifted by a good boost moves up.
 */
export function aggregateBoosts<T extends FoldablePost>(posts: T[]): Array<Folded<T>> {
  const out: Array<Folded<T>> = []
  const byKey = new Map<string, number>() // group key -> index in `out`
  const synthesized = new Set<string>() // keys whose entry was built from a boost
  let scoreRaised = false

  const adoptScore = (entry: Folded<T>, from: FoldablePost): void => {
    if (from.score > entry.score) {
      entry.score = from.score
      entry.justification = from.justification
      entry.defaultScore = from.defaultScore
      scoreRaised = true
    }
  }

  for (const post of posts) {
    const isFoldableBoost = post.type === 'boost' && !!post.originalPost?.id
    const key = isFoldableBoost ? post.originalPost!.id : post.id
    const at = byKey.get(key)

    if (at === undefined) {
      byKey.set(key, out.length)
      if (isFoldableBoost) {
        const orig = post.originalPost!
        synthesized.add(key)
        out.push({
          ...post,
          id: orig.id,
          type: 'original',
          author: orig.author,
          content: orig.content,
          originalPost: undefined,
          quotedPost: undefined,
          rawEvent: undefined,
          boostedBy: [post.author],
        } as Folded<T>)
      } else {
        out.push({ ...post })
      }
      continue
    }

    const entry = out[at]
    if (isFoldableBoost) {
      entry.boostedBy ??= []
      if (!entry.boostedBy.includes(post.author)) entry.boostedBy.push(post.author)
      if (synthesized.has(key) && post.createdAt > entry.createdAt) entry.createdAt = post.createdAt
      adoptScore(entry, post)
    } else if (synthesized.has(key)) {
      // The note itself turned up after boosts of it: it replaces the stand-in.
      const replacement = { ...post, boostedBy: entry.boostedBy } as Folded<T>
      adoptScore(replacement, entry)
      out[at] = replacement
      synthesized.delete(key)
    } else {
      adoptScore(entry, post) // the same note listed twice
    }
  }

  if (!scoreRaised) return out
  return out
    .map((post, i) => ({ post, i }))
    .sort((a, b) => b.post.score - a.post.score || a.i - b.i)
    .map((x) => x.post)
}

export interface BoosterSummary {
  /** Pubkeys named directly. */
  shown: string[]
  /** Pubkeys behind "and N more". Empty when everyone fits. */
  rest: string[]
}

/** Up to four names in full; beyond that the first three and a count. */
export function summarizeBoosters(pubkeys: string[]): BoosterSummary {
  if (pubkeys.length <= 4) return { shown: pubkeys, rest: [] }
  return { shown: pubkeys.slice(0, 3), rest: pubkeys.slice(3) }
}

// ─── Content tokens ──────────────────────────────────────────────────────────

export type ContentToken =
  | { kind: 'text'; text: string }
  | { kind: 'profile'; bech32: string; pubkey: string | null }
  | { kind: 'ref'; bech32: string }
  | { kind: 'url'; url: string; trailing: string }

const TOKEN_PATTERN = /nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+|n(?:event|ote|addr)1[a-z0-9]+)|https?:\/\/[^\s]+/gi

/** Pubkey behind an npub or nprofile string, or null. */
export function pubkeyOfProfileRef(bech32: string): string | null {
  try {
    const decoded = nip19.decode(bech32.toLowerCase())
    if (decoded.type === 'npub') return decoded.data
    if (decoded.type === 'nprofile') return decoded.data.pubkey
  } catch {
    // not a valid reference
  }
  return null
}

/** Split post text into plain text, profile mentions, event references and URLs. */
export function tokenizeContent(content: string): ContentToken[] {
  const tokens: ContentToken[] = []
  let last = 0
  for (const m of content.matchAll(TOKEN_PATTERN)) {
    const at = m.index ?? 0
    if (at > last) tokens.push({ kind: 'text', text: content.slice(last, at) })
    const whole = m[0]
    const bech32 = m[1]
    if (bech32) {
      if (/^(npub1|nprofile1)/i.test(bech32)) {
        tokens.push({ kind: 'profile', bech32, pubkey: pubkeyOfProfileRef(bech32) })
      } else {
        tokens.push({ kind: 'ref', bech32 })
      }
    } else {
      const url = whole.replace(/[)>]+$/, '')
      tokens.push({ kind: 'url', url, trailing: whole.slice(url.length) })
    }
    last = at + whole.length
  }
  if (last < content.length) tokens.push({ kind: 'text', text: content.slice(last) })
  return tokens
}
