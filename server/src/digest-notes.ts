import { nip19 } from 'nostr-tools'
import type { DigestSourceNote } from 'nalgorithm'

/** Most notes listed in a digest DM. */
export const MAX_DM_NOTES = 10
/** Stored JSON stays under a MariaDB TEXT column (65535 bytes), with headroom. */
export const MAX_NOTES_JSON_BYTES = 60_000

const HEX64 = /^[0-9a-f]{64}$/

const size = (notes: DigestSourceNote[]): number => Buffer.byteLength(JSON.stringify(notes), 'utf8')

/**
 * The JSON to store for a digest's notes, bounded in size. Too large: the
 * contents are trimmed evenly first (so every note survives), then trailing
 * notes are dropped. Null when there is nothing to store.
 */
export function serializeNotes(notes: DigestSourceNote[]): string | null {
  let list = notes.filter((n) => HEX64.test(n.id) && HEX64.test(n.pubkey))
  if (list.length === 0) return null
  for (let cap = 750; size(list) > MAX_NOTES_JSON_BYTES && cap >= 50; cap = Math.floor(cap / 2)) {
    list = list.map((n) => ({ ...n, content: n.content.slice(0, cap) }))
  }
  while (list.length > 0 && size(list) > MAX_NOTES_JSON_BYTES) list = list.slice(0, -1)
  return list.length > 0 ? JSON.stringify(list) : null
}

/** Read stored notes; anything malformed (or null) gives an empty list. */
export function parseNotes(json: string | null | undefined): DigestSourceNote[] {
  if (!json) return []
  try {
    const v: unknown = JSON.parse(json)
    if (!Array.isArray(v)) return []
    return v.filter((n): n is DigestSourceNote => !!n && typeof n === 'object' && typeof n.id === 'string' && typeof n.pubkey === 'string')
  } catch {
    return []
  }
}

/** `nostr:nevent1...` with the author and, when known, a relay hint. */
export function noteLink(n: DigestSourceNote): string {
  return `nostr:${nip19.neventEncode({ id: n.id, author: n.pubkey, ...(n.relay ? { relays: [n.relay] } : {}), ...(typeof n.kind === 'number' ? { kind: n.kind } : {}) })}`
}

/**
 * The show-notes block for a DM: a blank line, "Notes:", one link per line.
 * At most `MAX_DM_NOTES`, and at most `room` characters, dropping the last
 * links first. Empty string when no note fits.
 */
export function notesSection(notes: DigestSourceNote[], room = Infinity): string {
  const lines: string[] = []
  for (const n of notes.slice(0, MAX_DM_NOTES)) {
    let line: string
    try {
      line = noteLink(n)
    } catch {
      continue
    }
    const next = `\n\nNotes:\n${[...lines, line].join('\n')}`
    if (next.length > room) break
    lines.push(line)
  }
  return lines.length > 0 ? `\n\nNotes:\n${lines.join('\n')}` : ''
}
