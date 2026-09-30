import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mp3DurationSeconds } from '../dist/mp3-duration.js'
import { concat, frame, id3v2, mp3 } from './mp3-fixture.mjs'

const close = (actual, expected, eps = 0.001) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not ${expected}`)

test('MPEG1 Layer III: 1152 samples per frame, for each bitrate and sample rate', () => {
  for (const bitrate of [32, 64, 128, 192, 320]) {
    for (const rate of [44100, 48000, 32000]) {
      close(mp3DurationSeconds(mp3({ version: 1, bitrate, rate, frames: 200 })), (200 * 1152) / rate)
    }
  }
})

test('MPEG2 and MPEG2.5 Layer III: 576 samples per frame', () => {
  close(mp3DurationSeconds(mp3({ version: 2, bitrate: 64, rate: 24000, frames: 300 })), (300 * 576) / 24000)
  close(mp3DurationSeconds(mp3({ version: 2, bitrate: 32, rate: 22050, frames: 120 })), (120 * 576) / 22050)
  close(mp3DurationSeconds(mp3({ version: 2.5, bitrate: 16, rate: 8000, frames: 50 })), (50 * 576) / 8000)
  close(mp3DurationSeconds(mp3({ version: 2, bitrate: 48, rate: 16000, frames: 80, mono: true })), (80 * 576) / 16000)
})

test('padding bits change the frame length but not its duration', () => {
  const data = concat(...Array.from({ length: 100 }, (_, i) => frame({ bitrate: 128, rate: 44100, padding: i % 2 })))
  close(mp3DurationSeconds(data), (100 * 1152) / 44100)
})

test('an ID3v2 tag (with a footer too) is skipped, even one that contains a false sync pattern', () => {
  const tag = id3v2(300)
  tag.set([0xff, 0xfb, 0x90, 0x00], 50)
  close(mp3DurationSeconds(concat(tag, mp3({ frames: 40 }))), (40 * 1152) / 44100)
  close(mp3DurationSeconds(concat(id3v2(64, { footer: true }), mp3({ frames: 40 }))), (40 * 1152) / 44100)
})

test('several TTS chunks joined end to end add up, including a change of sample rate between them', () => {
  const a = mp3({ bitrate: 64, rate: 24000, version: 2, frames: 100 })
  const b = mp3({ bitrate: 64, rate: 24000, version: 2, frames: 150 })
  close(mp3DurationSeconds(concat(a, b)), (250 * 576) / 24000)
  close(mp3DurationSeconds(concat(mp3({ frames: 10 }), mp3({ version: 2, bitrate: 64, rate: 24000, frames: 10 }))), (10 * 1152) / 44100 + (10 * 576) / 24000)
})

test('garbage between frames is skipped and the parser resyncs', () => {
  const junk = new Uint8Array(333).fill(0x11)
  const data = concat(mp3({ frames: 30 }), junk, mp3({ frames: 20 }))
  // The frame before the junk is confirmed by its predecessor, so all 50 count.
  close(mp3DurationSeconds(data), (50 * 1152) / 44100)
})

test('a partial last frame and a trailing ID3v1 tag add nothing', () => {
  const full = mp3({ frames: 30 })
  const partial = frame().slice(0, 100)
  close(mp3DurationSeconds(concat(full, partial)), (30 * 1152) / 44100)
  const v1 = new Uint8Array(128)
  v1.set([0x54, 0x41, 0x47])
  close(mp3DurationSeconds(concat(full, v1)), (30 * 1152) / 44100)
  close(mp3DurationSeconds(concat(full, new Uint8Array([0xff, 0xfb]))), (30 * 1152) / 44100, 0.001)
})

test('a Xing/Info header frame carries no audio', () => {
  const info = frame({ bitrate: 128, rate: 44100 })
  info.set([0x49, 0x6e, 0x66, 0x6f], 4 + 32) // "Info" after the stereo side info
  close(mp3DurationSeconds(concat(info, mp3({ frames: 40 }))), (40 * 1152) / 44100)
  const xing = frame({ version: 2, bitrate: 64, rate: 24000, mono: true })
  xing.set([0x58, 0x69, 0x6e, 0x67], 4 + 9)
  close(mp3DurationSeconds(concat(xing, mp3({ version: 2, bitrate: 64, rate: 24000, mono: true, frames: 40 }))), (40 * 576) / 24000)
})

test('no MP3 in the bytes gives null: empty, random text, a WAV header, free format or reserved fields', () => {
  assert.equal(mp3DurationSeconds(new Uint8Array(0)), null)
  assert.equal(mp3DurationSeconds(new TextEncoder().encode('RIFF....WAVEfmt this is not an mp3 at all')), null)
  assert.equal(mp3DurationSeconds(new Uint8Array([1, 2, 3])), null)
  assert.equal(mp3DurationSeconds(new Uint8Array(4000).fill(0xff)), null)
  const freeFormat = frame()
  freeFormat[2] &= 0x0f
  assert.equal(mp3DurationSeconds(concat(freeFormat, freeFormat)), null)
  const layer2 = frame()
  layer2[1] = 0xfd
  assert.equal(mp3DurationSeconds(concat(layer2, layer2)), null, 'Layer II is not read')
})

test('the real sample digest is 56.475 seconds (ffprobe)', () => {
  const sample = readFileSync(new URL('../../landing/assets/sample-digest.mp3', import.meta.url))
  const s = mp3DurationSeconds(new Uint8Array(sample))
  assert.ok(s >= 56.4 && s <= 56.6, `got ${s}`)
})
