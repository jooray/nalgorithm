import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanText, decodeEntities, parsePreview } from '../dist/preview/parse.js'
import { page } from './preview-helpers.mjs'

const BASE = 'https://site.example/articles/one'

test('OpenGraph tags are read, and a relative image is made absolute', () => {
  const p = parsePreview(
    page(`<meta property="og:title" content="The Title"><meta property="og:description" content="About it">
      <meta property="og:image" content="/img/cover.png"><meta property="og:site_name" content="Site"><meta property="og:type" content="Article">
      <title>ignored</title>`),
    BASE,
  )
  assert.deepEqual(p, { title: 'The Title', description: 'About it', siteName: 'Site', image: 'https://site.example/img/cover.png', type: 'article' })
})

test('fallbacks: twitter tags, then <title> and meta description', () => {
  const tw = parsePreview(page('<meta name="twitter:title" content="TW"><meta name="twitter:description" content="TD"><meta name="twitter:image" content="https://cdn.example/a.jpg">'), BASE)
  assert.equal(tw.title, 'TW')
  assert.equal(tw.description, 'TD')
  assert.equal(tw.image, 'https://cdn.example/a.jpg')
  const plain = parsePreview(page('<TITLE>\n  Plain   page\n</TITLE><META NAME="Description" CONTENT="Just text">'), BASE)
  assert.equal(plain.title, 'Plain page')
  assert.equal(plain.description, 'Just text')
  assert.equal(plain.type, 'website')
  // OpenGraph wins over twitter, whichever comes first in the document.
  const both = parsePreview(page('<meta name="twitter:title" content="TW"><meta property="og:title" content="OG">'), BASE)
  assert.equal(both.title, 'OG')
})

test('missing tags give empty strings, not errors', () => {
  assert.deepEqual(parsePreview('', BASE), { title: '', description: '', siteName: '', image: '', type: 'website' })
  assert.deepEqual(parsePreview('just some text, no markup', BASE).title, '')
  assert.equal(parsePreview(page('<meta property="og:title">'), BASE).title, '')
  assert.equal(parsePreview(page('<meta property="og:title" content="   ">  <title>Fallback</title>'), BASE).title, 'Fallback')
})

test('entities are decoded once, numerics are validated', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry &lt;3 &#39;x&#39; &#x2014; &quot;q&quot; &unknown; &#0; &#xD800; &#9999999;'), `Tom & Jerry <3 'x' \u2014 "q" &unknown;${' '.repeat(6)}`)
  // &amp;lt; is the text "&lt;", not "<".
  assert.equal(decodeEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;')
  const p = parsePreview(page('<meta property="og:title" content="Caf&eacute; &amp; Bar &#8217;s">'), BASE)
  assert.equal(p.title, 'Café & Bar ’s')
})

test('lengths are capped on whole characters, with an ellipsis', () => {
  const long = 'x'.repeat(500)
  const p = parsePreview(page(`<meta property="og:title" content="${long}"><meta property="og:description" content="${long}">`), BASE)
  assert.equal(Array.from(p.title).length, 200)
  assert.equal(Array.from(p.description).length, 400)
  assert.ok(p.title.endsWith('…'))
  const emoji = cleanText('\u{1F600}'.repeat(300), 200)
  assert.equal(Array.from(emoji).length, 200)
  assert.doesNotMatch(emoji, /\ud83d$/)
  assert.equal(cleanText('short', 200), 'short')
})

test('control and bidi characters are removed', () => {
  assert.equal(cleanText('a\u0000b‮c​d\ne\t f', 50), 'a b c d e f')
})

test('hostile HTML: tags inside script, style, comments and after the head are ignored', () => {
  const p = parsePreview(
    `<html><head><!-- <meta property="og:title" content="comment"> -->
     <script>var s = '<meta property="og:title" content="script">'</script>
     <style>/* <meta property="og:title" content="style"> */</style>
     <meta property="og:title" content="real"></head>
     <body><meta property="og:description" content="in body"></body></html>`,
    BASE,
  )
  assert.equal(p.title, 'real')
  assert.equal(p.description, '')
})

test('hostile HTML: markup in values stays text, bad image schemes are dropped', () => {
  const p = parsePreview(page('<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;"><meta property="og:image" content="javascript:alert(1)">'), BASE)
  assert.equal(p.title, '<img src=x onerror=alert(1)>') // text for the client to show with textContent
  assert.equal(p.image, '')
  for (const image of ['data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://x/y.png', 'http://[bad']) {
    assert.equal(parsePreview(page(`<meta property="og:image" content="${image}">`), BASE).image, '')
  }
  assert.equal(parsePreview(page('<meta property="og:image" content="//cdn.example/x.png">'), BASE).image, 'https://cdn.example/x.png')
})

test('hostile HTML: unterminated and malformed input is handled quickly', () => {
  const started = Date.now()
  const inputs = [
    '<meta ' + 'a="'.repeat(50_000),
    '<script>' + '<meta property="og:title" content="x">'.repeat(20_000),
    '<!--' + 'x'.repeat(200_000),
    '<'.repeat(200_000),
    '<meta property="og:title" content="' + 'x'.repeat(1_000_000),
    '<title>' + 'y'.repeat(300_000),
    '<meta '.repeat(40_000),
    '<a b="c>'.repeat(30_000),
    '<meta "junk" property=og:title content=ok>',
  ]
  for (const html of inputs) parsePreview(html, BASE)
  assert.equal(parsePreview(inputs[8], BASE).title, 'ok')
  assert.ok(Date.now() - started < 3000, 'linear time')
  // A huge title is capped, not returned whole.
  assert.ok(parsePreview(inputs[5], BASE).title.length <= 200)
})

test('only the first part of the document is scanned', () => {
  const html = page('<title>' + 'x'.repeat(300_000) + '</title><meta property="og:title" content="late">')
  assert.notEqual(parsePreview(html, BASE).title, 'late')
})

test('unquoted and single-quoted attributes work; duplicates keep the first', () => {
  const p = parsePreview(page(`<meta property=og:title content=Unquoted><meta property='og:description' content='It''s'><meta property="og:title" content="second">`), BASE)
  assert.equal(p.title, 'Unquoted')
})

// Regression: fountain.fm renders its og: tags inside <body>, 40 KB after </head>.
test('tags that a site renders inside the body are used when the head has none', () => {
  const html = `<!doctype html><html><head><title>Fountain</title></head><body><div id="root">${'<p>x</p>'.repeat(50)}</div>` +
    `<meta property="og:title" content="Letter #7 &amp; more"/><meta property="og:description" content="Read aloud"/>` +
    `<meta property="og:image" content="/img/a.jpg"/><meta property="og:site_name" content="Fountain"/></body></html>`
  const p = parsePreview(html, 'https://fountain.fm/episode/x')
  assert.equal(p.title, 'Letter #7 & more')
  assert.equal(p.description, 'Read aloud')
  assert.equal(p.siteName, 'Fountain')
  assert.equal(p.image, 'https://fountain.fm/img/a.jpg')
})

test('the head always wins: body content cannot override or add to a site\'s own preview data', () => {
  const html = `<html><head><meta property="og:title" content="Real title"/></head>` +
    `<body><article>user comment: <meta property="og:title" content="Injected title"/><meta property="og:image" content="https://evil.example/x.png"/></article></body></html>`
  const p = parsePreview(html, 'https://site.example/')
  assert.equal(p.title, 'Real title')
  assert.equal(p.image, '', 'the body is not consulted when the head already has preview data')
})

test('scripts and styles in the body are still skipped when scanning the whole document', () => {
  const html = `<html><head></head><body><script>var s = '<meta property="og:title" content="from script">'</script>` +
    `<meta property="og:title" content="Real"/></body></html>`
  assert.equal(parsePreview(html, 'https://site.example/').title, 'Real')
})
