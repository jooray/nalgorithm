import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configureProviderBudget, withProviderSlot } from '../dist/index.js'
test('one provider budget bounds callers across model roles', async () => {
  const config={apiBaseUrl:'https://budget.test',apiKey:'not-real'}
  configureProviderBudget(config,{concurrency:2,requestsPerMinute:100000})
  let active=0,peak=0
  await Promise.all(Array.from({length:8},()=>withProviderSlot(config,async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--})))
  assert.equal(peak,2)
})
