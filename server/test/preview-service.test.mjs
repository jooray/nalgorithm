import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { openDb } from '../dist/db.js'
import { createApp } from '../dist/app.js'
import { createSession } from '../dist/auth.js'
import { createPreviewService, normalizeUrl, PreviewError } from '../dist/preview/service.js'
import { DEFAULT_SETTINGS } from '../dist/settings.js'
import { fakeTransport, page, publicResolver } from './preview-helpers.mjs'

let shared
after(async () => {
  await shared?.close()
})
async function freshDb() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return openDb(':memory:')
  shared ??= await openDb(url)
  for (const t of ['link_previews', 'sessions', 'accounts']) await shared.exec(`DELETE FROM ${t}`)
  return shared
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
const ARTICLE = page('<meta property="og:title" content="Hello"><meta property="og:description" content="World"><meta property="og:image" content="https://img.example/c.png">')

function setup(routes, extra = {}) {
  const clock = { ms: 1_800_000_000_000 }
  const transport = fakeTransport(routes)
  return (async () => {
    const db = await freshDb()
    const svc = createPreviewService({
      db,
      nowMs: () => clock.ms,
      fetch: { transport, resolver: publicResolver() },
      skipHosts: ['app.example'],
      ...extra,
    })
    return { db, svc, clock, transport }
  })()
}

test('a page becomes a card with a signed, server-relative image path', async () => {
  const { svc } = await setup({ 'https://a.example/post': { body: ARTICLE } })
  const card = await svc.preview('u1', 'https://a.example/post#frag')
  assert.equal(card.title, 'Hello')
  assert.equal(card.description, 'World')
  assert.equal(card.siteName, 'a.example')
  assert.equal(card.url, 'https://a.example/post')
  assert.match(card.image, /^preview\/image\?u=[\w-]+&s=[\w-]+$/)
  assert.doesNotMatch(JSON.stringify(card), /img\.example\/c\.png/)
})

test('cache: hit within the ttl, refetch after 7 days, no per-user data stored', async () => {
  const { svc, clock, transport, db } = await setup({ 'https://a.example/post': { body: ARTICLE } })
  await svc.preview('u1', 'https://a.example/post')
  await svc.preview('u2', 'https://a.example/post#other-fragment')
  assert.equal(transport.calls.length, 1, 'second reader is served from the cache')
  clock.ms += 7 * 86_400_000 - 1000
  await svc.preview('u1', 'https://a.example/post')
  assert.equal(transport.calls.length, 1)
  clock.ms += 2000
  await svc.preview('u1', 'https://a.example/post')
  assert.equal(transport.calls.length, 2)
  const rows = await db.all('SELECT * FROM link_previews')
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['data', 'fetched_at', 'found', 'url_hash'])
  assert.doesNotMatch(JSON.stringify(rows), /u1|u2/)
})

test('cache: a failure is remembered for an hour only', async () => {
  const { svc, clock, transport } = await setup({ 'https://a.example/x': { status: 404, body: 'no' } })
  assert.deepEqual(await svc.preview('u', 'https://a.example/x'), { unavailable: true })
  assert.deepEqual(await svc.preview('u', 'https://a.example/x'), { unavailable: true })
  assert.equal(transport.calls.length, 1)
  clock.ms += 3599_000
  await svc.preview('u', 'https://a.example/x')
  assert.equal(transport.calls.length, 1)
  clock.ms += 2000
  await svc.preview('u', 'https://a.example/x')
  assert.equal(transport.calls.length, 2)
})

test('nothing to show: no title and no description is unavailable, and is cached as such', async () => {
  const { svc, transport } = await setup({ 'https://a.example/empty': { body: page('<meta property="og:image" content="https://i.example/x.png">') } })
  assert.deepEqual(await svc.preview('u', 'https://a.example/empty'), { unavailable: true })
  assert.deepEqual(await svc.preview('u', 'https://a.example/empty'), { unavailable: true })
  assert.equal(transport.calls.length, 1)
})

test('blocked targets are unavailable and never reach the transport', async () => {
  const { svc, transport } = await setup({})
  for (const u of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/', 'http://2130706433/', 'http://a.example:8080/']) {
    assert.deepEqual(await svc.preview('u', u), { unavailable: true }, u)
  }
  assert.equal(transport.calls.length, 0)
})

test('media URLs and the app own host are skipped without a fetch', async () => {
  const { svc, transport } = await setup({})
  for (const u of ['https://a.example/p.png', 'https://a.example/v.MP4?x=1', 'https://a.example/a.mp3', 'https://a.example/i.svg', 'https://app.example/x', 'https://sub.app.example/x']) {
    assert.deepEqual(await svc.preview('u', u), { unavailable: true }, u)
  }
  assert.equal(transport.calls.length, 0)
})

test('bad input is a 400', async () => {
  for (const bad of ['', 'not a url', 'ftp://a.example/', 'javascript:alert(1)', 'https://a.example/' + 'x'.repeat(3000)]) {
    assert.throws(() => normalizeUrl(bad), (e) => e instanceof PreviewError && e.status === 400, bad)
  }
})

test('rate limit: 60 previews a minute per user, and the window slides', async () => {
  const { svc, clock } = await setup({})
  for (let i = 0; i < 60; i++) await svc.preview('busy', `https://a.example/${i}.png`)
  await assert.rejects(svc.preview('busy', 'https://a.example/x.png'), (e) => e instanceof PreviewError && e.status === 429)
  await svc.preview('other', 'https://a.example/x.png') // another user is unaffected
  clock.ms += 61_000
  await svc.preview('busy', 'https://a.example/x.png')
})

test('concurrency: at most 4 fetches at once, the rest queue, identical URLs share one fetch', async () => {
  let active = 0
  let peak = 0
  const release = []
  const routes = {}
  for (let i = 0; i < 12; i++) {
    routes[`https://a.example/${i}`] = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => release.push(r))
      active--
      return { body: page(`<title>t${i}</title>`) }
    }
  }
  const { svc, transport } = await setup(routes, { previewsPerMinute: 1000 })
  const all = []
  for (let i = 0; i < 12; i++) all.push(svc.preview('u', `https://a.example/${i}`))
  all.push(svc.preview('u', 'https://a.example/0'), svc.preview('u', 'https://a.example/0'))
  const tick = () => new Promise((r) => setTimeout(r, 20))
  await tick()
  assert.equal(active, 4)
  while (release.length) {
    release.shift()()
    await tick()
  }
  const results = await Promise.all(all)
  assert.equal(results.filter((r) => r.title).length, 14)
  assert.equal(peak, 4)
  assert.equal(transport.calls.length, 12, 'duplicates were coalesced')
})

test('overload: a full queue answers 503 instead of opening more sockets', async () => {
  const gate = []
  const routes = {}
  for (let i = 0; i < 5; i++) routes[`https://a.example/${i}`] = async () => { await new Promise((r) => gate.push(r)); return { body: page('<title>t</title>') } }
  const { svc } = await setup(routes, { concurrency: 1, maxQueue: 2, previewsPerMinute: 1000 })
  const ps = [0, 1, 2].map((i) => svc.preview('u', `https://a.example/${i}`))
  await new Promise((r) => setTimeout(r, 20))
  await assert.rejects(svc.preview('u', 'https://a.example/3'), (e) => e instanceof PreviewError && e.status === 503)
  while (gate.length < 3) {
    gate.forEach((g) => g())
    await new Promise((r) => setTimeout(r, 10))
  }
  gate.forEach((g) => g())
  await Promise.all(ps)
})

test('prune removes only rows older than the ttl', async () => {
  const { svc, clock, db } = await setup({ 'https://a.example/1': { body: ARTICLE }, 'https://a.example/2': { body: ARTICLE } })
  await svc.preview('u', 'https://a.example/1')
  clock.ms += 6 * 86_400_000
  await svc.preview('u', 'https://a.example/2')
  clock.ms += 2 * 86_400_000
  assert.equal(await svc.prune(), 1)
  assert.equal((await db.all('SELECT url_hash FROM link_previews')).length, 1)
})

// ─── image endpoint ──────────────────────────────────────────────────────────

function imageParams(card) {
  return new URL(card.image, 'http://x/').searchParams
}

test('image: served through the server, sniffed, with private long cache headers; svg and html are refused', async () => {
  const { svc } = await setup({
    'https://a.example/post': { body: ARTICLE },
    'https://img.example/c.png': { type: 'image/png', body: PNG },
  })
  const card = await svc.preview('u', 'https://a.example/post')
  const q = imageParams(card)
  const img = await svc.image('u', q.get('u'), q.get('s'))
  assert.equal(img.type, 'image/png')
  assert.ok(img.body.equals(PNG))

  const bad = async (type, body, routeUrl = 'https://img.example/c.png') => {
    const t = await setup({ 'https://a.example/post': { body: ARTICLE }, [routeUrl]: { type, body } })
    const c = await t.svc.preview('u', 'https://a.example/post')
    const p = imageParams(c)
    await assert.rejects(t.svc.image('u', p.get('u'), p.get('s')), (e) => e instanceof PreviewError && e.status === 404, type)
  }
  await bad('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  await bad('text/html', '<script>alert(1)</script>')
  await bad('image/png', '<html>not really a png</html>') // the bytes must match the claim
  await bad('image/png', Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])) // over 2 MB
})

test('image: only ids issued by a preview are served, so it is not an open proxy', async () => {
  const { svc, transport } = await setup({ 'https://a.example/post': { body: ARTICLE }, 'https://evil.example/x.png': { type: 'image/png', body: PNG } })
  const card = await svc.preview('u', 'https://a.example/post')
  const q = imageParams(card)
  const own = (url) => Buffer.from(url).toString('base64url')
  const before = transport.calls.length
  const attempts = [
    ['', ''],
    [own('https://evil.example/x.png'), ''],
    [own('https://evil.example/x.png'), q.get('s')], // a valid signature for a different URL
    [q.get('u'), 'A'.repeat(q.get('s').length)],
    [q.get('u'), q.get('s') + 'A'],
    ['%%%', 'x'],
    [own('http://127.0.0.1/secret.png'), q.get('s')],
  ]
  for (const [u, s] of attempts) {
    await assert.rejects(svc.image('u', u, s), (e) => e instanceof PreviewError && e.status === 404, `${u} ${s}`)
  }
  assert.equal(transport.calls.length, before, 'nothing was fetched for a refused id')
  // Another process (another secret) cannot use this server's paths.
  const other = createPreviewService({ db: await freshDb(), fetch: { transport, resolver: publicResolver() } })
  await assert.rejects(other.image('u', q.get('u'), q.get('s')), PreviewError)
})

test('image: a signed URL to a private address is still refused by the fetch rules', async () => {
  const html = page('<meta property="og:title" content="T"><meta property="og:image" content="http://192.168.1.1/cam.png">')
  const { svc, transport } = await setup({ 'https://a.example/post': { body: html } })
  const card = await svc.preview('u', 'https://a.example/post')
  const q = imageParams(card)
  await assert.rejects(svc.image('u', q.get('u'), q.get('s')), (e) => e.status === 404)
  assert.equal(transport.calls.length, 1)
})

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function withApp(routes, fn, extra = {}) {
  const { svc, db } = await setup(routes, extra)
  const T0 = 1_800_000_000
  const server = createServer(
    createApp({
      db,
      billing: {},
      feed: async () => ({}),
      publicUrl: 'https://app.example/api',
      secureCookie: false,
      log: { info() {}, warn() {} },
      now: () => T0,
      previews: svc,
    }),
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const { token } = await createSession(db, 'npub-test', T0)
  const get = (path, auth = true) => fetch(base + path, { headers: auth ? { Authorization: `Bearer ${token}` } : {} })
  try {
    await fn({ get })
  } finally {
    server.close()
  }
}

test('HTTP: /preview needs a session, validates the url and returns the card', async () => {
  await withApp({ 'https://a.example/post': { body: ARTICLE }, 'https://img.example/c.png': { type: 'image/png', body: PNG } }, async ({ get }) => {
    assert.equal((await get('/preview?url=https%3A%2F%2Fa.example%2Fpost', false)).status, 401)
    assert.equal((await get('/preview/image?u=x&s=y', false)).status, 401)
    assert.equal((await get('/preview')).status, 400)
    assert.equal((await get('/preview?url=ftp%3A%2F%2Fa.example%2F')).status, 400)
    const res = await get('/preview?url=' + encodeURIComponent('https://a.example/post'))
    assert.equal(res.status, 200)
    const card = await res.json()
    assert.deepEqual(Object.keys(card).sort(), ['description', 'finalUrl', 'image', 'siteName', 'title', 'type', 'url'])
    assert.equal(card.title, 'Hello')

    const img = await get('/' + card.image)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.match(img.headers.get('cache-control'), /private, max-age=604800/)
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(PNG))

    const refused = await get('/preview/image?u=' + Buffer.from('http://127.0.0.1/').toString('base64url') + '&s=nope')
    assert.equal(refused.status, 404)
    assert.equal((await get('/preview?url=' + encodeURIComponent('http://127.0.0.1:8350/me'))).status, 200)
  })
})

test('HTTP: the 61st preview in a minute is a 429; unavailable is a plain 200', async () => {
  await withApp({}, async ({ get }) => {
    for (let i = 0; i < 60; i++) {
      const res = await get('/preview?url=' + encodeURIComponent(`https://a.example/${i}.png`))
      assert.deepEqual(await res.json(), { unavailable: true })
    }
    const res = await get('/preview?url=' + encodeURIComponent('https://a.example/z.png'))
    assert.equal(res.status, 429)
    assert.equal((await res.json()).error, 'too many previews, slow down')
  })
})

test('the link preview setting defaults to on', () => {
  assert.equal(DEFAULT_SETTINGS.linkPreviews, true)
})

// Regression: one network blip used to hide a link's preview for a full hour.
test('a transient failure is retried after two minutes, a definitive miss is remembered for an hour', async () => {
  const { PreviewFetchError } = await import('../dist/preview/ssrf.js')
  let up = false
  const routes = {
    'https://flaky.example/a': () => { if (!up) throw new PreviewFetchError('network', 'request failed'); return { body: ARTICLE } },
    'https://plain.example/a': { body: page('<title></title>') },
  }
  const { svc, clock, transport } = await setup(routes)
  const calls = (host) => transport.calls.filter((c) => c.url.includes(host)).length

  assert.deepEqual(await svc.preview('u', 'https://flaky.example/a'), { unavailable: true })
  assert.deepEqual(await svc.preview('u', 'https://flaky.example/a'), { unavailable: true })
  assert.equal(calls('flaky'), 1, 'inside two minutes the failure is remembered, so a dead site is not hammered')
  up = true
  clock.ms += 121_000
  assert.equal((await svc.preview('u', 'https://flaky.example/a')).title, 'Hello', 'after two minutes it is tried again and now works')

  assert.deepEqual(await svc.preview('u', 'https://plain.example/a'), { unavailable: true })
  clock.ms += 59 * 60_000
  await svc.preview('u', 'https://plain.example/a')
  assert.equal(calls('plain'), 1, 'a page with no preview data stays cached for the hour')
  clock.ms += 2 * 60_000
  await svc.preview('u', 'https://plain.example/a')
  assert.equal(calls('plain'), 2, 'and is looked at again after it')
})

test('server errors and rate limiting count as transient too, a 404 does not', async () => {
  const { svc, clock, transport } = await setup({
    'https://five.example/a': { status: 503 },
    'https://gone.example/a': { status: 404 },
  })
  await svc.preview('u', 'https://five.example/a'); await svc.preview('u', 'https://gone.example/a')
  clock.ms += 121_000
  await svc.preview('u', 'https://five.example/a'); await svc.preview('u', 'https://gone.example/a')
  const calls = (host) => transport.calls.filter((c) => c.url.includes(host)).length
  assert.equal(calls('five'), 2, '503 is retried after two minutes')
  assert.equal(calls('gone'), 1, '404 is definitive')
})
