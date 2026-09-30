import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { PreviewFetchError, isBlockedAddress, safeFetch, vetUrl } from '../dist/preview/ssrf.js'
import { fakeTransport, page, publicResolver, response } from './preview-helpers.mjs'

const html = { acceptType: (t) => t === 'text/html', accept: 'text/html', maxBytes: 1024 * 1024, truncate: true }
const refuses = (p, code) => assert.rejects(p, (e) => e instanceof PreviewFetchError && (code === undefined || e.code === code))

test('address matrix: every non-public range is blocked, public addresses are not', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '224.0.0.1', '239.255.255.255',
    '255.255.255.255', '240.0.0.1', '192.0.2.1', '198.18.0.1',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::ffff:192.168.1.1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '2001:db8::1',
    '64:ff9b::7f00:1', '2002:7f00:1::', '::127.0.0.1', 'not-an-ip',
  ]
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip)
  const open = ['93.184.216.34', '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:8.8.8.8', '2001:4860:4860::8888']
  for (const ip of open) assert.equal(isBlockedAddress(ip), false, ip)
})

test('loopback is only allowed by the explicit test option', () => {
  assert.equal(isBlockedAddress('127.0.0.1', true), false)
  assert.equal(isBlockedAddress('::1', true), false)
  assert.equal(isBlockedAddress('::ffff:127.0.0.1', true), false)
  assert.equal(isBlockedAddress('10.0.0.1', true), true)
  assert.equal(isBlockedAddress('169.254.169.254', true), true)
})

test('URL forms: tricky spellings of loopback and private hosts never reach the transport', async () => {
  const transport = fakeTransport({})
  const resolver = async () => {
    throw new Error('an address literal must not be resolved')
  }
  const urls = [
    'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0x7f000001/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/',
    'http://10.1.2.3/', 'http://192.168.0.10/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://0.0.0.0/', 'http://[::]/',
    'https://3232235777/', 'http://017700000001/', 'http://0/',
  ]
  for (const u of urls) await refuses(safeFetch(u, { ...html, transport, resolver }), 'blocked')
  assert.equal(transport.calls.length, 0)
})

test('URL rules: scheme, credentials, ports', async () => {
  const transport = fakeTransport({})
  for (const u of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/html,hi']) {
    await refuses(safeFetch(u, { ...html, transport, resolver: publicResolver() }), 'invalid')
  }
  await refuses(safeFetch('http://user:pw@example.com/', { ...html, transport, resolver: publicResolver() }), 'invalid')
  await refuses(safeFetch('http://user@example.com/', { ...html, transport, resolver: publicResolver() }), 'invalid')
  for (const u of ['http://example.com:8080/', 'https://example.com:22/', 'http://example.com:6379/', 'https://example.com:8443/']) {
    await refuses(safeFetch(u, { ...html, transport, resolver: publicResolver() }), 'blocked')
  }
  assert.equal(transport.calls.length, 0)
  // 80 and 443 are fine, and so are the defaults.
  for (const u of ['http://example.com:80/', 'https://example.com:443/', 'http://example.com/']) {
    const t = fakeTransport({ [new URL(u).toString()]: { body: page('<title>x</title>') } })
    await safeFetch(u, { ...html, transport: t, resolver: publicResolver() })
  }
})

test('a hostname that resolves to a private address is refused, even when other answers are public', async () => {
  const transport = fakeTransport({})
  await refuses(safeFetch('http://internal.example/', { ...html, transport, resolver: publicResolver({ 'internal.example': ['10.0.0.5'] }) }), 'blocked')
  await refuses(safeFetch('http://mixed.example/', { ...html, transport, resolver: publicResolver({ 'mixed.example': ['93.184.216.34', '127.0.0.1'] }) }), 'blocked')
  await refuses(safeFetch('http://v6.example/', { ...html, transport, resolver: publicResolver({ 'v6.example': ['::ffff:169.254.169.254'] }) }), 'blocked')
  await refuses(safeFetch('http://nothing.example/', { ...html, transport, resolver: async () => [] }), 'network')
  await refuses(safeFetch('http://nxdomain.example/', { ...html, transport, resolver: async () => { throw new Error('ENOTFOUND') } }), 'network')
  assert.equal(transport.calls.length, 0)
})

test('the vetted address is the one connected to, and the URL keeps its hostname', async () => {
  let answers = 0
  // A resolver that would answer differently the second time: it is asked once per hop only.
  const resolver = async () => (answers++ === 0 ? ['93.184.216.34'] : ['127.0.0.1'])
  const transport = fakeTransport({ 'https://rebind.example/a': { body: page('<title>t</title>') } })
  await safeFetch('https://rebind.example/a', { ...html, transport, resolver })
  assert.equal(answers, 1)
  assert.equal(transport.calls[0].ip, '93.184.216.34')
  assert.equal(transport.calls[0].url, 'https://rebind.example/a')
  assert.equal(transport.calls[0].headers['User-Agent'], 'nalgorithm-link-preview')
  assert.equal(transport.calls[0].headers.Cookie, undefined)
  assert.equal(transport.calls[0].headers['Accept-Encoding'], 'identity')
})

test('redirects: each hop is vetted again', async () => {
  const resolver = publicResolver({ 'evil.example': ['192.168.1.1'] })
  const go = (location) => fakeTransport({ 'http://a.example/': { status: 302, headers: { location } } })
  await refuses(safeFetch('http://a.example/', { ...html, transport: go('http://127.0.0.1/admin'), resolver }), 'blocked')
  await refuses(safeFetch('http://a.example/', { ...html, transport: go('http://169.254.169.254/latest/meta-data/'), resolver }), 'blocked')
  await refuses(safeFetch('http://a.example/', { ...html, transport: go('http://evil.example/'), resolver }), 'blocked')
  await refuses(safeFetch('http://a.example/', { ...html, transport: go('http://a.example:8080/'), resolver }), 'blocked')
  await refuses(safeFetch('http://a.example/', { ...html, transport: go('ftp://a.example/'), resolver }), 'invalid')
  await refuses(safeFetch('http://a.example/', { ...html, transport: go('file:///etc/passwd'), resolver }), 'invalid')
  await refuses(safeFetch('http://a.example/', { ...html, transport: fakeTransport({ 'http://a.example/': { status: 301 } }), resolver }), 'status')
})

test('redirects: no downgrade from https, a relative target works, a loop and a long chain stop', async () => {
  const resolver = publicResolver()
  await refuses(
    safeFetch('https://a.example/', { ...html, resolver, transport: fakeTransport({ 'https://a.example/': { status: 301, headers: { location: 'http://a.example/x' } } }) }),
    'downgrade',
  )
  // http to https and a relative Location are fine.
  const ok = fakeTransport({
    'http://a.example/': { status: 301, headers: { location: 'https://a.example/b' } },
    'https://a.example/b': { status: 302, headers: { location: '/c?x=1' } },
    'https://a.example/c?x=1': { body: page('<title>done</title>') },
  })
  const r = await safeFetch('http://a.example/', { ...html, resolver, transport: ok })
  assert.equal(r.finalUrl, 'https://a.example/c?x=1')
  // A loop.
  const loop = fakeTransport({ 'http://a.example/': { status: 302, headers: { location: 'http://b.example/' } }, 'http://b.example/': { status: 302, headers: { location: 'http://a.example/' } } })
  await refuses(safeFetch('http://a.example/', { ...html, resolver, transport: loop }), 'redirects')
  assert.equal(loop.calls.length, 4)
  // Exactly three redirects are allowed, a fourth is not.
  const chain = (n) => {
    const routes = {}
    for (let i = 0; i < n; i++) routes[`http://h${i}.example/`] = { status: 302, headers: { location: `http://h${i + 1}.example/` } }
    routes[`http://h${n}.example/`] = { body: page('<title>end</title>') }
    return fakeTransport(routes)
  }
  assert.equal((await safeFetch('http://h0.example/', { ...html, resolver, transport: chain(3) })).finalUrl, 'http://h3.example/')
  await refuses(safeFetch('http://h0.example/', { ...html, resolver, transport: chain(4) }), 'redirects')
})

test('bodies: HTML is cut at the cap and reading stops; an oversize image is an error', async () => {
  const big = Buffer.alloc(100, 'a')
  let handle
  const transport = async (req) => {
    handle = response({ chunks: Array.from({ length: 1000 }, () => big) }, req.signal)
    return handle
  }
  const r = await safeFetch('http://a.example/', { ...html, maxBytes: 250, transport, resolver: publicResolver() })
  assert.equal(r.body.length, 250)
  assert.equal(handle.state.read, 3, 'stopped after the chunk that crossed the cap')
  assert.equal(handle.state.destroyed, true)

  await refuses(safeFetch('http://a.example/', { ...html, maxBytes: 250, truncate: false, transport, resolver: publicResolver() }), 'size')
  const declared = fakeTransport({ 'http://a.example/': { headers: { 'content-length': '999999999' }, body: 'x' } })
  await refuses(safeFetch('http://a.example/', { ...html, truncate: false, transport: declared, resolver: publicResolver() }), 'size')
})

test('content types and status codes', async () => {
  const resolver = publicResolver()
  for (const type of ['application/json', 'image/png', 'application/pdf', 'text/plain', '']) {
    await refuses(safeFetch('http://a.example/', { ...html, resolver, transport: fakeTransport({ 'http://a.example/': { type, body: '<title>x</title>' } }) }), 'type')
  }
  const xhtml = { ...html, acceptType: (t) => t === 'text/html' || t === 'application/xhtml+xml' }
  const r = await safeFetch('http://a.example/', { ...xhtml, resolver, transport: fakeTransport({ 'http://a.example/': { type: 'Application/XHTML+xml; charset=utf-8', body: 'x' } }) })
  assert.equal(r.mediaType, 'application/xhtml+xml')
  for (const status of [400, 404, 500]) {
    await refuses(safeFetch('http://a.example/', { ...html, resolver, transport: fakeTransport({ 'http://a.example/': { status, body: 'x' } }) }), 'status')
  }
})

test('a slow body and slow headers both hit the total timeout', async () => {
  const resolver = publicResolver()
  const started = Date.now()
  await refuses(
    safeFetch('http://a.example/', { ...html, resolver, timeoutMs: 80, transport: fakeTransport({ 'http://a.example/': { body: '<title>', hang: true } }) }),
    'timeout',
  )
  const slowHeaders = () => new Promise(() => {})
  await refuses(safeFetch('http://a.example/', { ...html, resolver, timeoutMs: 80, transport: slowHeaders }), 'timeout')
  await refuses(safeFetch('http://a.example/', { ...html, timeoutMs: 80, transport: fakeTransport({}), resolver: () => new Promise(() => {}) }), 'timeout')
  assert.ok(Date.now() - started < 2000)
})

test('vetUrl returns the address to pin', async () => {
  const v = await vetUrl('https://x.example/p', { resolver: publicResolver({ 'x.example': ['2606:2800:220:1::1'] }) })
  assert.equal(v.ip, '2606:2800:220:1::1')
  assert.equal(v.family, 6)
})

test('the real transport connects to the pinned address and sends the hostname as Host', async () => {
  let seen
  const server = createServer((req, res) => {
    seen = req.headers
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'a=b' })
    res.end(page('<title>real</title>'))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    const url = `http://pinned.test:${port}/path?q=1`
    // By default loopback (and the port) is refused, whatever the name resolves to.
    await refuses(safeFetch(url, { ...html, resolver: publicResolver({ 'pinned.test': ['127.0.0.1'] }) }), 'blocked')
    const r = await safeFetch(url, { ...html, allowLoopback: true, resolver: publicResolver({ 'pinned.test': ['127.0.0.1'] }) })
    assert.match(r.body.toString(), /<title>real<\/title>/)
    assert.equal(seen.host, `pinned.test:${port}`)
    assert.equal(seen['user-agent'], 'nalgorithm-link-preview')
    assert.equal(seen.cookie, undefined)
    assert.equal(seen['accept-encoding'], 'identity')
  } finally {
    server.close()
  }
})

// Regression: a host that lists IPv6 addresses this machine cannot route to (a common
// situation) used to fail, because only the first resolved address was tried. Found
// against a real site whose DNS answer contained both families.
test('addresses are tried IPv4 first, and the next one is used only when the connection fails', async () => {
  const resolver = publicResolver({ 'dual.example': ['2606:4700:3037::6815:5dc9', '104.21.93.201', '172.67.214.92', '2606:4700:3037::ac43:d65c'] })
  const vetted = await vetUrl('https://dual.example/', { resolver })
  assert.deepEqual(vetted.candidates.map((c) => c.ip), ['104.21.93.201', '172.67.214.92', '2606:4700:3037::6815:5dc9', '2606:4700:3037::ac43:d65c'], 'IPv4 first, order kept within a family')
  assert.equal(vetted.ip, '104.21.93.201')

  // IPv4 unreachable here, IPv6 works: the fetch falls through to it.
  const tried = []
  const transport = async (req) => {
    tried.push(req.ip)
    if (req.family === 4) throw new PreviewFetchError('network', 'request failed')
    return response({ body: page('<title>ok</title>') }, req.signal)
  }
  const r = await safeFetch('https://dual.example/', { ...html, transport, resolver })
  assert.match(r.body.toString(), /ok/)
  assert.deepEqual(tried, ['104.21.93.201', '172.67.214.92', '2606:4700:3037::6815:5dc9'], 'stops at the first address that connects')
})

test('failover never hides a refusal: a response is final, and all-failed reports the failure', async () => {
  const resolver = publicResolver({ 'dual.example': ['104.21.93.201', '2606:4700:3037::6815:5dc9'] })
  // A 403 from the first address is an answer, not a connection failure: no second attempt.
  const seen = []
  await refuses(safeFetch('https://dual.example/', { ...html, resolver, transport: async (req) => { seen.push(req.ip); return response({ status: 403 }, req.signal) } }), 'status')
  assert.equal(seen.length, 1)
  // Every address fails to connect: the caller sees a network error, not a hang.
  const failing = async () => { throw new PreviewFetchError('network', 'request failed') }
  await refuses(safeFetch('https://dual.example/', { ...html, resolver, transport: failing }), 'network')
})

test('every address must still be public: one private answer refuses the host even if it is not the first', async () => {
  const resolver = publicResolver({ 'mixed.example': ['93.184.216.34', '10.0.0.5'] })
  const transport = fakeTransport({})
  await refuses(safeFetch('https://mixed.example/', { ...html, transport, resolver }), 'blocked')
  assert.equal(transport.calls.length, 0)
})
