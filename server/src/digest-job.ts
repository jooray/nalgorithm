import { randomBytes } from 'node:crypto'
import type { PipelineLogger, ProfileData } from 'nalgorithm'
import type { DigestSourceNote } from 'nalgorithm'
import { digestSourceNotes, selectDigestPosts, synthesizeSpeech as libSynthesize, writeDigest as libWriteDigest } from 'nalgorithm'
import { notesSection, serializeNotes, parseNotes } from './digest-notes.js'
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
  send(recipient: string, text: string, opts: { format: DmFormat; idempotencyKey?: string }): Promise<DmSendOutcome | DmSendOutcome[]>
}

export interface ModelConfig {
  apiBaseUrl: string
  apiKey: string
  digestModel: string
  digestFallbackModel?: string
  humanizerModel: string
  humanizerEnabled?: boolean
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
  /** Where the app lives, named in a DM that had to be shortened. */
  appUrl?: string
  now?: () => number
  /** Replaceable in tests. */
  writeDigest?: typeof libWriteDigest
  synthesize?: typeof libSynthesize
}

/** `delivery_pending`: the digest is written and saved in the app, but its DM has not been accepted yet. */
export type DigestStatus = 'sent' | 'delivery_pending' | 'no_prompt' | 'not_entitled' | 'billing_unavailable' | 'capped' | 'no_posts' | 'failed'

export interface DigestOutcome {
  status: DigestStatus
  detail?: string
  hasAudio?: boolean
}

/** How long an undelivered digest is resent instead of writing a new one. */
export const PENDING_RETRY_SECONDS = 6 * 3600

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
export function composeMessage(text: string, audioUrl: string | null, nowSec: number, notes: DigestSourceNote[] = [], appUrl?: string): string {
  const d = new Date(nowSec * 1000)
  const date = `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  const head = audioUrl ? `Your nalgorithm digest, ${date}\n${audioUrl}\n\n` : `Your nalgorithm digest, ${date}\n\n`
  const body = head + fitSpokenText(text, MAX_TEXT_LENGTH - head.length, appUrl)
  // Show notes go after the spoken text and shrink first when the DM is too long.
  return body + notesSection(notes, MAX_TEXT_LENGTH - body.length)
}

/**
 * A digest that does not fit one DM is cut at a paragraph end and says where the rest is.
 * The audio link and the app carry the whole digest, so a long one is never a failed one.
 */
export function fitSpokenText(text: string, room: number, appUrl?: string): string {
  if (text.length <= room) return text
  const tail = `\n\n…\nThe rest of the text, and every note, is in the app${appUrl ? `: ${appUrl}` : '.'}`
  const budget = Math.max(0, room - tail.length)
  const cut = text.slice(0, budget)
  const paragraph = cut.lastIndexOf('\n\n')
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  const at = paragraph > budget * 0.6 ? paragraph : sentence > budget * 0.6 ? sentence + 1 : budget
  return cut.slice(0, at).trimEnd() + tail
}

const all = (r: DmSendOutcome | DmSendOutcome[]): DmSendOutcome[] => (Array.isArray(r) ? r : [r])

/**
 * Produce and deliver one digest for one npub.
 *
 * Order matters for cost and safety: entitlement and the daily cap are checked
 * before any model is called, and each optional step (speech, upload) degrades
 * to a text-only digest instead of losing the digest already paid for.
 */
export async function runDigest(deps: DigestDeps, npub: string, opts: { manual?: boolean; signal?: AbortSignal } = {}): Promise<DigestOutcome> {
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

  // A recent digest whose DM did not go through is delivered again rather than paid for twice.
  // An older one stays readable in the app; today's run writes a new digest instead of resending it.
  await db.run("UPDATE digests SET status = 'undelivered' WHERE npub = ? AND status = 'delivery_pending' AND created_at < ?", [npub, now - PENDING_RETRY_SECONDS])
  const pending = await db.get<{ id: number; created_at: number; body: string; audio_url: string | null; notes: string | null }>(
    "SELECT id, created_at, body, audio_url, notes FROM digests WHERE npub = ? AND status = 'delivery_pending' ORDER BY created_at DESC LIMIT 1", [npub])
  if (pending) return deliverDigest(deps, npub, pending.id, pending.created_at, pending.body, pending.audio_url, parseNotes(pending.notes))

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
    const feed = await deps.feed(npub, settings, store, opts.signal)
    if (feed.posts.length === 0) return { status: 'no_posts' }

    const top = selectDigestPosts(feed.posts, settings.topN)
    if (top.length === 0) return { status: 'failed', detail: 'No notes could be ranked. Check the model connection.' }
    notes = digestSourceNotes(top, settings.topN)
    const profiles = new Map<string, ProfileData>(Object.entries(feed.profiles))
    const llm = { apiBaseUrl: deps.models.apiBaseUrl, apiKey: deps.models.apiKey, signal: opts.signal }
    text = await write({
      primary: { llm: { ...llm, model: deps.models.digestModel }, temperature: 0.7 },
      fallback: deps.models.digestFallbackModel ? { llm: { ...llm, model: deps.models.digestFallbackModel }, temperature: 0.7 } : undefined,
      humanizer: deps.models.humanizerEnabled === false ? undefined : { llm: { ...llm, model: deps.models.humanizerModel } },
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
      opts.signal?.throwIfAborted()
      // Without somewhere to upload it, audio could not reach anyone: do not pay for it.
      if (deps.upload) {
        const audio = await synth(
          { ...llm, model: deps.models.ttsModel, voice: schedule.voice ?? deps.models.ttsVoice, format: 'mp3' },
          text,
        )
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
  opts.signal?.throwIfAborted()

  const digestId = (
    await db.run('INSERT INTO digests (npub, created_at, body, audio_url, status, notes, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)', [npub, now, text, audioUrl, 'delivery_pending', serializeNotes(notes), durationSeconds])
  ).lastInsertId

  return deliverDigest(deps, npub, digestId, now, text, audioUrl, notes)
}

async function deliverDigest(deps: DigestDeps, npub: string, digestId: number, createdAt: number, text: string, audioUrl: string | null, notes: DigestSourceNote[]): Promise<DigestOutcome> {
  const { db } = deps
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000)
  const schedule = await loadSchedule(db, npub)

  const format = await effectiveFormat(db, npub, schedule)
  let delivered = false
  let tier: string | null = null
  let detail: string | null = null
  try {
    const results = all(await deps.dm.send(npub, composeMessage(text, audioUrl, createdAt, notes, deps.appUrl), { format, idempotencyKey: `digest:${digestId}` }))
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
  if (!delivered) return { status: 'delivery_pending', detail: detail ?? 'not delivered', hasAudio: audioUrl !== null }
  await db.run("UPDATE digests SET status = 'ok' WHERE id = ? AND npub = ?", [digestId, npub])
  return { status: 'sent', hasAudio: audioUrl !== null }
}

/** Advance a schedule after a run: retry soon after a transient failure, otherwise wait for tomorrow. */
export async function recordRun(db: Db, npub: string, outcome: DigestOutcome, nowSec: number): Promise<Schedule> {
  const s = await loadSchedule(db, npub)
  const transient = outcome.status === 'failed' || outcome.status === 'billing_unavailable' || outcome.status === 'delivery_pending'
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
