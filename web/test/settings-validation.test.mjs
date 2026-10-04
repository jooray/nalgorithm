import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupProblem } from '../src/settings-validation.ts'
const valid = { npub: 'a'.repeat(64), relays: ['wss://nos.lol'], apiBaseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'local', userPrompt: 'Cooking', hoursBack: 24, digestTopN: 15, batchSize: 20, concurrency: 1, scorer: 'chat', decisionModel: 'jev-latest' }
test('keyless local model is supported, remote models need credentials', () => {
  assert.equal(setupProblem(valid), null)
  assert.equal(setupProblem({ ...valid, apiBaseUrl: 'https://api.venice.ai/api/v1' }).field, 'input-api-key')
})
test('invalid identity, bounds and unsafe endpoints fail before persistence', () => {
  for (const patch of [{ npub: 'nsec1private' }, { batchSize: -1 }, { hoursBack: 99999 }, { concurrency: 999 }, { digestTopN: -5 }, { batchSize: 5.5 }, { apiBaseUrl: 'javascript:bad' }, { apiBaseUrl: 'http://remote.example/v1' }, { relays: ['bad'] }]) assert.notEqual(setupProblem({ ...valid, ...patch }), null)
})
