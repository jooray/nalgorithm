import { test } from 'node:test'
import assert from 'node:assert/strict'
import { feedbackPrompt, withFeedback, FEEDBACK_RULES_MAX } from '../dist/index.js'

test('feedback rules become one labelled block after the learned preferences', () => {
  assert.equal(feedbackPrompt([]), '')
  assert.equal(withFeedback(undefined, []), undefined)
  assert.equal(withFeedback('  likes relays ', []), 'likes relays')
  const text = withFeedback('likes relays', [{ kind: 'less', excerpt: 'Price  is\nup again' }, { kind: 'more', excerpt: 'A new relay release' }])
  assert.match(text, /^likes relays\n\n=== Private feedback on specific notes ===/)
  assert.match(text, /- Less like this: "Price is up again"/)
  assert.match(text, /- More like this: "A new relay release"/)
  const many = Array.from({ length: FEEDBACK_RULES_MAX + 5 }, (_, i) => ({ kind: 'less', excerpt: `note ${i}` }))
  assert.equal(feedbackPrompt(many).split('\n').filter((l) => l.startsWith('- ')).length, FEEDBACK_RULES_MAX, 'only the newest rules steer')
})
