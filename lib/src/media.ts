/**
 * Media attached to a note, from its NIP-92 `imeta` tags: address, size,
 * description and type. Both modes render from this one shape; the hosted
 * server sends it instead of the raw event, so tag-only media still shows.
 */

export interface MediaMeta {
  url: string
  /** Intrinsic size in pixels, when the author's client recorded it. */
  width?: number
  height?: number
  /** The author's own description of the media. */
  alt?: string
  /** MIME type, such as image/jpeg or video/mp4. */
  mime?: string
}

const MAX_MEDIA = 8
const MAX_ALT = 500

/** Safe, bounded media metadata from a note's tags. Only http(s) addresses are kept. */
export function readImeta(tags: readonly (readonly string[])[] | undefined): MediaMeta[] {
  const out: MediaMeta[] = []
  for (const tag of tags ?? []) {
    if (tag[0] !== 'imeta' || out.length >= MAX_MEDIA) continue
    const meta: Partial<MediaMeta> = {}
    for (const entry of tag.slice(1)) {
      const space = entry.indexOf(' ')
      if (space < 1) continue
      const name = entry.slice(0, space)
      const value = entry.slice(space + 1).trim()
      if (name === 'url' && /^https?:\/\//i.test(value)) meta.url = value
      else if (name === 'dim') {
        const m = /^(\d{1,5})x(\d{1,5})$/.exec(value)
        if (m && Number(m[1]) > 0 && Number(m[2]) > 0) {
          meta.width = Number(m[1])
          meta.height = Number(m[2])
        }
      } else if (name === 'alt' && value) meta.alt = value.slice(0, MAX_ALT)
      else if (name === 'm' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(value)) meta.mime = value.toLowerCase()
    }
    if (meta.url && !out.some((m) => m.url === meta.url)) out.push(meta as MediaMeta)
  }
  return out
}
