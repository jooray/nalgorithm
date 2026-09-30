/**
 * Nalgorithm Web — hosted mode
 *
 * The hosted server does the fetching, scoring and billing; this is only the
 * client for it. Posts are drawn by the same renderer as bring-your-own-key
 * mode, so both look identical.
 *
 * Flow: read `/me` → signed out shows the login panel, signed in loads the
 * settings and waits for Refresh. Refresh is never automatic, because a run
 * starts the free trial and counts against the daily cap.
 */

import type { ProfileData, ScoredPost } from 'nalgorithm'
import { renderFeed, aggregateBoosts, clientRenderOptions } from '../render.js'
import { attachLinkPreviews } from './previews.js'
import { previewsEnabled } from './previews-logic.js'
import { loadSettings, saveSettings } from '../settings.js'
import { openHostedLoginDialog } from '../login-ui.js'
import { refreshButtonHtml, setStatus, setStatusLoading } from '../ui.js'
import { setUpdateBlocked } from '../version-check.js'
import { showTab } from '../shell.js'
import { validateTemplate } from '../client-url.js'
import {
  initDigestView,
  setDigests,
  setListError,
  setListLoading,
  setMakeStatus,
  stopPlayback,
  digestCount,
  type DigestBackend,
} from '../digest-view.js'
import { readDigest, type DigestRecord } from '../digest-model.js'
import { HOSTED_CACHE_KEY, loadHistory, saveHistory } from '../digest-history.js'
import { safeStorage } from '../player.js'
import { rememberProfiles } from '../profiles.js'
import {
  ApiError,
  createCheckout,
  digestNow,
  getDigest,
  getDigests,
  getFeed,
  getMe,
  getSchedule,
  getSettings,
  loginWithSigner,
  logout,
  putSchedule,
  putSettings,
  type FeedResponse,
} from './api.js'
import {
  DIGEST_BOT_NPUB,
  DIGEST_DM_NOTE,
  DIGEST_ON_ITS_WAY,
  DIGEST_VOICES,
  DM_FORMATS,
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

const POLL_INTERVAL_MS = 4000
const POLL_MAX_MS = 10 * 60 * 1000

let entitlement: Entitlement | null = null
let userNpub = ''
let running = false
let paying = false
let stopPaying = false

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
  // Settings are the Tune tab now, so there is no panel to close.
  const closeSettings = (): void => {}
  openSettingsPanel = () => showTab('tune')
  $('#btn-hosted-save').addEventListener('click', () => void saveSettingsForm(closeSettings))
  $<HTMLTextAreaElement>('#hosted-prompt').addEventListener('input', updatePromptCount)
  initClientPicker()

  // Account
  $('#btn-hosted-login').addEventListener('click', () => void signIn())
  $('#btn-hosted-logout').addEventListener('click', () => void signOut(closeSettings))
  $('#btn-hosted-to-byok').addEventListener('click', () => switchMode('byok'))
  $('#btn-hosted-switch-byok').addEventListener('click', () => switchMode('byok'))
  $('#btn-hosted-subscribe').addEventListener('click', () => showPaywall())
  $('#mode-line').textContent = 'You are using the hosted service. The server ranks your feed and writes your digest.'

  // Feed
  $('#btn-hosted-refresh').innerHTML = refreshButtonHtml()
  $('#btn-hosted-refresh').addEventListener('click', () => void runFeed())

  initDigestView(hostedBackend)
  setDigests(loadHistory(safeStorage(), readDigest, HOSTED_CACHE_KEY))

  initDigestForm(closeSettings)

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
  try {
    const me = await getMe()
    await onSignedIn(me.npub, me.entitlement)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin()
    showFailure(err, boot)
  }
}

// ─── Login / logout ──────────────────────────────────────────────────────────

function showLogin(message = ''): void {
  document.body.dataset.signedIn = 'false'
  entitlement = null
  userNpub = ''
  show('#hosted-login')
  show('#hosted-banner', false)
  show('#hosted-notice', false)
  show('#hosted-paywall', false)
  show('#hosted-loading', false)
  show('#hosted-empty', false)
  $('#hosted-feed').innerHTML = ''
  setStatus('')
  setLoginStatus(message, Boolean(message))
}

function setLoginStatus(text: string, isError = false): void {
  const el = $('#hosted-login-status')
  el.textContent = text
  el.classList.toggle('is-error', isError)
}

async function signIn(): Promise<void> {
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
  }
}

async function signOut(closeSettings: () => void): Promise<void> {
  try {
    await logout()
  } catch {
    // The cookie may already be gone; either way this device is done.
  }
  closeSettings()
  // The next person on this device must not see this account's digests.
  stopDigestPoll()
  stopPlayback()
  try {
    safeStorage()?.removeItem(HOSTED_CACHE_KEY)
  } catch {
    // nothing cached to clear
  }
  setDigests([])
  showLogin()
}

/** Whether link cards are shown; set from the saved settings. */
let linkPreviewsOn = true

async function onSignedIn(npub: string, ent: Entitlement): Promise<void> {
  userNpub = npub
  document.body.dataset.signedIn = 'true'
  show('#hosted-login', false)
  show('#hosted-notice', false)
  $('#hosted-npub').textContent = npub.length > 24 ? `${npub.slice(0, 14)}…${npub.slice(-6)}` : npub
  setEntitlement(ent)

  const s = await getSettings()
  $<HTMLTextAreaElement>('#hosted-prompt').value = s.userPrompt
  $<HTMLInputElement>('#hosted-hours').value = String(s.hoursBack)
  $<HTMLInputElement>('#hosted-topn').value = String(s.topN)
  $<HTMLInputElement>('#hosted-learn').checked = s.learnFromLikes
  $<HTMLInputElement>('#hosted-previews').checked = linkPreviewsOn = previewsEnabled(s)
  updatePromptCount()
  void loadDigestSection()
  void loadDigests()

  if (!s.userPrompt) {
    showEmpty('Describe what you want to see in Tune, then press Refresh.')
    // First run: the setup is on the Tune tab.
    openSettingsPanel()
  } else if (!$('#hosted-feed').childElementCount) {
    showEmpty('Press Refresh to rank your feed.')
  }
}

// ─── Subscription state ──────────────────────────────────────────────────────

function setEntitlement(ent: Entitlement): void {
  entitlement = ent
  const view = entitlementView(ent, nowSec())
  const banner = $('#hosted-banner')
  banner.classList.remove('hidden', 'is-warning', 'is-danger')
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

async function runFeed(): Promise<void> {
  if (running) return
  running = true
  const refresh = $<HTMLButtonElement>('#btn-hosted-refresh')
  refresh.disabled = true
  refresh.classList.add('is-busy')
  show('#hosted-notice', false)
  show('#hosted-paywall', false)
  show('#hosted-empty', false)
  show('#hosted-loading')
  // A reload mid-run would throw away a run that is already paid for.
  setUpdateBlocked(true)

  const started = Date.now()
  const label = $('#hosted-loading-text')
  const tick = (): void => {
    const s = Math.round((Date.now() - started) / 1000)
    label.textContent = `Ranking your feed. This can take up to a minute (${s}s so far).`
    setStatusLoading('Ranking your feed…')
  }
  tick()
  const timer = setInterval(tick, 1000)

  try {
    const feed = await getFeed()
    setEntitlement(feed.entitlement)
    renderResult(feed)
  } catch (err) {
    showFailure(err, runFeed)
  } finally {
    clearInterval(timer)
    show('#hosted-loading', false)
    refresh.disabled = false
    refresh.classList.remove('is-busy')
    running = false
    setUpdateBlocked(false)
  }
}

function renderResult(feed: FeedResponse): void {
  const profiles = new Map<string, ProfileData>()
  for (const [pubkey, p] of Object.entries(feed.profiles)) {
    profiles.set(pubkey, { ...p, pubkey })
  }
  // The renderer never touches the raw event, which stays on the server.
  rememberProfiles(profiles)
  const posts = feed.posts as unknown as ScoredPost[]
  const settings = loadSettings()

  if (posts.length === 0) {
    $('#hosted-feed').innerHTML = ''
    showEmpty(`No posts from the people you follow in the last ${feed.hoursBack} hours. Try a longer window in Tune.`)
    setStatus('No posts found')
    return
  }
  show('#hosted-empty', false)
  const display = aggregateBoosts(posts)
  renderFeed(display, $('#hosted-feed'), {
    profiles,
    ...clientRenderOptions(settings),
    linkPreviews: linkPreviewsOn ? attachLinkPreviews : undefined,
  })
  setStatus(`Showing ${display.length} posts, ranked by relevance`)
}

function showEmpty(text: string): void {
  $('#hosted-empty-text').textContent = text
  show('#hosted-empty')
}

/** Say what went wrong and offer the one thing that can fix it. */
function showFailure(err: unknown, retry: () => void | Promise<void>): void {
  const api = err instanceof ApiError ? err : new ApiError(0, (err as Error).message, 'network')
  const d = describeError(api)
  setStatus('')

  if (d.action === 'login') return showLogin(d.message)
  if (d.action === 'pay') {
    setEntitlement({ state: 'expired' })
    return showPaywall(d.message)
  }
  const text = $('#hosted-notice-text')
  text.textContent = d.message
  const button = $<HTMLButtonElement>('#btn-notice-action')
  button.classList.remove('hidden')
  if (d.action === 'settings') {
    button.textContent = 'Open settings'
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
  }
  const problem = validateHostedSettings(draft)
  if (problem) return setMsg(problem, true)
  const clientProblem = saveClientPreference()
  if (clientProblem) return setMsg(clientProblem, true)

  const button = $<HTMLButtonElement>('#btn-hosted-save')
  button.disabled = true
  setMsg('Saving…')
  try {
    const saved = await putSettings({ ...draft, userPrompt: draft.userPrompt.trim() })
    $<HTMLTextAreaElement>('#hosted-prompt').value = saved.userPrompt
    linkPreviewsOn = previewsEnabled(saved)
    updatePromptCount()
    setMsg('')
    setStatus('Settings saved')
    show('#hosted-notice', false)
    if (!$('#hosted-feed').childElementCount) showEmpty('Press Refresh to rank your feed.')
    closeSettings()
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
  $<HTMLAnchorElement>('#digest-bot-link').href = `nostr:${DIGEST_BOT_NPUB}`
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

  const voice = $<HTMLSelectElement>('#digest-voice')
  voice.append(new Option('Default', ''))
  for (const v of DIGEST_VOICES) voice.append(new Option(v.label, v.id))
  const format = $<HTMLSelectElement>('#digest-format')
  for (const f of DM_FORMATS) format.append(new Option(f.label, f.value))

  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
    for (const z of zones) $('#digest-tz-list').append(new Option(z))
  } catch {
    // The zone can still be typed.
  }

  $('#btn-digest-save').addEventListener('click', () => void saveDigestSchedule())
  $('#btn-digest-now').addEventListener('click', () => void sendDigestNow())
}

function showScheduleInfo(s: Schedule): void {
  setText('#digest-last-status', lastStatusText(s.lastStatus))
  setText('#digest-schedule-status', nextRunText(s))
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

/** Newest digests from the server, cached so the tab opens offline. */
async function loadDigests(): Promise<void> {
  const store = safeStorage()
  const cached = loadHistory(store, readDigest, HOSTED_CACHE_KEY)
  setListLoading(true)
  try {
    const fresh = await getDigests(DIGEST_FEED_LIMIT)
    // A list that omits the notes must not wipe notes already fetched.
    const known = new Map(cached.map((d) => [d.id, d]))
    const list = fresh.map((d) => (d.notes === undefined && known.get(d.id)?.notes ? { ...d, notes: known.get(d.id)!.notes } : d))
    saveHistory(store, list, HOSTED_CACHE_KEY)
    setDigests(list)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin(describeError(err).message)
    if (cached.length > 0 && digestCount() === 0) setDigests(cached)
    setListError(
      cached.length > 0
        ? 'Could not reach the server. Showing the digests saved on this device.'
        : 'Your digests could not be loaded. Check your connection and try again.',
      () => void loadDigests()
    )
  } finally {
    setListLoading(false)
  }
}

// ─── Digest on demand ────────────────────────────────────────────────────────

let digestPoll: number | undefined
const POLL_DIGEST_EVERY_MS = 15_000
const POLL_DIGEST_FOR_MS = 6 * 60_000

function stopDigestPoll(): void {
  if (digestPoll !== undefined) clearInterval(digestPoll)
  digestPoll = undefined
}

/** After "send now" the digest is made in the background: watch for it to land. */
function watchForNewDigest(): void {
  stopDigestPoll()
  const knownIds = new Set<string>()
  void getDigests(DIGEST_FEED_LIMIT).then(
    (l) => l.forEach((d) => knownIds.add(d.id)),
    () => {}
  )
  const until = Date.now() + POLL_DIGEST_FOR_MS
  digestPoll = window.setInterval(async () => {
    if (Date.now() > until) return stopDigestPoll()
    if (document.visibilityState !== 'visible') return
    try {
      const list = await getDigests(DIGEST_FEED_LIMIT)
      const fresh = list.find((d) => !knownIds.has(d.id))
      if (fresh && knownIds.size > 0) {
        stopDigestPoll()
        saveHistory(safeStorage(), list, HOSTED_CACHE_KEY)
        setDigests(list, { select: fresh.id })
        setMakeStatus('Your digest has arrived.')
      }
    } catch {
      // A blip while waiting is not a failure; keep watching.
    }
  }, POLL_DIGEST_EVERY_MS)
}

/** Ask the server for a digest now. Returns the text to show, or throws one. */
async function requestDigest(): Promise<string> {
  try {
    await digestNow()
  } catch (err) {
    const api = err instanceof ApiError ? err : new ApiError(0, (err as Error).message, 'network')
    const d = describeDigestNowError(api)
    if (d.action === 'login') {
      closeSettingsPanel()
      showLogin(d.message)
      return ''
    }
    if (d.action === 'pay') {
      setEntitlement({ state: 'expired' })
      closeSettingsPanel()
      showPaywall(d.message)
      return ''
    }
    throw new Error(d.message)
  }
  watchForNewDigest()
  return DIGEST_ON_ITS_WAY
}

const hostedBackend: DigestBackend = {
  mode: 'hosted',
  makeLabel: 'Send me a digest now',
  emptyText:
    'Every morning I write a digest of what the people you follow posted, voice it, and send it by Nostr DM. It lands here too. Nothing plays until you press play.',
  async make() {
    setMakeStatus('Asking for a digest…')
    const message = await requestDigest()
    setMakeStatus(message)
  },
  async loadFull(d) {
    return getDigest(d.id)
  },
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
  sync()
}

/** Save the client preference. Returns a problem to show, or null. */
function saveClientPreference(): string | null {
  const preset = $<HTMLSelectElement>('#select-client').value as ReturnType<typeof loadSettings>['clientPreset']
  const custom = $<HTMLInputElement>('#input-client-custom').value.trim()
  const customProfile = $<HTMLInputElement>('#input-client-custom-profile').value.trim()
  if (preset === 'custom') {
    const problem = validateTemplate(custom)
    if (problem) return problem
  }
  saveSettings({ ...loadSettings(), clientPreset: preset, clientCustomUrl: custom, clientCustomProfileUrl: customProfile })
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
  const button = $<HTMLButtonElement>('#btn-digest-now')
  button.disabled = true
  setText('#digest-now-status', 'Asking for a digest…')
  try {
    setText('#digest-now-status', await requestDigest())
  } catch (err) {
    setText('#digest-now-status', (err as Error).message, true)
  } finally {
    button.disabled = false
  }
}
