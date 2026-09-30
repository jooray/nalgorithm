/**
 * Nalgorithm Web — the live parts of the Feed header (DOM, both modes)
 *
 * The age line, the quiet "ranking in the background" indicator, the one-line
 * notice for failures that leave the stored feed usable, and the "N new notes"
 * pill. Decisions about when to show them live in snapshot-logic.ts.
 */

import { CHECK_EVERY_MS, TOP_SCROLL_PX, pillLabel } from './snapshot-logic.js'
import { currentTab } from './shell.js'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element not found: #${id}`)
  return el as T
}

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function scrollY(): number {
  return window.scrollY
}

export function feedVisible(): boolean {
  return currentTab() === 'feed'
}

export function atTop(): boolean {
  return window.scrollY <= TOP_SCROLL_PX
}

/** "Updated 5 min ago", or nothing. The row shows while either the age or the busy line has text. */
export function setAgeLabel(text: string): void {
  $('feed-age').textContent = text
  syncMeta()
}

/** A quiet inline indicator while a background run is going on. Null hides it. */
export function setBackgroundBusy(text: string | null): void {
  $('feed-busy').classList.toggle('hidden', text === null)
  if (text !== null) $('feed-busy-text').textContent = text
  syncMeta()
}

function syncMeta(): void {
  const hasAge = $('feed-age').textContent !== ''
  const busy = !$('feed-busy').classList.contains('hidden')
  $('feed-meta').classList.toggle('hidden', !hasAge && !busy)
}

/** One line under the header that does not replace the feed. Null or empty hides it. */
export function setQuietNotice(text: string | null): void {
  const el = $('feed-quiet')
  el.textContent = text ?? ''
  el.classList.toggle('hidden', !text)
}

/** Offer `count` new notes. Tapping merges them and returns to the top. */
export function showNewPill(count: number, onTap: () => void): void {
  const pill = $<HTMLButtonElement>('new-pill')
  const label = `${pillLabel(count)}. Show`
  pill.textContent = pillLabel(count)
  pill.setAttribute('aria-label', label)
  pill.classList.remove('hidden')
  pill.onclick = () => {
    hideNewPill()
    onTap()
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }
}

export function hideNewPill(): void {
  const pill = $<HTMLButtonElement>('new-pill')
  pill.classList.add('hidden')
  pill.onclick = null
}

/**
 * Look for work on open, whenever the app comes back to the foreground, and on
 * a slow timer while it is visible; also redraw the age line once a minute.
 * `check` decides whether anything is due. Returns a function that stops it all.
 */
export function startLiveChecks(handlers: { check: () => void; tick: () => void }): () => void {
  const onVisible = (): void => {
    if (document.visibilityState !== 'visible') return
    handlers.tick()
    handlers.check()
  }
  const check = window.setInterval(() => {
    if (document.visibilityState === 'visible') handlers.check()
  }, CHECK_EVERY_MS)
  const tick = window.setInterval(() => {
    if (document.visibilityState === 'visible') handlers.tick()
  }, 30_000)
  document.addEventListener('visibilitychange', onVisible)
  handlers.check()
  return () => {
    clearInterval(check)
    clearInterval(tick)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
