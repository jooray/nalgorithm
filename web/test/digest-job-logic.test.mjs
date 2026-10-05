import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANOTHER_DIGEST_HINT,
  readyDuringRun,
  IDLE_STATUS,
  clock,
  estimateText,
  failureFor,
  findArrived,
  firstDigestKey,
  makeButtonView,
  nextJobStep,
  progressText,
  readDigestStatus,
  shouldRequestFirstDigest,
} from '../src/digest-job-logic.ts'

const T = 1_800_000_000
const running = (startedAt = T, lastDurationSeconds = null) => ({ running: true, startedAt, lastDurationSeconds, lastStatus: null, finishedAt: null })
const finished = (lastStatus) => ({ running: false, startedAt: null, lastDurationSeconds: 100, lastStatus, finishedAt: T + 100 })

test('readDigestStatus: reads the server shape and treats anything odd as idle', () => {
  assert.deepEqual(readDigestStatus({ running: true, startedAt: 5, lastDurationSeconds: 90, lastStatus: 'sent', finishedAt: 7, message: 'x' }), {
    running: true,
    startedAt: 5,
    lastDurationSeconds: 90,
    lastStatus: 'sent',
    finishedAt: 7,
  })
  assert.deepEqual(readDigestStatus(null), IDLE_STATUS)
  assert.deepEqual(readDigestStatus({ running: 'yes', startedAt: 'now' }), IDLE_STATUS)
})

test('estimateText: a few minutes before there is a run to learn from, then minutes from the last one', () => {
  assert.equal(estimateText(null), 'usually a few minutes')
  assert.equal(estimateText(45), 'usually about a minute')
  assert.equal(estimateText(180), 'usually about 3 minutes')
  assert.equal(estimateText(0), 'usually a few minutes')
})

test('progressText: elapsed clock, estimate, and where it will arrive, in one line', () => {
  const text = progressText(running(T, 120), T + 75)
  assert.match(text, /^Writing your digest… 1:15 so far, usually about 2 minutes\./)
  assert.match(text, /appear here and arrive by DM/)
  assert.equal(clock(-3), '0:00')
  assert.match(progressText(running(T + 50), T), /0:00 so far/, 'a clock behind the server never goes negative')
})

test('makeButtonView: running disables and says so; afterwards the label depends on having a digest', () => {
  const i = { hasDigests: false, firstLabel: 'Send me a digest now', anotherLabel: 'Send me another digest now' }
  assert.deepEqual(makeButtonView({ ...i, running: true }), { label: 'Writing your digest…', disabled: true, busy: true })
  assert.deepEqual(makeButtonView({ ...i, running: false }), { label: 'Send me a digest now', disabled: false, busy: false })
  assert.equal(makeButtonView({ ...i, running: false, hasDigests: true }).label, 'Send me another digest now')
  assert.equal(makeButtonView({ ...i, running: true, hasDigests: true }).disabled, true)
  assert.match(ANOTHER_DIGEST_HINT, /latest notes/)
})

test('nextJobStep: only a running-to-finished change is news', () => {
  assert.deepEqual(nextJobStep(false, IDLE_STATUS), { kind: 'none' })
  assert.deepEqual(nextJobStep(false, finished('sent')), { kind: 'none' }, 'an old finished run seen on load is not announced')
  assert.deepEqual(nextJobStep(true, running()), { kind: 'none' })
  assert.deepEqual(nextJobStep(true, finished('sent')), { kind: 'arrived', dmPending: false })
  assert.deepEqual(nextJobStep(true, finished('delivery_pending')), { kind: 'arrived', dmPending: true }, 'a written digest whose DM is pending is not a failure')
  const failed = nextJobStep(true, finished('failed'))
  assert.equal(failed.kind, 'failed')
  assert.equal(failed.action, 'retry')
  assert.equal(nextJobStep(true, finished('not_entitled')).action, 'pay')
  assert.equal(nextJobStep(true, finished('no_prompt')).action, 'settings')
  assert.match(nextJobStep(true, finished('interrupted')).message, /restart/)
})

test('failureFor: every outcome the server records has words and a recovery', () => {
  for (const s of ['no_prompt', 'not_entitled', 'capped', 'no_posts', 'billing_unavailable', 'interrupted', 'failed', null, 'something_new']) {
    const f = failureFor(s)
    assert.ok(f.message.length > 10)
    assert.ok(['retry', 'pay', 'settings'].includes(f.action))
  }
})

// ─── first digest, asked once ────────────────────────────────────────────────

const ready = { hasPrompt: true, postCount: 10, digestCount: 0, digestsKnown: true, jobRunning: false, alreadyRequested: false, paywalled: false }

test('shouldRequestFirstDigest: a ranked feed, a prompt and no digest asks', () => {
  assert.equal(shouldRequestFirstDigest(ready), true)
})

test('shouldRequestFirstDigest: never without a prompt, a feed, a known empty list; never twice; never paywalled or while one runs', () => {
  assert.equal(shouldRequestFirstDigest({ ...ready, hasPrompt: false }), false)
  assert.equal(shouldRequestFirstDigest({ ...ready, postCount: 0 }), false)
  assert.equal(shouldRequestFirstDigest({ ...ready, digestCount: 1 }), false)
  assert.equal(shouldRequestFirstDigest({ ...ready, digestsKnown: false }), false, 'a list that failed to load is not an empty list')
  assert.equal(shouldRequestFirstDigest({ ...ready, jobRunning: true }), false)
  assert.equal(shouldRequestFirstDigest({ ...ready, alreadyRequested: true }), false)
  assert.equal(shouldRequestFirstDigest({ ...ready, paywalled: true }), false)
  assert.equal(firstDigestKey('npub1x'), 'nalgorithm_first_digest_npub1x')
})

test('first digest once: asking sets the flag, a reload reads it and does not ask again', () => {
  const store = new Map()
  let asked = 0
  const tick = (npub) => {
    const requested = store.has(firstDigestKey(npub))
    if (!shouldRequestFirstDigest({ ...ready, alreadyRequested: requested })) return
    store.set(firstDigestKey(npub), '1')
    asked++
  }
  tick('n1')
  tick('n1') // the next 5-minute check
  tick('n1') // a reload, same storage
  assert.equal(asked, 1)
  tick('n2')
  assert.equal(asked, 2, 'another person on this device has their own flag')
})

// ─── the digest that never showed up from an empty list ──────────────────────

test('findArrived: works from an empty list, finds only what was not there before', () => {
  assert.equal(findArrived([], []), null)
  assert.deepEqual(findArrived([], [{ id: '7' }]), { id: '7' })
  assert.deepEqual(findArrived(['7'], [{ id: '9' }, { id: '7' }]), { id: '9' })
  assert.equal(findArrived(['7'], [{ id: '7' }]), null)
})

test('empty list, digest requested: polling the status announces it once and finds it', () => {
  // The exact case that broke: nothing known before the request.
  const known = []
  const serverList = []
  const polls = [running(T), running(T), { ...finished('sent') }, finished('sent')]
  let wasRunning = false
  const announced = []
  for (const [i, status] of polls.entries()) {
    if (i === 2) serverList.push({ id: '1' }) // the row is stored before the job is marked finished
    const step = nextJobStep(wasRunning, status)
    wasRunning = status.running
    if (step.kind === 'arrived') announced.push(findArrived(known, serverList)?.id)
  }
  assert.deepEqual(announced, ['1'])
})

test('a digest made after the run began ends the progress display, even before the job is marked finished', () => {
  const running = { running: true, startedAt: 1000, lastDurationSeconds: null, lastStatus: null, finishedAt: null }
  assert.equal(readyDuringRun(running, [{ createdAt: 1200 }]), true)
  assert.equal(readyDuringRun(running, [{ createdAt: 900 }]), false, 'an older digest does not count')
  assert.equal(readyDuringRun(running, []), false)
  assert.equal(readyDuringRun({ ...running, running: false }, [{ createdAt: 1200 }]), false)
})
