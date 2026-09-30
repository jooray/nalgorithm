/**
 * A small, tolerant reader for the head of an HTML page. It is a single linear
 * scan (no backtracking patterns), looks only at the first part of the
 * document, never builds a DOM and never runs anything.
 */

export interface ParsedPreview {
  title: string
  description: string
  siteName: string
  /** Absolute http(s) URL of the page's image, or empty. */
  image: string
  type: string
}

export const TITLE_MAX = 200
export const DESCRIPTION_MAX = 400
const SITE_MAX = 100
/** Only this much of the document is looked at; metadata lives in the head. */
const SCAN_LIMIT = 256 * 1024

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
  eacute: 'é', egrave: 'è', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' '
      return String.fromCodePoint(code)
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

/** Decode, drop control characters, collapse whitespace, cut to `max` characters (whole code points). */
export function cleanText(text: string, max: number): string {
  const flat = decodeEntities(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

interface Tag {
  attrs: Record<string, string>
}

/** Attributes of one tag, read left to right; quotes are honoured, junk is skipped. */
function readAttributes(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  let i = 0
  const n = s.length
  while (i < n) {
    const before = i
    while (i < n && /[\s/]/.test(s[i])) i++
    const start = i
    while (i < n && !/[\s=/>]/.test(s[i])) i++
    const name = s.slice(start, i).toLowerCase()
    while (i < n && /\s/.test(s[i])) i++
    let value = ''
    if (s[i] === '=') {
      i++
      while (i < n && /\s/.test(s[i])) i++
      const q = s[i]
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, i + 1)
        value = s.slice(i + 1, end === -1 ? n : end)
        i = end === -1 ? n : end + 1
      } else {
        const vs = i
        while (i < n && !/\s/.test(s[i])) i++
        value = s.slice(vs, i)
      }
    }
    if (name && !(name in attrs)) attrs[name] = value
    if (i === before) i++ // always make progress on malformed input
  }
  return attrs
}

/** Find the `>` that ends a tag starting at `from`, skipping over quoted attribute values. */
function tagEnd(html: string, from: number): number {
  let quote = ''
  for (let i = from; i < html.length; i++) {
    const c = html[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

/**
 * The <meta> tags and the raw text of <title>. By default it stops at </head> or
 * <body>; with `wholeDocument` it reads on, because some sites (single-page apps
 * that render their tags late, such as fountain.fm) put them in the body, where
 * crawlers still find them.
 */
function scanHead(html: string, wholeDocument = false): { metas: Tag[]; title: string } {
  // ASCII-only lower-casing keeps every index aligned with `html`.
  const lower = html.replace(/[A-Z]+/g, (x) => x.toLowerCase())
  const metas: Tag[] = []
  let title = ''
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end === -1) break
      i = end + 3
      continue
    }
    const m = /^<\/?([a-z][a-z0-9:-]*)/.exec(lower.slice(lt, lt + 40))
    if (!m) {
      i = lt + 1
      continue
    }
    const name = m[1]
    const closing = html[lt + 1] === '/'
    if (!wholeDocument && closing && name === 'head') break
    if (!wholeDocument && !closing && name === 'body') break
    if (!closing && (name === 'script' || name === 'style' || name === 'noscript')) {
      // Anything inside is not metadata, even if it looks like a tag.
      const end = lower.indexOf(`</${name}`, lt + 1)
      if (end === -1) break
      const after = tagEnd(html, end)
      i = after === -1 ? html.length : after + 1
      continue
    }
    const end = tagEnd(html, lt + m[0].length)
    if (end === -1) break
    if (!closing && name === 'meta') metas.push({ attrs: readAttributes(html.slice(lt + m[0].length, end)) })
    if (!closing && name === 'title' && title === '') {
      const close = lower.indexOf('</title', end + 1)
      title = html.slice(end + 1, close === -1 ? Math.min(html.length, end + 1 + 2000) : close)
    }
    i = end + 1
  }
  return { metas, title }
}

function absoluteHttp(value: string, base: string): string {
  const v = decodeEntities(value).trim()
  if (!v || v.length > 2000) return ''
  try {
    const u = new URL(v, base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : ''
  } catch {
    return ''
  }
}

/** Read the preview metadata from `html`, resolving a relative image against `baseUrl`. */
export function parsePreview(html: string, baseUrl: string): ParsedPreview {
  const bounded = html.length > SCAN_LIMIT ? html.slice(0, SCAN_LIMIT) : html
  let { metas, title } = scanHead(bounded)
  // Only when the head carries no preview data at all is the body consulted. The
  // head always wins, so page content cannot override a site's own metadata.
  const hasSocial = (list: Tag[]): boolean =>
    list.some(({ attrs }) => /^(og:(title|description|image)|twitter:(title|description|image))/i.test((attrs.property ?? attrs.name ?? '').trim()) && attrs.content?.trim())
  if (!hasSocial(metas)) ({ metas, title } = scanHead(bounded, true))
  // First occurrence of each key wins; both `property` and `name` are used in the wild.
  const meta = new Map<string, string>()
  for (const { attrs } of metas) {
    const key = (attrs.property ?? attrs.name ?? '').trim().toLowerCase()
    const content = attrs.content
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content)
  }
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = meta.get(k)
      if (v !== undefined && v.trim() !== '') return v
    }
    return ''
  }
  return {
    title: cleanText(first('og:title', 'twitter:title') || title, TITLE_MAX),
    description: cleanText(first('og:description', 'twitter:description', 'description'), DESCRIPTION_MAX),
    siteName: cleanText(first('og:site_name'), SITE_MAX),
    image: absoluteHttp(first('og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image', 'twitter:image:src'), baseUrl),
    type: cleanText(first('og:type'), 40).toLowerCase() || 'website',
  }
}
