/**
 * Nalgorithm Web — reply, boost and like
 *
 * The user-facing half of note actions that publish an event: ask for a signer
 * when there is none, compose in the bottom sheet, sign, publish to relays,
 * and say how many took it. Zapping is in zap-ui.ts.
 *
 * Text that came from a note, a relay or a signer is only ever set through
 * textContent.
 */

import type { Event as NostrEvent } from 'nostr-tools/pure'
import { openSheet, type SheetHandle } from './sheet.js'
import { icon } from './icons.js'
import { showToast } from './toast.js'
import { connectSigner, findSigner, getActor, signChecked, type ActiveSigner } from './signer.js'
import { fetchEvent, getRelayList, publishEvent, publishRelaysFor, readRelaysFor } from './relays.js'
import { clearMark, markOf, setMark } from './note-state.js'
import { toNpub } from './nostr-login.js'
import {
  describePublish,
  likeTemplate,
  replyTemplate,
  repostTemplate,
  type RelayResult,
  type Target,
} from './note-logic.js'

/** A note as the actions see it. */
export interface NoteTarget extends Target {
  /** The full event when we have it (bring-your-own-key feed). */
  event?: NostrEvent
  content: string
  /** Name to show in sheets. */
  authorName: string
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', className, label)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

// ─── Signer needed ───────────────────────────────────────────────────────────

/**
 * A signer for the signed-in key, or null when the reader backs out.
 *
 * With none available it opens the small "Sign in with a signer" sheet, then
 * the same connect dialog the app already uses for login. Never fails silently:
 * a wrong-key signer gets its own explanation.
 */
export async function requireSigner(): Promise<ActiveSigner | null> {
  const ready = await findSigner()
  if (ready) return ready
  let message = ''
  for (;;) {
    const go = await askForSigner(message)
    if (!go) return null
    const outcome = await connectSigner()
    if (outcome.signer) return outcome.signer
    if (outcome.reason === 'cancelled') return null
    message = `That signer belongs to ${short(outcome.otherNpub ?? 'another key')}, not to the key you are signed in with. Connect the matching one.`
  }
}

function short(npub: string): string {
  return npub.length > 20 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : npub
}

function askForSigner(problem: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    const answer = (v: boolean): void => {
      if (answered) return
      answered = true
      sheet.close()
      resolve(v)
    }
    const sheet = openSheet({ title: 'Sign in with a signer', onClose: () => answer(false) })
    const actor = getActor()
    const lead = h('p', 'sheet-lead', 'Sign in with a signer to reply, boost, like or zap.')
    const why = h(
      'p',
      'sheet-note',
      actor
        ? `You are reading as ${short(toNpub(actor))}. Reading needs no signer; posting does, because every reply, boost, like and zap is signed by your key.`
        : 'Reading needs no signer; posting does, because every reply, boost, like and zap is signed by your key.'
    )
    sheet.body.append(lead, why)
    if (problem) {
      const p = h('p', 'sheet-problem', problem)
      p.setAttribute('role', 'alert')
      sheet.body.appendChild(p)
    }
    sheet.footer.append(
      button('Not now', 'btn btn-ghost', () => answer(false)),
      button('Choose a signer', 'btn btn-primary', () => answer(true))
    )
  })
}

// ─── Publishing helpers ──────────────────────────────────────────────────────

async function relayHint(t: Target): Promise<string> {
  if (t.relay) return t.relay
  return (await getRelayList(t.author))?.write[0] ?? ''
}

/** The full original event, for a boost or a reply: the one we hold, else from relays. */
async function originalOf(t: NoteTarget): Promise<NostrEvent | null> {
  if (t.event) return t.event
  return fetchEvent(t.id, await readRelaysFor(t.author, t.relay ? [t.relay] : []))
}

// ─── Like ────────────────────────────────────────────────────────────────────

const inFlight = new Set<string>()

export function isMarked(mark: 'liked' | 'boosted' | 'zapped', id: string): boolean {
  return markOf(getActor(), mark, id) !== undefined
}

export async function likeNote(t: NoteTarget): Promise<void> {
  if (isMarked('liked', t.id)) {
    showToast('You liked this. Nostr likes cannot be taken back from here.')
    return
  }
  const key = `like:${t.id}`
  if (inFlight.has(key)) return
  inFlight.add(key)
  try {
    const signer = await requireSigner()
    if (!signer) return
    setMark(signer.pubkey, 'liked', t.id) // optimistic: the heart fills now
    try {
      const target: Target = { id: t.id, author: t.author, kind: t.event?.kind ?? t.kind, relay: await relayHint(t) }
      const event = await signChecked(signer, likeTemplate(target))
      const results = await publishEvent(event, await publishRelaysFor(signer.pubkey, t.author))
      if (!results.some((r) => r.ok)) throw new Error(describePublish(results))
      showToast(`Liked. ${describePublish(results)}.`)
    } catch (err) {
      clearMark(signer.pubkey, 'liked', t.id)
      showToast(`Could not like: ${(err as Error).message}`, {
        tone: 'error',
        action: { label: 'Retry', run: () => void likeNote(t) },
      })
    }
  } finally {
    inFlight.delete(key)
  }
}

// ─── Boost ───────────────────────────────────────────────────────────────────

export async function boostNote(t: NoteTarget): Promise<void> {
  if (isMarked('boosted', t.id)) {
    showToast('You boosted this. Nostr boosts cannot be taken back from here.')
    return
  }
  const key = `boost:${t.id}`
  if (inFlight.has(key)) return
  const signer = await requireSigner()
  if (!signer) return
  if (!(await confirmBoost(t))) return
  inFlight.add(key)
  setMark(signer.pubkey, 'boosted', t.id)
  try {
    const original = await originalOf(t)
    const target: Target = { id: t.id, author: t.author, kind: original?.kind ?? t.kind, relay: await relayHint(t) }
    const event = await signChecked(signer, repostTemplate(target, original ?? undefined))
    const results = await publishEvent(event, await publishRelaysFor(signer.pubkey, t.author))
    if (!results.some((r) => r.ok)) throw new Error(describePublish(results))
    showToast(`Boosted. ${describePublish(results)}.`)
  } catch (err) {
    clearMark(signer.pubkey, 'boosted', t.id)
    showToast(`Could not boost: ${(err as Error).message}`, {
      tone: 'error',
      action: { label: 'Retry', run: () => void boostNote(t) },
    })
  } finally {
    inFlight.delete(key)
  }
}

function confirmBoost(t: NoteTarget): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    const answer = (v: boolean): void => {
      if (answered) return
      answered = true
      sheet.close()
      resolve(v)
    }
    const sheet = openSheet({ title: 'Boost this note?', onClose: () => answer(false) })
    sheet.body.append(
      h('p', 'sheet-lead', `Your followers will see ${t.authorName}'s note as boosted by you.`),
      quote(t),
      h('p', 'sheet-note', 'A boost is public and cannot be taken back from here.')
    )
    sheet.footer.append(
      button('Cancel', 'btn btn-ghost', () => answer(false)),
      button('Boost', 'btn btn-primary', () => answer(true))
    )
  })
}

function quote(t: NoteTarget): HTMLElement {
  const box = h('blockquote', 'compose-parent')
  box.appendChild(h('span', 'compose-parent-name', t.authorName))
  box.appendChild(h('span', 'compose-parent-text', t.content.trim().slice(0, 400) || '(no text)'))
  return box
}

// ─── Reply ───────────────────────────────────────────────────────────────────

/** Unsent replies, kept per note for this page view so a closed sheet loses nothing. */
const drafts = new Map<string, string>()

export async function replyToNote(t: NoteTarget): Promise<void> {
  const signer = await requireSigner()
  if (!signer) return

  const sheet = openSheet({ title: `Reply to ${t.authorName}` })
  const parent = quote(t)
  const input = h('textarea', 'compose-input')
  input.rows = 5
  input.placeholder = 'Write your reply'
  input.setAttribute('aria-label', `Your reply to ${t.authorName}`)
  input.value = drafts.get(t.id) ?? ''
  const count = h('p', 'compose-count')
  const status = h('p', 'compose-status')
  status.setAttribute('role', 'status')
  const form = h('div', 'compose')
  form.append(parent, input, count, status)
  sheet.body.appendChild(form)

  const cancel = button('Cancel', 'btn btn-ghost', () => sheet.close())
  const send = button('Send', 'btn btn-primary', () => void attempt())
  sheet.footer.append(cancel, send)

  let signed: NostrEvent | null = null
  let relays: string[] = []
  let busy = false

  const refresh = (): void => {
    const n = Array.from(input.value).length
    count.textContent = `${n} ${n === 1 ? 'character' : 'characters'}`
    send.disabled = busy || input.value.trim() === ''
    drafts.set(t.id, input.value)
  }
  input.addEventListener('input', () => {
    signed = null // an edit makes the signed event stale
    status.textContent = ''
    status.classList.remove('is-error')
    refresh()
  })
  refresh()
  queueMicrotask(() => input.focus())

  const fail = (text: string): void => {
    busy = false
    input.disabled = false
    send.textContent = 'Retry'
    status.textContent = text
    status.classList.add('is-error')
    refresh()
  }

  async function attempt(): Promise<void> {
    if (busy) return
    busy = true
    input.disabled = true
    status.classList.remove('is-error')
    send.disabled = true
    send.textContent = 'Sending…'
    try {
      if (!signed) {
        status.textContent = 'Waiting for your signer…'
        const original = await originalOf(t)
        const hint = await relayHint(t)
        relays = await publishRelaysFor(signer!.pubkey, t.author)
        const template = replyTemplate(
          input.value,
          original ?? { id: t.id, pubkey: t.author, tags: [] },
          { relay: hint, self: signer!.pubkey }
        )
        signed = await signChecked(signer!, template)
      }
    } catch (err) {
      return fail(`${(err as Error).message} Nothing was sent.`)
    }
    status.textContent = `Publishing to ${relays.length} ${relays.length === 1 ? 'relay' : 'relays'}…`
    let shownSent = false
    const results = await publishEvent(signed, relays, (_r, all) => {
      // Optimistic: the first relay that takes it is enough to say Sent.
      if (all.some((r) => r.ok) && !shownSent) {
        shownSent = true
        drafts.delete(t.id)
        showSent(sheet, all, relays.length)
      } else if (shownSent) {
        showSent(sheet, all, relays.length)
      }
    })
    if (!results.some((r) => r.ok)) {
      return fail(`No relay accepted your reply (0 of ${results.length}). ${firstError(results)}`.trim())
    }
    showSent(sheet, results, results.length, true)
  }
}

function firstError(results: RelayResult[]): string {
  const e = results.find((r) => r.error)?.error
  return e ? `Last error: ${e}.` : ''
}

function showSent(sheet: SheetHandle, results: RelayResult[], total: number, done = false): void {
  sheet.body.replaceChildren()
  const head = h('div', 'sent')
  const mark = h('span', 'sent-mark')
  mark.innerHTML = icon('check', 26)
  const text = h('div', 'sent-text')
  text.appendChild(h('p', 'sent-title', 'Sent'))
  const ok = results.filter((r) => r.ok).length
  const line = h('p', 'sent-line', done || results.length === total ? describePublish(results) : `Published to ${ok} of ${total} relays so far…`)
  line.setAttribute('role', 'status')
  text.appendChild(line)
  head.append(mark, text)

  const details = h('details', 'sent-relays')
  details.appendChild(h('summary', undefined, 'Relays'))
  const list = h('ul', 'sent-relay-list')
  for (const r of results) {
    const li = h('li', r.ok ? 'is-ok' : 'is-failed')
    li.appendChild(h('span', 'sent-relay-name', r.relay.replace(/^wss?:\/\//, '')))
    li.appendChild(h('span', 'sent-relay-state', r.ok ? 'accepted' : `refused${r.error ? `: ${r.error}` : ''}`))
    list.appendChild(li)
  }
  details.appendChild(list)
  sheet.body.append(head, details)
  sheet.footer.replaceChildren(button('Done', 'btn btn-primary', () => sheet.close()))
}
