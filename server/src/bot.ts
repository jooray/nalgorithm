import type { PipelineLogger } from 'nalgorithm'
import { insertIgnore, upsert } from './database.js'
import type { Db } from './db.js'
import { handleCommand, parseCommand } from './commands.js'
import type { CommandDeps } from './commands.js'
import { effectiveFormat } from './digest-job.js'
import type { DmSender } from './digest-job.js'
import type { IncomingDm, SeenStore } from './dm/index.js'

/** How many messages one sender may get answered per hour. Beyond that they are ignored, so a spammer cannot make the bot spam back. */
export const MAX_MESSAGES_PER_HOUR = 30
const HOUR = 3600

export interface BotDeps {
  db: Db
  sender: DmSender
  commands: CommandDeps
  log: PipelineLogger
  now?: () => number
}

/** Remember which protocol a peer last wrote in, and where their messages arrive, so replies match. */
async function recordPeer(db: Db, dm: IncomingDm, now: number): Promise<void> {
  const prev = await db.get<{ relays: string | null }>('SELECT relays FROM peers WHERE npub = ?', [dm.senderPubkey])
  let relays: string[] = []
  try {
    relays = prev?.relays ? (JSON.parse(prev.relays) as string[]) : []
  } catch {
    relays = []
  }
  if (dm.relay && !relays.includes(dm.relay)) relays = [...relays, dm.relay].slice(-3)
  await db.run(upsert(db, 'peers', ['npub', 'dm_kind', 'last_seen_at', 'relays'], ['npub'], ['dm_kind', 'last_seen_at', 'relays']), [
    dm.senderPubkey,
    dm.protocol,
    now,
    JSON.stringify(relays),
  ])
}

/**
 * The handler for incoming DMs: the sender is the verified signer, the text is
 * parsed as a command, and the answer goes back in the format they wrote in.
 */
export function createBot(deps: BotDeps) {
  const { db, log } = deps
  const now = (): number => (deps.now ? deps.now() : Math.floor(Date.now() / 1000))
  const recent = new Map<string, number[]>()

  function allowed(npub: string): boolean {
    const t = now()
    const times = (recent.get(npub) ?? []).filter((x) => t - x < HOUR)
    if (times.length >= MAX_MESSAGES_PER_HOUR) {
      recent.set(npub, times)
      return false
    }
    times.push(t)
    recent.set(npub, times)
    // Keep the map from growing without bound across many one-off senders.
    if (recent.size > 5000) for (const [k, v] of recent) if (v.every((x) => t - x >= HOUR)) recent.delete(k)
    return true
  }

  async function reply(npub: string, text: string): Promise<void> {
    try {
      await deps.sender.send(npub, text, { format: await effectiveFormat(db, npub) })
    } catch (err) {
      log.warn(`reply to ${npub.slice(0, 8)} failed: ${(err as Error).message}`)
    }
  }

  return {
    async onMessage(dm: IncomingDm): Promise<void> {
      const npub = dm.senderPubkey
      if (!allowed(npub)) {
        log.warn(`ignoring ${npub.slice(0, 8)}: over ${MAX_MESSAGES_PER_HOUR} messages an hour`)
        return
      }
      await recordPeer(db, dm, now())
      const command = parseCommand(dm.content)
      let answer: string
      try {
        answer = await handleCommand(deps.commands, npub, command)
      } catch (err) {
        log.warn(`command ${command.name} from ${npub.slice(0, 8)} failed: ${(err as Error).message}`)
        answer = 'Something went wrong on my side. Please try again in a few minutes.'
      }
      await reply(npub, answer)
    },
  }
}

/** Processed-message ids in the database, so a restart does not answer three days of history again. */
export function createDbSeenStore(db: Db, now: () => number = () => Math.floor(Date.now() / 1000)): SeenStore & { prune(olderThanDays?: number): Promise<number> } {
  return {
    async has(id) {
      return (await db.get('SELECT 1 AS x FROM seen_wraps WHERE id = ?', [id])) !== undefined
    },
    async add(id) {
      await db.run(insertIgnore(db, 'seen_wraps', ['id', 'seen_at']), [id, now()])
    },
    /** Wrap timestamps are randomised up to two days back and the inbox reads three, so keep a week. */
    async prune(olderThanDays = 7) {
      return (await db.run('DELETE FROM seen_wraps WHERE seen_at < ?', [now() - olderThanDays * 86_400])).changes
    },
  }
}
