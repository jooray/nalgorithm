/**
 * Nalgorithm Web — Rich post rendering
 *
 * One note, as a modern Nostr client draws it: avatar, name, handle and time,
 * "Boosted by" line, body, media, link cards, quoted note, then the score pill
 * with its reason, then the action row. Tapping a note opens the detail sheet.
 *
 * Nothing here prints a hex key: a person is a profile name or their npub.
 * All text goes in through textContent, never innerHTML (icons excepted: those
 * are static strings from icons.ts).
 */

import type { ScoredPost, EmbeddedPost, ProfileData } from 'nalgorithm'
import * as nip19 from 'nostr-tools/nip19'
import {
  buildEventUrl,
  buildProfileUrl,
  clientLabel,
  nostrUri,
  resolveProfileTemplate,
  resolveTemplate,
  safeLink,
  type ClientPreset,
} from './client-url.js'
import {
  aggregateBoosts as foldBoosts,
  authorLabel,
  avatarInitial,
  npubOf,
  nprofileOf,
  summarizeBoosters,
  tokenizeContent,
  type Folded,
} from './identity.js'
import type { AppSettings } from './settings.js'
import { copyText } from './clipboard.js'
import { noteActions, renderActionRow, type NoteLinks } from './actions.js'
import { icon, type IconName } from './icons.js'
import type { NoteTarget } from './note-ui.js'
import { directReplies, parentOf } from './note-logic.js'
import { splitFresh } from './snapshot-logic.js'
import { fetchEvent, queryEvents, readRelaysFor } from './relays.js'
import { knownProfiles, loadProfiles } from './profiles.js'
import { postsToRedraw, unresolvedPeople } from './lazy-profiles.js'
import type { Event as NostrEvent } from 'nostr-tools/pure'
import { openSheet } from './sheet.js'
import { relativeTime } from './time.js'
import { readImeta, type MediaMeta } from 'nalgorithm'
import { disposeTree } from './lifecycle.js'
import { addRule, hideNote, isFilteredOut, isSaved, muteAuthor, onFeedbackChange, readFeedback, saveNote, unsaveNote } from './feedback.js'
import { showToast } from './toast.js'

export interface RenderOptions {
  feedOrder?: 'new' | 'best'
  dataSaver?: boolean
  profiles?: Map<string, ProfileData>
  /** URL template for "open in client" — may contain {e} or be a prefix. */
  eventUrlTemplate?: string
  /** Profile URL template — {npub}, {nprofile}, {pubkey}, or a prefix. */
  profileUrlTemplate?: string
  /** Which preset is selected, for the menu label. */
  clientPreset?: ClientPreset
  /** Relays to hint in copied nprofiles: the ones this app reads from. */
  relayHints?: string[]
  /** Hosted mode only: add link cards for the URLs in `content` to `card`. */
  linkPreviews?: (content: string, card: HTMLElement) => void
  /** Tapping a note opens the detail sheet (default true). */
  detail?: boolean
  /**
   * Relays for one lazy browser lookup of authors and boosters that have no
   * profile after the first render. Their cards update in place. Off when unset.
   */
  lazyProfileRelays?: string[]
  /**
   * Notes that came with the latest run (folded ids). They go first under
   * "New since last refresh", and the rest follow under their own heading.
   */
  fresh?: ReadonlySet<string>
}

/** Link options derived from the reader's settings; shared by both modes. */
export function clientRenderOptions(
  settings: Pick<AppSettings, 'clientPreset' | 'clientCustomUrl' | 'clientCustomProfileUrl'> & Partial<Pick<AppSettings, 'feedOrder' | 'dataSaver'>>,
  relayHints: string[] = []
): RenderOptions {
  return {
    eventUrlTemplate: resolveTemplate(settings.clientPreset, settings.clientCustomUrl),
    profileUrlTemplate: resolveProfileTemplate(settings.clientPreset, settings.clientCustomProfileUrl),
    clientPreset: settings.clientPreset,
    relayHints,
    feedOrder: settings.feedOrder ?? 'new',
    dataSaver: settings.dataSaver ?? false,
  }
}

/** A post as displayed: boosts are folded into the note, `boostedBy` lists the boosters. */
export type DisplayPost = Folded<ScoredPost>

/** See identity.ts for the folding and timestamp policy. */
export function aggregateBoosts(posts: ScoredPost[]): DisplayPost[] {
  return foldBoosts(posts)
}

/**
 * Render a list of scored posts into the feed container.
 */
export function renderFeed(
  posts: DisplayPost[],
  container: HTMLElement,
  options: RenderOptions = {}
): void {
  const previous = feedState.get(container)
  const source = posts
  // The reader's private hides apply to the feed lists, not to a digest's show notes.
  if (FEED_LISTS.has(container.id)) {
    const feedback = readFeedback()
    posts = posts.filter((p) => !isFilteredOut(p, feedback))
    watchFeedback()
  }
  if (posts.length === 0) {
    disposeTree(container)
    container.replaceChildren()
    feedState.delete(container)
    const empty = el('p', 'feed-empty')
    empty.textContent = source.length > 0 ? 'Every note here is one you chose to hide. Tune lists your hidden notes and people.' : 'No posts to display.'
    container.appendChild(empty)
    feedState.set(container, { source, posts: [], allPosts: [], visibleCount: 50, freshKey: '', cards: [], items: new Map(), options })
    return
  }

  const split = options.feedOrder === 'best' ? { fresh: [], rest: posts } : splitFresh(posts, options.fresh ?? new Set())
  const freshIds = new Set(split.fresh.map((post) => post.id))
  // From what the caller gave, so hiding a note is not mistaken for a different feed.
  const freshKey = options.feedOrder === 'best' ? '' : splitFresh(source, options.fresh ?? new Set()).fresh.map((p) => p.id).sort().join()
  let ordered = [...split.fresh, ...split.rest]
  // A reader engaging with progressively arriving scores keeps their reading order.
  // A changed "new" set is a different feed, not a rescore, so it is laid out afresh.
  const reading = window.scrollY > 80 && !document.getElementById('view-feed')?.classList.contains('hidden')
  const anchor = reading ? previous?.cards.find((card) => card.getBoundingClientRect().bottom > 0) : null
  const anchorTop = anchor?.getBoundingClientRect().top
  if (previous && reading && previous.freshKey === freshKey && FEED_LISTS.has(container.id)) {
    const incoming = new Map(ordered.map((post) => [post.id, post]))
    const kept = previous.allPosts.filter((post) => incoming.has(post.id)).map((post) => incoming.get(post.id)!)
    const keys = new Set(kept.map((post) => post.id))
    const added = ordered.filter((post) => !keys.has(post.id))
    const group = (list: DisplayPost[], isFresh: boolean): DisplayPost[] => list.filter((post) => freshIds.has(post.id) === isFresh)
    ordered = [...group(kept, true), ...group(added, true), ...group(kept, false), ...group(added, false)]
  }
  const linkedId = /\/note\/([0-9a-f]{64})$/i.exec(location.hash)?.[1]
  const count = Math.max(previous?.visibleCount ?? 50, linkedId ? ordered.findIndex((post) => post.id === linkedId) + 1 : 0)
  const visible = ordered.slice(0, count)
  const cards: HTMLElement[] = []
  const items = new Map<string, CardState>()
  const nodes: HTMLElement[] = []
  // One lime edge: the first of the highest-scored ranked notes.
  const topId = posts.reduce<DisplayPost | null>((best, p) => (!p.defaultScore && (!best || p.score > best.score) ? p : best), null)?.id
  const heading = (kind: string, text: string): HTMLElement => {
    const old = container.querySelector<HTMLElement>(`.feed-section[data-kind="${kind}"]`)
    const node = old ?? sectionHeading(text)
    node.dataset.kind = kind
    if (node.textContent !== text) node.textContent = text
    return node
  }
  visible.forEach((post, i) => {
    if (split.fresh.length > 0 && (i === 0 || i === split.fresh.length)) {
      nodes.push(heading(i === 0 ? 'fresh' : 'rest', i === 0 ? `New since last refresh · ${split.fresh.length}` : 'Earlier notes'))
    }
    const signature = JSON.stringify([post.type, post.author, post.content, post.createdAt, post.quotedPost, post.originalPost, post.boostedBy, post.rawEvent?.tags, options.eventUrlTemplate, options.profileUrlTemplate, options.clientPreset, options.dataSaver, Boolean(options.linkPreviews)])
    const old = previous?.items.get(post.id)
    let card: HTMLElement
    if (old && old.signature === signature) {
      card = old.card
      Object.assign(old.post, post)
      Object.assign(old.options, options)
      const score = card.querySelector('.note-score')
      const scoreKey = `${post.score}|${post.justification}|${post.defaultScore}`
      if (card.dataset.scoreKey !== scoreKey) { score?.replaceWith(renderScore(post)); card.dataset.scoreKey = scoreKey }
      patchPeople(card, old.options)
      card.setAttribute('aria-label', cardLabel(post, old.options, post.id === topId))
      items.set(post.id, old)
    } else {
      if (old) disposeTree(old.card)
      const postRef = { ...post }, optionRef = { ...options }
      card = renderPostCard(postRef, optionRef)
      card.dataset.noteId = post.id
      card.dataset.scoreKey = `${post.score}|${post.justification}|${post.defaultScore}`
      items.set(post.id, { card, post: postRef, options: optionRef, signature })
    }
    const top = post.id === topId
    if (card.classList.contains('note-top') !== top) {
      card.classList.toggle('note-top', top)
      // The lime edge is visual only; the label says it too.
      card.setAttribute('aria-label', cardLabel(post, items.get(post.id)!.options, top))
    }
    cards.push(card)
    nodes.push(card)
  })
  if (ordered.length > visible.length) {
    const more = el('button', 'btn btn-full feed-more') as HTMLButtonElement
    more.type = 'button'
    more.textContent = `Show next ${Math.min(50, ordered.length - visible.length)} notes · ${ordered.length} total`
    more.addEventListener('click', () => {
      const state = feedState.get(container)
      if (!state) return
      const next = state.visibleCount
      state.visibleCount += 50
      renderFeed(state.source, container, state.options)
      // Keyboard and screen-reader users continue at the first newly shown note.
      feedState.get(container)?.cards[next]?.focus({ preventScroll: true })
    })
    nodes.push(more)
  }
  for (const [id, item] of previous?.items ?? []) if (!items.has(id)) disposeTree(item.card)
  // Reconcile in place, instead of detaching reused cards and losing focus/media.
  nodes.forEach((node, i) => { if (container.children[i] !== node) container.insertBefore(node, container.children[i] ?? null) })
  while (container.children.length > nodes.length) { const last = container.lastElementChild!; disposeTree(last); last.remove() }
  feedState.set(container, { source, posts: visible, allPosts: ordered, visibleCount: count, freshKey, cards, items, options })
  if (anchor?.isConnected && anchorTop !== undefined) {
    const shift = anchor.getBoundingClientRect().top - anchorTop
    if (Math.abs(shift) > 1) window.scrollBy({ top: shift, behavior: 'auto' })
  }
  const linked = linkedId ? ordered.find((p) => p.id === linkedId) : null
  if (linked && !document.querySelector('dialog[open]')) queueMicrotask(() => {
    if (!document.querySelector('dialog[open]')) openNoteSheet(linked, options)
  })
  void lazyResolveProfiles(container)
}

function sectionHeading(text: string): HTMLElement {
  const h = el('h2', 'feed-section')
  h.textContent = text
  return h
}

interface FeedState {
  /** What the caller gave, before the reader's hides. */
  source: DisplayPost[]
  allPosts: DisplayPost[]
  visibleCount: number
  freshKey: string
  items: Map<string, CardState>
  posts: DisplayPost[]
  cards: HTMLElement[]
  options: RenderOptions
}
interface CardState { card: HTMLElement; post: DisplayPost; options: RenderOptions; signature: string }

function patchPeople(card: HTMLElement, options: RenderOptions): void {
  for (const link of card.querySelectorAll<HTMLAnchorElement>('a[data-person]')) {
    const pubkey = link.dataset.person!
    const label = authorLabel(pubkey, options.profiles?.get(pubkey)).text
    const text = (link.dataset.prefix ?? '') + label
    if (link.textContent !== text) link.replaceChildren(nameNode(pubkey, options, link.dataset.prefix ?? ''))
    link.href = profileHref(pubkey, options)
  }
  for (const avatar of card.querySelectorAll<HTMLElement>('[data-avatar]')) {
    const pubkey = avatar.dataset.avatar!
    const signature = JSON.stringify(options.profiles?.get(pubkey) ?? null)
    if (avatar.dataset.profileKey !== signature) avatar.replaceWith(renderAvatar(pubkey, options, avatar.className.replace(' post-avatar-fallback', '')))
  }
}

/** The latest render of each feed container, so a late profile redraws the current cards. */
const feedState = new WeakMap<HTMLElement, FeedState>()

const FEED_LISTS = new Set(['feed-list', 'hosted-feed'])
let watching = false
/** A hide, mute or undo redraws the feed lists on screen at once. */
function watchFeedback(): void {
  if (watching) return
  watching = true
  onFeedbackChange(() => {
    for (const id of FEED_LISTS) {
      const container = document.getElementById(id)
      const state = container ? feedState.get(container) : undefined
      if (container && state) renderFeed(state.source, container, state.options)
    }
  })
}
export function clearFeed(container: HTMLElement): void {
  disposeTree(container)
  container.replaceChildren()
  feedState.delete(container)
}

/**
 * One browser lookup for people the feed shows without a profile (the library
 * and server passes can miss some). Matching cards are replaced in place; the
 * npub stays as the fallback when nothing is found.
 */
async function lazyResolveProfiles(container: HTMLElement): Promise<void> {
  const first = feedState.get(container)
  const relays = first?.options.lazyProfileRelays
  if (!first || !relays || relays.length === 0) return
  const people = unresolvedPeople(first.posts, first.options.profiles)
  if (people.length === 0) return

  const found = await loadProfiles(people, relays)
  const state = feedState.get(container)
  if (!state || found.size === 0) return

  // The shared map is filled in place, so later renders start with these names.
  const profiles = state.options.profiles ?? new Map<string, ProfileData>()
  const arrived = new Set<string>()
  for (const [pk, p] of found) {
    if (!profiles.has(pk)) {
      profiles.set(pk, p)
      arrived.add(pk)
    }
  }
  if (arrived.size === 0) return
  state.options.profiles = profiles

  for (const i of postsToRedraw(state.posts, arrived)) {
    const old = state.cards[i]
    if (!old?.isConnected) continue
    patchPeople(old, state.options)
  }
}

// ─── People ──────────────────────────────────────────────────────────────────

/** A person's profile in the reader's chosen client, for links outside the feed. */
export function profileLink(pubkey: string, options: RenderOptions): string {
  return profileHref(pubkey, options)
}

function profileHref(pubkey: string, options: RenderOptions): string {
  const url = buildProfileUrl(options.profileUrlTemplate ?? '', {
    npub: npubOf(pubkey),
    nprofile: nprofileOf(pubkey, options.relayHints),
    pubkey,
  })
  return safeLink(url) ?? '#'
}

/** The visible name: a profile name, or the complete npub in an ellipsised monospace element. */
function nameNode(pubkey: string, options: RenderOptions, prefix = ''): Node {
  const label = authorLabel(pubkey, options.profiles?.get(pubkey))
  if (!label.isNpub) return document.createTextNode(prefix + label.text)
  const frag = document.createDocumentFragment()
  if (prefix) frag.appendChild(document.createTextNode(prefix))
  const code = el('code', 'npub-text')
  code.textContent = label.text
  frag.appendChild(code)
  return frag
}

/** A link to the person's profile in the reader's client. */
function personLink(pubkey: string, options: RenderOptions, className: string, prefix = ''): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = className
  a.dataset.person = pubkey
  a.dataset.prefix = prefix
  a.href = profileHref(pubkey, options)
  a.target = '_blank'
  a.rel = 'noopener'
  a.appendChild(nameNode(pubkey, options, prefix))
  return a
}

/** Avatar (linked to the profile). Falls back to an initial from the name, else a neutral glyph. */
function renderAvatar(pubkey: string, options: RenderOptions, className: string): HTMLElement {
  const profile = options.profiles?.get(pubkey)
  const container = el('div', className)
  container.dataset.avatar = pubkey
  container.dataset.profileKey = JSON.stringify(profile ?? null)
  const link = document.createElement('a')
  link.href = profileHref(pubkey, options)
  link.target = '_blank'
  link.rel = 'noopener'
  link.tabIndex = -1 // the name next to it is the keyboard target
  link.setAttribute('aria-hidden', 'true')

  const showFallback = (): void => {
    link.textContent = avatarInitial(profile)
    container.classList.add('post-avatar-fallback')
  }

  // Data saver: an initial instead of a request to the avatar's host.
  if (profile?.picture && safeLink(profile.picture) && !options.dataSaver) {
    const img = document.createElement('img')
    img.src = profile.picture
    img.alt = ''
    img.loading = 'lazy'
    img.onerror = () => {
      img.remove()
      showFallback()
    }
    link.appendChild(img)
  } else {
    showFallback()
  }
  container.appendChild(link)
  return container
}

/** "Boosted by a, b, c and d", each name a profile link; long lists expand on demand. */
function renderBoostedBy(pubkeys: string[], options: RenderOptions): HTMLElement {
  const line = el('div', 'boosted-by')
  const { shown, rest } = summarizeBoosters(pubkeys)
  line.appendChild(document.createTextNode('Boosted by '))

  const names = (keys: string[], into: Node, closeWithAnd: boolean): void => {
    keys.forEach((pk, i) => {
      if (i > 0) into.appendChild(document.createTextNode(closeWithAnd && i === keys.length - 1 ? ' and ' : ', '))
      into.appendChild(personLink(pk, options, 'booster-link'))
    })
  }

  if (rest.length === 0) {
    names(shown, line, true)
    return line
  }

  names(shown, line, false)
  line.appendChild(document.createTextNode(' '))
  const more = el('button', 'boosted-by-more') as HTMLButtonElement
  more.type = 'button'
  more.textContent = `and ${rest.length} more`
  more.setAttribute('aria-expanded', 'false')
  const extra = el('span', 'boosted-by-rest hidden')
  names(rest, extra, true)
  more.addEventListener('click', () => {
    const open = extra.classList.toggle('hidden') === false
    more.setAttribute('aria-expanded', String(open))
    more.textContent = open ? 'fewer' : `and ${rest.length} more`
  })
  line.appendChild(more)
  line.appendChild(extra)
  return line
}

// ─── Cards ───────────────────────────────────────────────────────────────────

/** The grey handle next to a name: the profile's NIP-05, without the `_@` of a root identifier. */
function handleOf(pubkey: string, options: RenderOptions): string {
  const nip05 = options.profiles?.get(pubkey)?.nip05?.trim()
  if (!nip05) return ''
  return nip05.replace(/^_@/, '')
}

/** Identifiers and links for a note, computed once and used by the row, the menu and the sheet. */
function linksFor(post: DisplayPost, options: RenderOptions): NoteLinks & { eventTemplate: string } {
  const preset = options.clientPreset ?? 'njump'
  const npub = npubOf(post.author)
  const nprofile = nprofileOf(post.author, options.relayHints)
  const relay = (post as { relay?: string }).relay
  const relays = [...(relay ? [relay] : []), ...(options.relayHints ?? [])].slice(0, 3)
  let nevent = ''
  try {
    nevent = nip19.neventEncode({ id: post.id, author: post.author, kind: post.rawEvent?.kind ?? 1, relays })
  } catch {
    // invalid id: the note actions are left out
  }
  const eventTemplate = options.eventUrlTemplate ?? ''
  return {
    id: post.id,
    author: post.author,
    npub,
    nprofile,
    nevent,
    eventHref: nevent ? (safeLink(buildEventUrl(eventTemplate, nevent)) ?? '') : '',
    clientLabel: clientLabel(preset),
    eventTemplate,
  }
}

/**
 * The note as the actions see it. A digest's stored note carries a stand-in raw
 * event (no signature, no tags), which must never be mistaken for the real
 * one: only a signed event counts as the original.
 */
function targetFor(post: DisplayPost, options: RenderOptions): NoteTarget {
  const raw = post.rawEvent as NostrEvent | undefined
  return {
    id: post.id,
    author: post.author,
    kind: raw?.kind ?? 1,
    relay: (post as { relay?: string }).relay,
    event: raw && raw.sig ? raw : undefined,
    content: post.content,
    authorName: shortName(post.author, options),
  }
}

function shortName(pubkey: string, options: RenderOptions): string {
  const label = authorLabel(pubkey, options.profiles?.get(pubkey))
  return label.isNpub ? `${label.text.slice(0, 12)}…${label.text.slice(-4)}` : label.text
}

/** Name, handle and time on one line, as Primal, Damus and Amethyst set them. */
function renderNoteHead(post: DisplayPost, options: RenderOptions): HTMLElement {
  const head = el('div', 'note-head')
  const author = el('span', 'post-author')
  author.appendChild(personLink(post.author, options, 'author-link'))
  head.appendChild(author)
  const handle = handleOf(post.author, options)
  if (handle) {
    const h = el('span', 'note-handle')
    h.textContent = handle
    head.appendChild(h)
  }
  if (post.type !== 'original') {
    const t = el('span', 'post-type-label')
    t.textContent = post.type === 'boost' ? 'Boosted' : 'Quoted'
    head.appendChild(t)
  }
  const time = document.createElement('time')
  time.className = 'post-time'
  time.dateTime = new Date(post.createdAt * 1000).toISOString()
  time.textContent = relativeTime(post.createdAt)
  time.title = new Date(post.createdAt * 1000).toLocaleString()
  head.appendChild(time)
  return head
}

/** Body, media and quoted note: the part a note and its detail sheet share. */
function renderNoteContent(post: DisplayPost, options: RenderOptions, into: HTMLElement): void {
  const content = el('div', 'post-content')
  content.appendChild(renderContent(post.content, options))
  into.appendChild(content)
  options.linkPreviews?.(post.content, into)

  // Hosted posts carry `media` (the server's imeta summary); BYOK reads the raw tags.
  const meta = (post as DisplayPost & { media?: MediaMeta[] }).media ?? readImeta(post.rawEvent?.tags)
  const media = extractMedia(post.content, meta)
  if (media.length > 0) {
    const mediaContainer = el('div', 'post-media')
    for (const m of media) mediaContainer.appendChild(renderMedia(m, options))
    into.appendChild(mediaContainer)
  }

  if (post.type === 'quote' && post.quotedPost) {
    into.appendChild(renderEmbeddedPost(post.quotedPost, options))
  } else if (post.type === 'boost' && post.originalPost) {
    // Only reached for a boost that was not folded (kept for safety).
    into.appendChild(renderEmbeddedPost(post.originalPost, options))
  }
}

/** The lime score pill with the one-line reason beside it. */
function renderScore(post: DisplayPost, full = false): HTMLElement {
  const row = el('div', full ? 'note-score note-score-full' : 'note-score')
  const pill = el('span', 'score-pill')
  pill.textContent = post.defaultScore ? 'Not ranked yet' : `Score ${post.score.toFixed(1)}`
  pill.setAttribute('aria-label', post.defaultScore ? 'This note has not been ranked' : `Estimated relevance ${post.score.toFixed(1)} out of 10`)
  row.appendChild(pill)
  const reason = el('span', 'score-reason')
  reason.textContent = post.defaultScore ? 'Model unavailable. Refresh retries only unranked notes.' : post.justification || 'No reason was given'
  row.appendChild(reason)
  if (!full && !post.defaultScore) {
    // The card's own click handler opens the sheet at its explanation.
    const why = el('button', 'why-btn') as HTMLButtonElement
    why.type = 'button'
    why.textContent = 'Why this?'
    row.appendChild(why)
  }
  return row
}

/**
 * Render a single note.
 *
 *   [avatar]  name  handle  · time
 *             Boosted by a, b
 *             body, media, link cards, quoted note
 *             [Score 9.1] one-line reason
 *             open  copy                          •••
 *
 * Tapping the note (anywhere that is not a link or button) opens the detail sheet.
 */
function cardLabel(post: DisplayPost, options: RenderOptions, top = false): string {
  const name = authorLabel(post.author, options.profiles?.get(post.author)).text
  return `Note by ${name}, ${post.defaultScore ? 'not ranked yet' : `relevance ${post.score.toFixed(1)}${top ? ', top match' : ''}`}. Open details`
}

function renderPostCard(post: DisplayPost, options: RenderOptions): HTMLElement {
  const card = el('article', 'note')
  card.tabIndex = 0
  card.setAttribute('aria-label', cardLabel(post, options))

  card.appendChild(renderAvatar(post.author, options, 'post-avatar'))

  const main = el('div', 'note-main')
  main.appendChild(renderNoteHead(post, options))
  if (post.boostedBy && post.boostedBy.length > 0) {
    main.appendChild(renderBoostedBy(post.boostedBy, options))
  }
  renderNoteContent(post, options, main)
  main.appendChild(renderScore(post))

  const links = linksFor(post, options)
  main.appendChild(renderActionRow(noteActions(targetFor(post, options)), renderMenu(post, options, links)))
  card.appendChild(main)

  if (options.detail !== false) {
    const open = (): void => openNoteSheet(post, options)
    card.addEventListener('click', (e) => {
      const target = e.target as Element | null
      if (target?.closest('.why-btn')) return openNoteSheet(post, options, { at: 'why' })
      if (target?.closest('a, button, input, textarea, select, video, [role="menu"], .video-placeholder')) return
      if (window.getSelection()?.toString()) return
      open()
    })
    card.addEventListener('keydown', (e) => {
      if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      open()
    })
  }
  return card
}

// ─── Detail sheet ────────────────────────────────────────────────────────────

/**
 * The full note, its actions, what it replies to and its direct replies (one
 * level each way), why it ranked, and every way to open or copy it.
 */
export function openNoteSheet(post: DisplayPost, options: RenderOptions, opts: { at?: 'why' } = {}): void {
  const links = linksFor(post, options)
  const tab = location.hash.slice(1).split('/')[0] || 'feed'
  const sheet = openSheet({ title: 'Note', route: `#${tab}/note/${post.id}` })
  const body = sheet.body

  const note = el('article', 'note note-detail')
  note.appendChild(renderAvatar(post.author, options, 'post-avatar'))
  const main = el('div', 'note-main')
  main.appendChild(renderNoteHead(post, options))
  if (post.boostedBy && post.boostedBy.length > 0) {
    main.appendChild(renderBoostedBy(post.boostedBy, options))
  }
  renderNoteContent(post, options, main)
  note.appendChild(main)
  const parentBox = el('section', 'thread-parent hidden')
  body.appendChild(parentBox)
  body.appendChild(note)
  body.appendChild(renderActionRow(noteActions(targetFor(post, options))))

  const repliesBox = el('section', 'sheet-section thread-replies')
  repliesBox.appendChild(statusLine('Loading replies…'))
  body.appendChild(repliesBox)
  void loadThread(post, options, parentBox, repliesBox)

  if (Number.isFinite(post.score)) {
    const why = el('section', 'sheet-section')
    const whyTitle = el('h3', 'sheet-section-title')
    whyTitle.textContent = 'Why it ranked'
    why.appendChild(whyTitle)
    why.appendChild(renderScore(post, true))
    const about = el('p', 'sheet-note')
    about.textContent = post.defaultScore
      ? 'The model could not score this note, so it sits behind the ranked ones.'
      : 'The score estimates how well this note matches your words in Tune; it is the model\'s judgement, not a measured certainty. The model read the first 500 characters of the note. To change what ranks high, change your words.'
    why.appendChild(about)
    body.insertBefore(why, repliesBox)
    if (opts.at === 'why') {
      whyTitle.tabIndex = -1
      queueMicrotask(() => {
        whyTitle.scrollIntoView({ block: 'start' })
        whyTitle.focus({ preventScroll: true })
      })
    }
  }

  const list = el('div', 'sheet-actions')
  const item = (labelText: string, iconName: IconName, run: () => Promise<boolean>, doneText: string): void => {
    const b = el('button', 'sheet-action') as HTMLButtonElement
    b.type = 'button'
    const label = el('span', 'sheet-action-label')
    label.textContent = labelText
    b.innerHTML = icon(iconName, 20)
    b.appendChild(label)
    b.addEventListener('click', async () => {
      const ok = await run()
      label.textContent = ok ? doneText : 'Copy failed'
      setTimeout(() => (label.textContent = labelText), 1400)
    })
    list.appendChild(b)
  }
  const link = (labelText: string, iconName: IconName, href: string): void => {
    const safe = safeLink(href)
    if (!safe) return
    const a = el('a', 'sheet-action') as HTMLAnchorElement
    a.href = safe
    a.target = '_blank'
    a.rel = 'noopener'
    a.innerHTML = icon(iconName, 20)
    const label = el('span', 'sheet-action-label')
    label.textContent = labelText
    a.appendChild(label)
    list.appendChild(a)
  }
  if (links.nevent) item('Copy note link (nevent)', 'copy', () => copyText(links.nevent), 'Copied')
  if (links.eventHref) link(`Open note in ${links.clientLabel}`, 'external', links.eventHref)
  if ((options.clientPreset ?? 'njump') !== 'app' && links.nevent) {
    link('Open note in my Nostr app', 'external', nostrUri(links.nevent))
  }
  if (links.npub) item('Copy npub', 'copy', () => copyText(links.npub), 'Copied')
  link(`Open profile in ${links.clientLabel}`, 'user', profileHref(post.author, options))
  body.appendChild(list)
}

// ─── Thread (one level up, one level down) ──────────────────────────────────

function statusLine(text: string): HTMLElement {
  const p = el('p', 'thread-status')
  p.textContent = text
  return p
}

function sectionTitle(text: string): HTMLElement {
  const t = el('h3', 'sheet-section-title')
  t.textContent = text
  return t
}

/** A note from a relay as the detail sheet draws it, without a ranking. */
function unrankedPost(ev: NostrEvent): DisplayPost {
  return {
    id: ev.id,
    type: 'original',
    author: ev.pubkey,
    content: ev.content,
    createdAt: ev.created_at,
    score: Number.NaN,
    rawEvent: ev,
  } as unknown as DisplayPost
}

/** A smaller note for a parent or a reply. Tapping it opens it in full. */
function renderCompactNote(ev: NostrEvent, options: RenderOptions): HTMLElement {
  const post = unrankedPost(ev)
  const card = el('article', 'note note-compact')
  card.tabIndex = 0
  card.setAttribute('aria-label', `Note by ${shortName(ev.pubkey, options)}. Open`)
  card.appendChild(renderAvatar(ev.pubkey, options, 'post-avatar'))
  const main = el('div', 'note-main')
  main.appendChild(renderNoteHead(post, options))
  const content = el('div', 'post-content')
  content.appendChild(renderContent(ev.content, options))
  main.appendChild(content)
  card.appendChild(main)
  const open = (): void => openNoteSheet(post, options)
  card.addEventListener('click', (e) => {
    if ((e.target as Element | null)?.closest('a, button')) return
    if (window.getSelection()?.toString()) return
    open()
  })
  card.addEventListener('keydown', (e) => {
    if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    open()
  })
  return card
}

async function loadThread(post: DisplayPost, options: RenderOptions, parentBox: HTMLElement, repliesBox: HTMLElement): Promise<void> {
  const hint = (post as { relay?: string }).relay
  const relays = await readRelaysFor(post.author, hint ? [hint] : [])
  const raw = post.rawEvent as NostrEvent | undefined

  const parentDone = (async (): Promise<NostrEvent | null> => {
    const self = raw && raw.sig ? raw : await fetchEvent(post.id, relays)
    const ref = self ? parentOf(self) : undefined
    if (!ref) return null
    return fetchEvent(ref.id, ref.relay ? [ref.relay, ...relays] : relays)
  })()
  const repliesDone = queryEvents(relays, { kinds: [1], '#e': [post.id], limit: 100 }).then((events) => directReplies(events, post.id, 20))

  const [parent, replies] = await Promise.all([parentDone, repliesDone])
  if (!repliesBox.isConnected) return // the sheet was closed while this loaded

  const people = [...new Set([...(parent ? [parent.pubkey] : []), ...replies.map((r) => r.pubkey)])]
  const shown = async (): Promise<RenderOptions> => ({ ...options, profiles: new Map([...(options.profiles ?? []), ...knownProfiles(people)]) })
  const draw = async (): Promise<void> => {
    const opts = await shown()
    if (parent) {
      parentBox.replaceChildren(sectionTitle('In reply to'), renderCompactNote(parent, opts))
      parentBox.classList.remove('hidden')
    }
    repliesBox.replaceChildren(sectionTitle(replies.length === 0 ? 'Replies' : `Replies (${replies.length}${replies.length === 20 ? ', oldest first' : ''})`))
    if (replies.length === 0) repliesBox.appendChild(statusLine('No replies found on your relays.'))
    for (const r of replies) repliesBox.appendChild(renderCompactNote(r, opts))
  }
  await draw()
  if (people.length > 0) {
    await loadProfiles(people, relays)
    if (repliesBox.isConnected) await draw()
  }
}

// ─── Menu ────────────────────────────────────────────────────────────────────

export { copyText }

let menuListenersInstalled = false

function closeAllMenus(except?: Element | null): void {
  document.querySelectorAll('.post-menu-dropdown:not(.hidden)').forEach((d) => {
    if (d === except) return
    d.classList.add('hidden')
    d.parentElement?.querySelector('.post-menu-btn')?.setAttribute('aria-expanded', 'false')
  })
}

/** One pair of document listeners for every card, however often the feed re-renders. */
function installMenuListeners(): void {
  if (menuListenersInstalled) return
  menuListenersInstalled = true
  document.addEventListener('click', (e) => {
    if (!(e.target as Element | null)?.closest?.('.post-context-menu')) closeAllMenus()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const open = document.querySelector('.post-menu-dropdown:not(.hidden)')
    if (!open) return
    closeAllMenus()
    ;(open.parentElement?.querySelector('.post-menu-btn') as HTMLElement | null)?.focus()
  })
}

function renderMenu(post: DisplayPost, options: RenderOptions, links: NoteLinks): HTMLElement {
  installMenuListeners()
  const preset = options.clientPreset ?? 'njump'
  const label = links.clientLabel
  const { npub, nprofile, nevent } = links

  const container = el('div', 'post-context-menu')
  const btn = el('button', 'post-menu-btn') as HTMLButtonElement
  btn.type = 'button'
  btn.innerHTML = icon('more', 20)
  btn.title = 'More'
  btn.setAttribute('aria-label', 'More actions')
  btn.setAttribute('aria-haspopup', 'menu')
  btn.setAttribute('aria-expanded', 'false')

  const dropdown = el('div', 'post-menu-dropdown hidden')
  dropdown.setAttribute('role', 'menu')

  const items = (): HTMLElement[] => Array.from(dropdown.querySelectorAll<HTMLElement>('[role="menuitem"]'))

  const close = (): void => {
    dropdown.classList.add('hidden')
    btn.setAttribute('aria-expanded', 'false')
  }

  const addCopy = (text: string, value: string): void => {
    if (!value) return
    const item = el('button', 'post-menu-item') as HTMLButtonElement
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    item.textContent = text
    item.addEventListener('click', async (e) => {
      e.stopPropagation()
      const ok = await copyText(value)
      item.textContent = ok ? 'Copied' : 'Copy failed'
      setTimeout(() => {
        item.textContent = text
        close()
        btn.focus()
      }, 900)
    })
    dropdown.appendChild(item)
  }

  const addLink = (text: string, href: string): void => {
    const safe = safeLink(href)
    if (!safe) return
    const item = document.createElement('a')
    item.className = 'post-menu-item'
    item.setAttribute('role', 'menuitem')
    item.href = safe
    item.target = '_blank'
    item.rel = 'noopener'
    item.textContent = text
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      close()
    })
    dropdown.appendChild(item)
  }

  // Private feedback first: none of it is published, and each can be undone.
  const addPrivate = (text: string, run: () => void): HTMLButtonElement => {
    const item = el('button', 'post-menu-item') as HTMLButtonElement
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    item.textContent = text
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      close()
      // A hide removes this card: keep keyboard focus nearby rather than at the top of the page.
      const card = btn.closest<HTMLElement>('.note')
      const next = (card?.nextElementSibling ?? card?.previousElementSibling) as HTMLElement | null
      run()
      if (btn.isConnected) btn.focus()
      else (next?.isConnected ? next : document.getElementById('status'))?.focus()
    })
    dropdown.appendChild(item)
    return item
  }
  const undoable = (message: string, undo: (() => void) | null): void => {
    // No timeout: Undo has to be reachable by keyboard and screen reader.
    if (undo) showToast(message, { action: { label: 'Undo', run: undo } })
    else showToast('This note has no text to learn from.', { tone: 'error' })
  }
  const heading = el('p', 'post-menu-label')
  heading.textContent = 'Private, never published'
  dropdown.appendChild(heading)
  addPrivate('More like this', () => undoable('Noted privately: more like this. It steers future rankings.', addRule('more', post)))
  addPrivate('Less like this', () => {
    const undoRule = addRule('less', post)
    const undoHide = hideNote(post.id)
    // A note with no words still hides; there is just nothing for the ranking to learn.
    if (undoRule) undoable('Hidden, and noted privately: less like this.', () => { undoHide(); undoRule() })
    else undoable('Hidden. It has no text, so it does not steer rankings.', undoHide)
  })
  addPrivate('Hide this note', () => undoable('Note hidden on this device.', hideNote(post.id)))
  const who = authorLabel(post.author, options.profiles?.get(post.author))
  addPrivate(`Hide notes from ${who.isNpub ? 'this person' : who.text}`, () => undoable(`Notes from ${who.isNpub ? 'this person' : who.text} are hidden on this device.`, muteAuthor(post.author)))
  const saveItem = addPrivate('Save for later', () => {
    if (isSaved(post.id)) unsaveNote(post.id)
    else undoable('Saved for later on this device. Find it under Saved in the feed.', saveNote(post))
  })
  dropdown.appendChild(el('hr', 'post-menu-sep'))

  addCopy('Copy npub', npub)
  addCopy('Copy nprofile', nprofile)
  addLink(`Open profile in ${label}`, profileHref(post.author, options))
  if (preset !== 'app' && npub) addLink('Open profile in my Nostr app (nostr: link)', nostrUri(nprofile || npub))
  if (nevent) {
    addCopy('Copy note link (nevent)', nevent)
    addLink(`Open note in ${label}`, buildEventUrl(options.eventUrlTemplate ?? '', nevent))
    if (preset !== 'app') addLink('Open note in my Nostr app (nostr: link)', nostrUri(nevent))
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const wasHidden = dropdown.classList.contains('hidden')
    closeAllMenus()
    if (!wasHidden) return
    saveItem.textContent = isSaved(post.id) ? 'Remove from saved' : 'Save for later'
    dropdown.classList.remove('hidden', 'opens-up')
    // Open upward when there is no room below (above the tab bar).
    if (dropdown.getBoundingClientRect().bottom > window.innerHeight - 88) dropdown.classList.add('opens-up')
    btn.setAttribute('aria-expanded', 'true')
    items()[0]?.focus()
  })

  dropdown.addEventListener('keydown', (e) => {
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      list[(at + 1) % list.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      list[(at - 1 + list.length) % list.length]?.focus()
    } else if (e.key === 'Tab') {
      close()
    }
  })

  container.appendChild(btn)
  container.appendChild(dropdown)
  return container
}

/**
 * Render an embedded post (for quotes).
 */
function renderEmbeddedPost(post: EmbeddedPost, options: RenderOptions): HTMLElement {
  const container = el('div', 'embedded-post')

  const header = el('div', 'embedded-header')
  header.appendChild(renderAvatar(post.author, options, 'embedded-avatar'))

  const authorEl = el('div', 'embedded-author')
  authorEl.appendChild(personLink(post.author, options, 'author-link'))
  header.appendChild(authorEl)
  container.appendChild(header)

  const content = el('div', 'embedded-content')
  content.appendChild(renderContent(post.content, options))
  container.appendChild(content)
  options.linkPreviews?.(post.content, container)

  const media = extractMedia(post.content, [])
  if (media.length > 0) {
    const mediaContainer = el('div', 'post-media')
    for (const m of media) mediaContainer.appendChild(renderMedia(m, options))
    container.appendChild(mediaContainer)
  }

  return container
}

// ─── Content formatting ──────────────────────────────────────────────────────

interface MediaItem {
  type: 'image' | 'video'
  url: string
  width?: number
  height?: number
  /** The author's description; never invented here. */
  alt?: string
}

/**
 * Build post text as DOM nodes.
 *
 * Plain text goes in as text nodes (so nothing in a post can inject markup),
 * `nostr:npub/nprofile` mentions become "@name" links or a truncated-npub
 * element, and media URLs are dropped here because they render as media.
 */
function renderContent(content: string, options: RenderOptions): DocumentFragment {
  const frag = document.createDocumentFragment()
  const tokens = tokenizeContent(content)
  const text = (t: string): void => {
    if (t) frag.appendChild(document.createTextNode(t))
  }

  tokens.forEach((token, i) => {
    switch (token.kind) {
      case 'text': {
        let t = token.text.replace(/\n{3,}/g, '\n\n')
        if (i === 0) t = t.replace(/^\s+/, '')
        if (i === tokens.length - 1) t = t.replace(/\s+$/, '')
        text(t)
        break
      }
      case 'profile': {
        if (!token.pubkey) {
          text('@unknown')
          break
        }
        const a = personLink(token.pubkey, options, 'nostr-profile-link', '@')
        frag.appendChild(a)
        break
      }
      case 'ref': {
        const a = document.createElement('a')
        a.className = 'nostr-ref-link'
        a.href = safeLink(buildEventUrl(options.eventUrlTemplate ?? '', token.bech32)) ?? '#'
        a.target = '_blank'
        a.rel = 'noopener'
        a.textContent = '[referenced post]'
        frag.appendChild(a)
        break
      }
      case 'url': {
        if (isMediaUrl(token.url)) break
        const safe = safeLink(token.url)
        if (safe) {
          const a = document.createElement('a')
          a.href = safe
          a.target = '_blank'
          a.rel = 'noopener'
          a.textContent = token.url
          frag.appendChild(a)
        } else {
          text(token.url)
        }
        text(token.trailing)
        break
      }
    }
  })

  return frag
}

/**
 * Media items from the note's imeta summary and the media URLs in its text.
 */
function extractMedia(content: string, meta: readonly MediaMeta[]): MediaItem[] {
  const items: MediaItem[] = []
  const seen = new Set<string>()
  const known = new Map(meta.map((m) => [m.url, m]))
  const add = (url: string): void => {
    if (seen.has(url)) return
    seen.add(url)
    const m = known.get(url)
    const video = m?.mime ? m.mime.startsWith('video/') : isVideoUrl(url)
    items.push({ type: video ? 'video' : 'image', url, width: m?.width, height: m?.height, alt: m?.alt })
  }
  for (const m of meta) add(m.url)
  for (const url of content.match(/https?:\/\/[^\s]+/g) ?? []) {
    const clean = url.replace(/[)>]+$/, '') // Strip trailing punctuation
    if (isMediaUrl(clean)) add(clean)
  }
  return items
}

/**
 * Render a media item (image or video).
 */
function renderMedia(item: MediaItem, options: RenderOptions): HTMLElement {
  if (item.type === 'video') {
    // Click-to-load rather than a <video src> with preload="metadata".
    //
    // "metadata" is not the small fetch it sounds like. For an MP4 whose moov
    // atom sits at the end of the file — anything not written with faststart —
    // the browser has to hunt for it, and in practice pulls hundreds of
    // kilobytes to several megabytes per clip. A 500-post feed carried 34
    // videos, the sampled ones totalling ~400 MB of source material, none of
    // which anyone had asked to watch. (The hosts themselves are fine: all 12
    // sampled honour Range correctly. The waste is on our side.)
    //
    // Requesting nothing until the placeholder is clicked sidesteps the whole
    // question.
    const holder = el('div', 'video-placeholder')
    holder.setAttribute('role', 'button')
    holder.setAttribute('tabindex', '0')
    holder.title = item.url

    const play = el('div', 'video-play-icon')
    play.innerHTML = icon('play', 28)
    const label = el('div', 'video-placeholder-label')
    label.textContent = 'Load video'
    holder.appendChild(play)
    holder.appendChild(label)

    const load = (): void => {
      const video = document.createElement('video')
      video.src = item.url
      video.controls = true
      video.autoplay = true
      video.muted = true
      video.playsInline = true
      video.className = 'post-video'
      holder.replaceWith(video)
    }

    holder.addEventListener('click', load)
    holder.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
        e.preventDefault()
        load()
      }
    })
    return holder
  }

  return options.dataSaver ? imagePlaceholder(item) : renderImage(item)
}

/** Data saver: nothing is requested from the image host until the reader asks. */
function imagePlaceholder(item: MediaItem): HTMLElement {
  const holder = el('button', 'media-placeholder') as HTMLButtonElement
  holder.type = 'button'
  let host = ''
  try {
    host = new URL(item.url).hostname
  } catch {
    // shown without a host
  }
  holder.textContent = item.alt ? `Load image: ${item.alt}` : `Load image${host ? ` from ${host}` : ''}`
  if (item.width && item.height) holder.style.aspectRatio = `${item.width} / ${item.height}`
  holder.addEventListener('click', (e) => {
    e.stopPropagation()
    const image = renderImage(item)
    holder.replaceWith(image)
    image.querySelector('a')?.focus()
  })
  return holder
}

/**
 * An image in its own proportions: the space is reserved when the size is known, a tall
 * image is shown whole (letterboxed) rather than cropped, and it links to the full file.
 */
function renderImage(item: MediaItem): HTMLElement {
  const figure = el('figure', 'post-image')
  const link = document.createElement('a')
  const safe = safeLink(item.url)
  if (safe) {
    link.href = safe
    link.target = '_blank'
    link.rel = 'noopener'
  }
  link.setAttribute('aria-label', item.alt ? `Open full image: ${item.alt}` : 'Open full image')
  const img = document.createElement('img')
  img.src = item.url
  // The author's description when there is one; otherwise say plainly that none was given.
  img.alt = item.alt ?? 'Image without a description'
  img.loading = 'lazy'
  img.decoding = 'async'
  if (item.width && item.height) {
    img.width = item.width
    img.height = item.height
    img.style.aspectRatio = `${item.width} / ${item.height}`
  }
  img.onerror = () => {
    figure.replaceChildren(statusLine('This image could not be loaded.'))
  }
  link.appendChild(img)
  figure.appendChild(link)
  return figure
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

function isMediaUrl(url: string): boolean {
  return isImageUrl(url) || isVideoUrl(url)
}

function isImageUrl(url: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?.*)?$/i.test(url) ||
    url.includes('nostr.build') && !isVideoUrl(url)
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|ogg)(\?.*)?$/i.test(url)
}

function el(tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag)
  if (className) element.className = className
  return element
}
