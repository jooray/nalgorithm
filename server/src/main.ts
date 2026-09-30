import { createServer } from 'node:http'
import type { PipelineLogger } from 'nalgorithm'
import { createApp } from './app.js'
import { createBillingClient } from './billing-client.js'
import { createBot, createDbSeenStore } from './bot.js'
import { uploadAudio } from './blossom.js'
import { loadConfig } from './config.js'
import { openDb, pruneScores } from './db.js'
import { explain, createScheduler } from './scheduler.js'
import { effectiveFormat, runDigest } from './digest-job.js'
import type { DmSender, DmSendOutcome } from './digest-job.js'
import { createDmInbox, createDmPool, createDmSender, createRelayResolver } from './dm/index.js'
import { createFeedRunner } from './feed.js'
import { configureWebSocket } from './websocket.js'

const log: PipelineLogger = {
  info: (m) => process.stderr.write(`[server] ${m}\n`),
  warn: (m) => process.stderr.write(`[server] warning: ${m}\n`),
}

configureWebSocket()
const config = loadConfig()
const db = await openDb(config.databaseUrl)
const billing = createBillingClient({ url: config.billing.url, token: config.billing.token, product: 'nalgorithm' })
const feed = createFeedRunner(config, log)

let runDigestNow: ((npub: string) => Promise<string>) | undefined
let stopBot = async (): Promise<void> => {}

if (config.bot) {
  const secretKey = Uint8Array.from(Buffer.from(config.bot.secretKeyHex, 'hex'))
  const pool = createDmPool()
  const resolver = createRelayResolver({ pool, fallback: config.bot.fallbackRelays })
  const rawSender = createDmSender({ pool, resolver, secretKey, selfRelays: config.bot.relays, log })

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
      humanizerModel: config.venice.humanizerModel,
      ttsModel: config.venice.ttsModel,
      ttsVoice: config.venice.ttsVoice,
    },
    upload: (audio: Uint8Array) => uploadAudio({ servers: config.bot!.blossomServers, secretKey, log }, audio),
  }

  const scheduler = createScheduler({ db, dm: sender, log, run: (npub, opts) => runDigest(digestDeps, npub, opts) })

  // "digest now": answer immediately, do the work in the background, and DM the reason if it cannot be made.
  runDigestNow = async (npub) => {
    if (scheduler.isRunning(npub)) return 'A digest is already being made for you. It will arrive here shortly.'
    void (async () => {
      const outcome = await runDigest(digestDeps, npub, { manual: true }).catch((err: Error) => ({ status: 'failed' as const, detail: err.message }))
      log.info(`manual digest for ${npub.slice(0, 8)}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ''}`)
      const message = explain(outcome.status, true)
      if (message) await sender.send(npub, message, { format: await effectiveFormat(db, npub) }).catch(() => {})
    })()
    return 'On its way. Making a digest takes a few minutes; it will arrive in this chat.'
  }

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

  stopBot = async () => {
    scheduler.stop()
    await inbox.stop()
    pool.close(config.bot!.relays)
  }
} else {
  log.info('BOT_NSEC is not set: DM commands and digest delivery are off')
}

const app = createApp({
  db,
  billing,
  feed,
  publicUrl: config.publicUrl,
  secureCookie: config.secureCookie,
  log,
  runDigestNow,
})

// Old cached scores are useless after 30 days; prune once a day.
setInterval(() => {
  pruneScores(db).then((n) => log.info(`pruned ${n} old scores`), (e) => log.warn(`prune failed: ${(e as Error).message}`))
}, 86_400_000).unref()

const server = createServer(app)
server.listen(config.port, config.host, () => {
  log.info(`listening on http://${config.host}:${config.port}, db ${config.databaseUrl.replace(/:\/\/[^@/]*@/, '://***@')}`)
})

// systemd stops the unit with SIGTERM: stop taking work, close sockets, then exit.
let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info(`${signal}: shutting down`)
  server.close()
  await stopBot().catch((e) => log.warn(`bot stop failed: ${(e as Error).message}`))
  await db.close().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
