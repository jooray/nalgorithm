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
import { PreviewError } from './preview/service.js'
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
}

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
      const rows = await db.all<DigestRow>(
        'SELECT id, created_at, body, audio_url, notes, duration_s FROM digests WHERE npub = ? ORDER BY created_at DESC LIMIT ?',
        [npub, limit],
      )
      return send(res, 200, { digests: rows.map(publicDigest) })
    }

    const digestMatch = method === 'GET' ? /^\/digests\/(\d{1,15})$/.exec(path) : null
    if (digestMatch) {
      const row = await db.get<DigestRow>('SELECT id, created_at, body, audio_url, notes, duration_s FROM digests WHERE id = ? AND npub = ?', [Number(digestMatch[1]), npub])
      if (!row) throw new HttpError(404, 'digest not found')
      return send(res, 200, publicDigest(row))
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
      const endJob = deps.jobs?.begin() ?? (() => {})
      try {
        // One unit per real run, as before. Served-from-snapshot answers above
        // never reach this line, so they are free.
        const cap = await billing.consume(npub, 'feed', 1, `feed:${npub}:${nowSec()}`)
        if (!cap.allowed) {
          if (cap.reason === 'billing_unavailable') throw new HttpError(503, 'billing is unavailable, try again shortly', { code: 'billing_unavailable' })
          throw new HttpError(429, 'daily limit reached, try again tomorrow', { code: 'daily_cap' })
        }

        running.add(npub)
        try {
          const result = await deps.feed(npub, settings, createStore(db, npub, nowSec))
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
      if (err instanceof ShuttingDown) return send(res, 503, { error: err.message, code: 'shutting_down' })
      if (err instanceof PreviewError) return send(res, err.status, { error: err.message })
      if (err instanceof BillingUnavailable) return send(res, 503, { error: 'billing is unavailable, try again shortly', code: 'billing_unavailable' })
      log.warn(`${req.method} ${req.url} failed: ${(err as Error).message}`)
      send(res, 500, { error: 'internal error' })
    }
  }
}
