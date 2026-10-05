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
test('an aborted waiter leaves the queue at once with the abort reason', async () => {
  const config={apiBaseUrl:'https://budget-abort.test',apiKey:'not-real'}
  configureProviderBudget(config,{concurrency:1,requestsPerMinute:100000})
  let release; const gate=new Promise(r=>release=r)
  const holder=withProviderSlot(config,()=>gate)
  const controller=new AbortController()
  let ran=false
  const waiter=withProviderSlot({...config,signal:controller.signal},async()=>{ran=true})
  const { providerBudgetStats } = await import('../dist/index.js')
  assert.equal(providerBudgetStats().queued,1)
  controller.abort(new Error('caller gave up'))
  await assert.rejects(waiter,/caller gave up/)
  assert.equal(providerBudgetStats().queued,0)
  release(); await holder
  assert.equal(ran,false)
  await withProviderSlot(config,async()=>{})
})
test('a full queue throws ProviderBusy, which the retry helpers do not retry', async () => {
  const { ProviderBusy, chatCompletionWithRetry } = await import('../dist/index.js')
  const config={apiBaseUrl:'https://budget-full.test',apiKey:'not-real'}
  configureProviderBudget(config,{concurrency:1,requestsPerMinute:100000})
  let release; const gate=new Promise(r=>release=r)
  const waiting=Array.from({length:65},()=>withProviderSlot(config,()=>gate))
  await assert.rejects(withProviderSlot(config,async()=>{}),(e)=>e instanceof ProviderBusy)
  const original=globalThis.fetch; let calls=0
  globalThis.fetch=async()=>{calls++;throw new Error('unreachable')}
  try { await assert.rejects(chatCompletionWithRetry({...config,model:'m'},[],false,3,0),(e)=>e instanceof ProviderBusy); assert.equal(calls,0) } finally { globalThis.fetch=original }
  release(); await Promise.all(waiting)
})
