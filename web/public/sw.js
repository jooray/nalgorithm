/**
 * Nalgorithm service worker.
 *
 * Deliberately conservative about what it caches. The app shell is fetched
 * network-first so a deploy is picked up on the next load rather than being
 * pinned to whatever the cache holds — the failure mode this whole versioning
 * setup exists to prevent. Only content-hashed build assets, which can never
 * change under a given URL, are served cache-first.
 *
 * Nothing cross-origin is touched: relay sockets and LLM API calls go straight
 * to the network, and are never stored.
 */

// Replaced at build time so each release gets its own cache bucket.
const VERSION = '__APP_VERSION__'
const CACHE = `nalgorithm-${VERSION}`

// Resolved from the worker's own location so a subdirectory deploy works.
const SCOPE = new URL(self.registration ? self.registration.scope : './', self.location).pathname

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // Best-effort: a failed precache must not block activation.
      await cache.addAll([SCOPE]).catch(() => {})
      // Take over immediately; the page decides when to reload.
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((n) => n.startsWith('nalgorithm-') && n !== CACHE).map((n) => caches.delete(n))
      )
      await self.clients.claim()
    })()
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // The version probe must always hit the network.
  if (url.pathname.endsWith('/version.json')) return

  // Content-hashed assets are immutable: cache-first is safe and fast.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put(request, copy))
            }
            return res
          })
      )
    )
    return
  }

  // The shell (and anything else same-origin): network-first, cache as backup
  // so the app still opens offline.
  if (request.mode === 'navigate' || url.pathname === SCOPE) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(SCOPE, copy))
          }
          return res
        })
        .catch(() => caches.match(SCOPE).then((hit) => hit ?? Response.error()))
    )
  }
})
