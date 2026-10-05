import { test } from 'node:test'
import assert from 'node:assert/strict'
import { domModule } from './dom-harness.mjs'

const A = 'a'.repeat(64), B = 'b'.repeat(64)
const post = (n, extra = {}) => ({ id: n.toString(16).padStart(64, '0'), author: A, type: 'original', createdAt: 1000 + n, score: 8, content: `Note number ${n} about relays`, rawEvent: { kind: 1, tags: [] }, ...extra })

// No localStorage in the fixture: the device store keeps everything in memory, as when storage is blocked.
const setup = () => domModule('test/feedback-entry.ts')
const plain = (v) => JSON.parse(JSON.stringify(v))

test('hide, mute and undo redraw the feed, are kept per identity, and never touch the network', async () => {
  const { exports: m, document } = await setup()
  let who = A
  m.setFeedbackIdentity(() => who)
  const container = document.getElementById('feed-list')
  m.renderFeed([post(1), post(2), post(3, { author: B })], container, { detail: false })
  assert.equal(container.querySelectorAll('.note').length, 3)
  const undoHide = m.hideNote(post(1).id)
  assert.equal(container.querySelectorAll('.note').length, 2, 'a hide redraws at once')
  const undoMute = m.muteAuthor(B)
  assert.equal(container.querySelectorAll('.note').length, 1)
  undoMute(); undoHide()
  assert.equal(container.querySelectorAll('.note').length, 3, 'undo brings them back')
  m.hideNote(post(2).id)
  who = B
  assert.equal(m.readFeedback().hidden.length, 0, 'another identity has its own feedback')
})

test('more/less rules are excerpts, one per note, newest first, and reach the ranking prompt', async () => {
  const { exports: m } = await setup()
  m.setFeedbackIdentity(() => A)
  const synced = []
  m.setRulesSync((rules) => synced.push(rules))
  m.addRule('less', { id: 'x', content: 'Price is up again https://x.example nostr:npub1abc' })
  const undo = m.addRule('more', { id: 'y', content: 'A relay release' })
  m.addRule('less', { id: 'y', content: 'A relay release' })
  const rules = m.activeRules()
  assert.deepEqual(plain(rules.map((r) => [r.kind, r.excerpt])), [['less', 'A relay release'], ['less', 'Price is up again']])
  assert.equal(synced.length, 3, 'each change is offered to the server sync')
  assert.match(m.withFeedback('likes relays', rules), /Less like this: "Price is up again"/)
  assert.equal(m.addRule('more', { id: 'z', content: 'https://only.a.link' }), null, 'a note without words teaches nothing')
  undo()
  assert.deepEqual(plain(m.activeRules().map((r) => r.kind)), ['less'], 'undo restores the rules as they were before that action')
})

test('an undo reverses only its own action, for the identity that made it', async () => {
  const { exports: m } = await setup()
  let who = A
  m.setFeedbackIdentity(() => who)
  const undoRule = m.addRule('more', post(1))
  who = B
  m.addRule('less', post(2))
  undoRule()
  assert.deepEqual(plain(m.readFeedback().rules.map((r) => r.kind)), ['less'], 'an Undo left on screen cannot rewrite another identity')
  who = A
  assert.equal(m.readFeedback().rules.length, 1, 'and it did nothing for the first identity either')

  m.muteAuthor(B)
  const repeated = m.muteAuthor(B)
  repeated()
  assert.deepEqual(plain(m.readFeedback().muted), [B], 'undoing a repeated mute keeps the deliberate one')
  m.hideNote(post(3).id)
  m.hideNote(post(3).id)()
  assert.deepEqual(plain(m.readFeedback().hidden), [post(3).id])

  const undoLater = m.addRule('less', post(4))
  m.addRule('more', post(5))
  undoLater()
  assert.deepEqual(plain(m.readFeedback().rules.map((r) => r.noteId)), [post(5).id, post(1).id], 'a later rule survives an earlier undo')
})

test('rules sync: local changes are sent until confirmed, then the server list wins', async () => {
  const { exports: m } = await setup()
  m.setFeedbackIdentity(() => A)
  const sent = []
  m.setRulesSync((rules) => sent.push(plain(rules)))
  m.addRule('more', post(1))
  const mine = sent.at(-1)
  m.adoptRules([])
  assert.deepEqual(sent.at(-1), mine, 'an unconfirmed local rule is sent again, not dropped')
  m.markRulesSynced(mine)
  m.adoptRules([])
  assert.equal(m.readFeedback().rules.length, 0, 'once confirmed, a removal made on another device sticks')
  m.adoptRules([{ kind: 'less', excerpt: 'price talk' }])
  assert.deepEqual(plain(m.activeRules()), [{ kind: 'less', excerpt: 'price talk' }], 'a new device takes the server list')
})

test('removing the last rule here is sent, not replaced by the server list', async () => {
  const { exports: m } = await setup()
  m.setFeedbackIdentity(() => A)
  const sent = []
  m.setRulesSync((rules) => sent.push(plain(rules)))
  m.addRule('more', post(1))
  m.markRulesSynced(sent.at(-1))
  m.removeRule(post(1).id)
  m.adoptRules([{ kind: 'more', excerpt: m.excerptOf(post(1).content) }])
  assert.equal(m.readFeedback().rules.length, 0)
  assert.deepEqual(sent.at(-1), [])
})
