/**
 * Nalgorithm Web — toast
 *
 * One short message at a time, announced politely to screen readers, with an
 * optional action (Retry). It lives in the top layer (popover) so it stays
 * visible above an open bottom sheet.
 */

export interface ToastOptions {
  tone?: 'ok' | 'error'
  action?: { label: string; run: () => void }
  /** Milliseconds before it goes away. Errors with an action stay longer. */
  ms?: number
}

let current: { el: HTMLElement; timer: number | undefined } | null = null

function dismiss(): void {
  if (!current) return
  clearTimeout(current.timer)
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
}
