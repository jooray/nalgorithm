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
import { activities } from './activity.js'

/** How often to re-check while the tab is visible. */
const POLL_INTERVAL_MS = 5 * 60_000
/** Grace period before the automatic reload, so a banner is actually readable. */
const RELOAD_DELAY_MS = 8_000
/**
 * Work in progress defers an update, but not forever: after this long the page
 * reloads the next time it is hidden (drafts are saved at the checkpoint).
 */
const MAX_DEFER_MS = 60 * 60_000
/** How long to wait for a fresh worker to install before reloading anyway. */
const WORKER_WAIT_MS = 5_000

let reloadScheduled = false

export const APP_VERSION = __APP_VERSION__

/** Register the service worker and start polling for new versions. */
export function initVersionCheck(): void {
  registerServiceWorker()

  const check = (): void => {
    if (document.visibilityState === 'visible') void checkForUpdate()
  }

  // On load, whenever the tab regains focus, and on a slow poll.
  setTimeout(check, 5_000)
  setInterval(check, POLL_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  window.addEventListener('online', check)
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
  const detected = Date.now()
  const deadline = detected + RELOAD_DELAY_MS

  const tick = (): void => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    const counter = banner.querySelector('.update-count')
    if (counter) {
      counter.textContent = activities.blocked ? `updating after ${activities.reasons.join(', ')}` : `reloading in ${remaining}s`
    }
    const overdue = Date.now() - detected > MAX_DEFER_MS && document.visibilityState === 'hidden'
    if ((!activities.blocked && remaining <= 0) || overdue) {
      void doReload()
      return
    }
    setTimeout(tick, 500)
  }
  tick()
}

let reloading = false

/** Reload onto the new build. Callers decide whether waiting work allows it. */
async function doReload(): Promise<void> {
  if (reloading) return
  reloading = true
  window.dispatchEvent(new Event('nalgorithm:checkpoint'))
  // Fetch the new worker and let it take over first, so the reload lands on
  // the new build and the worker itself is never left waiting for every tab
  // to close.
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await withTimeout(reg.update().then(() => installed(reg)), WORKER_WAIT_MS)
      if (reg.waiting) {
        const taken = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
        reg.waiting.postMessage('skip-waiting')
        await withTimeout(taken, WORKER_WAIT_MS)
      }
    }
  } catch {
    // No worker, or the update check failed: a plain reload is enough.
  }
  location.reload()
}

/** Resolves once a worker found by update() has finished installing (or there is none). */
function installed(reg: ServiceWorkerRegistration): Promise<void> {
  const worker = reg.installing
  if (!worker) return Promise.resolve()
  return new Promise((resolve) => {
    worker.addEventListener('statechange', () => {
      if (worker.state !== 'installing') resolve()
    })
  })
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    promise.then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); resolve() })
  })
}

function showBanner(newVersion: string): HTMLElement {
  const existing = document.querySelector<HTMLElement>('.update-banner')
  if (existing) return existing

  const el = document.createElement('div')
  el.className = 'update-banner'
  el.setAttribute('role', 'status')
  el.innerHTML = `
    <span>Version ${escapeHtml(newVersion.split('+')[0])} ready — <span class="update-count"></span></span>
    <button class="btn btn-small update-now">Reload now</button>
  `
  // An explicit request: it does not wait for playback or other deferrable work.
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
    navigator.serviceWorker.register(swUrl).then((reg) => {
      // A worker left waiting by an earlier visit (this page already runs the
      // new build, so versions match and no update cycle would ever start)
      // takes over now. Its shell is network-first, so nothing here changes.
      if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage('skip-waiting')
    }).catch(() => {
      // Registration failure is not fatal — the app works without it.
    })
  })

  // A worker taking control means the assets under us changed.
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return
    refreshing = true
    if (reloadScheduled && !activities.blocked) location.reload()
  })
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
