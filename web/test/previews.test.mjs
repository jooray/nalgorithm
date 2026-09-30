import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPreviewUrls, previewsEnabled, readLinkCard, safeImagePath } from '../src/hosted/previews-logic.ts'

test('extractPreviewUrls: first two page links, in order', () => {
  const text = 'read https://a.example/one and https://b.example/two, also https://c.example/three'
  assert.deepEqual(extractPreviewUrls(text), ['https://a.example/one', 'https://b.example/two'])
  assert.deepEqual(extractPreviewUrls(text, '', 3).length, 3)
  assert.deepEqual(extractPreviewUrls('no links here'), [])
})

test('extractPreviewUrls: skips media and images hosts that render inline', () => {
  const text = [
    'https://a.example/pic.PNG', 'https://a.example/clip.mp4?x=1'.replace('?x=1', ''), 'https://a.example/song.mp3',
    'https://image.nostr.build/abc', 'https://nostr.build/i/x', 'https://a.example/drawing.svg', 'https://a.example/article',
  ].join(' ')
  assert.deepEqual(extractPreviewUrls(text), ['https://a.example/article'])
})

test('extractPreviewUrls: skips the app host, duplicates, fragments-only duplicates and credentials', () => {
  const text = 'https://app.example/x https://a.example/p https://a.example/p#top https://a.example/p https://u:pw@b.example/ https://b.example/q'
  assert.deepEqual(extractPreviewUrls(text, 'app.example'), ['https://a.example/p', 'https://b.example/q'])
})

test('extractPreviewUrls: trailing punctuation and non-http schemes', () => {
  assert.deepEqual(extractPreviewUrls('(see https://a.example/p). Also https://b.example/q!'), ['https://a.example/p', 'https://b.example/q'])
  assert.deepEqual(extractPreviewUrls('ftp://a.example/x javascript:alert(1) nostr:npub1abc'), [])
  assert.deepEqual(extractPreviewUrls('https://[bad https://ok.example/'), ['https://ok.example/'])
})

test('safeImagePath only lets the server image path through', () => {
  const good = 'preview/image?u=aHR0cHM6Ly9leC5jb20vYS5wbmc&s=abc_DEF-123'
  assert.equal(safeImagePath(good), good)
  for (const bad of [
    'https://evil.example/x.png', '//evil.example/x.png', '/preview/image?u=a&s=b', 'preview/image?u=a&s=b&x=1', 'javascript:alert(1)',
    'preview/image?u=a b&s=b', 'data:image/png;base64,AAAA', '../preview/image?u=a&s=b', 'preview/image?u=a&s=', 5, null, undefined, {},
  ]) {
    assert.equal(safeImagePath(bad), '', String(bad))
  }
})

test('readLinkCard: unavailable and junk give null, text is capped, the image is vetted', () => {
  assert.equal(readLinkCard({ unavailable: true }), null)
  assert.equal(readLinkCard(null), null)
  assert.equal(readLinkCard('x'), null)
  assert.equal(readLinkCard({ title: '', description: '' }), null)
  assert.equal(readLinkCard({ title: 5 }), null)
  const c = readLinkCard({ title: 'T'.repeat(500), description: 'D', siteName: 's', image: 'https://evil.example/i.png' })
  assert.equal(c.title.length, 200)
  assert.equal(c.image, '')
  assert.equal(readLinkCard({ description: '<b>only</b>' }).description, '<b>only</b>') // kept as text; the page uses textContent
})

test('previewsEnabled: on unless the setting is exactly false', () => {
  assert.equal(previewsEnabled({ linkPreviews: true }), true)
  assert.equal(previewsEnabled({}), true)
  assert.equal(previewsEnabled(null), true)
  assert.equal(previewsEnabled({ linkPreviews: false }), false)
})
