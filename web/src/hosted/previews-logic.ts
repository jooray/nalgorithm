/**
 * Link previews, the parts that need no DOM: which URLs of a post get a card,
 * and what a server answer may put on the page. Hosted mode only; the server
 * fetches the pages, because a browser cannot read other sites (CORS).
 */

export const MAX_CARDS_PER_POST = 2

export interface LinkCard {
  title: string
  description: string
  siteName: string
  /** A path under the API base, never anything else. Empty when there is no image. */
  image: string
}

// Mirrors render.ts: what it shows inline as media is never previewed.
const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|svg|avif|mp4|webm|mov|ogg|mp3|wav|flac|m4a|aac|opus)$/i

function isMedia(u: URL): boolean {
  return MEDIA_EXT.test(u.pathname) || u.hostname === 'nostr.build' || u.hostname.endsWith('.nostr.build')
}

/**
 * The first http(s) URLs of `content` that deserve a card: not media, not the
 * app's own host, each page once. `ownHost` is `location.host`.
 */
export function extractPreviewUrls(content: string, ownHost = '', max = MAX_CARDS_PER_POST): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of content.match(/https?:\/\/[^\s<>"]+/gi) ?? []) {
    let url: URL
    try {
      url = new URL(raw.replace(/[)\]>.,;:!?'"]+$/, ''))
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    if (url.username || url.password) continue
    if (isMedia(url) || (ownHost && url.host === ownHost)) continue
    url.hash = ''
    const key = url.toString()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= max) break
  }
  return out
}

/** The one shape an image path may have: what the server's `/preview/image` hands out. */
export function safeImagePath(value: unknown): string {
  return typeof value === 'string' && /^preview\/image\?u=[\w-]{1,4096}&s=[\w-]{1,128}$/.test(value) ? value : ''
}

/** A card from a server answer, or null when there is nothing to show. Text is used with textContent only. */
export function readLinkCard(data: unknown): LinkCard | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.unavailable === true) return null
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const title = text(d.title, 200)
  const description = text(d.description, 400)
  if (!title && !description) return null
  return { title, description, siteName: text(d.siteName, 100), image: safeImagePath(d.image) }
}

/** Off only when the person turned it off; a server that predates the setting means on. */
export function previewsEnabled(settings: { linkPreviews?: boolean } | null | undefined): boolean {
  return settings?.linkPreviews !== false
}
