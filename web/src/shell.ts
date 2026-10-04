/**
 * Nalgorithm Web — app shell: bottom tab bar, toast, offline banner
 *
 * The tab bar is the only navigation. Each tab keeps its scroll position.
 * The browser chrome colour follows the tab: violet over the Digests hero,
 * the page ground elsewhere.
 */

import { icon, type IconName } from './icons.js'
import { showToast } from './toast.js'
import { deviceStorage } from './storage.js'

export type TabName = 'digest' | 'feed' | 'tune'

const TABS: Array<{ name: TabName; label: string; icon: IconName }> = [
  { name: 'feed', label: 'Feed', icon: 'feed' },
  { name: 'digest', label: 'Digests', icon: 'digest' },
  { name: 'tune', label: 'Tune', icon: 'tune' },
]

const HERO_VIOLET = '#6B3DF5'

let active: TabName = 'feed'
const scrollAt: Record<TabName, number> = { digest: 0, feed: 0, tune: 0 }
let toastTimer: number | undefined

export function currentTab(): TabName {
  return active
}

const tabListeners: Array<(tab: TabName) => void> = []

/** Called after a tab is shown (including the first, initial one). */
export function onTabShown(listener: (tab: TabName) => void): void {
  tabListeners.push(listener)
}

export function showTab(name: TabName, history = true): void {
  scrollAt[active] = window.scrollY
  active = name
  if (history && location.hash.split('/')[0] !== `#${name}`) window.history.pushState(null, '', `#${name}`)
  deviceStorage.setItem('nalgorithm_last_tab', name)
  for (const view of document.querySelectorAll<HTMLElement>('.view')) {
    view.classList.toggle('hidden', view.dataset.view !== name)
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#tabbar .tab')) {
    if (btn.dataset.tab === name) btn.setAttribute('aria-current', 'page')
    else btn.removeAttribute('aria-current')
  }
  window.scrollTo({ top: scrollAt[name] })
  const heading = document.querySelector<HTMLElement>(`.view[data-view="${name}"] h1`)
  if (history && heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
  setChromeColor()
  for (const l of tabListeners) l(name)
}

function setChromeColor(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) return
  meta.content = active === 'digest' ? HERO_VIOLET : getComputedStyle(document.body).backgroundColor
}

/** A short message that does not depend on which tab is showing. */
export function toast(text: string): void {
  if (text) showToast(text)
}

export function initShell(): void {
  const bar = document.getElementById('tabbar')!
  for (const btn of bar.querySelectorAll<HTMLButtonElement>('.tab')) {
    const tab = TABS.find((t) => t.name === btn.dataset.tab)!
    btn.innerHTML = `${icon(tab.icon, 26)}<span>${tab.label}</span>`
    btn.addEventListener('click', () => {
      if (tab.name === active) window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      else showTab(tab.name)
    })
  }
  const restore = (): void => {
    const hash = location.hash.slice(1).split('/')[0]
    const stored = deviceStorage.getItem('nalgorithm_last_tab')
    const tab = hash || stored
    showTab(tab === 'tune' || tab === 'digest' ? tab : 'feed', false)
  }
  restore()
  window.addEventListener('popstate', restore)

  // Offline notice.
  const banner = document.getElementById('offline-banner')!
  document.getElementById('offline-icon')!.innerHTML = icon('offline', 20)
  const sync = (): void => {
    banner.classList.toggle('hidden', navigator.onLine)
  }
  window.addEventListener('online', sync)
  window.addEventListener('offline', sync)
  sync()

  // The theme can change while the app is open.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setChromeColor())
}
