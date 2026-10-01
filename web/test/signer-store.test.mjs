import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIGNER_KEY,
  clearSavedSigner,
  keepAfterSignError,
  loadSavedSigner,
  parseSavedSigner,
  saveSavedSigner,
} from '../src/signer-store.ts'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const good = { v: 1, user: A, client: B, remote: C, relays: ['wss://nos.lol'] }

function memStore() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    m,
  }
}

test('parseSavedSigner: accepts a well-formed record and rejects anything else', () => {
  assert.deepEqual(parseSavedSigner(JSON.stringify(good)), good)
  assert.equal(parseSavedSigner(null), null)
  assert.equal(parseSavedSigner('not json'), null)
  assert.equal(parseSavedSigner(JSON.stringify({ ...good, v: 2 })), null)
  assert.equal(parseSavedSigner(JSON.stringify({ ...good, client: 'xyz' })), null)
  assert.equal(parseSavedSigner(JSON.stringify({ ...good, user: A.toUpperCase() })), null)
  assert.equal(parseSavedSigner(JSON.stringify({ ...good, relays: ['https://x', 3] })), null)
  assert.deepEqual(parseSavedSigner(JSON.stringify({ ...good, relays: ['wss://a', 3] })).relays, ['wss://a'])
})

test('save, load for the same reader only, clear', () => {
  const s = memStore()
  assert.equal(saveSavedSigner(s, good), true)
  assert.deepEqual(loadSavedSigner(s, A), good)
  assert.equal(loadSavedSigner(s, B), null)
  clearSavedSigner(s)
  assert.equal(s.m.has(SIGNER_KEY), false)
  assert.equal(loadSavedSigner(null, A), null)
  assert.equal(saveSavedSigner(null, good), false)
})

test('storage that throws is treated as no storage', () => {
  const bad = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') }, removeItem: () => { throw new Error('x') } }
  assert.equal(saveSavedSigner(bad, good), false)
  assert.equal(loadSavedSigner(bad, A), null)
  clearSavedSigner(bad)
})

test('keepAfterSignError: a refusal keeps the connection, a timeout drops it', () => {
  assert.equal(keepAfterSignError('User rejected the request'), true)
  assert.equal(keepAfterSignError('The signer did not answer the sign request in time.'), false)
})
