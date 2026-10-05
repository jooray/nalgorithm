import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readImeta } from '../dist/index.js'

test('imeta: url, size, description and type, bounded and http(s) only', () => {
  const media = readImeta([
    ['imeta', 'url https://img.example/a.jpg', 'dim 1200x800', 'alt A cat on a keyboard', 'm image/jpeg'],
    ['imeta', 'url javascript:alert(1)', 'dim 10x10'],
    ['imeta', 'url https://img.example/a.jpg'],
    ['imeta', 'url https://v.example/b.mp4', 'dim 0x5', 'm video/mp4'],
    ['p', 'x'],
  ])
  assert.deepEqual(media, [
    { url: 'https://img.example/a.jpg', width: 1200, height: 800, alt: 'A cat on a keyboard', mime: 'image/jpeg' },
    { url: 'https://v.example/b.mp4', mime: 'video/mp4' },
  ])
  assert.deepEqual(readImeta(undefined), [])
  assert.equal(readImeta(Array.from({ length: 20 }, (_, i) => ['imeta', `url https://x.example/${i}.png`])).length, 8)
})
