/**
 * Nalgorithm Web — what this reader has done to which note
 *
 * Liked, boosted and zapped notes stay marked across reloads, per Nostr key,
 * in localStorage. The marks are this device's memory, not a query of relays:
 * they appear the moment an action is sent and survive relays that never echo
 * it back. Storage can be blocked, so every access is guarded.
 */

import { parseNoteState, trimNoteState, type NoteState } from './note-logic.js'

const PREFIX = 'nalgorithm_noteactions_'

const cache = new Map<string, NoteState>()
const listeners = new Set<(id: string) => void>()

function read(pubkey: string): NoteState {
  let state = cache.get(pubkey)
  if (!state) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(PREFIX + pubkey)
    } catch {
      // blocked storage: marks last for this page view only
    }
    state = parseNoteState(raw)
    cache.set(pubkey, state)
  }
  return state
}

export type Mark = 'liked' | 'boosted' | 'zapped'

export function markOf(pubkey: string | null, mark: Mark, id: string): number | undefined {
  if (!pubkey) return undefined
  return read(pubkey)[mark][id]
}

/** Record an action. For a zap, `value` is the sats sent (added to earlier zaps). */
export function setMark(pubkey: string, mark: Mark, id: string, value = Math.floor(Date.now() / 1000)): void {
  const state = read(pubkey)
  state[mark][id] = mark === 'zapped' ? (state.zapped[id] ?? 0) + value : value
  const trimmed = trimNoteState(state)
  cache.set(pubkey, trimmed)
  try {
    localStorage.setItem(PREFIX + pubkey, JSON.stringify(trimmed))
  } catch {
    // not remembered across reloads
  }
  for (const l of listeners) l(id)
}

/** Undo a mark that was set optimistically and then failed. */
export function clearMark(pubkey: string, mark: Mark, id: string): void {
  const state = read(pubkey)
  delete state[mark][id]
  try {
    localStorage.setItem(PREFIX + pubkey, JSON.stringify(state))
  } catch {
    // ignore
  }
  for (const l of listeners) l(id)
}

/** Call `fn` whenever a note's marks change. Return a function that stops it. */
export function onMarkChange(fn: (id: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
