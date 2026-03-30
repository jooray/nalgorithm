/**
 * Nalgorithm Web — Rich post rendering
 *
 * Layout per card:
 *   [profile pic] [display name] [type label]    [timestamp]
 *   [post content]
 *   [media]
 *   [embedded post for quotes/boosts]
 *   [score bar — clickable to expand justification]
 *   [...] context menu (Copy Nevent, Copy URL)
 */

import type { ScoredPost, EmbeddedPost, ProfileData } from 'nalgorithm'
import * as nip19 from 'nostr-tools/nip19'

export interface RenderOptions {
  profiles?: Map<string, ProfileData>
  njumpBaseUrl?: string
}

/**
 * Render a list of scored posts into the feed container.
 */
export function renderFeed(
  posts: ScoredPost[],
  container: HTMLElement,
  options: RenderOptions = {}
): void {
  container.innerHTML = ''

  if (posts.length === 0) {
    container.innerHTML = '<p class="feed-empty">No posts to display.</p>'
    return
  }

  for (const post of posts) {
    container.appendChild(renderPostCard(post, options))
  }
}

/**
 * Render a single post card.
 */
function renderPostCard(post: ScoredPost, options: RenderOptions): HTMLElement {
  const card = el('article', 'post-card')

  // ── Header: profile pic + name + type label + timestamp ──
  const header = el('div', 'post-header')

  // Profile picture
  const profile = options.profiles?.get(post.author)
  const avatarContainer = el('div', 'post-avatar')
  if (profile?.picture) {
    const img = document.createElement('img')
    img.src = profile.picture
    img.alt = profile.name ?? 'avatar'
    img.loading = 'lazy'
    img.onerror = () => {
      img.style.display = 'none'
      avatarContainer.textContent = post.author.slice(0, 2)
      avatarContainer.classList.add('post-avatar-fallback')
    }
    avatarContainer.appendChild(img)
  } else {
    avatarContainer.textContent = post.author.slice(0, 2)
    avatarContainer.classList.add('post-avatar-fallback')
  }
  header.appendChild(avatarContainer)

  // Name + type
  const meta = el('div', 'post-meta')
  const author = el('div', 'post-author')
  author.textContent = profile?.name ?? formatAuthor(post.author)
  author.title = post.author
  meta.appendChild(author)

  if (post.type !== 'original') {
    const typeLabel = el('span', 'post-type-label')
    typeLabel.textContent = post.type === 'boost' ? 'Boosted' : 'Quoted'
    meta.appendChild(typeLabel)
  }

  header.appendChild(meta)

  // Timestamp (right side)
  const time = el('span', 'post-time')
  time.textContent = formatTime(post.createdAt)
  header.appendChild(time)

  card.appendChild(header)

  // ── Content ──
  if (post.type === 'boost' && post.originalPost) {
    const embedded = renderEmbeddedPost(post.originalPost, options)
    card.appendChild(embedded)
  } else {
    const content = el('div', 'post-content')
    content.innerHTML = formatContent(post.content, options)
    card.appendChild(content)

    // Media
    const media = extractMedia(post.content, post.rawEvent?.tags ?? [])
    if (media.length > 0) {
      const mediaContainer = el('div', 'post-media')
      for (const m of media) {
        mediaContainer.appendChild(renderMedia(m))
      }
      card.appendChild(mediaContainer)
    }

    // For quote posts, show the embedded post
    if (post.type === 'quote' && post.quotedPost) {
      const embedded = renderEmbeddedPost(post.quotedPost, options)
      card.appendChild(embedded)
    }
  }

  // ── Score row (below content) ──
  const scoreRow = el('div', 'post-score-row')
  scoreRow.title = 'Click to see justification'

  const scoreBar = el('div', 'post-score-bar')
  const scoreFill = el('div', `post-score-fill ${getScoreClass(post.score)}`)
  scoreFill.style.width = `${(post.score / 10) * 100}%`
  scoreBar.appendChild(scoreFill)

  const scoreLabel = el('span', `post-score-label ${getScoreClass(post.score)}`)
  scoreLabel.textContent = post.score.toFixed(1)

  scoreRow.appendChild(scoreBar)
  scoreRow.appendChild(scoreLabel)

  // Justification (hidden by default, shown on click)
  const justification = el('div', 'post-justification hidden')
  if (post.justification) {
    justification.textContent = post.justification
  } else {
    justification.textContent = 'No justification available'
  }

  scoreRow.addEventListener('click', () => {
    justification.classList.toggle('hidden')
  })

  card.appendChild(scoreRow)
  card.appendChild(justification)

  // ── Footer: context menu ──
  const footer = el('div', 'post-footer')

  const menuContainer = el('div', 'post-context-menu')
  const menuBtn = el('button', 'post-menu-btn')
  menuBtn.textContent = '\u2022\u2022\u2022' // three dots (•••)
  menuBtn.title = 'Actions'

  const dropdown = el('div', 'post-menu-dropdown hidden')

  // Generate nevent
  let neventStr = ''
  try {
    neventStr = nip19.neventEncode({ id: post.id, author: post.author, kind: post.rawEvent?.kind })
  } catch {
    // fallback — use raw hex
    neventStr = post.id
  }

  const copyNeventItem = el('button', 'post-menu-item')
  copyNeventItem.textContent = 'Copy Nevent ID'
  copyNeventItem.addEventListener('click', (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(neventStr).catch(() => {})
    closeDropdown()
  })

  const baseUrl = (options.njumpBaseUrl ?? 'https://njump.me/').replace(/\/?$/, '/')
  const postUrl = baseUrl + neventStr

  const copyUrlItem = el('button', 'post-menu-item')
  copyUrlItem.textContent = 'Copy URL'
  copyUrlItem.addEventListener('click', (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(postUrl).catch(() => {})
    closeDropdown()
  })

  const openUrlItem = el('button', 'post-menu-item')
  openUrlItem.textContent = 'Open in njump'
  openUrlItem.addEventListener('click', (e) => {
    e.stopPropagation()
    window.open(postUrl, '_blank', 'noopener')
    closeDropdown()
  })

  dropdown.appendChild(copyNeventItem)
  dropdown.appendChild(copyUrlItem)
  dropdown.appendChild(openUrlItem)

  function closeDropdown() {
    dropdown.classList.add('hidden')
  }

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    // Close any other open dropdowns
    document.querySelectorAll('.post-menu-dropdown').forEach((d) => d.classList.add('hidden'))
    dropdown.classList.toggle('hidden')
  })

  // Close dropdown on outside click
  document.addEventListener('click', closeDropdown)

  menuContainer.appendChild(menuBtn)
  menuContainer.appendChild(dropdown)

  footer.appendChild(menuContainer)
  card.appendChild(footer)

  return card
}

/**
 * Render an embedded post (for quotes and boosts).
 */
function renderEmbeddedPost(post: EmbeddedPost, options: RenderOptions): HTMLElement {
  const container = el('div', 'embedded-post')
  const njumpBase = (options.njumpBaseUrl ?? 'https://njump.me/').replace(/\/?$/, '/')

  // ── Header: avatar + name (like top-level posts) ──
  const header = el('div', 'embedded-header')

  const profile = options.profiles?.get(post.author)
  const avatarContainer = el('div', 'embedded-avatar')
  if (profile?.picture) {
    const img = document.createElement('img')
    img.src = profile.picture
    img.alt = profile.name ?? 'avatar'
    img.loading = 'lazy'
    img.onerror = () => {
      img.style.display = 'none'
      avatarContainer.textContent = post.author.slice(0, 2)
      avatarContainer.classList.add('post-avatar-fallback')
    }
    avatarContainer.appendChild(img)
  } else {
    avatarContainer.textContent = post.author.slice(0, 2)
    avatarContainer.classList.add('post-avatar-fallback')
  }
  header.appendChild(avatarContainer)

  const authorEl = el('div', 'embedded-author')
  const displayName = profile?.name ?? formatAuthor(post.author)
  const npub = nip19.npubEncode(post.author)
  const authorLink = document.createElement('a')
  authorLink.href = njumpBase + npub
  authorLink.target = '_blank'
  authorLink.rel = 'noopener'
  authorLink.textContent = displayName
  authorLink.title = post.author
  authorEl.appendChild(authorLink)
  header.appendChild(authorEl)

  container.appendChild(header)

  const content = el('div', 'embedded-content')
  content.innerHTML = formatContent(post.content, options)
  container.appendChild(content)

  // Extract and render media from embedded post content
  const media = extractMediaFromContent(post.content)
  if (media.length > 0) {
    const mediaContainer = el('div', 'post-media')
    for (const m of media) {
      mediaContainer.appendChild(renderMedia(m))
    }
    container.appendChild(mediaContainer)
  }

  return container
}

// ─── Content formatting ──────────────────────────────────────────────────────

interface MediaItem {
  type: 'image' | 'video'
  url: string
}

/**
 * Decode a nostr:npub1... or nostr:nprofile1... reference to a hex pubkey.
 * Returns null if decoding fails.
 */
function decodeNostrPubkey(bech32: string): string | null {
  try {
    const decoded = nip19.decode(bech32)
    if (decoded.type === 'npub') return decoded.data as string
    if (decoded.type === 'nprofile') return (decoded.data as { pubkey: string }).pubkey
  } catch {
    // Ignore decode failures
  }
  return null
}

/**
 * Format post content for HTML display.
 *
 * Strategy: work on RAW content (not pre-escaped). Split into tokens
 * (nostr refs, URLs, plain text), escape only the plain text segments,
 * and build HTML for the special tokens from unescaped source data.
 */
function formatContent(content: string, options: RenderOptions = {}): string {
  const njumpBase = (options.njumpBaseUrl ?? 'https://njump.me/').replace(/\/?$/, '/')
  const profiles = options.profiles

  // Tokenize: match nostr: references and URLs as special tokens
  // Everything between them is plain text that needs escaping
  const tokenPattern = /nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+|n(?:event|ote|addr)1[a-z0-9]+)|https?:\/\/[^\s]+/gi

  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenPattern.exec(content)) !== null) {
    // Append escaped plain text before this match
    if (match.index > lastIndex) {
      result += escapeHtml(content.slice(lastIndex, match.index))
    }

    const fullMatch = match[0]
    const nostrBech32 = match[1] // Capture group from nostr: pattern

    if (nostrBech32) {
      // nostr: reference
      if (/^npub1|^nprofile1/i.test(nostrBech32)) {
        // Profile reference — resolve to name + link
        const pubkey = decodeNostrPubkey(nostrBech32)
        const profile = pubkey ? profiles?.get(pubkey) : undefined
        const displayName = profile?.name ?? nostrBech32.slice(0, 16) + '...'
        const href = njumpBase + nostrBech32
        result += `<a href="${escapeAttr(href)}" target="_blank" rel="noopener" class="nostr-profile-link" title="${escapeAttr(pubkey ?? nostrBech32)}">@${escapeHtml(displayName)}</a>`
      } else {
        // Event/note/addr reference — generic link
        const href = njumpBase + nostrBech32
        result += `<a href="${escapeAttr(href)}" target="_blank" rel="noopener" class="nostr-ref-link">[referenced post]</a>`
      }
    } else {
      // URL — clean trailing punctuation, check if media
      const cleanUrl = fullMatch.replace(/[)>]+$/, '')
      if (isMediaUrl(cleanUrl)) {
        // Will be rendered separately as media; skip
      } else {
        result += `<a href="${escapeAttr(cleanUrl)}" target="_blank" rel="noopener">${escapeHtml(cleanUrl)}</a>`
        // Append any trailing chars that were stripped
        if (cleanUrl.length < fullMatch.length) {
          result += escapeHtml(fullMatch.slice(cleanUrl.length))
        }
      }
    }

    lastIndex = match.index + fullMatch.length
  }

  // Append remaining plain text
  if (lastIndex < content.length) {
    result += escapeHtml(content.slice(lastIndex))
  }

  // Clean up extra whitespace from removed media URLs
  result = result.replace(/\n{3,}/g, '\n\n').trim()

  return result
}

/**
 * Extract media items from post content and imeta tags.
 */
function extractMedia(content: string, tags: string[][]): MediaItem[] {
  const items: MediaItem[] = []
  const seen = new Set<string>()

  // From imeta tags
  for (const tag of tags) {
    if (tag[0] !== 'imeta') continue
    for (const entry of tag.slice(1)) {
      if (entry.startsWith('url ')) {
        const url = entry.slice(4).trim()
        if (!seen.has(url)) {
          seen.add(url)
          items.push({
            type: isVideoUrl(url) ? 'video' : 'image',
            url,
          })
        }
      }
    }
  }

  // From content URLs
  const urlMatches = content.match(/https?:\/\/[^\s]+/g) ?? []
  for (const url of urlMatches) {
    const clean = url.replace(/[)>]+$/, '') // Strip trailing punctuation
    if (isMediaUrl(clean) && !seen.has(clean)) {
      seen.add(clean)
      items.push({
        type: isVideoUrl(clean) ? 'video' : 'image',
        url: clean,
      })
    }
  }

  return items
}

/**
 * Extract media from content only (no tags — for embedded posts).
 */
function extractMediaFromContent(content: string): MediaItem[] {
  return extractMedia(content, [])
}

/**
 * Render a media item (image or video).
 */
function renderMedia(item: MediaItem): HTMLElement {
  if (item.type === 'video') {
    const video = document.createElement('video')
    video.src = item.url
    video.controls = true
    video.preload = 'metadata'
    video.muted = true
    return video
  }

  const img = document.createElement('img')
  img.src = item.url
  img.alt = 'Post media'
  img.loading = 'lazy'
  img.onerror = () => {
    img.style.display = 'none'
  }
  return img
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

function getScoreClass(score: number): string {
  if (score >= 7) return 'score-high'
  if (score >= 4) return 'score-mid'
  return 'score-low'
}

function formatAuthor(pubkey: string): string {
  return pubkey.slice(0, 8) + '...' + pubkey.slice(-4)
}

function formatTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))

  if (diffHours < 1) {
    const diffMin = Math.floor(diffMs / (1000 * 60))
    return `${diffMin}m ago`
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function el(tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag)
  if (className) element.className = className
  return element
}
