/**
 * Nalgorithm Web — note actions
 *
 * The one place that decides which actions a note offers. The row under a note
 * is reply, boost, like and zap, signed with the reader's signer (see
 * signer.ts). Opening a note elsewhere and copying its identifiers live in the
 * overflow menu and the detail sheet, which keeps the row inside a phone's
 * width. `renderActionRow` draws whatever this returns.
 */

import { icon, type IconName } from './icons.js'
import { boostNote, isMarked, likeNote, replyToNote, type NoteTarget } from './note-ui.js'
import { onMarkChange } from './note-state.js'
import { zapNote } from './zap-ui.js'

/** What an action needs to know about the note it acts on. */
export interface NoteLinks {
  /** Hex event id. */
  id: string
  /** Author hex pubkey. */
  author: string
  npub: string
  nprofile: string
  /** Empty when the id was not a valid event id. */
  nevent: string
  /** Link to the note in the reader's chosen client, or '' when there is none. */
  eventHref: string
  /** Name of the chosen client, for labels. */
  clientLabel: string
}

export interface NoteAction {
  id: string
  /** Accessible name and tooltip. */
  label: string
  icon: IconName
  /** A link action (opens in a new tab). */
  href?: string
  /** A button action. Resolves to true when it did its job (shows a check). */
  run?: () => Promise<boolean> | boolean
  /** A button that does its own reporting (sheets, toasts) instead of flashing a check. */
  press?: () => void
  /** For a toggle: whether it is on now. The icon stays filled while it is. */
  active?: () => boolean
}

/** The four social actions, in display order. */
export function noteActions(target: NoteTarget): NoteAction[] {
  return [
    { id: 'reply', label: 'Reply', icon: 'reply', press: () => void replyToNote(target) },
    {
      id: 'boost',
      label: 'Boost',
      icon: 'boost',
      press: () => void boostNote(target),
      active: () => isMarked('boosted', target.id),
    },
    {
      id: 'like',
      label: 'Like',
      icon: 'like',
      press: () => void likeNote(target),
      active: () => isMarked('liked', target.id),
    },
    {
      id: 'zap',
      label: 'Zap',
      icon: 'zap',
      press: () => void zapNote(target),
      active: () => isMarked('zapped', target.id),
    },
  ]
}

/**
 * The icon row under a note. Every button is a 44px target; `trailing` (the
 * overflow menu) sits at the far end.
 */
export function renderActionRow(actions: NoteAction[], trailing?: HTMLElement): HTMLElement {
  const row = document.createElement('div')
  row.className = 'note-actions'
  for (const action of actions) {
    if (action.href) {
      const a = document.createElement('a')
      a.className = 'note-action'
      a.href = action.href
      a.target = '_blank'
      a.rel = 'noopener'
      a.title = action.label
      a.setAttribute('aria-label', action.label)
      a.innerHTML = icon(action.icon, 20)
      row.appendChild(a)
      continue
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'note-action'
    if (action.press) {
      b.classList.add(`note-action-${action.id}`)
      b.title = action.label
      b.setAttribute('aria-label', action.label)
      b.innerHTML = icon(action.icon, 20)
      const active = action.active
      if (active) {
        const paint = (): void => {
          const on = active()
          b.classList.toggle('is-on', on)
          b.setAttribute('aria-pressed', String(on))
        }
        paint()
        // Follow the mark while this button is on screen; let go of it once it is not.
        const stop = onMarkChange(() => (b.isConnected ? paint() : stop()))
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        action.press?.()
      })
      row.appendChild(b)
      continue
    }
    b.title = action.label
    b.setAttribute('aria-label', action.label)
    b.innerHTML = icon(action.icon, 20)
    b.addEventListener('click', async (e) => {
      e.stopPropagation()
      const ok = await action.run?.()
      b.innerHTML = icon(ok ? 'check' : 'close', 20)
      b.classList.add(ok ? 'is-done' : 'is-failed')
      b.title = ok ? 'Copied' : 'Copy failed'
      setTimeout(() => {
        b.innerHTML = icon(action.icon, 20)
        b.classList.remove('is-done', 'is-failed')
        b.title = action.label
      }, 1400)
    })
    row.appendChild(b)
  }
  if (trailing) row.appendChild(trailing)
  return row
}
