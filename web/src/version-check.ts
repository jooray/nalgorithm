/**
 * Nalgorithm Web — version checking and automatic refresh
 *
 * Every build stamps its version into the bundle and writes a matching
 * `version.json`. The running page polls that file and reloads itself when the
 * two disagree, so a deploy reaches people who already have the app open (or
 * installed) without anyone being told to hard-refresh.
 *
 * The service worker takes care of not serving a stale shell; this takes care
 * of noticing while the page is still open.
 */

declare const __APP_VERSION__: string

/** How often to re-check while the tab is visible. */
const POLL_INTERVAL_MS = 5 * 60_000
/** Grace period before the automatic reload, so a banner is actually readable. */
const RELOAD_DELAY_MS = 8_000

let reloadScheduled = false
/** Set while a feed refresh is running, so we never reload mid-scoring. */
let busy = false

export const APP_VERSION = __APP_VERSION__

/**
 * Mark the app busy. A pending auto-reload waits until this clears, so an
 * update never throws away scoring the user has already paid for.
 */
export function setUpdateBlocked(value: boolean): void {
  busy = value
}

/** Register the service worker and start polling for new versions. */
export function initVersionCheck(): void {
  registerServiceWorker()

  const check = (): void => {
    void checkForUpdate()
  }

  // On load, whenever the tab regains focus, and on a slow poll.
  setTimeout(check, 5_000)
  setInterval(check, POLL_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
}

async function checkForUpdate(): Promise<void> {
  if (reloadScheduled) return
  try {
    const url = new URL('version.json', document.baseURI)
    // Defeat every layer of caching: the whole point is to see the new file.
    url.searchParams.set('t', String(Date.now()))
    const res = await fetch(url.toString(), { cache: 'no-store' })
    if (!res.ok) return
    const data = (await res.json()) as { version?: string }
    if (data.version && data.version !== APP_VERSION) {
      scheduleReload(data.version)
    }
  } catch {
    // Offline or blocked — try again on the next tick.
  }
}

function scheduleReload(newVersion: string): void {
  if (reloadScheduled) return
  reloadScheduled = true

  const banner = showBanner(newVersion)
  const deadline = Date.now() + RELOAD_DELAY_MS

  const tick = (): void => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    const counter = banner.querySelector('.update-count')
    if (counter) {
      counter.textContent = busy ? 'waiting for the current refresh to finish' : `reloading in ${remaining}s`
    }
    if (!busy && remaining <= 0) {
      doReload()
      return
    }
    setTimeout(tick, 500)
  }
  tick()
}

async function doReload(): Promise<void> {
  // Ask a waiting worker to take over first, so the reload lands on the new
  // build rather than triggering a second update cycle.
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    reg?.waiting?.postMessage('skip-waiting')
  } catch {
    // No worker — a plain reload is enough.
  }
  location.reload()
}

function showBanner(newVersion: string): HTMLElement {
  const existing = document.querySelector<HTMLElement>('.update-banner')
  if (existing) return existing

  const el = document.createElement('div')
  el.className = 'update-banner'
  el.innerHTML = `
    <span>New version ${escapeHtml(newVersion)} available — <span class="update-count"></span></span>
    <button class="btn btn-small update-now">Reload now</button>
  `
  el.querySelector<HTMLButtonElement>('.update-now')!.addEventListener('click', () => {
    void doReload()
  })
  document.body.appendChild(el)
  return el
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  // Only over HTTPS or localhost; browsers reject it elsewhere anyway.
  window.addEventListener('load', () => {
    const swUrl = new URL('sw.js', document.baseURI).toString()
    navigator.serviceWorker.register(swUrl).catch(() => {
      // Registration failure is not fatal — the app works without it.
    })
  })

  // A worker taking control means the assets under us changed.
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return
    refreshing = true
    if (reloadScheduled) location.reload()
  })
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
