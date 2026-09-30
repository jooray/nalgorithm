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

let current: { el: HTMLElement; timer: number } | null = null

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

export function showToast(text: string, options: ToastOptions = {}): void {
  dismiss()
  const el = document.createElement('div')
  el.className = `toast toast-${options.tone ?? 'ok'}`
  el.setAttribute('role', options.tone === 'error' ? 'alert' : 'status')

  const message = document.createElement('span')
  message.className = 'toast-text'
  message.textContent = text
  el.appendChild(message)

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

  el.setAttribute('popover', 'manual')
  document.body.appendChild(el)
  try {
    el.showPopover()
  } catch {
    // no popover support: it still shows, just beneath any open sheet
  }
  const ms = options.ms ?? (options.action ? 9000 : 4500)
  current = { el, timer: window.setTimeout(dismiss, ms) }
}
