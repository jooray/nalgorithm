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

test('exported settings leave out the model key unless asked, and clearing removes every record', async () => {
  await import('fake-indexeddb/auto')
  const { domModule } = await import('./dom-harness.mjs')
  const { exports: d, context } = await domModule('test/device-entry.ts')
  context.indexedDB = globalThis.indexedDB
  context.IDBKeyRange = globalThis.IDBKeyRange
  d.saveSettings({ ...d.loadSettings(), apiKey: 'sk-secret', rememberKey: true, npub: 'a'.repeat(64) })
  assert.equal(JSON.stringify(d.exportableSettings(false)).includes('sk-secret'), false)
  assert.equal(d.exportableSettings(true).settings.apiKey, 'sk-secret')
  await d.clearDeviceData()
  assert.equal(d.loadSettings().apiKey, '')
})
