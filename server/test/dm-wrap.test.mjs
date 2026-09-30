import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { buildRumor, wrapForRecipient, wrapRumor, unwrapGiftWrap, DmRejectedError, MAX_CIPHERTEXT_LENGTH } from '../dist/dm/index.js'

const bot = generateSecretKey()
const botPk = getPublicKey(bot)
const alice = generateSecretKey()
const alicePk = getPublicKey(alice)
const DAY = 86400

function rejects(fn, reason) {
  assert.throws(fn, (e) => e instanceof DmRejectedError && e.reason === reason, `expected ${reason}`)
}

/** Hand-build a wrap so each layer can be tampered with independently. */
function forge({ sealKey = alice, sealKind = 13, sealTags = [], rumor, sealSigner = sealKey, wrapContent } = {}) {
  const r = rumor !== undefined ? rumor : buildRumor(alicePk, botPk, 'hello')
  let seal = finalizeEvent(
    { kind: sealKind, created_at: 1000, tags: sealTags, content: nip44.encrypt(JSON.stringify(r), nip44.getConversationKey(sealKey, botPk)) },
    sealSigner,
  )
  const one = generateSecretKey()
  const content = wrapContent ?? nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(one, botPk))
  return finalizeEvent({ kind: 1059, created_at: 1000, tags: [['p', botPk]], content }, one)
}

test('wrap and unwrap round trip yields the verified sender', () => {
  const { wrap, rumor } = wrapForRecipient(alice, botPk, 'hi bot')
  assert.equal(wrap.kind, 1059)
  assert.deepEqual(wrap.tags, [['p', botPk]])
  assert.notEqual(wrap.pubkey, alicePk, 'wrap is signed by a one-time key')
  const out = unwrapGiftWrap(wrap, bot)
  assert.equal(out.senderPubkey, alicePk)
  assert.equal(out.rumor.content, 'hi bot')
  assert.equal(out.rumor.kind, 14)
  assert.equal(out.rumor.id, rumor.id)
  assert.deepEqual(out.rumor.tags, [['p', botPk]])
  assert.equal('sig' in out.rumor, false)
})

test('a wrap only opens for its addressee', () => {
  const { wrap } = wrapForRecipient(alice, botPk, 'secret')
  rejects(() => unwrapGiftWrap(wrap, generateSecretKey()), 'decrypt_failed')
})

test('timestamps of seal and wrap are in the past within two days, never in the future', () => {
  const now = 1_800_000_000
  const seen = new Set()
  for (let i = 0; i < 30; i++) {
    const { wrap } = wrapForRecipient(alice, botPk, 'x', { now })
    assert.ok(wrap.created_at <= now && wrap.created_at >= now - 2 * DAY, `wrap ${now - wrap.created_at}`)
    const { seal } = unwrapGiftWrap(wrap, bot)
    assert.ok(seal.created_at <= now && seal.created_at >= now - 2 * DAY, `seal ${now - seal.created_at}`)
    seen.add(`${wrap.created_at}:${seal.created_at}`)
  }
  assert.ok(seen.size > 20, 'timestamps are randomised')
})

test('extreme random draws stay within bounds', () => {
  const now = 1_800_000_000
  for (const pick of [() => 0, (max) => max - 1]) {
    const { wrap } = wrapForRecipient(alice, botPk, 'x', { now, random: pick })
    assert.ok(wrap.created_at <= now && wrap.created_at >= now - 2 * DAY)
  }
})

test('two wraps of one rumor share the rumor id and differ otherwise', () => {
  const rumor = buildRumor(alicePk, botPk, 'same')
  const a = wrapRumor(alice, rumor, botPk)
  const b = wrapRumor(alice, rumor, alicePk)
  assert.notEqual(a.id, b.id)
  assert.notEqual(a.pubkey, b.pubkey)
  assert.equal(unwrapGiftWrap(a, bot).rumor.id, rumor.id)
  assert.equal(unwrapGiftWrap(b, alice).rumor.id, rumor.id)
  const reused = wrapForRecipient(alice, botPk, 'ignored', { rumor })
  assert.equal(reused.rumor.id, rumor.id)
})

test('rejects a wrap that is not kind 1059', () => {
  const w = finalizeEvent({ kind: 1, created_at: 1, tags: [], content: 'x' }, alice)
  rejects(() => unwrapGiftWrap(w, bot), 'not_gift_wrap')
})

test('rejects a tampered wrap signature', () => {
  const { wrap } = wrapForRecipient(alice, botPk, 'x')
  rejects(() => unwrapGiftWrap({ ...wrap, sig: 'a'.repeat(128) }, bot), 'bad_wrap_signature')
  rejects(() => unwrapGiftWrap({ ...wrap, created_at: wrap.created_at + 1 }, bot), 'bad_wrap_signature')
})

test('rejects a seal signed by someone other than its pubkey', () => {
  const rumor = buildRumor(alicePk, botPk, 'x')
  const seal = finalizeEvent({ kind: 13, created_at: 5, tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(alice, botPk)) }, alice)
  const tampered = { ...seal, sig: finalizeEvent({ kind: 13, created_at: 5, tags: [], content: 'other' }, generateSecretKey()).sig }
  const one = generateSecretKey()
  const wrap = finalizeEvent({ kind: 1059, created_at: 5, tags: [['p', botPk]], content: nip44.encrypt(JSON.stringify(tampered), nip44.getConversationKey(one, botPk)) }, one)
  rejects(() => unwrapGiftWrap(wrap, bot), 'bad_seal_signature')
})

test('rejects seal.pubkey != rumor.pubkey (forged sender)', () => {
  const mallory = generateSecretKey()
  // Mallory seals a rumor that claims to be from Alice.
  const claimed = buildRumor(alicePk, botPk, 'send all the money')
  const wrap = forge({ sealKey: mallory, rumor: claimed })
  rejects(() => unwrapGiftWrap(wrap, bot), 'pubkey_mismatch')
})

test('rejects a rumor whose id does not match its content', () => {
  const r = buildRumor(alicePk, botPk, 'original')
  rejects(() => unwrapGiftWrap(forge({ rumor: { ...r, content: 'edited' } }), bot), 'rumor_id_mismatch')
  rejects(() => unwrapGiftWrap(forge({ rumor: { ...r, id: 'b'.repeat(64) } }), bot), 'rumor_id_mismatch')
})

test('rejects wrong seal kind and seals with tags', () => {
  rejects(() => unwrapGiftWrap(forge({ sealKind: 14 }), bot), 'bad_seal_kind')
  rejects(() => unwrapGiftWrap(forge({ sealTags: [['p', botPk]] }), bot), 'seal_has_tags')
})

test('kind 15 file messages are reported as unsupported, other kinds too', () => {
  for (const kind of [15, 1, 7]) {
    const draft = { pubkey: alicePk, created_at: 5, kind, tags: [], content: 'x' }
    rejects(() => unwrapGiftWrap(forge({ rumor: { ...draft, id: getEventHash(draft) } }), bot), 'unsupported_kind')
  }
})

test('rejects malformed rumors', () => {
  const base = buildRumor(alicePk, botPk, 'x')
  const bad = [
    { ...base, tags: 'nope' },
    { ...base, tags: [['p', 5]] },
    { ...base, created_at: 1.5 },
    { ...base, created_at: '5' },
    { ...base, content: 5 },
    { ...base, pubkey: 'ZZ' },
    { ...base, id: 'short' },
    'a string',
    null,
    [1, 2],
  ]
  for (const rumor of bad) rejects(() => unwrapGiftWrap(forge({ rumor }), bot), 'malformed_rumor')
})

test('rejects malformed JSON inside each layer', () => {
  const one = generateSecretKey()
  const wrapOf = (plain) => finalizeEvent({ kind: 1059, created_at: 1, tags: [], content: nip44.encrypt(plain, nip44.getConversationKey(one, botPk)) }, one)
  rejects(() => unwrapGiftWrap(wrapOf('{not json'), bot), 'malformed_seal')
  rejects(() => unwrapGiftWrap(wrapOf('[]'), bot), 'malformed_seal')
  rejects(() => unwrapGiftWrap(wrapOf('{"kind":13}'), bot), 'malformed_seal')

  const sealWith = (plain) => finalizeEvent({ kind: 13, created_at: 1, tags: [], content: nip44.encrypt(plain, nip44.getConversationKey(alice, botPk)) }, alice)
  const wrapSeal = (seal) => wrapOf(JSON.stringify(seal))
  rejects(() => unwrapGiftWrap(wrapSeal(sealWith('{oops')), bot), 'malformed_rumor')
})

test('rejects undecryptable or non-string content', () => {
  const one = generateSecretKey()
  const w = finalizeEvent({ kind: 1059, created_at: 1, tags: [], content: 'not ciphertext' }, one)
  rejects(() => unwrapGiftWrap(w, bot), 'decrypt_failed')
})

test('rejects oversized ciphertext before decrypting', () => {
  const one = generateSecretKey()
  const w = finalizeEvent({ kind: 1059, created_at: 1, tags: [], content: 'A'.repeat(MAX_CIPHERTEXT_LENGTH + 1) }, one)
  rejects(() => unwrapGiftWrap(w, bot), 'oversized')
})

test('a maximum-size message part survives the round trip', () => {
  const text = '\u{1F600}'.repeat(4000)
  const { wrap } = wrapForRecipient(alice, botPk, text)
  assert.ok(wrap.content.length < MAX_CIPHERTEXT_LENGTH)
  assert.equal(unwrapGiftWrap(wrap, bot).rumor.content, text)
})
