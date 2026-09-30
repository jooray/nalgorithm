/**
 * Nalgorithm — which pubkeys a set of posts needs profiles for
 *
 * A boost's `author` is the booster, and the person who wrote the note only
 * appears inside `originalPost`. Fetching profiles for `author` alone leaves
 * every boosted note anonymous, so both the web app and the hosted server
 * collect pubkeys through this one function.
 */

import * as nip19 from 'nostr-tools/nip19'
import type { EmbeddedPost, FetchedPost } from './types.js'

/** Upper bound on profiles requested per feed, so one busy feed stays cheap. */
export const MAX_PROFILE_PUBKEYS = 400

/** Hex pubkeys named by `nostr:npub1...` / `nostr:nprofile1...` references in text. */
export function extractReferencedPubkeys(content: string, out: Set<string> = new Set()): Set<string> {
  for (const m of content.matchAll(/nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+)/gi)) {
    try {
      const decoded = nip19.decode(m[1].toLowerCase())
      if (decoded.type === 'npub') out.add(decoded.data)
      else if (decoded.type === 'nprofile') out.add(decoded.data.pubkey)
    } catch {
      // Malformed reference: nothing to look up.
    }
  }
  return out
}

type PostLike = Pick<FetchedPost, 'author' | 'content'> & {
  originalPost?: Pick<EmbeddedPost, 'author' | 'content'>
  quotedPost?: Pick<EmbeddedPost, 'author' | 'content'>
}

/**
 * Every pubkey worth a profile lookup: authors first (post, original, quoted),
 * then people mentioned in the text. The cap trims the mentions, never the authors.
 */
export function collectPostPubkeys(posts: PostLike[], cap: number = MAX_PROFILE_PUBKEYS): string[] {
  const authors = new Set<string>()
  const mentioned = new Set<string>()
  for (const p of posts) {
    authors.add(p.author)
    if (p.originalPost) authors.add(p.originalPost.author)
    if (p.quotedPost) authors.add(p.quotedPost.author)
    extractReferencedPubkeys(p.content, mentioned)
    if (p.originalPost) extractReferencedPubkeys(p.originalPost.content, mentioned)
    if (p.quotedPost) extractReferencedPubkeys(p.quotedPost.content, mentioned)
  }
  const all = [...authors]
  for (const pk of mentioned) if (!authors.has(pk)) all.push(pk)
  return all.slice(0, cap)
}
