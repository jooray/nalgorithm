import type { BillingClient, ProductState } from './billing-client.js'
import type { Db } from './db.js'
import { applySchedulePatch, loadSchedule, saveSchedule, ScheduleError } from './schedule.js'
import type { Schedule } from './schedule.js'
import { DigestRunning } from './digest-jobs.js'
import { ShuttingDown } from './drain.js'
import { applySettings, loadSettings, saveSettings, SettingsError } from './settings.js'

export type Command =
  | { name: 'help' }
  | { name: 'status' }
  | { name: 'prompt'; text: string }
  | { name: 'time'; value: string }
  | { name: 'tz'; value: string }
  | { name: 'voice'; value: string }
  | { name: 'top'; value: number }
  | { name: 'hours'; value: number }
  | { name: 'pause' }
  | { name: 'resume' }
  | { name: 'digest' }
  | { name: 'format'; value: 'nip17' | 'nip04' }
  | { name: 'pay'; plan: 'nalgorithm' | 'all-access'; sats?: number }
  | { name: 'delete'; confirmed: boolean }
  | { name: 'unknown'; text: string }

/**
 * Parse a direct message into a command.
 *
 * Deliberately strict: free text that is not a command is `unknown`, never a
 * prompt, so a stray message cannot overwrite what someone carefully wrote.
 * The first word may end in a colon (`prompt: ...`) and may carry a leading
 * slash or bang.
 */
export function parseCommand(input: string): Command {
  const text = input.trim()
  const m = /^[/!]?([A-Za-z0-9?]+):?(?:\s+([\s\S]*))?$/.exec(text)
  if (!m) return { name: 'unknown', text }
  const word = m[1].toLowerCase()
  const arg = (m[2] ?? '').trim()
  const int = (): number => Number(arg)

  switch (word) {
    case 'help': case 'hi': case 'hello': case '?': case 'gm': return { name: 'help' }
    case 'status': return { name: 'status' }
    case 'prompt': return arg ? { name: 'prompt', text: arg } : { name: 'unknown', text }
    case 'time': return arg ? { name: 'time', value: arg } : { name: 'unknown', text }
    case 'tz': case 'timezone': return arg ? { name: 'tz', value: arg } : { name: 'unknown', text }
    case 'voice': return arg ? { name: 'voice', value: arg.toLowerCase() } : { name: 'unknown', text }
    case 'top': return /^\d+$/.test(arg) ? { name: 'top', value: int() } : { name: 'unknown', text }
    case 'hours': return /^\d+$/.test(arg) ? { name: 'hours', value: int() } : { name: 'unknown', text }
    case 'pause': case 'stop': case 'off': return { name: 'pause' }
    case 'resume': case 'on': case 'start': return { name: 'resume' }
    case 'digest': return { name: 'digest' }
    case 'legacy': return { name: 'format', value: 'nip04' }
    case 'nip17': return { name: 'format', value: 'nip17' }
    case 'pay': case 'subscribe': {
      const words = arg.toLowerCase().split(/\s+/).filter(Boolean)
      const all = words.some((w) => w === 'all' || w === 'all-access')
      const sats = words.find((w) => /^\d[\d_,]*$/.test(w))
      return { name: 'pay', plan: all ? 'all-access' : 'nalgorithm', ...(sats ? { sats: Number(sats.replace(/[_,]/g, '')) } : {}) }
    }
    case 'delete': {
      const rest = arg.toLowerCase().replace(/\s+/g, ' ')
      if (rest === 'my data') return { name: 'delete', confirmed: false }
      if (rest === 'my data confirm') return { name: 'delete', confirmed: true }
      return { name: 'unknown', text }
    }
    default: return { name: 'unknown', text }
  }
}

export interface CommandDeps {
  db: Db
  billing: Pick<BillingClient, 'entitlement' | 'createCharge'>
  /** Public web app URL, for pointing people at the settings screen. */
  webUrl: string
  now?: () => number
  /** Queue an immediate digest. Returns a reply, or throws to report why it cannot. */
  runDigestNow: (npub: string) => Promise<string>
}

export const HELP = `nalgorithm ranks your Nostr feed and sends a daily voice digest here.

prompt: what you want to see (your own words)
time 07:30      when to send the digest (turns it on)
tz Europe/Bratislava   your time zone
voice af_bella  the digest voice
top 15          posts in the digest
hours 24        how far back to look
digest          send one now
pause / resume  stop or restart daily digests
status          show your settings and subscription
pay             get a payment link (pay 5000 for a partial month, pay all for all apps)
legacy / nip17  use old-style (kind 4) or modern DMs
delete my data  erase everything stored about you

Free for 3 days, then 10,000 sats per 30 days.`

const fmtDate = (sec: number, tz: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sec * 1000))

function describeSubscription(state: ProductState, tz: string): string {
  switch (state.state) {
    case 'active': return `subscribed until ${fmtDate(state.until ?? 0, tz)}`
    case 'trial': return `free trial until ${fmtDate(state.until ?? 0, tz)}`
    case 'expired': return 'expired (send "pay" for a link)'
    case 'none': return 'not started (your 3-day trial begins with your first digest)'
    default: return 'unknown right now (billing is unreachable)'
  }
}

/** Erase everything stored about an npub except billing records, which live in the billing service. */
export async function deleteUserData(db: Db, npub: string): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of ['scores', 'feed_snapshots', 'digest_jobs', 'learned', 'settings', 'sessions', 'schedules', 'digests', 'deliveries', 'peers', 'accounts']) {
      await tx.run(`DELETE FROM ${table} WHERE npub = ?`, [npub])
    }
  })
}

/** Run one command for `npub` and return the reply text. Never throws for user error. */
export async function handleCommand(deps: CommandDeps, npub: string, cmd: Command): Promise<string> {
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000)
  const { db } = deps
  try {
    switch (cmd.name) {
      case 'help':
      case 'unknown':
        return cmd.name === 'unknown' ? `I did not understand that. ${HELP}` : HELP

      case 'status': {
        const [settings, schedule, state] = await Promise.all([loadSettings(db, npub), loadSchedule(db, npub), deps.billing.entitlement(npub)])
        const lines = [
          `Prompt: ${settings.userPrompt ? settings.userPrompt.slice(0, 300) : '(not set, send "prompt: ...")'}`,
          `Digest: top ${settings.topN} posts from the last ${settings.hoursBack} hours`,
          schedule.enabled
            ? `Daily at ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} ${schedule.tz}, next ${schedule.nextRunAt ? fmtDate(schedule.nextRunAt, schedule.tz) : 'soon'}`
            : 'Daily digest: off (send "time 07:30" to turn it on)',
          `Voice: ${schedule.voice ?? 'default'}`,
          `DM format: ${schedule.dmFormat === 'nip04' ? 'legacy (kind 4)' : schedule.dmFormat === 'nip17' ? 'modern (NIP-17)' : 'same as your last message'}`,
          `Subscription: ${describeSubscription(state, schedule.tz)}`,
        ]
        return lines.join('\n')
      }

      case 'prompt': {
        const next = applySettings(await loadSettings(db, npub), { userPrompt: cmd.text })
        await saveSettings(db, npub, next, now)
        const schedule = await loadSchedule(db, npub)
        return schedule.enabled ? 'Prompt saved.' : 'Prompt saved. Send "time 07:30" (and "tz Europe/Bratislava") to get a daily digest.'
      }

      case 'top':
      case 'hours': {
        const next = applySettings(await loadSettings(db, npub), cmd.name === 'top' ? { topN: cmd.value } : { hoursBack: cmd.value })
        await saveSettings(db, npub, next, now)
        return cmd.name === 'top' ? `Digests will use your top ${next.topN} posts.` : `Digests will look back ${next.hoursBack} hours.`
      }

      case 'time':
      case 'tz':
      case 'voice':
      case 'pause':
      case 'resume':
      case 'format': {
        const current = await loadSchedule(db, npub)
        const patch =
          cmd.name === 'time' ? { time: cmd.value, enabled: true }
          : cmd.name === 'tz' ? { tz: cmd.value }
          : cmd.name === 'voice' ? { voice: cmd.value }
          : cmd.name === 'pause' ? { enabled: false }
          : cmd.name === 'resume' ? { enabled: true }
          : { dmFormat: cmd.value }
        const next: Schedule = applySchedulePatch(current, patch, now)
        await saveSchedule(db, next)
        switch (cmd.name) {
          case 'time': {
            const at = `${String(next.hour).padStart(2, '0')}:${String(next.minute).padStart(2, '0')} ${next.tz}`
            return `Daily digest at ${at}. First one ${fmtDate(next.nextRunAt ?? now, next.tz)}.${next.tz === 'UTC' ? ' Send "tz Europe/Bratislava" (your zone) if UTC is not right.' : ''}`
          }
          case 'tz': return `Time zone set to ${next.tz}.${next.enabled && next.nextRunAt ? ` Next digest ${fmtDate(next.nextRunAt, next.tz)}.` : ''}`
          case 'voice': return `Voice set to ${next.voice}.`
          case 'pause': return 'Daily digests paused. Send "resume" to restart them.'
          case 'resume': return `Daily digests on. Next ${next.nextRunAt ? fmtDate(next.nextRunAt, next.tz) : 'soon'}.`
          default: return next.dmFormat === 'nip04' ? 'I will use legacy (kind 4) DMs from now on.' : 'I will use modern (NIP-17) DMs from now on.'
        }
      }

      case 'digest':
        try {
          return await deps.runDigestNow(npub)
        } catch (err) {
          if (err instanceof DigestRunning) return 'A digest is already being made for you. It will arrive here shortly.'
          if (err instanceof ShuttingDown) return 'I am restarting for a moment. Please send that again in a minute.'
          throw err
        }

      case 'pay': {
        let charge
        try {
          charge = await deps.billing.createCharge(npub, cmd.plan, cmd.sats)
        } catch {
          return 'Payments are unavailable right now, please try again in a few minutes.'
        }
        const what = cmd.plan === 'all-access' ? 'all-access (nalgorithm, Lievik, Emanator AI)' : 'nalgorithm'
        const price = cmd.sats ? `${cmd.sats} sats` : cmd.plan === 'all-access' ? '25,000 sats for 30 days' : '10,000 sats for 30 days'
        return `Pay ${price} for ${what}: ${charge.checkout_url}\nPartial amounts work too ("pay 5000" gives 15 days). The payment is credited to this npub automatically.`
      }

      case 'delete': {
        if (!cmd.confirmed) {
          return 'This erases your prompt, schedule, cached rankings and history. Payment records stay with the billing service. Send "delete my data confirm" to do it.'
        }
        await deleteUserData(db, npub)
        return 'Done. Everything stored about you here has been erased. Your payment history, if any, is kept by the billing service.'
      }
    }
  } catch (err) {
    if (err instanceof SettingsError || err instanceof ScheduleError) return `Not changed: ${err.message}.`
    throw err
  }
}
