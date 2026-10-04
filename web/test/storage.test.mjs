import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deviceStorage, storageNotice } from '../src/storage.ts'
test('blocked storage keeps writes and removals usable in memory', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('blocked') } })
  deviceStorage.setItem('nalgorithm_test', 'value')
  assert.equal(deviceStorage.getItem('nalgorithm_test'), 'value')
  assert.ok(storageNotice().includes('session'))
  assert.ok(deviceStorage.length >= 1)
  deviceStorage.removeItem('nalgorithm_test')
  assert.equal(deviceStorage.getItem('nalgorithm_test'), null)
  delete globalThis.localStorage
})
