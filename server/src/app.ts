import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { collectPostPubkeys } from 'nalgorithm'
import type { PipelineLogger, ScoredPost } from 'nalgorithm'
import { AuthError, createSession, getSession, issueChallenge, revokeSession, verifyLogin, SESSION_TTL_SECONDS } from './auth.js'
import type { BillingClient } from './billing-client.js'
import { BillingUnavailable } from './billing-client.js'
import { createStore } from './db.js'
import type { Db } from './db.js'
import { DigestRunning, digestJobStatus } from './digest-jobs.js'
import { parseNotes } from './digest-notes.js'
import { ShuttingDown } from './drain.js'
import type { JobTracker } from './drain.js'
import type { FeedRunner } from './feed.js'
import { FeedBusy } from './feed.js'
import { PreviewError } from './preview/service.js'
import { safeFetch } from './preview/ssrf.js'
import type { PreviewService } from './preview/service.js'
import { ScheduleError, applySchedulePatch, loadSchedule, saveSchedule } from './schedule.js'
import type { Schedule } from './schedule.js'
import { SNAPSHOT_FRESH_SECONDS, flagNew, loadSnapshot, saveSnapshot, settingsSignature } from './snapshot.js'
import type { StoredSnapshot } from './snapshot.js'
import { SettingsError, applySettings, loadSettings, saveSettings } from './settings.js'

export interface AppDeps {
  db: Db
  billing: Pick<BillingClient, 'entitlement' | 'startTrial' | 'consume' | 'createCharge' | 'forget'>
  feed: FeedRunner
  /** Public API base, no trailing slash. The login event must be bound to `<publicUrl>/auth/login`. */
  publicUrl: string
  secureCookie: boolean
  log: PipelineLogger
  now?: () => number
  /** Queue a digest for the npub right now. Absent means the endpoint answers 503. */
  runDigestNow?: (npub: string) => Promise<string>
  /** Link previews. Absent means `/preview` answers `{unavailable: true}`. */
  previews?: PreviewService
  /** In-flight work, so a shutdown can wait for it. Absent means nothing is tracked. */
  jobs?: JobTracker
  /** A short spoken sample in one of `SAMPLE_VOICES`. Absent means samples answer 503. */
  voiceSample?: (voice: string) => Promise<Uint8Array>
}

/**
 * The voices with a listenable sample: a fixed shortlist, so samples cost at most one
 * speech call per voice per process, whatever is asked for.
 */
export const SAMPLE_VOICES = ['af_bella', 'af_heart', 'af_sky', 'bf_emma', 'am_michael', 'bm_george'] as const

const COOKIE = 'nalgorithm_session'
const MAX_BODY = 64 * 1024
const CHECKOUT_PLANS = new Set(['nalgorithm', 'all-access'])

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const value = JSON.parse(raw || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid JSON body')
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

/** The schedule as the API shows it: the time as one HH:MM string, no internal bookkeeping. */
function publicSchedule(s: Schedule): Record<string, unknown> {
  return {
    enabled: s.enabled,
    time: `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`,
    tz: s.tz,
    voice: s.voice,
    dmFormat: s.dmFormat,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
  }
}

interface DigestRow {
  id: number
  created_at: number
  body: string
  audio_url: string | null
  notes: string | null
  duration_s: number | null
}

function publicDigest(r: DigestRow): Record<string, unknown> {
  return {
    id: Number(r.id),
    createdAt: Number(r.created_at),
    text: r.body,
    audioUrl: r.audio_url,
    notes: parseNotes(r.notes),
    durationSeconds: r.duration_s === null || r.duration_s === undefined ? null : Number(r.duration_s),
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/** Trim a scored post to what the client renders. The raw event stays server side. */
function publicPost(p: ScoredPost): Record<string, unknown> {
  return {
    id: p.id,
    type: p.type,
    author: p.author,
    content: p.content,
    createdAt: p.createdAt,
    quotedPost: p.quotedPost,
    originalPost: p.originalPost,
    score: p.score,
    justification: p.justification,
    defaultScore: p.defaultScore,
  }
}

export function createApp(deps: AppDeps) {
  const { db, billing, log } = deps
  const nowSec = (): number => (deps.now ? deps.now() : Math.floor(Date.now() / 1000))
  const loginUrl = `${deps.publicUrl}/auth/login`
  const cookiePath = new URL(deps.publicUrl).pathname.replace(/\/+$/, '') || '/'
  const running = new Set<string>()
  let audioActive = 0
  const audioHits = new Map<string, number[]>()
  const samples = new Map<string, Promise<Uint8Array>>()

  function sessionToken(req: IncomingMessage): string | undefined {
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
    return parseCookies(req.headers.cookie)[COOKIE]
  }

  async function requireSession(req: IncomingMessage): Promise<{ npub: string; token: string }> {
    const token = sessionToken(req)
    const npub = token ? await getSession(db, token, nowSec()) : null
    if (!token || !npub) throw new HttpError(401, 'not signed in')
    return { npub, token }
  }

  function cookie(value: string, maxAge: number): string {
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${maxAge}${deps.secureCookie ? '; Secure' : ''}`
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const path = url.pathname

    // Cross-site forms cannot set a JSON content type without a preflight, so
    // requiring it on every write is the CSRF check that goes with SameSite=Strict.
    if (method !== 'GET' && method !== 'HEAD' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new HttpError(415, 'content-type must be application/json')
    }

    if (method === 'GET' && path === '/healthz') return send(res, 200, { ok: true })

    if (method === 'POST' && path === '/auth/challenge') {
      return send(res, 200, { ...(await issueChallenge(db, nowSec())), url: loginUrl })
    }

    if (method === 'POST' && path === '/auth/login') {
      const body = await readJson(req)
      let npub: string
      try {
        npub = await verifyLogin(db, body.event, loginUrl, nowSec())
      } catch (err) {
        if (err instanceof AuthError) throw new HttpError(401, err.message)
        throw err
      }
      const session = await createSession(db, npub, nowSec())
      return send(res, 200, { npub, token: session.token, expires_at: session.expires_at }, {
        'Set-Cookie': cookie(session.token, SESSION_TTL_SECONDS),
      })
    }

    if (method === 'POST' && path === '/auth/logout') {
      const token = sessionToken(req)
      if (token) await revokeSession(db, token)
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) })
    }

    // Everything below needs a session.
    const { npub } = await requireSession(req)

    if (method === 'GET' && path === '/me') {
      return send(res, 200, { npub, entitlement: await billing.entitlement(npub) })
    }

    if (method === 'GET' && path === '/settings') return send(res, 200, await loadSettings(db, npub))

    // Learned taste, to inspect and to start over. A reset keeps which likes were already read,
    // so only likes from now on shape the new taste.
    if (method === 'GET' && path === '/learned') {
      const row = await db.get<{ prompt: string; updated_at: string }>('SELECT prompt, updated_at FROM learned WHERE npub = ?', [npub])
      return send(res, 200, { prompt: row?.prompt ?? '', updatedAt: row?.updated_at ?? null })
    }
    if (method === 'POST' && path === '/learned/reset') {
      await db.run('UPDATE learned SET prompt = ?, updated_at = ? WHERE npub = ?', ['', new Date(nowSec() * 1000).toISOString(), npub])
      return send(res, 200, { prompt: '', updatedAt: null })
    }

    if (method === 'PUT' && path === '/settings') {
      const body = await readJson(req)
      try {
        const next = applySettings(await loadSettings(db, npub), body)
        await saveSettings(db, npub, next, nowSec())
        return send(res, 200, next)
      } catch (err) {
        if (err instanceof SettingsError) throw new HttpError(400, err.message)
        throw err
      }
    }

    if (method === 'GET' && path === '/preview') {
      if (!deps.previews) return send(res, 200, { unavailable: true })
      return send(res, 200, await deps.previews.preview(npub, url.searchParams.get('url') ?? ''), { 'Cache-Control': 'private, max-age=300' })
    }

    if (method === 'GET' && path === '/preview/image') {
      if (!deps.previews) throw new HttpError(404, 'not found')
      const img = await deps.previews.image(npub, url.searchParams.get('u') ?? '', url.searchParams.get('s') ?? '')
      res.writeHead(200, {
        'Content-Type': img.type,
        'Content-Length': img.body.length,
        // The path is content-addressed by the signed image URL, so a long private cache is safe.
        'Cache-Control': 'private, max-age=604800, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
      })
      return void res.end(img.body)
    }

    if (method === 'GET' && path === '/schedule') return send(res, 200, publicSchedule(await loadSchedule(db, npub)))

    if (method === 'PUT' && path === '/schedule') {
      const body = await readJson(req)
      const allowed = new Set(['enabled', 'time', 'tz', 'voice', 'dmFormat'])
      for (const key of Object.keys(body)) if (!allowed.has(key)) throw new HttpError(400, `unknown setting: ${key}`)
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean')
      if (body.time !== undefined && typeof body.time !== 'string') throw new HttpError(400, 'time must be a string like 07:30')
      if (body.tz !== undefined && typeof body.tz !== 'string') throw new HttpError(400, 'tz must be a string')
      if (body.voice !== undefined && body.voice !== null && typeof body.voice !== 'string') throw new HttpError(400, 'voice must be a string or null')
      if (body.dmFormat !== undefined && body.dmFormat !== null && body.dmFormat !== 'nip17' && body.dmFormat !== 'nip04') {
        throw new HttpError(400, 'dmFormat must be nip17, nip04 or null')
      }
      try {
        const next = applySchedulePatch(await loadSchedule(db, npub), body as never, nowSec())
        await saveSchedule(db, next)
        return send(res, 200, publicSchedule(next))
      } catch (err) {
        if (err instanceof ScheduleError) throw new HttpError(400, err.message)
        throw err
      }
    }

    if (method === 'GET' && path === '/digests') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10) || 10, 1), 30)
      // `summary=1` leaves out the show notes, the bulk of the list; a polling client fetches them per digest.
      const summary = url.searchParams.get('summary') === '1'
      const rows = await db.all<DigestRow>(
        `SELECT id, created_at, body, audio_url, ${summary ? 'NULL AS notes' : 'notes'}, duration_s FROM digests WHERE npub = ? ORDER BY created_at DESC LIMIT ?`,
        [npub, limit],
      )
      const body = { digests: rows.map((r) => (summary ? { ...publicDigest(r), notes: undefined } : publicDigest(r))) }
      // An unchanged list answers 304 with no body, so status polls move almost nothing.
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' })
        return void res.end()
      }
      return send(res, 200, body, { ETag: etag })
    }

    const digestMatch = method === 'GET' ? /^\/digests\/(\d{1,15})$/.exec(path) : null
    const audioMatch = method === 'GET' ? /^\/digests\/(\d{1,15})\/audio$/.exec(path) : null
    if (audioMatch) {
      const hits = (audioHits.get(npub) ?? []).filter((at) => at > nowSec() - 60)
      if (hits.length >= 8 || audioActive >= 2) throw new HttpError(429, 'Audio downloads are busy. Try again shortly.')
      if (audioHits.size >= 1000) audioHits.delete(audioHits.keys().next().value!)
      audioHits.set(npub, [...hits, nowSec()])
      const row = await db.get<{ audio_url: string | null }>('SELECT audio_url FROM digests WHERE id = ? AND npub = ?', [Number(audioMatch[1]), npub])
      if (!row?.audio_url) throw new HttpError(404, 'this digest has no audio')
      if (audioActive >= 2) throw new HttpError(429, 'Audio downloads are busy. Try again shortly.')
      audioActive++
      try {
      const audio = await safeFetch(row.audio_url, { maxBytes: 60 * 1024 * 1024, truncate: false, timeoutMs: 60_000, accept: 'audio/mpeg', acceptType: (type) => type.startsWith('audio/') || type === 'application/octet-stream' })
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.body.length, 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="nalgorithm-${audioMatch[1]}.mp3"`, 'X-Content-Type-Options': 'nosniff' })
      return void res.end(audio.body)
      } finally { audioActive-- }
    }
    if (digestMatch) {
      const row = await db.get<DigestRow>('SELECT id, created_at, body, audio_url, notes, duration_s FROM digests WHERE id = ? AND npub = ?', [Number(digestMatch[1]), npub])
      if (!row) throw new HttpError(404, 'digest not found')
      return send(res, 200, publicDigest(row))
    }

    const sampleMatch = method === 'GET' ? /^\/voices\/([a-z_]{4,24})\/sample$/.exec(path) : null
    if (sampleMatch) {
      const voice = sampleMatch[1]
      if (!(SAMPLE_VOICES as readonly string[]).includes(voice)) throw new HttpError(404, 'no sample for this voice')
      if (!deps.voiceSample) throw new HttpError(503, 'voice samples are not available on this server')
      let sample = samples.get(voice)
      if (!sample) {
        sample = deps.voiceSample(voice)
        samples.set(voice, sample)
        // A failure is not cached: the next listener asks again.
        sample.catch(() => samples.delete(voice))
      }
      let audio: Uint8Array
      try {
        audio = await sample
      } catch (err) {
        log.warn(`voice sample ${voice} failed: ${(err as Error).message}`)
        throw new HttpError(503, 'the sample could not be made right now')
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
      return void res.end(Buffer.from(audio))
    }

    if (method === 'GET' && path === '/digest/status') return send(res, 200, await digestJobStatus(db, npub, nowSec()))

    if (method === 'POST' && path === '/digest/now') {
      if (!deps.runDigestNow) throw new HttpError(503, 'digests are not available on this server', { code: 'digests_unavailable' })
      const message = await deps.runDigestNow(npub)
      return send(res, 202, { message, ...(await digestJobStatus(db, npub, nowSec())) })
    }

    if (method === 'POST' && path === '/billing/checkout') {
      const body = await readJson(req)
      const plan = typeof body.plan === 'string' ? body.plan : ''
      if (!CHECKOUT_PLANS.has(plan)) throw new HttpError(400, 'unknown plan')
      const sats = body.sats === undefined ? undefined : body.sats
      if (sats !== undefined && (typeof sats !== 'number' || !Number.isInteger(sats))) throw new HttpError(400, 'sats must be an integer')
      try {
        // The npub always comes from the session, never from the request.
        const charge = await billing.createCharge(npub, plan, sats as number | undefined)
        return send(res, 200, charge)
      } catch (err) {
        log.warn(`checkout failed: ${(err as Error).message}`)
        throw new HttpError(502, 'payments are unavailable right now')
      }
    }

    if (method === 'GET' && (path === '/feed' || path === '/feed/latest')) {
      const latest = path === '/feed/latest'
      const settings = await loadSettings(db, npub)
      if (!latest && !settings.userPrompt) throw new HttpError(400, 'set a prompt first', { code: 'no_prompt' })

      // Entitlement. A run starts a never-seen npub's trial; reading the last
      // snapshot never does, and a never-seen npub has no snapshot anyway.
      let state = await billing.entitlement(npub)
      if (state.state === 'none' && latest) return send(res, 200, { snapshot: null, entitlement: state })
      if (state.state === 'none') {
        try {
          state = await billing.startTrial(npub)
        } catch (err) {
          log.warn(`trial start failed: ${(err as Error).message}`)
          state = { state: 'unknown' }
        }
      }
      if (state.state === 'unknown') throw new HttpError(503, 'billing is unavailable, try again shortly', { code: 'billing_unavailable' })
      if (state.state !== 'active' && state.state !== 'trial') {
        throw new HttpError(402, 'a subscription is required', { code: 'paywall', state: state.state, until: state.until })
      }

      const previous = await loadSnapshot(db, npub)
      const sig = settingsSignature(settings)
      const answer = (snap: StoredSnapshot, posts: Array<Record<string, unknown>>, cached: boolean) => ({
        entitlement: state,
        fetched: snap.fetched,
        hoursBack: snap.hoursBack,
        posts,
        profiles: snap.profiles,
        learnedPrompt: snap.learnedPrompt,
        createdAt: snap.createdAt,
        ageSeconds: Math.max(0, nowSec() - snap.createdAt),
        cached,
        settingsChanged: snap.sig !== sig,
      })

      // Reading the snapshot never ranks and never touches the daily cap.
      if (latest) {
        if (!previous) return send(res, 200, { snapshot: null, entitlement: state })
        // `since`: the client already has this ranking, so only say whether it is still current.
        const since = Number(url.searchParams.get('since'))
        if (Number.isFinite(since) && since > 0 && previous.createdAt <= since) {
          return send(res, 200, { snapshot: null, unchanged: true, createdAt: previous.createdAt, settingsChanged: previous.sig !== sig, entitlement: state })
        }
        return send(res, 200, { snapshot: answer(previous, previous.posts.map((p) => ({ ...p, isNew: false })), true), entitlement: state })
      }

      // A fresh snapshot for the same settings answers a repeat call without a
      // run, so several tabs or an auto-refresh loop cost nothing.
      const force = url.searchParams.get('force') === '1'
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 200)
      if (!force && previous && previous.sig === sig && nowSec() - previous.createdAt < SNAPSHOT_FRESH_SECONDS) {
        return send(res, 200, answer(previous, previous.posts.slice(0, limit).map((p) => ({ ...p, isNew: false })), true))
      }

      if (running.has(npub)) throw new HttpError(429, 'a feed run is already in progress', { code: 'in_progress' })
      if (running.size >= 12) throw new HttpError(503, 'ranking is busy, try again shortly', { code: 'busy' })
      const endJob = deps.jobs?.begin() ?? (() => {})
      running.add(npub)
      try {
        // One unit per real run, as before. Served-from-snapshot answers above
        // never reach this line, so they are free.
        const cap = await billing.consume(npub, 'feed', 1, `feed:${npub}:${nowSec()}`)
        if (!cap.allowed) {
          if (cap.reason === 'billing_unavailable') throw new HttpError(503, 'billing is unavailable, try again shortly', { code: 'billing_unavailable' })
          throw new HttpError(429, 'daily limit reached, try again tomorrow', { code: 'daily_cap' })
        }

        try {
          const result = await deps.feed(npub, settings, createStore(db, npub, nowSec), AbortSignal.timeout(180_000), force)
          const posts = result.posts.slice(0, limit).map(publicPost)
          // Authors plus anyone mentioned in the text, so mentions render as names.
          const authors = new Set(collectPostPubkeys(result.posts.slice(0, limit), Infinity))
          const profiles = Object.fromEntries(Object.entries(result.profiles).filter(([k]) => authors.has(k)))
          const snap = { posts, profiles, fetched: result.fetched, hoursBack: settings.hoursBack, learnedPrompt: result.learnedPrompt, sig }
          // A failed save must not turn a good ranking into an error.
          await saveSnapshot(db, npub, snap, nowSec()).catch((err) => log.warn(`snapshot save failed: ${(err as Error).message}`))
          return send(res, 200, answer({ ...snap, createdAt: nowSec() }, flagNew(posts, previous), false))
        } finally {
          running.delete(npub)
        }
      } finally {
        running.delete(npub)
        endJob()
      }
    }

    throw new HttpError(404, 'not found')
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res)
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra })
      if (err instanceof DigestRunning) return send(res, 409, { error: 'a digest is already being made for you', code: 'digest_running', startedAt: err.startedAt })
      if (err instanceof FeedBusy) return send(res, 429, { error: err.message, code: 'in_progress' })
      if (err instanceof ShuttingDown) return send(res, 503, { error: err.message, code: 'shutting_down' })
      if (err instanceof PreviewError) return send(res, err.status, { error: err.message })
      if (err instanceof BillingUnavailable) return send(res, 503, { error: 'billing is unavailable, try again shortly', code: 'billing_unavailable' })
      log.warn(`${req.method} ${req.url} failed: ${(err as Error).message}`)
      send(res, 500, { error: 'internal error' })
    }
  }
}
