import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../dist/db.js'
import { createSession } from '../dist/auth.js'
import { saveSettings, DEFAULT_SETTINGS } from '../dist/settings.js'
import { createApp } from '../dist/app.js'
import { claimDigestJob, digestJobStatus, finishDigestJob } from '../dist/digest-jobs.js'

test('feed slot is claimed before awaiting billing, so concurrent requests consume once', async () => {
  const db = await openDb(':memory:'); const npub = 'a'.repeat(64); const now = 1800000000
  try {
    const session = await createSession(db, npub, now)
    await saveSettings(db, npub, { ...DEFAULT_SETTINGS, userPrompt: 'Bitcoin' }, now)
    let consumed = 0, runs = 0, release, entered
    const gate = new Promise(r=>release=r), inside = new Promise(r=>entered=r)
    const app = createApp({ db, publicUrl:'https://example.test/app/api', secureCookie:true, now:()=>now, log:{info(){},warn(){}},
      billing:{async entitlement(){return {state:'active'}},async consume(){consumed++;entered();await gate;return {allowed:true}}},
      feed:async()=>{runs++;return {posts:[],profiles:{},fetched:0}},
    })
    const request = () => ({method:'GET',url:'/feed?force=1',headers:{authorization:`Bearer ${session.token}`}})
    const status = []
    const response = () => ({writeHead(s){this.status=s},end(){status.push(this.status)}})
    const first = app(request(),response()); await inside
    await app(request(),response()); release(); await first
    assert.equal(consumed,1);assert.equal(runs,1);assert.deepEqual(status,[429,200])
  } finally {await db.close()}
})

test('fresh heartbeat protects a long job and a different owner cannot finish it', async () => {
  const db=await openDb(':memory:');const npub='a'.repeat(64)
  try {
    const claim=await claimDigestJob(db,npub,1000)
    await db.run('UPDATE digest_jobs SET lease_at = ? WHERE npub = ? AND owner = ?', [1700,npub,claim.owner])
    assert.equal((await digestJobStatus(db,npub,1701)).running,true)
    assert.equal((await claimDigestJob(db,npub,1701)).claimed,false)
    await finishDigestJob(db,npub,1000,'sent',1702,'wrong-owner')
    assert.equal((await digestJobStatus(db,npub,1703)).running,true)
  } finally {await db.close()}
})

test('retention prunes operational records only, never what a reader keeps', async () => {
  const { openDb, pruneOperational, RETENTION } = await import('../dist/db.js')
  const db = await openDb(':memory:')
  const now = 2_000_000_000, day = 86_400
  await db.run('INSERT INTO deliveries (npub, digest_id, created_at, protocol, delivered) VALUES (?, ?, ?, ?, ?)', ['a', 1, now - (RETENTION.deliveriesDays + 1) * day, 'nip04', 1])
  await db.run('INSERT INTO deliveries (npub, digest_id, created_at, protocol, delivered) VALUES (?, ?, ?, ?, ?)', ['a', 2, now - day, 'nip04', 1])
  await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status) VALUES (?, ?, ?, ?, ?)', ['a', now - 1000 * day, 'old but kept', null, 'ok'])
  await db.run('INSERT INTO pipeline_jobs (npub, owner, lease_until) VALUES (?, ?, ?)', ['dead', 'x', now - 7200])
  await db.run('INSERT INTO pipeline_jobs (npub, owner, lease_until) VALUES (?, ?, ?)', ['live', 'y', now + 600])
  const removed = await pruneOperational(db, now)
  assert.equal(removed.deliveries, 1)
  assert.equal(removed.pipelineClaims, 1)
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM digests')).n, 1, 'digests stay until the reader deletes them')
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM pipeline_jobs')).n, 1)
  await db.close()
})
