import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDigestMessages, FAITHFULNESS_RULES, SPOKEN_SIGN_OFF } from '../dist/index.js'

const post = { id: 'a', author: 'b', content: 'hello', createdAt: 1, score: 8, type: 'note' }
const user = (opts) => buildDigestMessages({ posts: [post], userPrompt: 'x', ...opts })[1].content

test('the faithfulness rules follow the post list, and the sign-off only for speech', () => {
  const text = user({})
  assert.ok(text.includes(FAITHFULNESS_RULES))
  assert.ok(!text.includes(SPOKEN_SIGN_OFF))
  assert.ok(text.indexOf(FAITHFULNESS_RULES) > text.indexOf('hello'))
  assert.ok(user({ forSpeech: true }).includes(SPOKEN_SIGN_OFF))
})

test('they apply with a custom digest prompt and can be switched off', () => {
  assert.ok(user({ digestPrompt: 'custom' }).includes(FAITHFULNESS_RULES))
  assert.ok(!user({ faithfulness: false, forSpeech: true }).includes(FAITHFULNESS_RULES))
  assert.ok(!user({ faithfulness: false, forSpeech: true }).includes(SPOKEN_SIGN_OFF))
})

test('target length: the reader\'s minutes replace the default length, and stay an upper bound', () => {
  const posts = [{ id: 'a'.repeat(64), author: 'b'.repeat(64), type: 'original', content: 'A note worth hearing about.', createdAt: 1, score: 9 }]
  const short = buildDigestMessages({ posts, userPrompt: 'x', targetMinutes: 3 })[0].content
  assert.match(short, /at most about 3 minutes of spoken content \(roughly 500-600 words\)/)
  assert.match(short, /be shorter: never pad/)
  assert.doesNotMatch(short, /about 6 minutes/)
  const plain = buildDigestMessages({ posts, userPrompt: 'x' })[0].content
  assert.match(plain, /about 6 minutes of spoken content/)
  const custom = buildDigestMessages({ posts, userPrompt: 'x', targetMinutes: 3, systemPrompt: 'My own host.' })[0].content
  assert.match(custom, /^My own host\./, 'a custom system prompt is left as written')
})
