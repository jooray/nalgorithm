import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { uploadAudio } from '../dist/blossom.js'

const silent = { info() {}, warn() {} }
const collect = () => { const w = []; return { w, log: { info() {}, warn: (m) => w.push(m) } } }

/** A tiny Blossom: PUT /upload checks the auth event, GET|HEAD /<sha>[.ext] serves what was stored. */
async function mockBlossom({ stripExtension = false, contentType = 'audio/mpeg', fail = 0, bareUrl = true, servesExt = true } = {}) {
  const store = new Map()
  const seen = { auth: [], puts: 0 }
  let failLeft = fail
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'PUT' && url.pathname === '/upload') {
      seen.puts++
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        if (failLeft-- > 0) { res.writeHead(500, { 'X-Reason': 'busy' }); return res.end() }
        const ev = JSON.parse(Buffer.from(req.headers.authorization.replace('Nostr ', ''), 'base64').toString())
        seen.auth.push(ev)
        const body = Buffer.concat(chunks)
        const sha = req.headers['x-sha-256']
        store.set(sha, { body, type: req.headers['content-type'] })
        const origin = `http://127.0.0.1:${server.address().port}`
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ url: bareUrl ? `${origin}/${sha}` : `${origin}/${sha}.mp3`, sha256: sha, size: body.length }))
      })
      return
    }
    const m = /^\/([0-9a-f]{64})(\.[a-z0-9]+)?$/.exec(url.pathname)
    const hit = m && store.get(m[1])
    if (!hit || (m[2] && !servesExt)) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': hit.body.length })
    res.end(req.method === 'HEAD' ? undefined : hit.body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

const data = new Uint8Array([1, 2, 3, 4, 5])

test('uploads with a valid kind 24242 authorisation bound to the file hash', async () => {
  const b = await mockBlossom()
  const sk = generateSecretKey()
  try {
    const r = await uploadAudio({ servers: [b.url], secretKey: sk, log: silent, now: () => 1_800_000_000 }, data)
    const ev = b.seen.auth[0]
    assert.equal(ev.kind, 24242)
    assert.equal(verifyEvent(ev), true)
    assert.equal(ev.pubkey, getPublicKey(sk))
    assert.deepEqual(ev.tags.find((t) => t[0] === 't'), ['t', 'upload'])
    assert.equal(ev.tags.find((t) => t[0] === 'x')[1], r.sha256)
    assert.ok(Number(ev.tags.find((t) => t[0] === 'expiration')[1]) > 1_800_000_000, 'expiry is in the future')
  } finally { b.close() }
})

test('a bare /<sha256> URL gets a .mp3 extension when the server resolves it', async () => {
  const b = await mockBlossom()
  try {
    const r = await uploadAudio({ servers: [b.url], secretKey: generateSecretKey(), log: silent }, data)
    assert.match(r.url, /\/[0-9a-f]{64}\.mp3$/)
    assert.equal(r.servedAs, 'audio/mpeg')
  } finally { b.close() }
})

test('an URL that already has an extension is left alone', async () => {
  const b = await mockBlossom({ bareUrl: false })
  try {
    const r = await uploadAudio({ servers: [b.url], secretKey: generateSecretKey(), log: silent }, data)
    assert.match(r.url, /\.mp3$/)
    assert.doesNotMatch(r.url, /\.mp3\.mp3/)
  } finally { b.close() }
})

test('falls back to the bare URL when the extension variant does not resolve', async () => {
  const b = await mockBlossom({ servesExt: false })
  try {
    const r = await uploadAudio({ servers: [b.url], secretKey: generateSecretKey(), log: silent }, data)
    assert.match(r.url, /\/[0-9a-f]{64}$/)
  } finally { b.close() }
})

test('warns when the server would not serve the file as audio', async () => {
  const b = await mockBlossom({ contentType: 'application/octet-stream' })
  const { w, log } = collect()
  try {
    const r = await uploadAudio({ servers: [b.url], secretKey: generateSecretKey(), log }, data)
    assert.equal(r.servedAs, 'application/octet-stream')
    assert.ok(w.some((m) => m.includes('octet-stream')))
  } finally { b.close() }
})

test('tries the next server when the first fails, and reports every failure if all do', async () => {
  const bad = await mockBlossom({ fail: 99 })
  const good = await mockBlossom()
  try {
    const r = await uploadAudio({ servers: [bad.url, good.url], secretKey: generateSecretKey(), log: silent }, data)
    assert.equal(r.server, good.url)
    assert.equal(bad.seen.puts, 1)
    await assert.rejects(
      uploadAudio({ servers: [bad.url, 'http://127.0.0.1:1'], secretKey: generateSecretKey(), log: silent }, data),
      /no Blossom server accepted the upload.*busy/s,
    )
  } finally { bad.close(); good.close() }
})
