import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScoringLine } from '../dist/scoring-line.js'

test('scoring line: runs take turns in order, a place is live, and an abort leaves the line', async () => {
  const line = createScoringLine(1)
  const leaveA = await line.enter('a')
  const order = []
  line.report('b', { state: 'queued', ahead: 0, startedAt: 1 })
  line.report('c', { state: 'queued', ahead: 0, startedAt: 2 })
  line.report('d', { state: 'queued', ahead: 0, startedAt: 3 })
  const b = line.enter('b').then((leave) => { order.push('b'); return leave })
  const quit = new AbortController()
  const c = line.enter('c', quit.signal).catch(() => order.push('c gave up'))
  const d = line.enter('d').then((leave) => { order.push('d'); return leave })
  assert.equal(line.progress('d').ahead, 2, 'two runs are waiting before d')
  quit.abort()
  await c
  assert.equal(line.progress('d').ahead, 1, 'a run that gives up frees its place')
  leaveA()
  leaveA()
  const leaveB = await b
  assert.deepEqual(order, ['c gave up', 'b'], 'giving a turn back twice admits only one run')
  leaveB()
  ;(await d)()
  assert.deepEqual(order, ['c gave up', 'b', 'd'])
  line.report('d', null)
  assert.equal(line.progress('d'), null)
  assert.ok(await line.enter('e'), 'with nobody scoring, a run starts at once')
})
