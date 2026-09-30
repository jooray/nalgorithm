/**
 * Nalgorithm Web — note actions
 *
 * The one place that decides which actions a note offers. Stage 1 implements
 * open-in-client and copy-note-link. A later stage adds reply, boost, like and
 * zap here (signed with the reader's signer); `renderActionRow` draws whatever
 * this returns, so the row needs no change when they arrive.
 */

import { copyText } from './clipboard.js'
import { icon, type IconName } from './icons.js'

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
}

/** Actions implemented so far, in display order. */
export function noteActions(links: NoteLinks): NoteAction[] {
  const actions: NoteAction[] = []
  if (links.eventHref) {
    actions.push({ id: 'open', label: `Open note in ${links.clientLabel}`, icon: 'external', href: links.eventHref })
  }
  if (links.nevent) {
    actions.push({
      id: 'copy-nevent',
      label: 'Copy note link (nevent)',
      icon: 'copy',
      run: () => copyText(links.nevent),
    })
  }
  return actions
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
