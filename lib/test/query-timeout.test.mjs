import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFetcher } from '../dist/index.js'

const pk = (c) => c.repeat(64)

test('a slow relay costs time, not what the live relays sent', async () => {
  const like = { id: pk('1'), pubkey: pk('a'), created_at: 100, kind: 7, tags: [['e', pk('4')]], content: '+' }
  const liked = { id: pk('4'), pubkey: pk('b'), created_at: 90, kind: 1, tags: [], content: 'a liked note' }
  // Like nostr-tools: one relay took a while to connect, so the pool answers a little after maxWait.
  const pool = {
    async querySync(relays, filter, params) {
      await new Promise((r) => setTimeout(r, params.maxWait + 30))
      return filter.kinds?.includes(7) ? [like] : filter.ids ? [liked] : []
    },
    close() {},
  }
  const fetcher = createFetcher({ relays: ['wss://a.example', 'wss://b.example'], pool })
  const page = await fetcher.getLikes(pk('a'), { limit: 200 })
  assert.deepEqual(page.map((l) => l.id), [pk('4')])
})
