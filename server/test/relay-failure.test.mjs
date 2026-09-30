import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimplePool } from 'nostr-tools/pool'
import { configureWebSocket } from '../dist/websocket.js'

// Regression: on Node 22 the built-in WebSocket overflowed the stack when a relay
// connection failed, killing the process. With `ws` configured, an unreachable
// relay must just yield no events.
test('an unreachable relay does not crash the process', { timeout: 20000 }, async () => {
  configureWebSocket()
  let uncaught
  const onUncaught = (e) => { uncaught = e }
  process.on('uncaughtException', onUncaught)
  const pool = new SimplePool()
  try {
    const events = await pool.querySync(['ws://127.0.0.1:1', 'ws://127.0.0.1:2'], { kinds: [3], limit: 1 }, { maxWait: 3000 })
    assert.deepEqual(events, [])
    await new Promise((r) => setTimeout(r, 500)) // let any late error events fire
    assert.equal(uncaught, undefined, `uncaught exception: ${uncaught?.message}`)
  } finally {
    process.off('uncaughtException', onUncaught)
    pool.close(['ws://127.0.0.1:1', 'ws://127.0.0.1:2'])
  }
})
