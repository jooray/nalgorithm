import { randomBytes } from 'node:crypto'
import type { PipelineLogger, ProfileData } from 'nalgorithm'
import type { DigestSourceNote } from 'nalgorithm'
import { digestSourceNotes, synthesizeSpeech as libSynthesize, writeDigest as libWriteDigest } from 'nalgorithm'
import { notesSection, serializeNotes } from './digest-notes.js'
import { mp3DurationSeconds } from './mp3-duration.js'
import { MAX_TEXT_LENGTH } from './dm/send.js'
import type { BillingClient } from './billing-client.js'
import type { UploadedAudio } from './blossom.js'
import { createStore } from './db.js'
import type { Db } from './db.js'
import type { FeedRunner } from './feed.js'
import { loadSchedule, nextRunAt, saveSchedule } from './schedule.js'
import type { Schedule } from './schedule.js'
import { loadSettings } from './settings.js'

export type DmFormat = 'nip17' | 'nip04'

/** The outcome of sending, as far as this module cares. One entry per message part. */
export interface DmSendOutcome {
  delivered: boolean
  tier?: string
  detail?: string
}

export interface DmSender {
  send(recipient: string, text: string, opts: { format: DmFormat }): Promise<DmSendOutcome | DmSendOutcome[]>
}

export interface ModelConfig {
  apiBaseUrl: string
  apiKey: string
  digestModel: string
  digestFallbackModel?: string
  humanizerModel: string
  ttsModel: string
  ttsVoice: string
}

export interface DigestDeps {
  db: Db
  billing: Pick<BillingClient, 'entitlement' | 'startTrial' | 'consume'>
  feed: FeedRunner
  models: ModelConfig
  /** Absent when no Blossom server or bot key is configured: digests are then text only. */
  upload?: (audio: Uint8Array) => Promise<UploadedAudio>
  dm: DmSender
  log: PipelineLogger
  now?: () => number
  /** Replaceable in tests. */
  writeDigest?: typeof libWriteDigest
  synthesize?: typeof libSynthesize
}

export type DigestStatus = 'sent' | 'no_prompt' | 'not_entitled' | 'billing_unavailable' | 'capped' | 'no_posts' | 'failed'

export interface DigestOutcome {
  status: DigestStatus
  detail?: string
  hasAudio?: boolean
}

const dayStamp = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10)

/** Format for replies and digests: the user's explicit choice, else what they last wrote to us, else modern. */
export async function effectiveFormat(db: Db, npub: string, schedule?: Schedule): Promise<DmFormat> {
  const s = schedule ?? (await loadSchedule(db, npub))
  if (s.dmFormat) return s.dmFormat
  const peer = await db.get<{ dm_kind: string }>('SELECT dm_kind FROM peers WHERE npub = ?', [npub])
  return peer?.dm_kind === 'nip04' ? 'nip04' : 'nip17'
}

/** The message text: link first (so it is in the first part of a long DM), then the digest. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The message text: link first (so it is in the first part of a long DM), then
 * the digest. The date is built by hand, not with Intl, because its short month
 * names differ between Node/ICU versions ("Sep" vs "Sept").
 */
export function composeMessage(text: string, audioUrl: string | null, nowSec: number, notes: DigestSourceNote[] = []): string {
  const d = new Date(nowSec * 1000)
  const date = `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  const body = audioUrl ? `Your nalgorithm digest, ${date}\n${audioUrl}\n\n${text}` : `Your nalgorithm digest, ${date}\n\n${text}`
  // Show notes go after the spoken text and shrink first when the DM is too long.
  return body + notesSection(notes, MAX_TEXT_LENGTH - body.length)
}

const all = (r: DmSendOutcome | DmSendOutcome[]): DmSendOutcome[] => (Array.isArray(r) ? r : [r])

/**
 * Produce and deliver one digest for one npub.
 *
 * Order matters for cost and safety: entitlement and the daily cap are checked
 * before any model is called, and each optional step (speech, upload) degrades
 * to a text-only digest instead of losing the digest already paid for.
 */
export async function runDigest(deps: DigestDeps, npub: string, opts: { manual?: boolean } = {}): Promise<DigestOutcome> {
  const { db, billing, log } = deps
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000)
  const write = deps.writeDigest ?? libWriteDigest
  const synth = deps.synthesize ?? libSynthesize

  const settings = await loadSettings(db, npub)
  if (!settings.userPrompt) return { status: 'no_prompt' }

  let state = await billing.entitlement(npub)
  if (state.state === 'none') {
    try {
      state = await billing.startTrial(npub)
    } catch (err) {
      log.warn(`trial start failed for ${npub.slice(0, 8)}: ${(err as Error).message}`)
      state = { state: 'unknown' }
    }
  }
  if (state.state === 'unknown') return { status: 'billing_unavailable' }
  if (state.state !== 'active' && state.state !== 'trial') return { status: 'not_entitled' }

  // A scheduled digest counts once per day however often it is retried; a manual
  // one is unique each time so the daily cap limits how many can be asked for.
  const key = opts.manual ? `digest:${npub}:m:${randomBytes(6).toString('hex')}` : `digest:${npub}:s:${dayStamp(now)}`
  const cap = await billing.consume(npub, 'digest', 1, key)
  if (!cap.allowed) return { status: cap.reason === 'billing_unavailable' ? 'billing_unavailable' : 'capped' }

  const schedule = await loadSchedule(db, npub)
  const store = createStore(db, npub, () => now)
  let text: string
  let notes: DigestSourceNote[] = []
  let audioUrl: string | null = null
  let durationSeconds: number | null = null
  try {
    const feed = await deps.feed(npub, settings, store)
    if (feed.posts.length === 0) return { status: 'no_posts' }

    const top = feed.posts.slice(0, settings.topN)
    notes = digestSourceNotes(top, settings.topN)
    const profiles = new Map<string, ProfileData>(Object.entries(feed.profiles))
    const llm = { apiBaseUrl: deps.models.apiBaseUrl, apiKey: deps.models.apiKey }
    text = await write({
      primary: { llm: { ...llm, model: deps.models.digestModel }, temperature: 0.7 },
      fallback: deps.models.digestFallbackModel ? { llm: { ...llm, model: deps.models.digestFallbackModel }, temperature: 0.7 } : undefined,
      humanizer: { llm: { ...llm, model: deps.models.humanizerModel } },
      digest: {
        posts: top,
        profiles,
        userPrompt: settings.userPrompt,
        learnedPrompt: feed.learnedPrompt,
        topN: settings.topN,
        // Spoken output: plain text, no markdown, spelled-out abbreviations.
        forSpeech: true,
      },
      log,
    })

    try {
      const audio = await synth(
        { ...llm, model: deps.models.ttsModel, voice: schedule.voice ?? deps.models.ttsVoice, format: 'mp3' },
        text,
      )
      if (deps.upload) {
        try {
          audioUrl = (await deps.upload(audio)).url
          durationSeconds = mp3DurationSeconds(audio)
        } catch (err) {
          log.warn(`digest audio upload failed for ${npub.slice(0, 8)}: ${(err as Error).message}`)
        }
      }
    } catch (err) {
      log.warn(`digest speech failed for ${npub.slice(0, 8)}: ${(err as Error).message}`)
    }
  } catch (err) {
    return { status: 'failed', detail: (err as Error).message }
  }

  const digestId = (
    await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status, notes, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)', [npub, now, text, audioUrl, 'ok', serializeNotes(notes), durationSeconds])
  ).lastInsertId

  const format = await effectiveFormat(db, npub, schedule)
  let delivered = false
  let tier: string | null = null
  let detail: string | null = null
  try {
    const results = all(await deps.dm.send(npub, composeMessage(text, audioUrl, now, notes), { format }))
    delivered = results.length > 0 && results.every((r) => r.delivered)
    tier = results[0]?.tier ?? null
    detail = results.filter((r) => !r.delivered).map((r) => r.detail ?? 'not delivered').join('; ') || null
  } catch (err) {
    detail = (err as Error).message
  }
  await db.run('INSERT INTO deliveries (npub, digest_id, created_at, protocol, delivered, tier, detail) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    npub,
    digestId,
    now,
    format,
    delivered ? 1 : 0,
    tier,
    detail,
  ])
  if (!delivered) return { status: 'failed', detail: detail ?? 'the DM was not delivered', hasAudio: audioUrl !== null }
  return { status: 'sent', hasAudio: audioUrl !== null }
}

/** Advance a schedule after a run: retry soon after a transient failure, otherwise wait for tomorrow. */
export async function recordRun(db: Db, npub: string, outcome: DigestOutcome, nowSec: number): Promise<Schedule> {
  const s = await loadSchedule(db, npub)
  const transient = outcome.status === 'failed' || outcome.status === 'billing_unavailable'
  const attempts = transient ? s.attempts + 1 : 0
  const retry = transient && attempts < 3
  const next: Schedule = {
    ...s,
    lastRunAt: nowSec,
    lastStatus: outcome.status,
    attempts: retry ? attempts : 0,
    nextRunAt: !s.enabled ? null : retry ? nowSec + 600 * attempts : nextRunAt(nowSec, s.hour, s.minute, s.tz),
  }
  await saveSchedule(db, next)
  return next
}
