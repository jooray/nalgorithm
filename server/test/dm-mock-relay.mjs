import { WebSocketServer } from 'ws'
import { matchFilter } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'

/**
 * Minimal in-process NIP-01 relay for the DM tests.
 * ackMode: 'ok' answers true, 'reject' answers false with a reason,
 * 'hang' never answers, 'close' drops the connection on EVENT.
 */
export async function startMockRelay({ ackMode = 'ok', rejectReason = 'blocked: test' } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const relay = {
    url: `ws://127.0.0.1:${wss.address().port}`,
    ackMode,
    events: [],
    /** every EVENT message received, including ones answered false */
    attempts: [],
    reqs: [],
    async close() {
      for (const ws of wss.clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
    },
    /** Store an event as if it had been published earlier. */
    seed(event) {
      relay.events.push(event)
    },
    /** Push an event to live subscriptions without storing it (simulates a second relay's copy). */
    broadcast(event) {
      for (const ws of wss.clients) deliver(ws, event)
    },
  }
  const subs = new Map() // ws -> Map(subId -> filters)

  function deliver(ws, event) {
    for (const [id, filters] of subs.get(ws) ?? []) {
      if (filters.some((f) => matchFilter(f, event))) ws.send(JSON.stringify(['EVENT', id, event]))
    }
  }

  wss.on('connection', (ws) => {
    ws.on('error', () => {})
    subs.set(ws, new Map())
    ws.on('close', () => subs.delete(ws))
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg[0] === 'REQ') {
        const [, id, ...filters] = msg
        relay.reqs.push(filters)
        subs.get(ws)?.set(id, filters)
        for (const f of filters) {
          const hits = relay.events.filter((e) => matchFilter(f, e)).sort((a, b) => b.created_at - a.created_at)
          for (const e of hits.slice(0, f.limit ?? hits.length)) ws.send(JSON.stringify(['EVENT', id, e]))
        }
        ws.send(JSON.stringify(['EOSE', id]))
      } else if (msg[0] === 'EVENT') {
        const event = msg[1]
        relay.attempts.push(event)
        if (relay.ackMode === 'close') return ws.terminate()
        if (relay.ackMode === 'hang') return
        if (relay.ackMode === 'reject' || !verifyEvent(event)) {
          return ws.send(JSON.stringify(['OK', event.id, false, relay.ackMode === 'reject' ? rejectReason : 'invalid: bad event']))
        }
        relay.events.push(event)
        ws.send(JSON.stringify(['OK', event.id, true, '']))
        for (const other of wss.clients) deliver(other, event)
      } else if (msg[0] === 'CLOSE') {
        subs.get(ws)?.delete(msg[1])
      }
    })
  })
  return relay
}
