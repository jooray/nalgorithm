import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// markdown.ts imports its siblings the way the app does (.js), so bundle it first.
const out = await build({ entryPoints: ['src/markdown.ts'], absWorkingDir: new URL('..', import.meta.url).pathname, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
const { formatContent, isLongNote } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))

const plain = { bold: false, italic: false, code: false, strike: false }
const s = (over) => ({ ...plain, ...over })
const texts = (pieces) => pieces.map((p) => (p.kind === 'text' ? p.text : p.kind === 'link' ? `[${p.label}]` : `<${p.token.kind}>`)).join('')

test('bold, italic, code and strike lose their markers', () => {
  const p = formatContent('Ships **Amethyst Desktop** and *more*, `npm i` ~~old~~ __done__ _ok_')
  assert.equal(texts(p), 'Ships Amethyst Desktop and more, npm i old done ok')
  assert.deepEqual(p.find((x) => x.text === 'Amethyst Desktop').style, s({ bold: true }))
  assert.deepEqual(p.find((x) => x.text === 'more').style, s({ italic: true }))
  assert.deepEqual(p.find((x) => x.text === 'npm i').style, s({ code: true }))
  assert.deepEqual(p.find((x) => x.text === 'old').style, s({ strike: true }))
  assert.deepEqual(p.find((x) => x.text === 'done').style, s({ bold: true }))
  assert.deepEqual(p.find((x) => x.text === 'ok').style, s({ italic: true }))
})

test('snake_case, lone asterisks and math stay as written', () => {
  for (const t of ['call some_long_name now', '2 * 3 * 4 = 24', 'a**b', 'price: 5*', 'file_name_v2.txt and a__b__c']) {
    assert.equal(texts(formatContent(t)), t, t)
  }
})

test('nothing inside code is markdown', () => {
  const p = formatContent('run `a **b** c` now')
  assert.equal(texts(p), 'run a **b** c now')
  assert.deepEqual(p.find((x) => x.text === 'a **b** c').style, s({ code: true }))
})

test('headings become bold lines, bullets and rules are tidied', () => {
  const p = formatContent('## Contributors\n- one\n* two\n---\nend')
  assert.equal(texts(p), 'Contributors\n• one\n• two\n———\nend')
  assert.deepEqual(p.find((x) => x.text === 'Contributors').style, s({ bold: true }))
  assert.equal(texts(formatContent('#Amethyst v1.18')), '#Amethyst v1.18')
})

test('markdown links keep their label; images that render as media drop out', () => {
  const p = formatContent('see [the docs](https://example.com/a_b) and ![pic](https://x.test/i.png)', (u) => u.endsWith('.png'))
  assert.equal(texts(p), 'see [the docs] and')
  assert.deepEqual(p.find((x) => x.kind === 'link'), { kind: 'link', label: 'the docs', url: 'https://example.com/a_b', style: plain })
})

test('emphasis can wrap a mention and plain URLs stay tokens', () => {
  const npub = 'npub1' + 'q'.repeat(58)
  const p = formatContent(`**by nostr:${npub}** at https://example.com/x_y_z`)
  const mention = p.find((x) => x.kind === 'token' && x.token.kind === 'profile')
  assert.equal(mention.style.bold, true)
  const url = p.find((x) => x.kind === 'token' && x.token.kind === 'url')
  assert.equal(url.token.url, 'https://example.com/x_y_z')
})

test('private-use characters in a note cannot pose as placeholders', () => {
  assert.equal(texts(formatContent('abc')), 'a�b�c')
})

test('blank-line runs collapse and the ends are trimmed', () => {
  assert.equal(texts(formatContent('\n\n hi\n\n\n\nthere \n')), 'hi\n\nthere')
})

test('long notes: over 600 characters or 12 lines', () => {
  assert.equal(isLongNote('x'.repeat(600)), false)
  assert.equal(isLongNote('x'.repeat(601)), true)
  assert.equal(isLongNote('a\n'.repeat(11) + 'a'), false)
  assert.equal(isLongNote('a\n'.repeat(12) + 'a'), true)
})
