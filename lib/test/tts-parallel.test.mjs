import { test } from 'node:test'
import assert from 'node:assert/strict'
import { synthesizeSpeech } from '../dist/index.js'

const config = { apiBaseUrl: 'https://tts.test', apiKey: 'k', model: 'm', voice: 'v', format: 'mp3', maxChars: 50 }
const text = Array.from({ length: 6 }, (_, i) => `Chunk number ${i} is spoken here.`).join(' ')

function fakeFetch({ delays, fail } = {}) {
  let active = 0, peak = 0
  const calls = []
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input
    calls.push(input)
    active++; peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, delays?.(input) ?? 5))
    active--
    if (fail?.(input)) return new Response('boom', { status: 500 })
    return new Response(new TextEncoder().encode(`[${input}]`), { status: 200 })
  }
  return { get peak() { return peak }, calls }
}

test('chunks are synthesized concurrently but joined in text order', async () => {
  const spy = fakeFetch({ delays: (input) => (input.includes('number 0') ? 60 : 5) })
  const audio = await synthesizeSpeech(config, text, { concurrency: 3, baseDelayMs: 1 })
  const out = new TextDecoder().decode(audio)
  assert.ok(spy.peak > 1 && spy.peak <= 3, `peak concurrency ${spy.peak}`)
  const order = [...out.matchAll(/number (\d)/g)].map((m) => m[1]).join('')
  assert.equal(order, '012345', 'joined in order even though chunk 0 finished last')
})

test('concurrency 1 is the old sequential behaviour, and a failing chunk fails the whole digest', async () => {
  const seq = fakeFetch()
  await synthesizeSpeech(config, text, { concurrency: 1, baseDelayMs: 1 })
  assert.equal(seq.peak, 1)
  fakeFetch({ fail: (input) => input.includes('number 3') })
  await assert.rejects(synthesizeSpeech(config, text, { concurrency: 3, maxAttempts: 2, baseDelayMs: 1 }))
})
