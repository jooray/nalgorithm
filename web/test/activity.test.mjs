import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActivityGate } from '../src/activity.ts'
test('overlapping tasks cannot unblock each other and release is idempotent', () => {
  const gate=new ActivityGate();const feed=gate.begin('feed'),audio=gate.begin('audio')
  feed();feed();assert.equal(gate.blocked,true);assert.deepEqual(gate.reasons,['audio']);audio();assert.equal(gate.blocked,false)
})
