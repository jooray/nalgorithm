import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLoginTemplate,
  chooseMode,
  daysForSats,
  daysLeft,
  describeError,
  entitlementView,
  formatDays,
  formatSats,
  isHttpUrl,
  parseWholeNumber,
  paymentConfirmed,
  validateHostedSettings,
  validateSats,
  DIGEST_VOICES,
  defaultTimeZone,
  describeDigestNowError,
  formatInZone,
  isValidTime,
  isValidTimeZone,
  lastStatusText,
  nextRunText,
  safeAudioUrl,
  validateScheduleForm,
} from '../src/hosted/logic.ts'

const ok = { userPrompt: 'bitcoin', hoursBack: 24, topN: 15 }
const fmt = (sec) => `D${sec}`

test('chooseMode: stored choice wins, existing BYOK users are not asked', () => {
  assert.equal(chooseMode('hosted', true), 'hosted')
  assert.equal(chooseMode('byok', false), 'byok')
  assert.equal(chooseMode(null, true), 'byok')
  assert.equal(chooseMode(null, false), 'choose')
  assert.equal(chooseMode('garbage', false), 'choose')
})

test('buildLoginTemplate binds url, method and nonce', () => {
  const t = buildLoginTemplate('https://x.test/api/auth/login', 'n1', 1700000000)
  assert.equal(t.kind, 27235)
  assert.equal(t.created_at, 1700000000)
  assert.equal(t.content, '')
  assert.deepEqual(t.tags, [
    ['u', 'https://x.test/api/auth/login'],
    ['method', 'POST'],
    ['nonce', 'n1'],
  ])
})

test('daysForSats is pro rata per plan', () => {
  assert.equal(daysForSats('nalgorithm', 10000), 30)
  assert.equal(daysForSats('nalgorithm', 5000), 15)
  assert.equal(daysForSats('nalgorithm', 1000), 3)
  assert.equal(daysForSats('all-access', 25000), 30)
  assert.equal(daysForSats('all-access', 5000), 6)
  assert.equal(daysForSats('nalgorithm', 1234), 3.7)
  assert.equal(daysForSats('nalgorithm', 0), 0)
  assert.equal(daysForSats('nalgorithm', NaN), 0)
})

test('formatDays and formatSats', () => {
  assert.equal(formatDays(30), '30 days')
  assert.equal(formatDays(1), '1 day')
  assert.equal(formatDays(7.5), '7.5 days')
  assert.equal(formatSats(10000), '10,000 sats')
  assert.equal(formatSats(1000), '1,000 sats')
  assert.equal(formatSats(1234567), '1,234,567 sats')
})

test('validateSats enforces whole numbers and the minimum', () => {
  assert.equal(validateSats(1000), null)
  assert.equal(validateSats(25000), null)
  assert.match(validateSats(999), /minimum/)
  assert.match(validateSats(NaN), /whole number/)
  assert.match(validateSats(1500.5), /whole number/)
})

test('parseWholeNumber is strict', () => {
  assert.equal(parseWholeNumber(' 42 '), 42)
  assert.ok(Number.isNaN(parseWholeNumber('')))
  assert.ok(Number.isNaN(parseWholeNumber('2.5')))
  assert.ok(Number.isNaN(parseWholeNumber('1e3')))
  assert.ok(Number.isNaN(parseWholeNumber('-3')))
})

test('validateHostedSettings mirrors the server limits', () => {
  assert.equal(validateHostedSettings(ok), null)
  assert.equal(validateHostedSettings({ ...ok, userPrompt: 'x'.repeat(2000) }), null)
  assert.match(validateHostedSettings({ ...ok, userPrompt: 'x'.repeat(2001) }), /2000/)
  assert.equal(validateHostedSettings({ ...ok, hoursBack: 72 }), null)
  assert.match(validateHostedSettings({ ...ok, hoursBack: 73 }), /72/)
  assert.match(validateHostedSettings({ ...ok, hoursBack: 0 }), /hours/)
  assert.match(validateHostedSettings({ ...ok, hoursBack: NaN }), /hours/)
  assert.equal(validateHostedSettings({ ...ok, topN: 30 }), null)
  assert.match(validateHostedSettings({ ...ok, topN: 31 }), /30/)
  assert.match(validateHostedSettings({ ...ok, topN: 0 }), /Posts/)
})

test('daysLeft counts a started day and never goes negative', () => {
  assert.equal(daysLeft(1000 + 86400 * 3, 1000), 3)
  assert.equal(daysLeft(1000 + 86400 * 2 + 1, 1000), 3)
  assert.equal(daysLeft(1000 + 60, 1000), 1)
  assert.equal(daysLeft(500, 1000), 0)
  assert.equal(daysLeft(undefined, 1000), 0)
})

test('entitlementView per state', () => {
  const now = 1000
  const trial = entitlementView({ state: 'trial', until: now + 86400 * 2 }, now, fmt)
  assert.equal(trial.text, 'Free trial: 2 days left')
  assert.equal(trial.canRank, true)
  assert.equal(entitlementView({ state: 'trial', until: now + 10 }, now, fmt).text, 'Free trial: 1 day left')

  const active = entitlementView({ state: 'active', until: 5000 }, now, fmt)
  assert.equal(active.text, 'Subscribed until D5000')
  assert.equal(active.actionLabel, 'Add time')

  const expired = entitlementView({ state: 'expired' }, now, fmt)
  assert.equal(expired.canRank, false)
  assert.equal(expired.actionLabel, 'Subscribe')

  const none = entitlementView({ state: 'none' }, now, fmt)
  assert.equal(none.canRank, true)
  assert.match(none.text, /3-day trial/)

  assert.equal(entitlementView({ state: 'unknown' }, now, fmt).kind, 'unknown')
})

test('paymentConfirmed', () => {
  assert.equal(paymentConfirmed({ state: 'expired' }, { state: 'active', until: 10 }), true)
  assert.equal(paymentConfirmed({ state: 'trial', until: 5 }, { state: 'active', until: 10 }), true)
  assert.equal(paymentConfirmed(null, { state: 'active', until: 10 }), true)
  assert.equal(paymentConfirmed({ state: 'expired' }, { state: 'expired' }), false)
  assert.equal(paymentConfirmed({ state: 'trial', until: 5 }, { state: 'trial', until: 5 }), false)
  // Top-up while already subscribed: only a later end date counts.
  assert.equal(paymentConfirmed({ state: 'active', until: 10 }, { state: 'active', until: 10 }), false)
  assert.equal(paymentConfirmed({ state: 'active', until: 10 }, { state: 'active', until: 99 }), true)
})

test('describeError maps status and code to a message and action', () => {
  assert.equal(describeError({ status: 401 }).action, 'login')
  assert.equal(describeError({ status: 400, code: 'no_prompt' }).action, 'settings')
  assert.match(describeError({ status: 400, code: 'no_prompt' }).message, /prompt/)
  assert.equal(describeError({ status: 402, code: 'paywall' }).action, 'pay')
  assert.match(describeError({ status: 429, code: 'in_progress' }).message, /in progress/)
  assert.match(describeError({ status: 429, code: 'daily_cap' }).message, /daily limit/)
  assert.match(describeError({ status: 429 }).message, /Too many/)
  assert.match(describeError({ status: 503, code: 'billing_unavailable' }).message, /Billing/)
  assert.match(describeError({ status: 502 }).message, /Payments/)
  assert.match(describeError({ status: 0, code: 'network' }).message, /reach the server/)
  assert.match(describeError({ status: 500 }).message, /server had a problem/)
  assert.equal(describeError({ status: 418, message: 'teapot' }).message, 'teapot')
  assert.equal(describeError({ status: 418 }).message, 'Something went wrong.')
})

test('isHttpUrl only accepts http(s)', () => {
  assert.equal(isHttpUrl('https://pay.example/i/1'), true)
  assert.equal(isHttpUrl('javascript:alert(1)'), false)
  assert.equal(isHttpUrl('not a url'), false)
  assert.equal(isHttpUrl(undefined), false)
})

test('digest voices: 24 Kokoro voices with readable labels', () => {
  assert.equal(DIGEST_VOICES.length, 24)
  assert.deepEqual(DIGEST_VOICES[0], { id: 'af_bella', label: 'Bella (US, female)' })
  assert.ok(DIGEST_VOICES.some((v) => v.id === 'bm_fable' && v.label === 'Fable (UK, male)'))
  assert.ok(DIGEST_VOICES.some((v) => v.id === 'am_onyx' && v.label === 'Onyx (US, male)'))
})

test('time and zone validation', () => {
  assert.ok(isValidTime('07:30') && isValidTime('23:59') && isValidTime('00:00'))
  assert.ok(!isValidTime('24:00') && !isValidTime('7:30') && !isValidTime('') && !isValidTime(null))
  assert.ok(isValidTimeZone('Europe/Bratislava') && isValidTimeZone('UTC'))
  assert.ok(!isValidTimeZone('Mars/Base') && !isValidTimeZone('') && !isValidTimeZone(undefined))
})

test('validateScheduleForm reports the first problem', () => {
  const good = { time: '07:30', tz: 'Europe/Bratislava', voice: null }
  assert.equal(validateScheduleForm(good), null)
  assert.equal(validateScheduleForm({ ...good, voice: 'af_bella' }), null)
  assert.match(validateScheduleForm({ ...good, time: '' }), /time of day/)
  assert.match(validateScheduleForm({ ...good, tz: 'Nowhere/City' }), /time zone/)
  assert.match(validateScheduleForm({ ...good, voice: 'nope' }), /voice/)
})

test('defaultTimeZone only replaces a never-set schedule', () => {
  assert.equal(defaultTimeZone({ tz: 'UTC', enabled: false }, 'Europe/Bratislava'), 'Europe/Bratislava')
  assert.equal(defaultTimeZone({ tz: 'UTC', enabled: true }, 'Europe/Bratislava'), 'UTC')
  assert.equal(defaultTimeZone({ tz: 'Asia/Tokyo', enabled: false }, 'Europe/Bratislava'), 'Asia/Tokyo')
  assert.equal(defaultTimeZone({ tz: 'UTC', enabled: false }, 'garbage'), 'UTC')
  assert.equal(defaultTimeZone({ tz: 'UTC', enabled: false }, undefined), 'UTC')
})

test('formatInZone shows the wall clock of the chosen zone', () => {
  const sec = Date.UTC(2026, 9, 1, 5, 30) / 1000
  assert.equal(formatInZone(sec, 'Europe/Bratislava'), 'Thu 1 Oct, 07:30')
  assert.equal(formatInZone(sec, 'UTC'), 'Thu 1 Oct, 05:30')
  assert.equal(formatInZone(Date.UTC(2026, 9, 1, 0, 5) / 1000, 'UTC'), 'Thu 1 Oct, 00:05')
  assert.equal(formatInZone(sec, 'Pacific/Auckland'), 'Thu 1 Oct, 18:30')
})

test('nextRunText', () => {
  const sec = Date.UTC(2026, 9, 1, 5, 30) / 1000
  assert.equal(nextRunText({ enabled: true, nextRunAt: sec, tz: 'Europe/Bratislava' }), 'Next digest: Thu 1 Oct, 07:30')
  assert.match(nextRunText({ enabled: false, nextRunAt: null, tz: 'UTC' }), /off/)
  assert.equal(nextRunText({ enabled: true, nextRunAt: null, tz: 'UTC' }), '')
})

test('lastStatusText covers every server status', () => {
  for (const s of ['sent', 'no_prompt', 'not_entitled', 'billing_unavailable', 'capped', 'no_posts', 'failed']) {
    assert.ok(lastStatusText(s).startsWith('Last digest'), s)
  }
  assert.match(lastStatusText('no_prompt'), /prompt/)
  assert.match(lastStatusText('not_entitled'), /subscription has ended/)
  assert.match(lastStatusText('no_posts'), /nothing new/)
  assert.match(lastStatusText('failed'), /retry/)
  assert.equal(lastStatusText(null), '')
  assert.equal(lastStatusText('something_new'), '')
})

test('describeDigestNowError', () => {
  assert.equal(
    describeDigestNowError({ status: 503, code: 'digests_unavailable' }).message,
    'Digest delivery is not switched on for this server yet.'
  )
  assert.match(describeDigestNowError({ status: 429, code: 'daily_cap' }).message, /digests/)
  assert.equal(describeDigestNowError({ status: 402 }).action, 'pay')
  assert.equal(describeDigestNowError({ status: 401 }).action, 'login')
})

test('safeAudioUrl only lets http(s) through', () => {
  assert.equal(safeAudioUrl('https://cdn.example/a.mp3'), 'https://cdn.example/a.mp3')
  assert.equal(safeAudioUrl('javascript:alert(1)'), null)
  assert.equal(safeAudioUrl('data:audio/mpeg;base64,AAAA'), null)
  assert.equal(safeAudioUrl(null), null)
})
