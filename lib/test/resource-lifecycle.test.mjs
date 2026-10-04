import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFetcher, mapConcurrent } from '../dist/index.js'
test('fetcher closes fallback and discovered relays, not only configured relays', async () => {
  const opened = new Set(); const closed = new Set(); const pk = 'a'.repeat(64)
  const pool = { async querySync(relays, filter, params) { assert.ok(params.maxWait > 0); relays.forEach(r=>opened.add(r)); return relays.includes('wss://index.example') && filter.kinds.includes(0) ? [{ pubkey: pk, created_at: 1, content: '{"name":"Alice"}' }] : [] }, close(relays) { relays.forEach(r=>closed.add(r)) } }
  const fetcher = createFetcher({ relays: ['wss://main.example'], profileFallbackRelays: ['wss://index.example'], pool })
  await fetcher.getProfiles([pk]); fetcher.destroy()
  assert.deepEqual([...opened].sort(), [...closed].sort())
})
test('worker pool never exceeds its limit and preserves output order', async () => {
  let active=0, peak=0
  const out=await mapConcurrent([1,2,3,4,5],2,async n=>{active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;return n*2})
  assert.equal(peak,2); assert.deepEqual(out,[2,4,6,8,10])
})
