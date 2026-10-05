import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { configureProviderBudget, providerBudgetStats, synthesizeSpeech, type PipelineLogger } from 'nalgorithm'
import { createApp } from './app.js'
import { createBillingClient } from './billing-client.js'
import { createBot, createDbSeenStore } from './bot.js'
import { uploadAudio } from './blossom.js'
import { loadConfig } from './config.js'
import { openDb, pruneOperational, pruneScores } from './db.js'
import { explain, createScheduler } from './scheduler.js'
import { configureJobOwner, createDigestNow, interruptRunningJobs, runInSlot } from './digest-jobs.js'
import { createJobTracker } from './drain.js'
import { effectiveFormat, runDigest } from './digest-job.js'
import type { DmSender, DmSendOutcome } from './digest-job.js'
import { createDmInbox, createDmPool, createDmSender, createRelayResolver } from './dm/index.js'
import { createFeedRunner } from './feed.js'
import { createPreviewService } from './preview/service.js'
import { configureWebSocket } from './websocket.js'
import { upsert } from './database.js'
import type { StoredDm } from './dm/send.js'

const log: PipelineLogger = {
  info: (m) => process.stderr.write(`[server] ${m}\n`),
  warn: (m) => process.stderr.write(`[server] warning: ${m}\n`),
}

configureWebSocket()
const config = loadConfig()
configureProviderBudget(config.venice, { concurrency: 3, requestsPerMinute: 90 })
const db = await openDb(config.databaseUrl)
const billing = createBillingClient({ url: config.billing.url, token: config.billing.token, product: 'nalgorithm' })
const feed = createFeedRunner(config, log, db)

let runDigestNow: ((npub: string) => Promise<string>) | undefined
const jobs = createJobTracker()
const nowSec = (): number => Math.floor(Date.now() / 1000)
// A claim this server made before a restart belongs to a process that died; release it now
// rather than when its lease runs out. Two processes on one host listen on different ports.
configureJobOwner(`${hostname()}:${config.port}`)
await interruptRunningJobs(db, nowSec())

let stopIntake = async (): Promise<void> => {}
let closeBot = (): void => {}

if (config.bot) {
  const secretKey = Uint8Array.from(Buffer.from(config.bot.secretKeyHex, 'hex'))
  const pool = createDmPool()
  const resolver = createRelayResolver({ pool, fallback: config.bot.fallbackRelays })
  const rawSender = createDmSender({ pool, resolver, secretKey, selfRelays: config.bot.relays, log,
    outbox: {
      async get(key) {
        const row = await db.get<{ state_json: string }>('SELECT state_json FROM dm_outbox WHERE cache_key = ?', [key])
        return row ? JSON.parse(row.state_json) as StoredDm : null
      },
      async put(key, npub, value) {
        await db.run(upsert(db, 'dm_outbox', ['cache_key', 'npub', 'state_json', 'created_at'], ['cache_key'], ['state_json']), [key, npub, JSON.stringify(value), nowSec()])
      },
    },
  })

  // The DM layer reports per-relay outcomes; the digest job wants one readable reason per failed part.
  const sender: DmSender = {
    async send(recipient, text, opts): Promise<DmSendOutcome[]> {
      const results = await rawSender.send(recipient, text, opts)
      return results.map((r) => ({
        delivered: r.delivered,
        tier: r.tier,
        detail: r.delivered
          ? undefined
          : Object.entries(r.relays).map(([url, o]) => `${new URL(url).host}: ${o.status}${o.reason ? ` (${o.reason})` : ''}`).join(', ') || 'no relay accepted it',
      }))
    },
  }

  const digestDeps = {
    db,
    billing,
    feed,
    dm: sender,
    log,
    models: {
      apiBaseUrl: config.venice.apiBaseUrl,
      apiKey: config.venice.apiKey,
      digestModel: config.venice.digestModel,
      digestFallbackModel: config.venice.digestFallbackModel,
      humanizerModel: config.venice.humanizerModel,
      humanizerEnabled: config.venice.humanizerEnabled,
      ttsModel: config.venice.ttsModel,
      ttsVoice: config.venice.ttsVoice,
    },
    appUrl: config.webUrl,
    upload: (audio: Uint8Array) => uploadAudio({ servers: config.bot!.blossomServers, secretKey, log }, audio),
  }

  const scheduler = createScheduler({
    db,
    dm: sender,
    log,
    run: async (npub, opts) => {
      const outcome = await runInSlot(db, npub, nowSec, () => runDigest(digestDeps, npub, { ...opts, signal: AbortSignal.timeout(30 * 60_000) }), jobs)
      // Busy or restarting: a transient failure, so the schedule retries soon.
      return outcome.status === 'busy' ? { status: 'failed' as const, detail: outcome.detail } : outcome
    },
  })

  // "digest now": claim the one slot, answer immediately, do the work in the background, and DM the reason if it cannot be made.
  runDigestNow = createDigestNow({
    db,
    jobs,
    log,
    run: (npub, opts) => runDigest(digestDeps, npub, opts),
    onOutcome: async (npub, outcome) => {
      const message = explain(outcome.status as Parameters<typeof explain>[0], true)
      if (message) await sender.send(npub, message, { format: await effectiveFormat(db, npub) })
    },
  })

  const bot = createBot({
    db,
    sender,
    log,
    commands: { db, billing, webUrl: config.webUrl, runDigestNow },
  })
  const seen = createDbSeenStore(db)
  const inbox = createDmInbox({ pool, secretKey, relays: config.bot.relays, seen, log, onMessage: (dm) => bot.onMessage(dm) })
  inbox.start()
  scheduler.start()
  setInterval(() => void seen.prune().catch(() => {}), 86_400_000).unref()
  log.info(`bot is on: listening for DMs on ${config.bot.relays.length} relays, digests via ${config.bot.blossomServers.join(', ')}`)

  // Stop taking new work first; the pool stays open until running digests have sent their DMs.
  stopIntake = async () => {
    scheduler.stop()
    await inbox.stop()
  }
  closeBot = () => pool.close(config.bot!.relays)
} else {
  log.info('BOT_NSEC is not set: DM commands and digest delivery are off')
}

const previews = createPreviewService({
  db,
  skipHosts: [config.publicUrl, config.webUrl].map((u) => new URL(u).hostname),
})

/** The same sentence in every voice, so a listener compares voices, not texts. */
const SAMPLE_TEXT = 'Good morning. This is how your nalgorithm digest sounds in this voice. Here is what mattered on Nostr today.'

const app = createApp({
  db,
  billing,
  feed,
  publicUrl: config.publicUrl,
  secureCookie: config.secureCookie,
  log,
  runDigestNow,
  previews,
  jobs,
  feedProgress: feed.progress,
  voiceSample: (voice) =>
    synthesizeSpeech(
      { apiBaseUrl: config.venice.apiBaseUrl, apiKey: config.venice.apiKey, model: config.venice.ttsModel, voice, format: 'mp3', signal: AbortSignal.timeout(60_000) },
      SAMPLE_TEXT
    ),
})

// Old cached scores are useless after 30 days; prune once a day.
setInterval(() => {
  log.info(`model budget: ${JSON.stringify(providerBudgetStats())}`)
  pruneScores(db).then((n) => log.info(`pruned ${n} old scores`), (e) => log.warn(`prune failed: ${(e as Error).message}`))
  previews.prune().then((n) => log.info(`pruned ${n} old link previews`), (e) => log.warn(`prune failed: ${(e as Error).message}`))
  pruneOperational(db).then((n) => log.info(`retention: ${JSON.stringify(n)}`), (e) => log.warn(`retention failed: ${(e as Error).message}`))
}, 86_400_000).unref()

const server = createServer(app)
server.listen(config.port, config.host, () => {
  log.info(`listening on http://${config.host}:${config.port}, db ${config.databaseUrl.replace(/:\/\/[^@/]*@/, '://***@')}`)
})

/** How long a restart waits for running digests and feed runs. The unit's TimeoutStopSec must be longer. */
const DRAIN_MS = 4 * 60_000

// systemd stops the unit with SIGTERM: stop taking work, let running jobs finish, then exit.
let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info(`${signal}: shutting down`)
  jobs.stop()
  server.close()
  await stopIntake().catch((e) => log.warn(`bot stop failed: ${(e as Error).message}`))
  if (jobs.active > 0) log.info(`waiting up to ${DRAIN_MS / 1000}s for ${jobs.active} running job(s)`)
  if (!(await jobs.drain(DRAIN_MS))) {
    log.warn(`${jobs.active} job(s) still running after ${DRAIN_MS / 1000}s: stopping anyway`)
    await interruptRunningJobs(db, nowSec(), true).catch(() => {})
  }
  // Let the last responses leave the socket.
  await new Promise((r) => setTimeout(r, 250))
  closeBot()
  await db.close().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
