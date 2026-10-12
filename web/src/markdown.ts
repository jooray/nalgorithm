import { tokenizeContent, type ContentToken } from './identity.js'

/**
 * The light markdown people write in notes, turned into styled pieces.
 *
 * Covers **bold** / __bold__, *italic* / _italic_ (never inside snake_case
 * words), `code`, ~~strike~~, # headings (a bold line), - and * bullets (•),
 * horizontal rules and [label](https://…) links. Emphasis may wrap a mention
 * or a link. Everything else stays as written. The output is data, never
 * markup: renderers turn it into text nodes and elements.
 *
 * Kept in step with the Android app's NoteMarkdown.kt.
 */

export interface TextStyle {
  bold: boolean
  italic: boolean
  code: boolean
  strike: boolean
}

export type ContentPiece =
  | { kind: 'text'; text: string; style: TextStyle }
  | { kind: 'token'; token: Exclude<ContentToken, { kind: 'text' }>; style: TextStyle }
  | { kind: 'link'; label: string; url: string; style: TextStyle }

const BOLD = 1
const ITALIC = 2
const CODE = 4
const STRIKE = 8

// Private-use characters stand in for tokens and links while the inline pass runs.
const TOKEN_BASE = 0xe000
const LINK_BASE = 0xf000
const MAX_PLACEHOLDERS = 0x800
const PRIVATE_USE = /[-]/g
/** A consumed delimiter in the working copy: neither a word, a space nor a marker. */
const GONE = '\u0001'
/** Code text in the working copy, so no other pattern matches inside it. */
const INERT = '\u0002'

const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm
const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm
const BULLET = /^([ \t]*)[-*+][ \t]+/gm
const LINK = /(!?)\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g

interface Inline {
  pattern: RegExp
  delimiter: number
  flag: number
}

const INLINE: Inline[] = [
  { pattern: /\*\*(?=[^\s*])([^\n]*?[^\s*])\*\*/gu, delimiter: 2, flag: BOLD },
  { pattern: /(?<![\p{L}\p{N}_])__(?=[^\s_])([^\n]*?[^\s_])__(?![\p{L}\p{N}_])/gu, delimiter: 2, flag: BOLD },
  { pattern: /~~(?=\S)([^\n]*?\S)~~/gu, delimiter: 2, flag: STRIKE },
  { pattern: /(?<![\p{L}\p{N}*])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\p{L}\p{N}*])/gu, delimiter: 1, flag: ITALIC },
  { pattern: /(?<![\p{L}\p{N}_])_(?=[^\s_])([^\n_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, delimiter: 1, flag: ITALIC },
]

function styleOf(mask: number): TextStyle {
  return { bold: (mask & BOLD) !== 0, italic: (mask & ITALIC) !== 0, code: (mask & CODE) !== 0, strike: (mask & STRIKE) !== 0 }
}

/**
 * Split note text into styled pieces. [isMedia] says whether an `![alt](url)`
 * image is shown as media elsewhere (then it is dropped from the text).
 */
export function formatContent(content: string, isMedia: (url: string) => boolean = () => false): ContentPiece[] {
  const links: { label: string; url: string }[] = []
  const prepared = content
    .replace(PRIVATE_USE, '�')
    .replace(RULE, '———')
    .replace(HEADING, '**$1**')
    .replace(BULLET, '$1• ')
    .replace(LINK, (whole, bang: string, label: string, url: string) => {
      if (bang && isMedia(url)) return ''
      if (links.length >= MAX_PLACEHOLDERS) return whole
      links.push({ label, url })
      return String.fromCharCode(LINK_BASE + links.length - 1)
    })

  const tokens = tokenizeContent(prepared)
  const others: Exclude<ContentToken, { kind: 'text' }>[] = []
  let original = ''
  for (const t of tokens) {
    if (t.kind === 'text') original += t.text
    else if (others.length < MAX_PLACEHOLDERS) {
      others.push(t)
      original += String.fromCharCode(TOKEN_BASE + others.length - 1)
    }
  }

  // Work on UTF-16 code units so regex indexes line up with the arrays below.
  const units = original.split('')
  const work = units.slice()
  const removed = new Array<boolean>(units.length).fill(false)
  const mask = new Array<number>(units.length).fill(0)

  // Code first: nothing inside it is markdown.
  for (const m of original.matchAll(/`([^`\n]+)`/g)) {
    const at = m.index ?? 0
    const end = at + m[0].length
    removed[at] = removed[end - 1] = true
    work[at] = work[end - 1] = GONE
    for (let i = at + 1; i < end - 1; i++) {
      mask[i] |= CODE
      if (!isPlaceholder(units[i])) work[i] = INERT
    }
  }

  for (const { pattern, delimiter, flag } of INLINE) {
    const current = work.join('')
    for (const m of current.matchAll(pattern)) {
      const at = m.index ?? 0
      const end = at + m[0].length
      for (let i = 0; i < delimiter; i++) {
        removed[at + i] = removed[end - 1 - i] = true
        work[at + i] = work[end - 1 - i] = GONE
      }
      for (let i = at + delimiter; i < end - delimiter; i++) mask[i] |= flag
    }
  }

  const pieces: ContentPiece[] = []
  let text = ''
  let textMask = -1
  const flush = (): void => {
    if (text) pieces.push({ kind: 'text', text, style: styleOf(textMask) })
    text = ''
  }
  for (let i = 0; i < units.length; i++) {
    if (removed[i]) continue
    const ch = units[i]
    const code = ch.charCodeAt(0)
    if (code >= LINK_BASE && code < LINK_BASE + links.length) {
      flush()
      const link = links[code - LINK_BASE]
      pieces.push({ kind: 'link', label: link.label, url: link.url, style: styleOf(mask[i]) })
    } else if (code >= TOKEN_BASE && code < TOKEN_BASE + others.length) {
      flush()
      pieces.push({ kind: 'token', token: others[code - TOKEN_BASE], style: styleOf(mask[i]) })
    } else {
      if (mask[i] !== textMask) flush()
      textMask = mask[i]
      text += ch
    }
  }
  flush()

  // Blank-line runs collapse, and the note starts and ends with something to read.
  for (const p of pieces) if (p.kind === 'text') p.text = p.text.replace(/\n{3,}/g, '\n\n')
  const first = pieces[0]
  if (first?.kind === 'text') first.text = first.text.replace(/^\s+/, '')
  const last = pieces[pieces.length - 1]
  if (last?.kind === 'text') last.text = last.text.replace(/\s+$/, '')
  return pieces.filter((p) => p.kind !== 'text' || p.text !== '')
}

function isPlaceholder(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return code >= TOKEN_BASE && code < LINK_BASE + MAX_PLACEHOLDERS
}

/** A note long enough that a feed card shows it shortened, with Read more. */
export function isLongNote(content: string): boolean {
  if (content.length > 600) return true
  let lines = 1
  for (const ch of content) if (ch === '\n' && ++lines > 12) return true
  return false
}
