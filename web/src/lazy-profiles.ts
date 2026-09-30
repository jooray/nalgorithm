/**
 * Nalgorithm Web — which people a rendered feed still lacks profiles for.
 *
 * Pure helpers (no DOM, no network) for the lazy lookup in render.ts: the
 * relay pass at load time can miss authors, so anyone still unresolved after
 * the first render gets one more lookup in the browser, and only the cards
 * that show them are redrawn when the answer arrives.
 */

import { extractReferencedPubkeys } from 'nalgorithm'

export interface PersonPost {
  author: string
  content?: string
  boostedBy?: string[]
  originalPost?: { author: string; content?: string }
  quotedPost?: { author: string; content?: string }
}

const HEX_64 = /^[0-9a-f]{64}$/

/** The people a card names: its header (author, boosters, original and quoted authors) and every @mention in the text. */
export function peopleOf(post: PersonPost): string[] {
  const out = new Set<string>()
  const add = (pk?: string): void => {
    if (pk && HEX_64.test(pk)) out.add(pk)
  }
  add(post.author)
  for (const pk of post.boostedBy ?? []) add(pk)
  add(post.originalPost?.author)
  add(post.quotedPost?.author)
  for (const text of [post.content, post.originalPost?.content, post.quotedPost?.content]) {
    if (text) for (const pk of extractReferencedPubkeys(text)) add(pk)
  }
  return [...out]
}

/** People shown by these posts who have no profile at all yet, in first-seen order. */
export function unresolvedPeople(posts: PersonPost[], profiles: { has(pubkey: string): boolean } | undefined): string[] {
  const out = new Set<string>()
  for (const post of posts) {
    for (const pk of peopleOf(post)) if (!profiles?.has(pk)) out.add(pk)
  }
  return [...out]
}

/** Indexes of the posts whose card shows any of `resolved`. */
export function postsToRedraw(posts: PersonPost[], resolved: { has(pubkey: string): boolean }): number[] {
  const out: number[] = []
  posts.forEach((post, i) => {
    if (peopleOf(post).some((pk) => resolved.has(pk))) out.push(i)
  })
  return out
}
