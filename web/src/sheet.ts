/**
 * Nalgorithm Web — bottom sheet
 *
 * A modal <dialog> that rises from the bottom edge. The dialog element brings
 * focus containment, Escape to close and focus restore; this adds the
 * backdrop tap, a drag-down-to-dismiss handle and the scroll lock.
 *
 * Reusable: `openSheet` returns the body element to fill. The note detail is
 * the first user; a later stage puts the reply composer in the same sheet.
 */

import { disposeTree } from './lifecycle.js'

export interface SheetHandle {
  el: HTMLDialogElement
  /** Scrolling content area; append to it. */
  body: HTMLElement
  /** Fixed footer area under the body, for a composer or primary action. */
  footer: HTMLElement
  close: () => void
}

export interface SheetOptions {
  title: string
  route?: string
  onClose?: () => void
}

let open: SheetHandle | null = null

export function openSheet(options: SheetOptions): SheetHandle {
  // One sheet at a time: a second tap replaces the first.
  open?.close()

  const dialog = document.createElement('dialog')
  dialog.className = 'sheet'
  dialog.setAttribute('aria-label', options.title)

  const grab = document.createElement('div')
  grab.className = 'sheet-grab'
  grab.innerHTML = '<span class="sheet-handle"></span>'

  const head = document.createElement('div')
  head.className = 'sheet-head'
  const title = document.createElement('h2')
  title.className = 'sheet-title'
  title.textContent = options.title
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'icon-btn'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
  head.append(title, closeBtn)

  const body = document.createElement('div')
  body.className = 'sheet-body'
  const footer = document.createElement('div')
  footer.className = 'sheet-footer'

  dialog.append(grab, head, body, footer)
  document.body.appendChild(dialog)
  document.body.classList.add('sheet-open')

  let closed = false
  const handle: SheetHandle = {
    el: dialog,
    body,
    footer,
    close: () => {
      if (dialog.open) dialog.close()
      else finish()
    },
  }

  const finish = (): void => {
    if (closed) return
    closed = true
    disposeTree(dialog)
    dialog.remove()
    document.body.classList.remove('sheet-open')
    if (open === handle) open = null
    options.onClose?.()
  }

  dialog.addEventListener('close', finish)
  closeBtn.addEventListener('click', () => handle.close())
  // A tap on the dimmed area outside the sheet is a tap on the dialog itself.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) handle.close()
  })

  // Drag the handle or header down to dismiss.
  let startY: number | null = null
  let dy = 0
  const onMove = (e: PointerEvent): void => {
    if (startY === null) return
    dy = Math.max(0, e.clientY - startY)
    dialog.style.transform = `translateY(${dy}px)`
  }
  const onUp = (): void => {
    if (startY === null) return
    startY = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    dialog.style.transition = ''
    if (dy > 110) {
      handle.close()
    } else {
      dialog.style.transform = ''
    }
    dy = 0
  }
  const onDown = (e: PointerEvent): void => {
    if ((e.target as Element).closest('button')) return
    startY = e.clientY
    dy = 0
    dialog.style.transition = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  grab.addEventListener('pointerdown', onDown)
  head.addEventListener('pointerdown', onDown)

  dialog.showModal()
  open = handle
  const token = `sheet-${Date.now()}-${Math.random()}`
  if (options.route === location.hash && !history.state?.nalgorithmSheet) history.replaceState(null, '', location.hash.split('/')[0])
  const previous = history.state?.nalgorithmSheet
  const state = { ...history.state, nalgorithmSheet: token }
  if (previous) history.replaceState(state, '', options.route ?? location.href)
  else history.pushState(state, '', options.route ?? location.href)
  const onBack = (): void => { if (history.state?.nalgorithmSheet !== token && dialog.open) dialog.close() }
  window.addEventListener('popstate', onBack)
  dialog.addEventListener('close', () => {
    window.removeEventListener('popstate', onBack)
    if (history.state?.nalgorithmSheet === token) history.back()
  }, { once: true })
  return handle
}
