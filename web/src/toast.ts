/**
 * Nalgorithm Web — toast
 *
 * One short message at a time, announced politely to screen readers, with an
 * optional action (Retry). It lives in the top layer (popover) so it stays
 * visible above an open bottom sheet.
 *
 * An Undo toast has no timer, so it can be reached by keyboard and screen
 * reader, but it does not linger either: the reader's next action elsewhere
 * closes it (moving focus, scrolling and modifier keys do not count), and
 * Ctrl+Z / Cmd+Z runs it from anywhere outside a text field.
 */

export interface ToastOptions {
  tone?: 'ok' | 'error'
  action?: { label: string; run: () => void }
  /** The action is an Undo: closes on the next action elsewhere and answers Ctrl/Cmd+Z. */
  undo?: boolean
  /** Milliseconds before it goes away. Errors with an action stay longer. */
  ms?: number
}

let current: { el: HTMLElement; timer: number | undefined; stop?: AbortController } | null = null

/** Keys that move around rather than act: reaching the Undo button must not close it. */
const PASSIVE_KEYS = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'])
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

function editing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/** An Undo toast closes at the reader's next action outside it; Ctrl/Cmd+Z runs it. */
function followNextAction(el: HTMLElement, run: () => void): AbortController {
  const stop = new AbortController()
  // After the click or key that showed it has finished.
  setTimeout(() => {
    if (stop.signal.aborted) return
    const options = { capture: true, signal: stop.signal }
    document.addEventListener('pointerdown', (e) => {
      if (!el.contains(e.target as Node)) dismiss()
    }, options)
    document.addEventListener('keydown', (e) => {
      if (el.contains(e.target as Node) || PASSIVE_KEYS.has(e.key)) return
      if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !editing(e.target)) {
        e.preventDefault()
        dismiss()
        run()
        return
      }
      dismiss()
    }, options)
  }, 0)
  return stop
}

function dismiss(): void {
  if (!current) return
  clearTimeout(current.timer)
  current.stop?.abort()
  const el = current.el
  current = null
  try {
    if (el.matches(':popover-open')) el.hidePopover()
  } catch {
    // not a popover here
  }
  el.remove()
}

function show(el: HTMLElement): void {
  try {
    if (!el.matches(':popover-open')) el.showPopover()
  } catch {
    // no popover support: it still shows, just beneath any open sheet
  }
}

export function showToast(text: string, options: ToastOptions = {}): void {
  dismiss()
  const el = document.createElement('div')
  el.className = `toast toast-${options.tone ?? 'ok'}`
  el.setAttribute('role', options.tone === 'error' ? 'alert' : 'status')

  const message = document.createElement('span')
  message.className = 'toast-text'
  message.textContent = text
  el.appendChild(message)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'toast-dismiss'
  close.textContent = 'Dismiss'
  close.addEventListener('click', dismiss)

  if (options.action) {
    const { label, run } = options.action
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'toast-action'
    button.textContent = label
    if (options.undo) button.setAttribute('aria-keyshortcuts', isMac ? 'Meta+Z' : 'Control+Z')
    button.addEventListener('click', () => {
      dismiss()
      run()
    })
    el.appendChild(button)
  }
  el.appendChild(close)

  el.setAttribute('popover', 'manual')
  // Everything outside an open modal sheet is inert, so Undo or Retry would show but not
  // respond: the toast goes inside the sheet, and back to the page when the sheet closes.
  const sheet = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter((d) => d.matches(':modal')).pop()
  ;(sheet ?? document.body).appendChild(el)
  show(el)
  sheet?.addEventListener('close', () => {
    if (current?.el !== el) return
    document.body.appendChild(el)
    show(el)
  }, { once: true })
  const ms = options.ms ?? (options.action ? 0 : 4500)
  current = { el, timer: ms > 0 ? window.setTimeout(dismiss, ms) : undefined }
  if (options.undo && options.action) current.stop = followNextAction(el, options.action.run)
}

/** A change the reader can take back: see the Undo rules above. */
export function showUndoToast(text: string, undo: () => void): void {
  showToast(text, { action: { label: 'Undo', run: undo }, undo: true })
}
