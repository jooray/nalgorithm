/**
 * Nalgorithm Web — Tune's private feedback section and the Saved notes sheet
 *
 * Shows what the reader's private feedback is doing (the more/less rules that
 * steer ranking, the people and notes hidden here) with a way to undo each,
 * and the notes saved for later. Shared by both modes; the mode supplies how
 * learned taste is reset.
 */

import { onFeedbackChange, readFeedback, removeRule, showHiddenNotes, unmuteAuthor, unsaveNote, type SavedNote } from './feedback.js'
import { authorLabel } from './identity.js'
import { knownProfiles } from './profiles.js'
import { openSheet } from './sheet.js'
import { showToast } from './toast.js'
import { relativeTime } from './time.js'

export interface FeedbackSectionOptions {
  /** Forget learned taste for the current identity. Throws the text to show on failure. */
  resetLearned: () => void | Promise<void>
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element not found: #${id}`)
  return el as T
}

function nameOf(pubkey: string): string {
  const label = authorLabel(pubkey, knownProfiles([pubkey]).get(pubkey))
  return label.isNpub ? `${label.text.slice(0, 12)}…` : label.text
}

function listItem(text: string, action: string, run: () => void): HTMLLIElement {
  const li = document.createElement('li')
  const span = document.createElement('span')
  span.textContent = text
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'link-btn'
  button.textContent = action
  button.addEventListener('click', run)
  li.append(span, ' ', button)
  return li
}

function paint(): void {
  const state = readFeedback()
  const rules = $('feedback-rules')
  rules.replaceChildren(
    ...state.rules.map((r) =>
      listItem(`${r.kind === 'more' ? 'More' : 'Less'} like “${r.excerpt}”`, 'Remove', () => {
        const undo = removeRule(r.noteId)
        showToast('Feedback removed. It no longer steers rankings.', { action: { label: 'Undo', run: undo } })
      })
    )
  )
  const muted = $('feedback-muted')
  muted.replaceChildren(...state.muted.map((pk) => listItem(`Notes from ${nameOf(pk)} are hidden.`, 'Show them', () => unmuteAuthor(pk))))
  const hidden = $('feedback-hidden')
  hidden.replaceChildren()
  if (state.hidden.length > 0) {
    hidden.append(`${state.hidden.length === 1 ? '1 note is' : `${state.hidden.length} notes are`} hidden. `)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'link-btn'
    button.textContent = 'Show them again'
    button.addEventListener('click', () => {
      const undo = showHiddenNotes()
      showToast('Hidden notes are back in your feed.', { action: { label: 'Undo', run: undo } })
    })
    hidden.appendChild(button)
  } else if (state.rules.length === 0 && state.muted.length === 0) {
    hidden.textContent = 'Nothing yet.'
  }
  const saved = document.getElementById('btn-saved')
  if (saved) {
    saved.classList.toggle('hidden', state.saved.length === 0)
    saved.textContent = `Saved · ${state.saved.length}`
  }
}

function openSaved(): void {
  const sheet = openSheet({ title: 'Saved notes' })
  const draw = (): void => {
    const notes = readFeedback().saved
    sheet.body.replaceChildren()
    if (notes.length === 0) {
      const p = document.createElement('p')
      p.className = 'state-note'
      p.textContent = 'Nothing saved. Use Save for later in a note’s ••• menu.'
      sheet.body.appendChild(p)
      return
    }
    const list = document.createElement('ol')
    list.className = 'saved-list'
    for (const n of notes) list.appendChild(savedItem(n, draw))
    sheet.body.appendChild(list)
  }
  draw()
}

function savedItem(n: SavedNote, redraw: () => void): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'saved-item'
  const head = document.createElement('p')
  head.className = 'saved-head'
  head.textContent = `${nameOf(n.author)} · ${relativeTime(n.createdAt)}`
  const body = document.createElement('p')
  body.className = 'saved-body'
  body.textContent = n.content
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'link-btn'
  remove.textContent = 'Remove'
  remove.addEventListener('click', () => {
    unsaveNote(n.id)
    redraw()
  })
  li.append(head, body, remove)
  return li
}

export function initFeedbackSection(options: FeedbackSectionOptions): void {
  paint()
  onFeedbackChange(paint)
  document.getElementById('btn-saved')?.addEventListener('click', openSaved)
  // A different identity has different feedback.
  document.addEventListener('nalgorithm:settings-saved', paint)
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-reset-learned]')) {
    // The answer shows right under the button that was pressed.
    const anchor = button.closest('.btn-row') ?? button
    const status = document.createElement('p')
    status.className = 'form-status'
    status.setAttribute('role', 'status')
    anchor.after(status)
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await options.resetLearned()
        status.textContent = 'Learned taste cleared. Only likes from now on will shape a new one.'
        status.classList.remove('is-error')
      } catch (err) {
        status.textContent = (err as Error).message
        status.classList.add('is-error')
      } finally {
        button.disabled = false
      }
    })
  }
}

/** Repaint after the mode's identity changed (hosted sign-in, BYOK identity in Tune). */
export function refreshFeedbackSection(): void {
  paint()
}
