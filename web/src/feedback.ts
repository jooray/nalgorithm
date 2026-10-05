/**
 * Nalgorithm Web — private feedback on notes
 *
 * "More like this", "Less like this", hiding a note, hiding a person's notes,
 * and saving a note for later. None of it is published to Nostr; it is kept on
 * this device per identity, and the more/less rules also steer future ranking
 * (BYOK passes them to the model directly, hosted sends them to the server).
 * Every action can be undone, and Tune lists what is in effect.
 */

import { FEEDBACK_EXCERPT_MAX, FEEDBACK_RULES_MAX, type FeedbackRule } from 'nalgorithm'
import { deviceStorage } from './storage.js'
import { identityKey } from './local-data.js'

export interface StoredRule extends FeedbackRule {
  /** The note the rule came from, so the same note does not get two rules. */
  noteId: string
  at: number
}

export interface SavedNote {
  id: string
  author: string
  content: string
  createdAt: number
  savedAt: number
}

export interface FeedbackState {
  v: 1
  rules: StoredRule[]
  hidden: string[]
  muted: string[]
  saved: SavedNote[]
  /** Rules changed here that the server has not confirmed yet (hosted). Older data: pending if it has rules. */
  rulesPending?: boolean
}

const HIDDEN_MAX = 500
const SAVED_MAX = 100
const MUTED_MAX = 200

const empty = (): FeedbackState => ({ v: 1, rules: [], hidden: [], muted: [], saved: [] })

let identity: () => string | null = () => null
const listeners = new Set<() => void>()
/** Called after the rules change (hosted: send them to the server). */
let onRulesChanged: (rules: FeedbackRule[]) => void = () => {}

/** Whose feedback is in effect: the mode's current identity. */
export function setFeedbackIdentity(get: () => string | null): void {
  identity = get
}

export function setRulesSync(sync: (rules: FeedbackRule[]) => void): void {
  onRulesChanged = sync
}

export function onFeedbackChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function key(): string | null {
  const id = identity()
  const hex = id ? identityKey(id) : null
  return hex ? `nalgorithm_feedback_${hex}` : null
}

export function readFeedback(): FeedbackState {
  const k = key()
  if (!k) return empty()
  try {
    const parsed = JSON.parse(deviceStorage.getItem(k) ?? 'null') as Partial<FeedbackState> | null
    if (!parsed || parsed.v !== 1) return empty()
    const rules = Array.isArray(parsed.rules) ? parsed.rules.filter((r) => (r?.kind === 'more' || r?.kind === 'less') && typeof r.excerpt === 'string') : []
    return {
      v: 1,
      rules,
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((x) => typeof x === 'string') : [],
      muted: Array.isArray(parsed.muted) ? parsed.muted.filter((x) => typeof x === 'string') : [],
      saved: Array.isArray(parsed.saved) ? parsed.saved.filter((n) => typeof n?.id === 'string') : [],
      rulesPending: typeof parsed.rulesPending === 'boolean' ? parsed.rulesPending : rules.length > 0,
    }
  } catch {
    return empty()
  }
}

function write(next: FeedbackState, rulesChanged: boolean): void {
  const k = key()
  if (!k) return
  next.hidden = next.hidden.slice(-HIDDEN_MAX)
  next.muted = next.muted.slice(-MUTED_MAX)
  next.saved = next.saved.slice(0, SAVED_MAX)
  if (rulesChanged) next.rulesPending = true
  deviceStorage.setItem(k, JSON.stringify(next))
  if (rulesChanged) onRulesChanged(activeRules(next))
  for (const cb of listeners) cb()
}

function update(change: (s: FeedbackState) => void, rulesChanged = false): void {
  const s = readFeedback()
  change(s)
  write(s, rulesChanged)
}

/** The rules that reach the model, newest first. */
export function activeRules(state = readFeedback()): FeedbackRule[] {
  return state.rules.slice(0, FEEDBACK_RULES_MAX).map(({ kind, excerpt }) => ({ kind, excerpt }))
}

/** A short excerpt of the note: what the model sees of the reader's reaction. */
export function excerptOf(content: string): string {
  const text = content.replace(/nostr:[a-z0-9]+/gi, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  return text.length > FEEDBACK_EXCERPT_MAX ? `${text.slice(0, FEEDBACK_EXCERPT_MAX - 1)}…` : text
}

// ─── actions; each returns its own undo ──────────────────────────────────────
//
// An undo reverses only its own action, for the identity it was made under: an Undo still
// on screen after a sign-out or an identity change does nothing, and undoing a repeated
// hide or mute does not lift the earlier, deliberate one.

const noop = (): void => {}

/** Runs `undo` only while the identity that made the change is still the current one. */
function sameIdentity(undo: () => void): () => void {
  const made = key()
  return () => { if (made && key() === made) undo() }
}

function insertAt<T>(list: T[], index: number, item: T): T[] {
  return [...list.slice(0, index), item, ...list.slice(index)]
}

export function addRule(kind: 'more' | 'less', note: { id: string; content: string }): (() => void) | null {
  const excerpt = excerptOf(note.content)
  if (!excerpt) return null
  const before = readFeedback().rules
  const index = before.findIndex((r) => r.noteId === note.id)
  const prior = index >= 0 ? before[index] : undefined
  update((s) => {
    s.rules = [{ kind, excerpt, noteId: note.id, at: Date.now() }, ...s.rules.filter((r) => r.noteId !== note.id)]
  }, true)
  return sameIdentity(() => update((s) => {
    s.rules = s.rules.filter((r) => r.noteId !== note.id)
    if (prior) s.rules = insertAt(s.rules, index, prior)
  }, true))
}

/**
 * Reconcile with the rules the server ranks with. Rules changed on this device that the server
 * has not confirmed are sent; otherwise the server's list wins, so a rule removed on another
 * device is not brought back from here.
 */
export function adoptRules(rules: readonly FeedbackRule[]): void {
  const k = key()
  if (!k) return
  const s = readFeedback()
  const server = rules.map(({ kind, excerpt }) => ({ kind, excerpt }))
  const same = JSON.stringify(activeRules(s)) === JSON.stringify(server)
  if (s.rulesPending) {
    if (same) markRulesSynced(server)
    else onRulesChanged(activeRules(s))
    return
  }
  if (same) return
  s.rules = rules.map((r, i) => ({ kind: r.kind, excerpt: r.excerpt, noteId: `server-${i}`, at: 0 }))
  s.rulesPending = false
  write(s, false)
}

/** The server stored these rules; nothing is pending if they are still what this device has. */
export function markRulesSynced(rules: readonly FeedbackRule[]): void {
  const k = key()
  if (!k) return
  const s = readFeedback()
  if (!s.rulesPending || JSON.stringify(activeRules(s)) !== JSON.stringify(rules.map(({ kind, excerpt }) => ({ kind, excerpt })))) return
  s.rulesPending = false
  deviceStorage.setItem(k, JSON.stringify(s))
}

export function removeRule(noteId: string): () => void {
  const before = readFeedback().rules
  const index = before.findIndex((r) => r.noteId === noteId)
  if (index < 0) return noop
  const removed = before[index]
  update((s) => { s.rules = s.rules.filter((r) => r.noteId !== noteId) }, true)
  return sameIdentity(() => update((s) => {
    if (!s.rules.some((r) => r.noteId === noteId)) s.rules = insertAt(s.rules, index, removed)
  }, true))
}

export function hideNote(id: string): () => void {
  if (readFeedback().hidden.includes(id)) return noop
  update((s) => { s.hidden.push(id) })
  return sameIdentity(() => update((s) => { s.hidden = s.hidden.filter((x) => x !== id) }))
}

export function showHiddenNotes(): () => void {
  const before = readFeedback().hidden
  update((s) => { s.hidden = [] })
  return sameIdentity(() => update((s) => { s.hidden = [...before, ...s.hidden.filter((x) => !before.includes(x))] }))
}

export function muteAuthor(pubkey: string): () => void {
  if (readFeedback().muted.includes(pubkey)) return noop
  update((s) => { s.muted.push(pubkey) })
  return sameIdentity(() => unmuteAuthor(pubkey))
}

export function unmuteAuthor(pubkey: string): void {
  update((s) => { s.muted = s.muted.filter((x) => x !== pubkey) })
}

export function isSaved(id: string): boolean {
  return readFeedback().saved.some((n) => n.id === id)
}

export function saveNote(note: { id: string; author: string; content: string; createdAt: number }): () => void {
  if (isSaved(note.id)) return noop
  update((s) => {
    s.saved = [{ id: note.id, author: note.author, content: note.content, createdAt: note.createdAt, savedAt: Date.now() }, ...s.saved.filter((n) => n.id !== note.id)]
  })
  return sameIdentity(() => unsaveNote(note.id))
}

export function unsaveNote(id: string): void {
  update((s) => { s.saved = s.saved.filter((n) => n.id !== id) })
}

/** Whether the reader asked not to see this note (itself, or its author's notes). */
export function isFilteredOut(post: { id: string; author: string; originalPost?: { author: string } }, state = readFeedback()): boolean {
  return state.hidden.includes(post.id) || state.muted.includes(post.author) || (post.originalPost ? state.muted.includes(post.originalPost.author) : false)
}
