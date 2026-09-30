import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEventUrl, buildProfileUrl, isAllowedLink, resolveProfileTemplate, resolveTemplate,
  validateTemplate, nostrUri, presetFromUrl, CLIENT_PRESETS, isClientPreset,
} from '../src/client-url.ts'

const ids = { npub: 'npub1abc', nprofile: 'nprofile1xyz', pubkey: 'deadbeef' }

test('event templates: placeholder, prefix and empty fallback', () => {
  assert.equal(buildEventUrl('https://x.test/e/{e}', 'nevent1q'), 'https://x.test/e/nevent1q')
  assert.equal(buildEventUrl('https://x.test/e', 'nevent1q'), 'https://x.test/e/nevent1q')
  assert.equal(buildEventUrl('https://x.test/e/', 'nevent1q'), 'https://x.test/e/nevent1q')
  assert.equal(buildEventUrl('', 'nevent1q'), 'https://njump.me/nevent1q')
  assert.equal(buildEventUrl(CLIENT_PRESETS.app.url, 'nevent1q'), 'nostr:nevent1q')
})

test('profile templates: every preset and every placeholder', () => {
  assert.equal(buildProfileUrl(CLIENT_PRESETS.njump.profileUrl, ids), 'https://njump.me/npub1abc')
  assert.equal(buildProfileUrl(CLIENT_PRESETS.primal.profileUrl, ids), 'https://primal.net/p/npub1abc')
  assert.equal(buildProfileUrl(CLIENT_PRESETS.yakihonne.profileUrl, ids), 'https://yakihonne.com/profile/npub1abc')
  assert.equal(buildProfileUrl(CLIENT_PRESETS.app.profileUrl, ids), 'nostr:npub1abc')
  assert.equal(buildProfileUrl('https://x.test/u/{nprofile}?k={pubkey}&n={npub}', ids), 'https://x.test/u/nprofile1xyz?k=deadbeef&n=npub1abc')
  assert.equal(buildProfileUrl('https://x.test/u', ids), 'https://x.test/u/npub1abc')
  assert.equal(buildProfileUrl('web+nostr:{nprofile}', ids), 'web+nostr:nprofile1xyz')
  assert.equal(buildProfileUrl('', ids), 'https://njump.me/npub1abc')
})

test('scheme allowlist: http, https and nostr only', () => {
  for (const ok of ['https://a.test/x', 'http://a.test', 'HTTPS://a.test', 'nostr:npub1x', 'web+nostr:npub1x']) {
    assert.equal(isAllowedLink(ok), true, ok)
  }
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd',
    'java\tscript:alert(1)', ' javascript:alert(1)', 'https ://x', '//evil.test', 'evil.test/x', 'ftp://x', 'blob:https://x', '']) {
    assert.equal(isAllowedLink(bad), false, JSON.stringify(bad))
  }
})

test('unsafe templates are refused at validation and never produce a link', () => {
  assert.ok(validateTemplate('javascript:alert({npub})'))
  assert.ok(validateTemplate('data:text/html,{e}'))
  assert.equal(validateTemplate('https://x.test/{npub}'), null)
  assert.equal(validateTemplate('nostr:{e}'), null)
  assert.equal(validateTemplate(''), null)
  assert.equal(buildProfileUrl('javascript:alert({npub})', ids), 'https://njump.me/npub1abc')
  assert.equal(buildEventUrl('data:text/html,{e}', 'nevent1q'), 'https://njump.me/nevent1q')
  assert.equal(resolveTemplate('custom', 'javascript:{e}'), '')
  assert.equal(resolveProfileTemplate('custom', 'vbscript:{npub}'), '')
  assert.equal(resolveProfileTemplate('custom', 'https://a.test/{npub}'), 'https://a.test/{npub}')
})

test('presets: resolve, migrate, recognise', () => {
  assert.equal(resolveTemplate('primal', ''), 'https://primal.net/e/{e}')
  assert.equal(resolveProfileTemplate('app', ''), 'nostr:{npub}')
  assert.equal(presetFromUrl('https://primal.net/e/'), 'primal')
  assert.equal(presetFromUrl('https://elsewhere.test/'), 'custom')
  assert.equal(isClientPreset('app'), true)
  assert.equal(isClientPreset('toString'), false)
  assert.equal(nostrUri('npub1x'), 'nostr:npub1x')
})
