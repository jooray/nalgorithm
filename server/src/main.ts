import { createServer } from 'node:http'
import type { PipelineLogger } from 'nalgorithm'
import { createApp } from './app.js'
import { createBillingClient } from './billing-client.js'
import { loadConfig } from './config.js'
import { openDb, pruneScores } from './db.js'
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
const app = createApp({
  db,
  billing,
  feed: createFeedRunner(config, log),
  publicUrl: config.publicUrl,
  secureCookie: config.secureCookie,
  log,
})

// Old cached scores are useless after 30 days; prune once a day.
setInterval(() => {
  pruneScores(db).then((n) => log.info(`pruned ${n} old scores`), (e) => log.warn(`prune failed: ${(e as Error).message}`))
}, 86_400_000).unref()

createServer(app).listen(config.port, config.host, () => {
  log.info(`listening on http://${config.host}:${config.port}, db ${config.databaseUrl.replace(/:\/\/[^@/]*@/, '://***@')}`)
})
