import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SPEEDS, DEFAULT_SPEED, normalizeSpeed, nextSpeed, formatSpeed, loadSpeed, saveSpeed,
  ResumeStore, isNearEnd, resumeHint, formatClock, waveformBars, fractionFromPointer, clampSeek,
} from '../src/audio-logic.ts'

const memory = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    raw: m,
  }
}

test('speeds are the six the brief asks for', () => {
  assert.deepEqual([...SPEEDS], [0.75, 1, 1.25, 1.5, 1.75, 2])
})

test('nextSpeed cycles and wraps', () => {
  assert.equal(nextSpeed(1), 1.25)
  assert.equal(nextSpeed(2), 0.75)
  assert.equal(nextSpeed(3), 1, 'an unknown speed falls back to the default')
})

test('formatSpeed prints a trailing multiplication sign', () => {
  assert.equal(formatSpeed(1.25), '1.25×')
  assert.equal(formatSpeed(1), '1×')
  assert.equal(formatSpeed(0.75), '0.75×')
})

test('normalizeSpeed accepts known values only', () => {
  assert.equal(normalizeSpeed('1.5'), 1.5)
  assert.equal(normalizeSpeed(1.75), 1.75)
  assert.equal(normalizeSpeed('3'), DEFAULT_SPEED)
  assert.equal(normalizeSpeed(null), DEFAULT_SPEED)
  assert.equal(normalizeSpeed('fast'), DEFAULT_SPEED)
})

test('speed persists and survives a broken store', () => {
  const s = memory()
  assert.equal(loadSpeed(s), 1)
  saveSpeed(s, 1.5)
  assert.equal(loadSpeed(s), 1.5)
  const broken = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() {} }
  assert.equal(loadSpeed(broken), 1)
  assert.doesNotThrow(() => saveSpeed(broken, 2))
  assert.equal(loadSpeed(null), 1)
})

test('resume: position is remembered per key', () => {
  const r = new ResumeStore(memory())
  r.save('a', 83, 240, 1000)
  r.save('b', 12, 300, 1000)
  assert.equal(r.resumeAt('a'), 83)
  assert.equal(r.resumeAt('b'), 12)
  assert.equal(r.resumeAt('c'), 0)
  assert.equal(r.durationOf('a'), 240)
})

test('resume: nothing to resume in the first seconds', () => {
  const r = new ResumeStore(memory())
  r.save('a', 2, 240)
  assert.equal(r.resumeAt('a'), 0)
  assert.equal(resumeHint(2), null)
  assert.equal(resumeHint(undefined), null)
})

test('resume: clears near the end and marks the digest played', () => {
  const r = new ResumeStore(memory())
  r.save('a', 100, 240)
  assert.equal(r.isPlayed('a'), false)
  r.save('a', 235, 240)
  assert.equal(r.resumeAt('a'), 0)
  assert.equal(r.isPlayed('a'), true)
  assert.equal(isNearEnd(235, 240), true)
  assert.equal(isNearEnd(200, 240), false)
  assert.equal(isNearEnd(50, 0), false, 'an unknown duration is never "near the end"')
})

test('resume: a played mark survives later position saves', () => {
  const r = new ResumeStore(memory())
  r.markPlayed('a', 240)
  r.save('a', 60, 240)
  assert.equal(r.isPlayed('a'), true)
  assert.equal(r.resumeAt('a'), 60)
})

test('resume: saveDuration keeps the position', () => {
  const r = new ResumeStore(memory())
  r.save('a', 30, 0)
  r.saveDuration('a', 200)
  assert.equal(r.resumeAt('a'), 30)
  assert.equal(r.durationOf('a'), 200)
})

test('resume: hint text', () => {
  assert.equal(resumeHint(83), 'Resume at 1:23')
  assert.equal(resumeHint(3723), 'Resume at 1:02:03')
})

test('resume: old entries are dropped past the cap, newest kept', () => {
  const s = memory()
  const r = new ResumeStore(s)
  for (let i = 0; i < 120; i++) r.save(`k${i}`, 30, 600, i)
  assert.equal(Object.keys(JSON.parse(s.raw.get('nalgorithm_resume_v1'))).length, 100)
  assert.equal(r.resumeAt('k119'), 30)
  assert.equal(r.resumeAt('k0'), 0)
})

test('resume: garbage in storage reads as empty', () => {
  const s = memory()
  s.setItem('nalgorithm_resume_v1', '{"a":{"pos":"x"},"b":5}')
  const r = new ResumeStore(s)
  assert.equal(r.resumeAt('a'), 0)
  s.setItem('nalgorithm_resume_v1', 'not json')
  assert.equal(r.resumeAt('a'), 0)
})

test('clock formatting', () => {
  assert.equal(formatClock(0), '0:00')
  assert.equal(formatClock(65.9), '1:05')
  assert.equal(formatClock(3600), '1:00:00')
  assert.equal(formatClock(NaN), '0:00')
})

test('waveform is fixed, bounded and the requested length', () => {
  const a = waveformBars(64)
  const b = waveformBars(64)
  assert.deepEqual(a, b)
  assert.equal(a.length, 64)
  assert.ok(a.every((h) => h >= 0.12 && h <= 1))
  assert.ok(new Set(a.map((h) => h.toFixed(2))).size > 10, 'not flat')
})

test('seek maths', () => {
  assert.equal(fractionFromPointer(150, 100, 200), 0.25)
  assert.equal(fractionFromPointer(50, 100, 200), 0)
  assert.equal(fractionFromPointer(900, 100, 200), 1)
  assert.equal(fractionFromPointer(10, 0, 0), 0)
  assert.equal(clampSeek(10, -15, 100), 0)
  assert.equal(clampSeek(95, 15, 100), 100)
  assert.equal(clampSeek(50, 15, 100), 65)
})
