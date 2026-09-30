import { test } from 'node:test'
import assert from 'node:assert/strict'
import { miniClock, miniView, scrollAfterInsert } from '../src/mini-player-logic.ts'

const latest = (over = {}) => ({ when: 'Today, 7:30', length: '3 min 52 s', playing: false, pos: 0, dur: 232, resumeHint: null, ...over })
const view = (over = {}, running = false) => miniView({ running, elapsedSeconds: 3, latest: latest(over) })

test('no digest and nothing running: no bar', () => {
  assert.deepEqual(miniView({ running: false, elapsedSeconds: 0, latest: null }), { kind: 'none' })
})

test('running with no digest yet: a slim writing bar with the elapsed time', () => {
  assert.deepEqual(miniView({ running: true, elapsedSeconds: 75, latest: null }), { kind: 'running', title: 'Writing your digest… 1:15' })
})

test('running beside an older digest shows the writing bar, not a play button', () => {
  assert.equal(view({}, true).kind, 'running')
})

test('running while the latest digest is playing keeps the playback controls', () => {
  const v = view({ playing: true, pos: 10 }, true)
  assert.equal(v.kind, 'ready')
  assert.equal(v.playing, true)
})

test('ready: title, date and exact length, no progress, no hint', () => {
  const v = view()
  assert.equal(v.kind, 'ready')
  assert.equal(v.title, 'Your morning')
  assert.equal(v.meta, 'Today, 7:30 · 3 min 52 s')
  assert.equal(v.progress, null)
  assert.equal(v.hint, null)
  assert.equal(v.playing, false)
  assert.match(v.buttonLabel, /^Play /)
})

test('the length label is used as given, so the about rule stays with the caller', () => {
  assert.equal(view({ length: 'about 4 min' }).meta, 'Today, 7:30 · about 4 min')
})

test('resume: hint and a thin progress line at the saved place', () => {
  const v = view({ pos: 58, resumeHint: 'Resume at 0:58' })
  assert.equal(v.hint, 'Resume at 0:58')
  assert.ok(Math.abs(v.progress - 58 / 232) < 1e-9)
})

test('playing: pause button, live progress, no resume hint', () => {
  const v = view({ playing: true, pos: 116, resumeHint: 'Resume at 0:58' })
  assert.equal(v.playing, true)
  assert.equal(v.hint, null)
  assert.equal(v.progress, 0.5)
  assert.match(v.buttonLabel, /^Pause /)
})

test('playing at the very start shows an empty progress line, not none', () => {
  assert.equal(view({ playing: true, pos: 0 }).progress, 0)
})

test('progress is clamped and needs a known length', () => {
  assert.equal(view({ playing: true, pos: 999 }).progress, 1)
  assert.equal(view({ playing: true, pos: 5, dur: 0 }).progress, null)
})

test('clock never goes negative or non-finite', () => {
  assert.equal(miniClock(-5), '0:00')
  assert.equal(miniClock(NaN), '0:00')
  assert.equal(miniClock(61.9), '1:01')
})

test('an inserted bar pushes a scrolled reader down by its height, but not one at the top', () => {
  assert.equal(scrollAfterInsert(0, 72), 0)
  assert.equal(scrollAfterInsert(300, 72), 372)
})
