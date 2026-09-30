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
