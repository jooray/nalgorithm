/**
 * Nalgorithm Web — hosted mode
 *
 * The hosted server does the fetching, scoring and billing; this is only the
 * client for it. Posts are drawn by the same renderer as bring-your-own-key
 * mode, so both look identical.
 *
 * Flow: read `/me` → signed out shows the login panel. Signed in, the last
 * ranking is drawn at once (from this device, then from the server), and a run
 * starts in the background when that ranking is older than ten minutes. A run
 * starts the free trial and counts against the daily cap, so nothing runs
 * while paywalled, while the app is in the background, or again after a
 * failure without a pause.
 */

import { collectPostPubkeys, pubkeyToHex, type ProfileData, type ScoredPost } from 'nalgorithm'
import { adoptSigner, forgetSigner, setActorProvider } from '../signer.js'
import { renderFeed, clearFeed, aggregateBoosts, clientRenderOptions, profileLink } from '../render.js'
import { attachLinkPreviews } from './previews.js'
import { initPromptStarters } from '../prompt-starters.js'
import { previewsEnabled } from './previews-logic.js'
import { loadSettings, saveSettings } from '../settings.js'
import { openHostedLoginDialog } from '../login-ui.js'
import { refreshButtonHtml, setStatus, setStatusLoading } from '../ui.js'
import { setUpdateBlocked } from '../version-check.js'
import { currentTab, onTabShown, showTab, toast } from '../shell.js'
import {
  atTop,
  feedVisible,
  hideNewPill,
  scrollY,
  setAgeLabel,
  setBackgroundBusy,
  setQuietNotice,
  showNewPill,
  startLiveChecks,
} from '../feed-live.js'
import {
  ageLabel,
  coverageText,
  decideMerge,
  freshIds,
  quietNotice,
  shouldAutoRun,
  type LocalSnapshot,
} from '../snapshot-logic.js'
import {
  IDLE_STATUS,
  findArrived,
  readyDuringRun,
  arrivalText,
  firstDigestKey,
  nextJobStep,
  progressText,
  shouldRequestFirstDigest,
  type DigestStatus,
} from '../digest-job-logic.js'
import { clientLabel, validateTemplate } from '../client-url.js'
import {
  initDigestView,
  setDigests,
  setListError,
  setListLoading,
  setMakeStatus,
  stopPlayback,
  digestCount,
  digestIds,
  currentDigests,
  setDigestJobRunning,
  onFirstListen,
  type DigestBackend,
} from '../digest-view.js'
import { readDigest, type DigestRecord } from '../digest-model.js'
import { clearIdentityData, clearLegacyHistory, identityKey, loadDigestHistory, loadFeedSnapshot, saveDigestHistory, saveFeedSnapshot, setLegacyOwner } from '../local-data.js'
import { safeStorage } from '../player.js'
import { rememberProfiles } from '../profiles.js'
import {
  ApiError,
  createCheckout,
  digestNow,
  digestAudioUrl,
  getDigest,
  getDigests,
  getDigestStatus,
  getFeed,
  getLatestFeed,
  getMe,
  getSchedule,
  getSettings,
  loginWithSigner,
  logout,
  putSchedule,
  putSettings,
  voiceSampleUrl,
  type FeedResponse,
} from './api.js'
import {
  DIGEST_BOT_NPUB,
  DIGEST_DM_NOTE,
  DIGEST_ON_ITS_WAY,
  DIGEST_VOICES,
  DM_FORMATS,
  DM_FORMAT_HINT,
  SAMPLE_VOICE_IDS,
  scheduleLine,
  MAX_PROMPT_CHARS,
  PLANS,
  daysForSats,
  defaultTimeZone,
  describeDigestNowError,
  describeError,
  entitlementView,
  formatDays,
  formatSats,
  isHttpUrl,
  isValidTimeZone,
  lastStatusText,
  nextRunText,
  parseWholeNumber,
  paymentConfirmed,
  validateHostedSettings,
  validateSats,
  validateScheduleForm,
  type DmFormat,
  type Entitlement,
  type PlanId,
  type Schedule,
} from './logic.js'
import { switchMode } from './mode.js'
import { initTuneDrafts } from '../drafts.js'
import { beginActivity } from '../activity.js'

const POLL_INTERVAL_MS = 4000
const POLL_MAX_MS = 10 * 60 * 1000

let entitlement: Entitlement | null = null
let userNpub = ''
let running = false
let paying = false
let stopPaying = false

// The stored feed. `shownAt` is the run behind what is on screen; `fetchedAt` the newest run
// seen, which can be ahead while the "N new notes" pill waits for a tap.
let shownIds: string[] = []
let shownAt: number | null = null
let fetchedAt: number | null = null
let pending: { feed: FeedResponse; at: number; fresh: string[] } | null = null
// The ranking on screen as folded ids, and the notes it set apart as new. The next ranking is compared with these.
let baseKeys: string[] = []
let baseFresh: string[] = []
/** No automatic run before this time (unix seconds): after a daily cap or an outage. */
let pausedUntil = 0
/** An automatic run failed in a way that needs the reader; wait for a press. */
let attemptFailed = false
/** The prompt or window changed since the stored ranking was made. */
let settingsChanged = false
let paywalled = false
let promptSet = false
let loadedPrompt = ''
let loadedHours = 0
let stopLive: (() => void) | undefined
let digestsKnown = false
let digestBoot: Promise<void> = Promise.resolve()

const LAST_NPUB_KEY = 'nalgorithm_hosted_npub'

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  return el
}

const show = (selector: string, visible = true): void => {
  $(selector).classList.toggle('hidden', !visible)
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ─── Setup ───────────────────────────────────────────────────────────────────

/** The digest list asked for, per request. */
const DIGEST_FEED_LIMIT = 30

export function initHosted(): void {
  // Whose key note actions sign for: the hosted session's key.
  setActorProvider(() => (userNpub ? pubkeyToHex(userNpub) : null))
  // Settings are the Tune tab now, so there is no panel to close.
  const closeSettings = (): void => {}
  openSettingsPanel = () => showTab('tune')
  $('#btn-hosted-save').addEventListener('click', () => void saveSettingsForm(closeSettings))
  $<HTMLTextAreaElement>('#hosted-prompt').addEventListener('input', updatePromptCount)
  initPromptStarters($<HTMLTextAreaElement>('#hosted-prompt'), $('#hosted-prompt-starters'))
  initClientPicker()

  // Account
  $('#btn-hosted-login').addEventListener('click', () => void signIn())
  $('#btn-boot-retry').addEventListener('click', () => void boot())
  $('#btn-boot-byok').addEventListener('click', () => switchMode('byok'))
  $('#btn-hosted-logout').addEventListener('click', () => void signOut(closeSettings))
  $('#btn-hosted-to-byok').addEventListener('click', () => switchMode('byok'))
  $('#btn-hosted-switch-byok').addEventListener('click', () => switchMode('byok'))
  $('#btn-hosted-subscribe').addEventListener('click', () => showPaywall())
  $('#mode-line').textContent = 'You are using the hosted service. The server ranks your feed and writes your digest.'

  // Feed
  $('#btn-hosted-refresh').innerHTML = refreshButtonHtml()
  $('#btn-hosted-refresh').addEventListener('click', () => void runFeed({ manual: true }))
  $('#btn-hosted-empty-action').addEventListener('click', focusPrompt)

  initDigestView(hostedBackend)

  initDigestForm(closeSettings)

  // The Digests tab and coming back to the app both re-read the digest list and the job status.
  onTabShown((tab) => {
    if (tab === 'digest') void refreshDigests()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshDigests()
  })

  // Paywall
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="hosted-plan"]')) {
    radio.addEventListener('change', () => {
      $<HTMLInputElement>('#pay-sats').value = String(PLANS[selectedPlan()].sats)
      updatePayDays()
    })
  }
  $('#pay-sats').addEventListener('input', updatePayDays)
  $('#btn-pay').addEventListener('click', () => void startPayment())
  $('#btn-pay-cancel').addEventListener('click', () => {
    stopPaying = true
  })
  updatePayDays()
  updatePromptCount()

  void boot()
}

let openSettingsPanel: () => void = () => {}

async function boot(): Promise<void> {
  show('#hosted-startup', false)
  const remembered = paintRemembered()
  try {
    const me = await getMe()
    await onSignedIn(me.npub, me.entitlement)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin()
    // Offline answers fast; what this device remembers decides between a quiet line and the error gate.
    await remembered
    // Offline or the server is down, but the last ranking is on screen: leave it be.
    const api = err instanceof ApiError ? err : new ApiError(0, (err as Error).message, 'network')
    const quiet = shownIds.length > 0 ? quietNotice(api.status, api.code) : null
    if (quiet?.text) {
      setQuietNotice(quiet.text)
      window.addEventListener('online', () => void boot(), { once: true })
      document.addEventListener('visibilitychange', retryBootWhenVisible)
      return
    }
    if (document.body.dataset.signedIn !== 'true') {
      $('#startup-error').textContent = 'The server did not answer. Check your connection and try again; nothing has been ranked or charged here.'
      show('#hosted-startup')
    } else showFailure(err, boot)
  }
}

function retryBootWhenVisible(): void {
  if (document.visibilityState !== 'visible' || userNpub) return
  document.removeEventListener('visibilitychange', retryBootWhenVisible)
  void boot()
}

/** The identity whose remembered ranking and digests are on screen before the server confirms the session. */
let paintedNpub: string | null = null

function lastNpub(): string | null {
  try {
    return safeStorage()?.getItem(LAST_NPUB_KEY) ?? null
  } catch {
    return null
  }
}

/**
 * Before the server has answered: draw what this device remembers for the account last signed
 * in here, so a reload is not blank. `onSignedIn` drops it if the session turns out to be someone
 * else's, and `showLogin` if there is no session.
 */
async function paintRemembered(): Promise<void> {
  const npub = lastNpub()
  if (!npub) return
  // A digest list cached before identities were kept apart was this account's.
  setLegacyOwner((mode) => (mode === 'hosted' ? npub : null))
  const [snap, digests] = await Promise.all([loadFeedSnapshot('hosted', npub), loadDigestHistory('hosted', npub, readDigest)])
  // The server may have answered meanwhile: its account and data win.
  if (document.body.dataset.signedIn === 'false' || (userNpub && userNpub !== npub)) return
  paintedNpub = npub
  if (!digestsKnown && digests.length > 0) setDigests(digests)
  if (!snap || snap.posts.length === 0 || shownIds.length > 0) return
  document.body.dataset.signedIn = 'true'
  drawFeed(
    { posts: snap.posts as unknown as FeedResponse['posts'], profiles: snap.profiles as FeedResponse['profiles'], hoursBack: snap.hoursBack ?? 24, fetched: snap.fetched },
    Array.isArray(snap.fresh) ? snap.fresh : []
  )
  shownAt = fetchedAt = snap.createdAt
  paintAge()
}

// ─── Login / logout ──────────────────────────────────────────────────────────

function showLogin(message = ''): void {
  show('#hosted-startup', false)
  document.body.dataset.signedIn = 'false'
  entitlement = null
  userNpub = ''
  show('#hosted-login')
  show('#hosted-banner', false)
  show('#hosted-notice', false)
  show('#hosted-paywall', false)
  show('#hosted-loading', false)
  show('#hosted-empty', false)
  clearFeed($('#hosted-feed'))
  resetFeedState()
  // Without a session, nothing remembered for any account stays on screen.
  if (paintedNpub || digestCount() > 0) {
    stopPlayback()
    setDigests([])
  }
  paintedNpub = null
  setStatus('')
  setLoginStatus(message, Boolean(message))
}

/** Forget everything about the feed that is on screen. The stored copy is cleared by `signOut` only. */
function resetFeedState(): void {
  stopLive?.()
  stopLive = undefined
  shownIds = baseKeys = baseFresh = []
  shownAt = fetchedAt = null
  pending = null
  pausedUntil = 0
  attemptFailed = false
  settingsChanged = false
  promptSet = false
  hideNewPill()
  setAgeLabel('')
  setBackgroundBusy(null)
  setQuietNotice(null)
  stopJobTimers()
  job = IDLE_STATUS
  jobWasRunning = false
  readyDuringJob = null
  schedule = null
  show('#schedule-nudge', false)
  digestsKnown = false
  setDigestJobRunning(false)
}

function setLoginStatus(text: string, isError = false): void {
  const el = $('#hosted-login-status')
  el.textContent = text
  el.classList.toggle('is-error', isError)
}

async function signIn(): Promise<void> {
  const finishActivity = beginActivity('account login')
  const button = $<HTMLButtonElement>('#btn-hosted-login')
  button.disabled = true
  setLoginStatus('')
  let closeSigner: (() => void) | undefined
  try {
    const result = await openHostedLoginDialog(loadSettings().signerRelays)
    if (!result || !result.sign) return
    closeSigner = result.close
    setLoginStatus('Waiting for your signer to sign the login…')
    await loginWithSigner(result.sign, result.pubkey)
    const me = await getMe()
    // A remote signer that was granted the action kinds stays for replies and the next page load.
    if (adoptSigner(result)) closeSigner = undefined
    await onSignedIn(me.npub, me.entitlement)
  } catch (err) {
    setLoginStatus(err instanceof ApiError ? describeError(err).message : (err as Error).message, true)
  } finally {
    // The signer connection was kept open only for this one signature.
    try {
      closeSigner?.()
    } catch {
      // best-effort
    }
    button.disabled = false
    finishActivity()
  }
}

async function signOut(closeSettings: () => void): Promise<void> {
  forgetSigner()
  try {
    await logout()
  } catch {
    // The cookie may already be gone; either way this device is done.
  }
  closeSettings()
  // The next person on this device must not see this account's digests.
  stopPlayback()
  try {
    safeStorage()?.removeItem(LAST_NPUB_KEY)
  } catch {
    // nothing cached to clear
  }
  clearLegacyHistory('hosted')
  if (userNpub) await clearIdentityData('hosted', userNpub)
  setDigests([])
  showLogin()
}

/** Whether link cards are shown; set from the saved settings. */
let linkPreviewsOn = true

async function onSignedIn(npub: string, ent: Entitlement): Promise<void> {
  const switched = userNpub !== npub
  // A remembered ranking or digest list from another account goes before anything of this one is drawn.
  if (paintedNpub && identityKey(paintedNpub) !== identityKey(npub)) {
    stopPlayback()
    resetShown()
    setDigests([])
  }
  paintedNpub = null
  userNpub = npub
  document.body.dataset.signedIn = 'true'
  show('#hosted-login', false)
  show('#hosted-notice', false)
  $('#hosted-npub').textContent = npub.length > 24 ? `${npub.slice(0, 14)}…${npub.slice(-6)}` : npub
  setEntitlement(ent)
  paywalled = ent.state === 'expired'
  rememberNpub(npub)

  const s = await getSettings()
  $<HTMLTextAreaElement>('#hosted-prompt').value = s.userPrompt
  $<HTMLInputElement>('#hosted-hours').value = String(s.hoursBack)
  $<HTMLInputElement>('#hosted-topn').value = String(s.topN)
  $<HTMLInputElement>('#hosted-learn').checked = s.learnFromLikes
  $<HTMLInputElement>('#hosted-previews').checked = linkPreviewsOn = previewsEnabled(s)
  if (s.digestMinutes) $<HTMLSelectElement>('#select-digest-minutes').value = String(s.digestMinutes)
  promptSet = Boolean(s.userPrompt)
  loadedPrompt = s.userPrompt
  loadedHours = s.hoursBack
  updatePromptCount()
  await loadDigestSection()
  if (switched) initTuneDrafts(() => userNpub)
  // The list first, then the job status: a running digest's "what was there before" comes from the list.
  digestBoot = (async () => {
    await loadDigests()
    await refreshDigestStatus()
  })()

  if (!promptSet) return showFirstRun()
  $('#hosted-prompt-firstrun').classList.add('hidden')

  stopLive?.()
  // Runs the first check straight away: latest snapshot from the server, then a background run if it is stale.
  stopLive = startLiveChecks({ check: () => void liveCheck(), tick: paintAge })
}

function rememberNpub(npub: string): void {
  try {
    safeStorage()?.setItem(LAST_NPUB_KEY, npub)
  } catch {
    // Not remembered: the next load simply waits for the server.
  }
}

function resetShown(): void {
  clearFeed($('#hosted-feed'))
  shownIds = baseKeys = baseFresh = []
  shownAt = fetchedAt = null
  pending = null
  hideNewPill()
  setAgeLabel('')
}

/** No prompt yet: nothing runs until there is one. Say so where the person lands. */
function showFirstRun(): void {
  stopLive?.()
  stopLive = undefined
  $('#hosted-prompt-firstrun').classList.remove('hidden')
  $('#hosted-empty-text').textContent =
    'Write what you care about, in your own words. As soon as you save it I rank your feed and write your first digest.'
  $('#btn-hosted-empty-action').classList.remove('hidden')
  show('#hosted-empty')
  focusPrompt()
}

function focusPrompt(): void {
  showTab('tune')
  const field = $<HTMLTextAreaElement>('#hosted-prompt')
  field.focus({ preventScroll: true })
  field.scrollIntoView({ block: 'center', behavior: 'auto' })
}

// ─── Subscription state ──────────────────────────────────────────────────────

function setEntitlement(ent: Entitlement): void {
  entitlement = ent
  const view = entitlementView(ent, nowSec())
  const banner = $('#hosted-banner')
  banner.classList.remove('is-warning', 'is-danger')
  banner.classList.toggle('hidden', !view.banner)
  if (view.kind === 'expired') banner.classList.add('is-danger')
  else if (view.kind === 'unknown') banner.classList.add('is-warning')
  $('#hosted-banner-text').textContent = view.text
  $('#hosted-subscription').textContent = view.text

  const action = $<HTMLButtonElement>('#btn-banner-action')
  action.classList.toggle('hidden', !view.actionLabel)
  if (view.actionLabel) action.textContent = view.actionLabel
  action.onclick = () => showPaywall()
}

// ─── Feed ────────────────────────────────────────────────────────────────────

type ShownFeed = Pick<FeedResponse, 'posts' | 'profiles' | 'hoursBack'> & { fetched?: number }

/** Whether the app may start a ranking by itself right now. */
function autoDue(): boolean {
  return shouldAutoRun({
    enabled: true,
    ready: Boolean(userNpub) && promptSet && !paywalled,
    running,
    hidden: document.visibilityState !== 'visible',
    createdAt: fetchedAt,
    nowSec: nowSec(),
    settingsChanged,
    pausedUntil,
    attemptFailed,
  })
}

/** Look at the server's stored ranking, then run in the background if what we have is stale. */
async function liveCheck(): Promise<void> {
  if (!userNpub || !promptSet || running) return
  await syncLatest()
  await digestBoot
  if (autoDue()) await runFeed()
  else void maybeFirstDigest()
}

/** The stored ranking from the server. It never ranks and never uses the daily cap. */
async function syncLatest(): Promise<void> {
  try {
    const latest = await getLatestFeed(fetchedAt)
    settingsChanged = latest?.settingsChanged === true
    if (!latest || 'unchanged' in latest || (latest.createdAt ?? 0) <= (fetchedAt ?? 0)) return
    setEntitlement(latest.entitlement)
    applyFeed(latest, { manual: false })
  } catch (err) {
    const api = err instanceof ApiError ? err : new ApiError(0, (err as Error).message, 'network')
    if (api.status === 401 || api.status === 402) return showFailure(err, () => syncLatest())
    const quiet = shownIds.length > 0 ? quietNotice(api.status, api.code) : null
    if (quiet?.text) setQuietNotice(quiet.text)
  }
}

/**
 * Take a ranking that arrived. The newest is always remembered on this device;
 * whether it replaces the list on screen depends on whether the reader is in the middle of it.
 */
function applyFeed(feed: FeedResponse, opts: { manual: boolean }): void {
  const at = feed.createdAt ?? nowSec()
  const incoming = feed.posts.map((p) => p.id)
  const d = decideMerge({ shownIds, incomingIds: incoming, scrollY: scrollY(), feedVisible: feedVisible(), manual: opts.manual })
  fetchedAt = Math.max(fetchedAt ?? 0, at)
  const fresh = freshIds(baseKeys, aggregateBoosts(feed.posts as unknown as ScoredPost[]).map((p) => p.id), baseFresh)
  rememberFeed(feed, at, fresh)
  setQuietNotice(null)
  if (d.action === 'pill') {
    pending = { feed, at, fresh }
    showNewPill(d.newCount, mergePending)
    return
  }
  if (d.action === 'keep') {
    if (d.same) shownAt = at
    paintAge()
    return
  }
  pending = null
  hideNewPill()
  drawFeed(feed, fresh)
  shownAt = at
  paintAge()
}

function mergePending(): void {
  if (!pending) return
  const { feed, at, fresh } = pending
  pending = null
  drawFeed(feed, fresh)
  shownAt = at
  paintAge()
}

function rememberFeed(feed: FeedResponse, at: number, fresh: string[]): void {
  if (!userNpub) return
  const snap: LocalSnapshot = {
    v: 1,
    createdAt: at,
    hoursBack: feed.hoursBack,
    fetched: feed.fetched,
    fresh,
    posts: feed.posts as unknown as LocalSnapshot['posts'],
    profiles: feed.profiles,
  }
  void saveFeedSnapshot('hosted', userNpub, snap, (posts) => new Set(collectPostPubkeys(posts as never, Infinity)))
}

function paintAge(): void {
  setAgeLabel(ageLabel(shownAt, nowSec()))
}

async function runFeed(opts: { manual?: boolean } = {}): Promise<void> {
  if (running) return
  const manual = opts.manual ?? false
  running = true
  if (manual) {
    attemptFailed = false
    pausedUntil = 0
  }
  // Something readable is on screen: rank quietly beside it. Nothing yet: say what is happening.
  const quiet = shownIds.length > 0
  const refresh = $<HTMLButtonElement>('#btn-hosted-refresh')
  refresh.disabled = true
  refresh.classList.add('is-busy')
  show('#hosted-notice', false)
  show('#hosted-paywall', false)
  show('#hosted-empty', false)
  setQuietNotice(null)
  // A reload mid-run would throw away a run that is already paid for.
  setUpdateBlocked(true)

  let timer: ReturnType<typeof setInterval> | undefined
  if (quiet) {
    setBackgroundBusy('Ranking new posts…')
  } else {
    show('#hosted-loading')
    const started = Date.now()
    const label = $('#hosted-loading-text')
    const tick = (): void => {
      const s = Math.round((Date.now() - started) / 1000)
      label.textContent = `Ranking your feed. This can take up to a minute (${s}s so far).`
      setStatusLoading('Ranking your feed…')
    }
    tick()
    timer = setInterval(tick, 1000)
  }

  try {
    const feed = await getFeed(100, manual)
    setEntitlement(feed.entitlement)
    paywalled = false
    pausedUntil = 0
    attemptFailed = false
    applyFeed(feed, { manual })
    void maybeFirstDigest()
  } catch (err) {
    onRunFailed(err, quiet)
  } finally {
    if (timer !== undefined) clearInterval(timer)
    show('#hosted-loading', false)
    setBackgroundBusy(null)
    refresh.disabled = false
    refresh.classList.remove('is-busy')
    running = false
    setUpdateBlocked(false)
  }
}

function onRunFailed(err: unknown, hadFeed: boolean): void {
  const api = err instanceof ApiError ? err : new ApiError(0, (err as Error).message, 'network')
  // A stored feed stays: a cap, an outage or no network get one quiet line, not an error card.
  const q = hadFeed ? quietNotice(api.status, api.code) : null
  if (q) {
    pausedUntil = nowSec() + q.pauseSeconds
    if (q.text) setQuietNotice(q.text)
    return
  }
  // Nothing to fall back on, or it needs the reader: the normal affordance. No automatic second try.
  attemptFailed = true
  showFailure(err, () => runFeed({ manual: true }))
}

/** Draw a ranking, `fresh` notes first. Also the only place that knows which posts are on screen. */
function drawFeed(feed: ShownFeed, fresh: string[]): void {
  const profiles = new Map<string, ProfileData>()
  for (const [pubkey, p] of Object.entries(feed.profiles)) {
    profiles.set(pubkey, { ...p, pubkey })
  }
  // The renderer never touches the raw event, which stays on the server.
  rememberProfiles(profiles)
  const posts = feed.posts as unknown as ScoredPost[]
  const settings = loadSettings()

  if (posts.length === 0) {
    clearFeed($('#hosted-feed'))
    shownIds = baseKeys = baseFresh = []
    showEmpty(`No posts from the people you follow in the last ${feed.hoursBack} hours. Try a longer window in Tune.`)
    setStatus('No posts found')
    return
  }
  show('#hosted-empty', false)
  const display = aggregateBoosts(posts)
  const set = new Set(fresh)
  baseKeys = display.map((p) => p.id)
  baseFresh = baseKeys.filter((id) => set.has(id))
  renderFeed(display, $('#hosted-feed'), {
    fresh: set,
    profiles,
    ...clientRenderOptions(settings),
    lazyProfileRelays: loadSettings().relays,
    linkPreviews: linkPreviewsOn ? attachLinkPreviews : undefined,
  })
  shownIds = posts.map((p) => p.id)
  setStatus(coverageText({ shown: display.length, ranked: Math.max(feed.fetched ?? 0, posts.length), hoursBack: feed.hoursBack, order: settings.feedOrder }))
}

function showEmpty(text: string): void {
  $('#hosted-empty-text').textContent = text
  $('#btn-hosted-empty-action').classList.add('hidden')
  show('#hosted-empty')
}

/** Say what went wrong and offer the one thing that can fix it. */
function showFailure(err: unknown, retry: () => void | Promise<void>): void {
  const api = err instanceof ApiError ? err : new ApiError(0, (err as Error).message, 'network')
  const d = describeError(api)
  setStatus('')

  if (d.action === 'login') return showLogin(d.message)
  if (d.action === 'pay') {
    paywalled = true
    setEntitlement({ state: 'expired' })
    return showPaywall(d.message)
  }
  const text = $('#hosted-notice-text')
  text.textContent = d.message
  const button = $<HTMLButtonElement>('#btn-notice-action')
  button.classList.remove('hidden')
  if (d.action === 'settings') {
      button.textContent = 'Open Tune'
    button.onclick = openSettingsPanel
  } else {
    button.textContent = 'Try again'
    button.onclick = () => void retry()
  }
  show('#hosted-notice')
}

// ─── Settings form ───────────────────────────────────────────────────────────

function updatePromptCount(): void {
  const n = $<HTMLTextAreaElement>('#hosted-prompt').value.length
  $('#hosted-prompt-count').textContent = `${n} / ${MAX_PROMPT_CHARS} characters`
}

async function saveSettingsForm(closeSettings: () => void): Promise<void> {
  const status = $('#tune-status')
  const setMsg = (text: string, isError = false): void => {
    status.textContent = text
    status.classList.toggle('is-error', isError)
  }
  const draft = {
    userPrompt: $<HTMLTextAreaElement>('#hosted-prompt').value,
    hoursBack: parseWholeNumber($<HTMLInputElement>('#hosted-hours').value),
    topN: parseWholeNumber($<HTMLInputElement>('#hosted-topn').value),
    learnFromLikes: $<HTMLInputElement>('#hosted-learn').checked,
    linkPreviews: $<HTMLInputElement>('#hosted-previews').checked,
    // The server writes the digest, so the length choice goes there as well as to this device.
    digestMinutes: Number($<HTMLSelectElement>('#select-digest-minutes').value),
  }
  const problem = validateHostedSettings(draft)
  if (problem) return setMsg(problem, true)
  const clientProblem = saveClientPreference(false)
  if (clientProblem) return setMsg(clientProblem, true)

  const button = $<HTMLButtonElement>('#btn-hosted-save')
  button.disabled = true
  setMsg('Saving…')
  try {
    const saved = await putSettings({ ...draft, userPrompt: draft.userPrompt.trim() })
    saveClientPreference()
    $<HTMLTextAreaElement>('#hosted-prompt').value = saved.userPrompt
    linkPreviewsOn = previewsEnabled(saved)
    updatePromptCount()
    setMsg('')
    document.dispatchEvent(new Event('nalgorithm:settings-saved'))
    setStatus('Settings saved')
    show('#hosted-notice', false)
    closeSettings()
    afterSettingsSaved(saved.userPrompt, saved.hoursBack)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      closeSettings()
      return showLogin(describeError(err).message)
    }
    setMsg(err instanceof ApiError ? describeError(err).message : (err as Error).message, true)
  } finally {
    button.disabled = false
  }
}

/**
 * A saved prompt starts the work. The first one lands the person on the Feed tab with
 * the ranking under way (and, once it is there, the first digest); a changed prompt or
 * window re-ranks quietly beside the stored feed.
 */
function afterSettingsSaved(prompt: string, hoursBack: number): void {
  const first = !promptSet && Boolean(prompt)
  const changed = prompt !== loadedPrompt || hoursBack !== loadedHours
  promptSet = Boolean(prompt)
  loadedPrompt = prompt
  loadedHours = hoursBack
  $('#hosted-prompt-firstrun').classList.toggle('hidden', promptSet)
  if (!promptSet) {
    if (shownIds.length === 0) showFirstRun()
    return
  }
  if (first || changed) {
    settingsChanged = true
    attemptFailed = false
    pausedUntil = 0
  }
  if (first) {
    show('#hosted-empty', false)
    showTab('feed')
    stopLive?.()
    stopLive = startLiveChecks({ check: () => void liveCheck(), tick: paintAge })
    return
  }
  if (changed) void liveCheck()
  else if (shownIds.length === 0) showEmpty('Press Refresh to rank your feed.')
}

// ─── Payment ─────────────────────────────────────────────────────────────────

function selectedPlan(): PlanId {
  const checked = document.querySelector<HTMLInputElement>('input[name="hosted-plan"]:checked')
  return checked?.value === 'all-access' ? 'all-access' : 'nalgorithm'
}

function updatePayDays(): void {
  const sats = parseWholeNumber($<HTMLInputElement>('#pay-sats').value)
  const problem = validateSats(sats)
  $('#pay-days').textContent = problem ?? `${formatSats(sats)} buys about ${formatDays(daysForSats(selectedPlan(), sats))}.`
}

function setPayStatus(text: string, isError = false): void {
  const el = $('#pay-status')
  el.textContent = text
  el.classList.toggle('is-error', isError)
}

function showPaywall(message = ''): void {
  showTab('feed')
  show('#hosted-notice', false)
  show('#hosted-empty', false)
  show('#hosted-paywall')
  setPayStatus(message)
  updatePayDays()
  $('#hosted-paywall').scrollIntoView({ block: 'nearest' })
}

async function startPayment(): Promise<void> {
  if (paying) return
  const plan = selectedPlan()
  const sats = parseWholeNumber($<HTMLInputElement>('#pay-sats').value)
  const problem = validateSats(sats)
  if (problem) return setPayStatus(problem, true)

  paying = true
  stopPaying = false
  const button = $<HTMLButtonElement>('#btn-pay')
  button.disabled = true
  setUpdateBlocked(true)
  // Opened now, inside the click, so a popup blocker allows it; pointed at the
  // payment page once the invoice exists.
  const tab = window.open('', '_blank')
  const before = entitlement
  setPayStatus('Creating the invoice…')

  try {
    let charge
    try {
      charge = await createCheckout(plan, sats === PLANS[plan].sats ? undefined : sats)
    } catch (err) {
      tab?.close()
      if (err instanceof ApiError && err.status === 401) return showLogin(describeError(err).message)
      return setPayStatus(err instanceof ApiError ? describeError(err).message : (err as Error).message, true)
    }
    if (!isHttpUrl(charge.checkout_url)) {
      tab?.close()
      return setPayStatus('The payment page address was not valid. Try again.', true)
    }

    const link = $<HTMLAnchorElement>('#pay-link')
    link.href = charge.checkout_url
    link.classList.remove('hidden')
    if (tab) {
      try {
        tab.opener = null
      } catch {
        // Cross-origin hardening is best-effort.
      }
      tab.location.href = charge.checkout_url
    }

    setPayStatus('Waiting for your payment. Keep this page open.')
    show('#btn-pay-cancel')
    const confirmed = await waitForPayment(before)
    if (confirmed) {
      setPayStatus('Payment received. Thank you.')
      show('#hosted-paywall', false)
      await runFeed()
    } else if (!stopPaying) {
      setPayStatus('The payment has not shown up yet. If you paid, it can take a few minutes: try Refresh again shortly.', true)
    } else {
      setPayStatus('Stopped waiting. If you paid, your access will update on the next Refresh.')
    }
  } finally {
    paying = false
    button.disabled = false
    show('#btn-pay-cancel', false)
    $('#pay-link').classList.add('hidden')
    setUpdateBlocked(false)
  }
}

/** Poll `/me` until the payment shows up, the person stops, or ten minutes pass. */
async function waitForPayment(before: Entitlement | null): Promise<boolean> {
  const deadline = Date.now() + POLL_MAX_MS
  while (!stopPaying && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    if (stopPaying) break
    try {
      const me = await getMe()
      if (paymentConfirmed(before, me.entitlement)) {
        setEntitlement(me.entitlement)
        return true
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        stopPaying = true
        showLogin(describeError(err).message)
        return false
      }
      // A blip while polling is not a failed payment; keep waiting.
    }
  }
  return false
}

// ─── Daily digest ────────────────────────────────────────────────────────────

let digestTz = ''
let closeSettingsPanel: () => void = () => {}

function setText(selector: string, text: string, isError = false): void {
  const el = $(selector)
  el.textContent = text
  el.classList.toggle('is-error', isError)
}

function initDigestForm(closeSettings: () => void): void {
  closeSettingsPanel = closeSettings
  $('#digest-dm-note').textContent = DIGEST_DM_NOTE
  $('#digest-bot-npub').textContent = DIGEST_BOT_NPUB
  paintBotLink()
  document.addEventListener('nalgorithm:settings-saved', paintBotLink)
  $('#btn-digest-copy').addEventListener('click', () => {
    const button = $('#btn-digest-copy')
    navigator.clipboard.writeText(DIGEST_BOT_NPUB).then(
      () => {
        button.textContent = 'Copied'
      },
      () => {
        button.textContent = 'Select the npub to copy'
      }
    )
    setTimeout(() => {
      button.textContent = 'Copy npub'
    }, 2000)
  })

  // The voices with a sample come first; the rest stay available without one.
  const voice = $<HTMLSelectElement>('#digest-voice')
  voice.append(new Option('Default', ''))
  const sampled = document.createElement('optgroup')
  sampled.label = 'With a sample'
  const more = document.createElement('optgroup')
  more.label = 'More voices'
  for (const id of SAMPLE_VOICE_IDS) {
    const v = DIGEST_VOICES.find((x) => x.id === id)
    if (v) sampled.append(new Option(v.label, v.id))
  }
  for (const v of DIGEST_VOICES) if (!SAMPLE_VOICE_IDS.includes(v.id)) more.append(new Option(v.label, v.id))
  voice.append(sampled, more)
  voice.addEventListener('change', paintSampleButton)
  $('#btn-voice-sample').addEventListener('click', playVoiceSample)
  paintSampleButton()
  const format = $<HTMLSelectElement>('#digest-format')
  for (const f of DM_FORMATS) format.append(new Option(f.label, f.value))
  $('#digest-format-hint').textContent = DM_FORMAT_HINT

  $('#btn-schedule-open').addEventListener('click', openScheduleSettings)
  $('#btn-nudge-schedule').addEventListener('click', () => void acceptScheduleNudge())
  $('#btn-nudge-later').addEventListener('click', dismissScheduleNudge)
  onFirstListen(() => maybeScheduleNudge())

  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
    for (const z of zones) $('#digest-tz-list').append(new Option(z))
  } catch {
    // The zone can still be typed.
  }

  $('#btn-digest-save').addEventListener('click', () => void saveDigestSchedule())
  $('#btn-digest-now').addEventListener('click', () => void sendDigestNow())
}

/** The schedule as last read or saved, for the Digests tab line and the nudge. */
let schedule: Schedule | null = null

function showScheduleInfo(s: Schedule): void {
  schedule = s
  setText('#digest-last-status', lastStatusText(s.lastStatus))
  setText('#digest-schedule-status', nextRunText(s))
  $('#digest-schedule-line').textContent = scheduleLine(s)
  $('#btn-schedule-open').classList.toggle('hidden', s.enabled)
  if (s.enabled) show('#schedule-nudge', false)
}

/** "Follow the digest account": in the reader's chosen client, with the npub to copy beside it. */
function paintBotLink(): void {
  const settings = loadSettings()
  const link = $<HTMLAnchorElement>('#digest-bot-link')
  link.href = profileLink(pubkeyToHex(DIGEST_BOT_NPUB), clientRenderOptions(settings))
  link.textContent = `open the digest account in ${clientLabel(settings.clientPreset)}`
}

function openScheduleSettings(): void {
  showTab('tune')
  const box = $<HTMLInputElement>('#digest-enabled')
  box.scrollIntoView({ block: 'center' })
  box.focus()
}

// ─── voice samples ───────────────────────────────────────────────────────────

let sampleAudio: HTMLAudioElement | null = null

function paintSampleButton(): void {
  const id = $<HTMLSelectElement>('#digest-voice').value
  const has = id === '' || SAMPLE_VOICE_IDS.includes(id)
  const button = $<HTMLButtonElement>('#btn-voice-sample')
  button.disabled = !has
  setText('#voice-sample-status', has ? '' : 'No sample for this voice. The ones listed first have one.')
}

/** A short fixed sentence in the chosen voice. It is made once per voice on the server; no digest is written. */
function playVoiceSample(): void {
  const id = $<HTMLSelectElement>('#digest-voice').value || 'af_sky'
  if (!SAMPLE_VOICE_IDS.includes(id)) return
  sampleAudio?.pause()
  const audio = new Audio(voiceSampleUrl(id))
  sampleAudio = audio
  setText('#voice-sample-status', 'Loading the sample…')
  audio.addEventListener('playing', () => setText('#voice-sample-status', 'Playing a short sample.'), { once: true })
  audio.addEventListener('ended', () => setText('#voice-sample-status', ''), { once: true })
  audio.addEventListener('error', () => setText('#voice-sample-status', 'The sample could not play right now. The voice still works for digests.', true), { once: true })
  void audio.play().catch((err: Error) => {
    if (err.name !== 'AbortError') setText('#voice-sample-status', 'The sample could not play right now. The voice still works for digests.', true)
  })
}

// ─── the one schedule nudge ──────────────────────────────────────────────────

const NUDGE_TIME = '07:30'
const nudgeKey = (npub: string): string => `nalgorithm_schedule_nudge_${identityKey(npub) ?? npub}`

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** After the first real listen, once per account: offer daily delivery. It is never turned on without this press. */
function maybeScheduleNudge(): void {
  if (!userNpub || !schedule || schedule.enabled) return
  try {
    if (safeStorage()?.getItem(nudgeKey(userNpub))) return
  } catch {
    // Unreadable storage: offer it this once anyway.
  }
  const zone = isValidTimeZone(digestTz) ? digestTz : browserZone()
  $('#schedule-nudge-time').textContent = NUDGE_TIME
  $('#schedule-nudge-text').textContent =
    `I write it at ${NUDGE_TIME} ${zone} and send it by Nostr DM, in a format almost every app can read. ` +
    'The DM is encrypted, but the audio link in it is public: anyone with the link can play it. Change the time, voice or app in Tune.'
  setText('#schedule-nudge-status', '')
  show('#schedule-nudge')
}

function dismissScheduleNudge(): void {
  show('#schedule-nudge', false)
  try {
    if (userNpub) safeStorage()?.setItem(nudgeKey(userNpub), 'dismissed')
  } catch {
    // Not remembered: it may be offered once more on a later visit.
  }
}

async function acceptScheduleNudge(): Promise<void> {
  const button = $<HTMLButtonElement>('#btn-nudge-schedule')
  button.disabled = true
  setText('#schedule-nudge-status', 'Saving…')
  try {
    const zone = isValidTimeZone(digestTz) ? digestTz : browserZone()
    const saved = await putSchedule({ enabled: true, time: NUDGE_TIME, tz: zone })
    digestTz = saved.tz
    $<HTMLInputElement>('#digest-enabled').checked = true
    $<HTMLInputElement>('#digest-time').value = saved.time
    $<HTMLInputElement>('#digest-tz').value = saved.tz
    showScheduleInfo(saved)
    dismissScheduleNudge()
    toast(scheduleLine(saved))
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin(describeError(err).message)
    setText('#schedule-nudge-status', err instanceof ApiError ? describeError(err).message : (err as Error).message, true)
  } finally {
    button.disabled = false
  }
}

async function loadDigestSection(): Promise<void> {
  setText('#digest-schedule-status', '')
  setText('#digest-now-status', '')
  try {
    const s = await getSchedule()
    let browserTz: string | undefined
    try {
      browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      browserTz = undefined
    }
    digestTz = defaultTimeZone(s, browserTz)
    $<HTMLInputElement>('#digest-enabled').checked = s.enabled
    $<HTMLInputElement>('#digest-time').value = s.time
    $<HTMLInputElement>('#digest-tz').value = digestTz
    $<HTMLSelectElement>('#digest-voice').value = s.voice ?? ''
    $<HTMLSelectElement>('#digest-format').value = s.dmFormat ?? ''
    showScheduleInfo({ ...s, tz: digestTz })
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin(describeError(err).message)
    setText('#digest-schedule-status', 'The digest schedule could not be loaded.', true)
  }
}

/** The server's digest list as last read on this page, with the answers' ETags, for one account. */
let listState: { owner: string; list: DigestRecord[] | null; etag?: string; summaryEtag?: string } = { owner: '', list: null }
/** One read in flight at a time: triggers that coincide (tab shown, job poll, return to the app) share it. */
let listRead: { owner: string; summary: boolean; promise: Promise<DigestRecord[]> } | null = null

/**
 * Read the list from the server. A background read asks for the summary (no show notes) and
 * only with the ETag of the last answer, so an unchanged list is a body-less 304.
 */
function readServerList(owner: string, summary: boolean): Promise<DigestRecord[]> {
  if (listRead && listRead.owner === owner && (listRead.summary === summary || !listRead.summary)) return listRead.promise
  if (listState.owner !== owner) listState = { owner, list: null }
  const state = listState
  const promise = (async () => {
    const answer = await getDigests(DIGEST_FEED_LIMIT, { summary, etag: state.list ? (summary ? state.summaryEtag : state.etag) : undefined })
    if (summary) state.summaryEtag = answer.etag
    else state.etag = answer.etag
    if (answer.unchanged && state.list) return state.list
    const fresh = answer.unchanged ? [] : answer.digests
    // A list that omits the notes must not wipe notes already fetched.
    const known = new Map((state.list ?? (await loadDigestHistory('hosted', owner, readDigest))).map((d) => [d.id, d]))
    state.list = fresh.map((d) => (d.notes === undefined && known.get(d.id)?.notes ? { ...d, notes: known.get(d.id)!.notes } : d))
    return state.list
  })().finally(() => {
    if (listRead?.promise === promise) listRead = null
  })
  listRead = { owner, summary, promise }
  return promise
}

/** What a redraw would change: order, audio and length; show notes load on their own. */
const listShape = (list: readonly DigestRecord[]): string => list.map((d) => `${d.id}|${d.audioUrl ?? ''}|${d.durationSeconds ?? ''}`).join()

/**
 * Newest digests from the server, cached so the tab opens offline. `quiet` is for
 * background refreshes: no spinner, no error card, the summary list only, and nothing
 * redrawn when nothing changed. Returns the list, or null when it could not be read.
 */
async function loadDigests(quiet = false): Promise<DigestRecord[] | null> {
  const owner = userNpub
  if (!owner) return null
  if (!quiet) setListLoading(true)
  lastListLoad = Date.now()
  try {
    const before = listState.owner === owner ? listState.list : null
    const list = await readServerList(owner, quiet)
    // Signed out or another account meanwhile: this list is not theirs to see.
    if (userNpub !== owner) return null
    if (list !== before) void saveDigestHistory('hosted', owner, list)
    digestsKnown = true
    if (!quiet || listShape(list) !== listShape(currentDigests())) setDigests(list)
    return list
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      showLogin(describeError(err).message)
      return null
    }
    if (quiet || userNpub !== owner) return null
    const cached = await loadDigestHistory('hosted', owner, readDigest)
    if (cached.length > 0 && digestCount() === 0) setDigests(cached)
    setListError(
      cached.length > 0
        ? 'Could not reach the server. Showing the digests saved on this device.'
        : 'Your digests could not be loaded. Check your connection and try again.',
      () => void loadDigests()
    )
    return null
  } finally {
    if (!quiet) setListLoading(false)
  }
}

/** Show notes fetched for one digest are kept with the list on this device, for offline reading. */
async function loadFullDigest(d: DigestRecord): Promise<DigestRecord | null> {
  const owner = userNpub
  const full = await getDigest(d.id)
  if (!full || !owner || userNpub !== owner) return full
  if (listState.owner === owner && listState.list) {
    listState.list = listState.list.map((x) => (x.id === full.id ? { ...x, notes: full.notes } : x))
  }
  const stored = await loadDigestHistory('hosted', owner, readDigest)
  if (stored.some((x) => x.id === full.id)) {
    void saveDigestHistory('hosted', owner, stored.map((x) => (x.id === full.id ? { ...x, notes: full.notes } : x)))
  }
  return full
}

// ─── Digest on demand ────────────────────────────────────────────────────────

/** How often the job status is read while a digest is being written. */
const JOB_POLL_MS = 10_000

let job: DigestStatus = IDLE_STATUS
let jobWasRunning = false
/** The digests the reader had when the run began, so a new one is recognised even from an empty list. */
let knownBeforeRun: string[] = []
let jobPoll: number | undefined
let jobTick: number | undefined
let lastListLoad = 0
const askedThisPage = new Set<string>()

function stopJobTimers(): void {
  if (jobPoll !== undefined) clearInterval(jobPoll)
  if (jobTick !== undefined) clearInterval(jobTick)
  jobPoll = jobTick = undefined
}

/** The digest of the running job that is already in the list while its DM is being sent. */
let readyDuringJob: string | null = null

/** Both places that show the running digest: the Digests tab line and the Tune line. */
function paintJob(): void {
  const text = !job.running ? '' : readyDuringJob ? arrivalText('ready') : progressText(job, nowSec())
  if (job.running) setMakeStatus(text)
  setText('#digest-now-status', text)
}

/** Read the server's view of the digest being written, and react to it starting or ending. */
async function refreshDigestStatus(): Promise<void> {
  if (!userNpub) return
  try {
    const status = await getDigestStatus()
    if (status.running && !readyDuringJob) {
      // The list can have the new digest before the job is finished (the DM is sent in between):
      // it can be played now, but delivery is only known once the job ends.
      const list = await loadDigests(true)
      if (list && readyDuringRun(status, list)) {
        const fresh = findArrived(knownBeforeRun, list) ?? list[0]
        readyDuringJob = fresh.id
        setDigests(list, { select: fresh.id })
      }
    }
    applyDigestStatus(status)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin(describeError(err).message)
    // A blip is not news; the next poll or visit looks again.
  }
}

function applyDigestStatus(status: DigestStatus): void {
  const step = nextJobStep(jobWasRunning, status)
  if (status.running && !jobWasRunning) knownBeforeRun = digestIds()
  job = status
  jobWasRunning = status.running
  setDigestJobRunning(status.running, status.startedAt)

  if (status.running) {
    // Status every 10 s while the page is in view; a hidden tab reads nothing and catches up when shown.
    if (jobPoll === undefined) jobPoll = window.setInterval(() => document.visibilityState === 'visible' && void refreshDigestStatus(), JOB_POLL_MS)
    if (jobTick === undefined) jobTick = window.setInterval(() => document.visibilityState === 'visible' && paintJob(), 1000)
    paintJob()
    return
  }
  stopJobTimers()
  const shownEarly = readyDuringJob
  readyDuringJob = null
  if (step.kind === 'arrived') void announceArrival(step.dmPending, shownEarly)
  else if (step.kind === 'failed') {
    setMakeStatus(step.message, true)
    setText('#digest-now-status', step.message, true)
    if (step.action === 'pay') {
      setEntitlement({ state: 'expired' })
      paywalled = true
      showPaywall(step.message)
    }
  } else if (!status.running) {
    setText('#digest-now-status', '')
  }
}

/**
 * The digest finished: load it, put it in the hero player (no autoplay), say so once where the
 * reader is. A digest already shown while its DM was sent is not selected again.
 */
async function announceArrival(dmPending: boolean, shownEarly: string | null): Promise<void> {
  const list = await loadDigests(true)
  if (!shownEarly) {
    const fresh = findArrived(knownBeforeRun, list ?? []) ?? list?.[0]
    if (fresh) setDigests(list ?? [], { select: fresh.id })
  }
  const text = arrivalText(dmPending ? 'dm_pending' : 'sent')
  setText('#digest-now-status', text)
  if (currentTab() === 'digest') setMakeStatus(text)
  else toast(text)
}

/** Re-read the digest list and the job status: on opening the Digests tab and on returning to the app. */
async function refreshDigests(): Promise<void> {
  if (!userNpub) return
  // Two triggers often fire together (tab shown + visible): one read is enough.
  if (Date.now() - lastListLoad < 3000) return
  await loadDigests(true)
  await refreshDigestStatus()
}

/** Ask the server for a digest now. Throws the text to show; anything that needs a screen of its own gets it. */
async function requestDigest(): Promise<void> {
  try {
    const res = await digestNow()
    knownBeforeRun = digestIds()
    applyDigestStatus({ ...res.status, running: true, startedAt: res.status.startedAt ?? nowSec() })
  } catch (err) {
    const api = err instanceof ApiError ? err : new ApiError(0, (err as Error).message, 'network')
    if (api.status === 409 && api.code === 'digest_running') {
      // Another press, tab or device already started one: show that one.
      const startedAt = typeof api.data.startedAt === 'number' ? api.data.startedAt : nowSec()
      knownBeforeRun = digestIds()
      applyDigestStatus({ ...IDLE_STATUS, running: true, startedAt, lastDurationSeconds: job.lastDurationSeconds })
      return
    }
    const d = describeDigestNowError(api)
    if (d.action === 'login') {
      closeSettingsPanel()
      showLogin(d.message)
      return
    }
    if (d.action === 'pay') {
      paywalled = true
      setEntitlement({ state: 'expired' })
      closeSettingsPanel()
      showPaywall(d.message)
      return
    }
    throw new Error(d.message)
  }
}

/**
 * The first digest, asked for once without a button: after the first ranking, for someone who has
 * none yet. The flag is written before the request, so a failure or a reload never asks twice.
 */
async function maybeFirstDigest(): Promise<void> {
  if (!userNpub) return
  await digestBoot
  const store = safeStorage()
  let requested = askedThisPage.has(userNpub)
  try {
    requested ||= store?.getItem(firstDigestKey(userNpub)) != null
  } catch {
    // Unreadable storage: treat as not asked, but the per-page guard still holds.
  }
  if (
    !shouldRequestFirstDigest({
      hasPrompt: promptSet,
      postCount: shownIds.length,
      digestCount: digestCount(),
      digestsKnown,
      jobRunning: job.running,
      alreadyRequested: requested,
      paywalled,
    })
  ) {
    return
  }
  askedThisPage.add(userNpub)
  try {
    store?.setItem(firstDigestKey(userNpub), String(nowSec()))
  } catch {
    // The page guard still stops a second request until the next load.
  }
  try {
    await requestDigest()
  } catch (err) {
    setMakeStatus((err as Error).message, true)
  }
}

const hostedBackend: DigestBackend = {
  audioDownloadUrl: (d) => d.audioUrl ? digestAudioUrl(d.id) : null,
  mode: 'hosted',
  makeLabel: 'Send me a digest now',
  makeAnotherLabel: 'Send me another digest now',
  emptyText:
    'I write a spoken digest of what the people you follow posted. It lands here and by Nostr DM. Turn on daily delivery in Tune to have one every morning. Nothing plays until you press play.',
  async make() {
    setMakeStatus('Asking for a digest…')
    await requestDigest()
  },
  loadFull: loadFullDigest,
  renderOptions(profiles) {
    return {
      profiles,
      ...clientRenderOptions(loadSettings()),
      linkPreviews: linkPreviewsOn ? attachLinkPreviews : undefined,
    }
  },
  // Names come from public profile events; the reader's own relay list is the place to ask.
  relays: () => loadSettings().relays,
}

// ─── Open notes in (client preference, kept on this device) ─────────────────

function initClientPicker(): void {
  const s = loadSettings()
  const select = $<HTMLSelectElement>('#select-client')
  select.value = s.clientPreset
  $<HTMLInputElement>('#input-client-custom').value = s.clientCustomUrl
  $<HTMLInputElement>('#input-client-custom-profile').value = s.clientCustomProfileUrl
  const sync = (): void => {
    const custom = select.value === 'custom'
    $('#input-client-custom').classList.toggle('hidden', !custom)
    $('#input-client-custom-profile').classList.toggle('hidden', !custom)
    $('#client-hint').classList.toggle('hidden', !custom)
  }
  select.addEventListener('change', sync)
  $<HTMLSelectElement>('#select-feed-order').value = s.feedOrder
  $<HTMLInputElement>('#input-data-saver').checked = s.dataSaver
  $<HTMLSelectElement>('#select-digest-minutes').value = String(s.digestMinutes)
  $<HTMLInputElement>('#input-cache-audio').checked = s.cacheAudio
  sync()
}

/** Save the client preference. Returns a problem to show, or null. */
function saveClientPreference(persist = true): string | null {
  const preset = $<HTMLSelectElement>('#select-client').value as ReturnType<typeof loadSettings>['clientPreset']
  const custom = $<HTMLInputElement>('#input-client-custom').value.trim()
  const customProfile = $<HTMLInputElement>('#input-client-custom-profile').value.trim()
  if (preset === 'custom') {
    const problem = validateTemplate(custom) ?? validateTemplate(customProfile)
    if (problem) return problem
  }
  if (persist) saveSettings({ ...loadSettings(), clientPreset: preset, clientCustomUrl: custom, clientCustomProfileUrl: customProfile,
    feedOrder: $<HTMLSelectElement>('#select-feed-order').value === 'best' ? 'best' : 'new',
    dataSaver: $<HTMLInputElement>('#input-data-saver').checked,
    digestMinutes: Number($<HTMLSelectElement>('#select-digest-minutes').value),
    cacheAudio: $<HTMLInputElement>('#input-cache-audio').checked,
  })
  return null
}

async function saveDigestSchedule(): Promise<void> {
  const voiceValue = $<HTMLSelectElement>('#digest-voice').value
  const formatValue = $<HTMLSelectElement>('#digest-format').value
  const form = {
    enabled: $<HTMLInputElement>('#digest-enabled').checked,
    time: $<HTMLInputElement>('#digest-time').value,
    tz: $<HTMLInputElement>('#digest-tz').value.trim(),
    voice: voiceValue || null,
    dmFormat: (formatValue || null) as DmFormat | null,
  }
  const problem = validateScheduleForm(form)
  if (problem) return setText('#digest-schedule-status', problem, true)

  const button = $<HTMLButtonElement>('#btn-digest-save')
  button.disabled = true
  setText('#digest-schedule-status', 'Saving…')
  try {
    const saved = await putSchedule(form)
    document.dispatchEvent(new CustomEvent('nalgorithm:settings-saved', { detail: { section: 'schedule' } }))
    digestTz = saved.tz
    showScheduleInfo(saved)
    const next = nextRunText(saved)
    setText('#digest-schedule-status', next ? `Saved. ${next}` : 'Saved.')
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      closeSettingsPanel()
      return showLogin(describeError(err).message)
    }
    setText('#digest-schedule-status', err instanceof ApiError ? describeError(err).message : (err as Error).message, true)
  } finally {
    button.disabled = false
  }
}

async function sendDigestNow(): Promise<void> {
  // Double presses: the button is disabled from the moment the job is known to run.
  if (job.running) return
  setText('#digest-now-status', 'Asking for a digest…')
  try {
    await requestDigest()
  } catch (err) {
    setText('#digest-now-status', (err as Error).message, true)
  }
}
