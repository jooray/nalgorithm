/**
 * Nalgorithm Web — Main application
 *
 * Two-phase flow:
 *   Phase 1 (fast): fetch follows → fetch posts → fetch profiles → score (uncached only) → display
 *   Phase 2 (background): fetch likes → learn preferences → save learned prompt (no re-scoring)
 */

import {
  createFetcher,
  createRanker,
  createLearner,
  pubkeyToHex,
  collectPostPubkeys,
  scoreCacheKey,
  type FetchedPost,
  type ScoredPost,
  type ProfileData,
  type DebugEntry,
} from 'nalgorithm'

import {
  loadSettings,
  saveSettings,
  validateSettings,
  loadScoreCache,
  cacheScores,
  pruneScoreCache,
} from './settings.js'

import { renderFeed, aggregateBoosts, clientRenderOptions } from './render.js'
import { setActorProvider } from './signer.js'

import '@fontsource-variable/inter/wght.css'
import './style.css'

import {
  initUI,
  setStatus,
  setStatusLoading,
  setLearnedPrompt,
  setRefreshEnabled,
  showEmptyState,
  getFeedContainer,
  readFieldsToSettings,
} from './ui.js'

import { initShell } from './shell.js'
import {
  feedVisible,
  hideNewPill,
  scrollY,
  setAgeLabel,
  setBackgroundBusy,
  setQuietNotice,
  showNewPill,
  startLiveChecks,
} from './feed-live.js'
import {
  ageLabel,
  decideMerge,
  freshIds,
  loadLocalSnapshot,
  saveLocalSnapshot,
  shouldAutoRun,
  type LocalSnapshot,
} from './snapshot-logic.js'
import { initDigestView, setDigests, setMakeStatus } from './digest-view.js'
import { byokBackend, loadLocalDigests } from './byok-digest.js'
import { rememberProfiles } from './profiles.js'
import { APP_VERSION } from './version-check.js'
import { deviceStorage as localStorage } from './storage.js'

import { initVersionCheck, setUpdateBlocked } from './version-check.js'

import { resolveMode, switchMode } from './hosted/mode.js'
import { initHosted } from './hosted/app.js'

// ─── App state ───────────────────────────────────────────────────────────────

let isRunning = false
let currentPosts: ScoredPost[] = []
let currentProfiles = new Map<string, ProfileData>()

// The stored feed (see snapshot-logic.ts). `shownAt` is the run behind what is on screen,
// `fetchedAt` the newest run, which is ahead while the "N new notes" pill waits for a tap.
let shownIds: string[] = []
let shownAt: number | null = null
let fetchedAt: number | null = null
let pending: { posts: ScoredPost[]; at: number } | null = null
/** No automatic run before this time (unix seconds) after a failed one. */
let pausedUntil = 0
/** The settings the ranking on screen was made with; a different current value means it is out of date. */
let rankedSig: string | null = null
// The last finished ranking on screen, as folded ids, and the notes it set apart as new.
// A run in progress is drawn against these, so its new notes go on top as they are scored.
let baseKeys: string[] = []
let baseFresh: string[] = []
let shownFresh: string[] = []

const FEED_KEY_PREFIX = 'nalgorithm_byok_feed_'
const nowSec = (): number => Math.floor(Date.now() / 1000)
const sigOf = (s: ReturnType<typeof loadSettings>): string => `${s.npub.trim()}|${s.hoursBack}|${s.userPrompt}`
const keysOf = (posts: ScoredPost[]): string[] => aggregateBoosts(posts).map((p) => p.id)

function feedStore(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

function paintAge(): void {
  setAgeLabel(ageLabel(shownAt, nowSec()))
}

/** Keep the newest ranking on this device, and drop the copies of other identities. */
function saveByokFeed(posts: ScoredPost[], at: number, settings: ReturnType<typeof loadSettings>, fresh: string[]): void {
  const store = feedStore()
  if (!store) return
  try {
    for (let i = store.length - 1; i >= 0; i--) {
      const k = store.key(i)
      if (k?.startsWith(FEED_KEY_PREFIX) && k !== FEED_KEY_PREFIX + settings.npub.trim()) store.removeItem(k)
    }
  } catch {
    // Cleanup is best-effort.
  }
  const snap: LocalSnapshot = {
    v: 1,
    createdAt: at,
    hoursBack: settings.hoursBack,
    sig: sigOf(settings),
    fresh,
    posts: posts as unknown as LocalSnapshot['posts'],
    profiles: Object.fromEntries(currentProfiles),
  }
  saveLocalSnapshot(store, FEED_KEY_PREFIX + settings.npub.trim(), snap, (kept) => new Set(collectPostPubkeys(kept as never, Infinity)))
}

/** Draw the feed this device remembers, before any network call. True when there was one. */
function showStoredFeed(settings: ReturnType<typeof loadSettings>): boolean {
  if (!settings.npub.trim()) return false
  const snap = loadLocalSnapshot(feedStore(), FEED_KEY_PREFIX + settings.npub.trim())
  if (!snap || snap.posts.length === 0) return false
  currentPosts = snap.posts as unknown as ScoredPost[]
  currentProfiles = new Map(Object.entries(snap.profiles).map(([k, v]) => [k, v as ProfileData]))
  rememberProfiles(currentProfiles)
  baseKeys = keysOf(currentPosts)
  baseFresh = Array.isArray(snap.fresh) ? snap.fresh : []
  renderCurrent(settings)
  shownAt = fetchedAt = snap.createdAt
  rankedSig = snap.sig ?? null
  setStatus(`Showing ${aggregateBoosts(currentPosts).length} posts, ranked by relevance`)
  paintAge()
  return true
}

/**
 * Take a finished ranking. It is always remembered; whether it replaces the list on
 * screen depends on whether the reader is in the middle of it.
 */
function applyRanking(posts: ScoredPost[], settings: ReturnType<typeof loadSettings>, manual: boolean): void {
  const at = nowSec()
  fetchedAt = at
  // A new prompt or window is a different feed, not a newer one: nothing to set apart.
  if (rankedSig !== null && rankedSig !== sigOf(settings)) baseKeys = baseFresh = []
  rankedSig = sigOf(settings)
  saveByokFeed(posts, at, settings, freshIds(baseKeys, keysOf(posts), baseFresh))
  const d = decideMerge({ shownIds, incomingIds: posts.map((p) => p.id), scrollY: scrollY(), feedVisible: feedVisible(), manual })
  if (d.action === 'pill') {
    pending = { posts, at }
    showNewPill(d.newCount, () => mergePending(settings))
    return
  }
  if (d.action === 'keep') {
    if (d.same) shownAt = at
    paintAge()
    return
  }
  pending = null
  hideNewPill()
  currentPosts = posts
  renderCurrent(settings)
  commitShown()
  shownAt = at
  paintAge()
  const shown = aggregateBoosts(posts).length
  setStatus(`Showing ${shown} posts, ranked by relevance`)
}

function mergePending(settings: ReturnType<typeof loadSettings>): void {
  if (!pending) return
  const { posts, at } = pending
  pending = null
  currentPosts = posts
  renderCurrent(settings)
  commitShown()
  shownAt = at
  paintAge()
  setStatus(`Showing ${aggregateBoosts(posts).length} posts, ranked by relevance`)
}

/** Open, return to the app, every five minutes: rank quietly when the stored feed is stale. */
function autoCheck(): void {
  const settings = loadSettings()
  if (
    !shouldAutoRun({
      enabled: settings.autoRefresh,
      ready: !validateSettings(settings),
      running: isRunning,
      hidden: document.visibilityState !== 'visible',
      createdAt: fetchedAt,
      nowSec: nowSec(),
      settingsChanged: rankedSig !== null && rankedSig !== sigOf(settings),
      pausedUntil,
    })
  ) {
    return
  }
  void runFeed({ auto: true }).catch((err) => setStatus(`Error: ${(err as Error).message}`))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function logDebug(debug: DebugEntry[]): void {
  if (debug.length === 0) return
  console.group('[Nalgorithm] Scoring debug info')
  for (const entry of debug) {
    const label = `Batch ${entry.batch}: ${entry.scoredCount}/${entry.postCount} scored`
    if (entry.error) {
      console.warn(label, '—', entry.error)
    } else {
      console.log(label)
    }
    if (entry.rawResponse) {
      console.debug('Raw LLM response:', entry.rawResponse.slice(0, 500))
    }
  }
  console.groupEnd()
}

async function scorePosts(
  posts: FetchedPost[],
  userPrompt: string,
  learnedPrompt: string | undefined,
  settings: ReturnType<typeof loadSettings>,
  onProgress?: (scored: number, total: number) => void,
  profiles?: Map<string, ProfileData>,
  /** Receives each batch as it lands, for progressive rendering. */
  onBatch?: (batch: ScoredPost[]) => void
): Promise<ScoredPost[]> {
  const decision = settings.scorer === 'decision'
  const ranker = createRanker({
    concurrency: settings.concurrency,
    apiBaseUrl: settings.apiBaseUrl,
    apiKey: settings.apiKey,
    model: decision ? settings.decisionModel : settings.model,
    scorer: settings.scorer,
    batchSize: settings.batchSize,
  })

  const debug: DebugEntry[] = []
  const scored = await ranker.score(posts, {
    userPrompt,
    learnedPrompt,
    profiles,
    debug,
    onProgress,
    // Persist each batch the moment it lands. If the tab is reloaded or closed
    // mid-run, everything scored so far is already in the cache — which is the
    // whole point of having one.
    onBatchScored: (batch) => {
      const real = batch.filter((p) => !p.defaultScore)
      if (real.length > 0) {
        cacheScores(
          real.map((p) => ({
            id: scoreCacheKey(p),
            score: p.score,
            justification: p.justification,
            ...(decision ? { scorer: 'decision' as const } : {}),
          })), settings
        )
      }
      onBatch?.(batch)
    },
  })

  logDebug(debug)
  return scored
}

/**
 * Render the feed as it currently stands.
 *
 * Called repeatedly while scoring runs, so the user sees ranked posts building
 * up instead of staring at a spinner until the last batch lands.
 */
function renderCurrent(settings: ReturnType<typeof loadSettings>): void {
  shownIds = currentPosts.map((p) => p.id)
  const display = aggregateBoosts(currentPosts)
  shownFresh = freshIds(baseKeys, display.map((p) => p.id), baseFresh)
  showEmptyState(false)
  renderFeed(display, getFeedContainer(), {
    fresh: new Set(shownFresh),
    profiles: currentProfiles,
    ...clientRenderOptions(settings, settings.relays),
    lazyProfileRelays: settings.relays,
  })
}

/** What is on screen is now a finished ranking: the next one is compared with it. */
function commitShown(): void {
  baseKeys = keysOf(currentPosts)
  baseFresh = shownFresh
}

// ─── Main flow ───────────────────────────────────────────────────────────────

async function runFeed(opts: { auto?: boolean } = {}): Promise<void> {
  if (isRunning) return
  const auto = opts.auto === true

  // Read latest settings from form fields and save
  const settings = loadSettings()

  const error = validateSettings(settings)
  if (error) {
    setStatus(`Config error: ${error}`)
    return
  }

  // A run the reader did not ask for, beside a feed they can read: it works in the
  // background and never redraws the list itself (see `applyRanking`).
  const quiet = auto && currentPosts.length > 0
  if (!auto) pausedUntil = 0
  const progress = (text: string): void => {
    if (!quiet) setStatusLoading(text)
  }
  /** A problem: a quiet run leaves the stored feed alone and says so in one line. */
  const report = (text: string): void => {
    if (quiet) {
      pausedUntil = nowSec() + 300
      setQuietNotice(`${text}. Showing your last ranking.`)
    } else {
      setStatus(text)
    }
  }
  let working: ScoredPost[] = []
  const setWorking = (list: ScoredPost[]): void => {
    working = list
    if (!quiet) {
      currentPosts = list
      renderCurrent(settings)
    }
  }

  isRunning = true
  setRefreshEnabled(false)
  setQuietNotice(null)
  if (quiet) setBackgroundBusy('Ranking new posts…')
  if (currentPosts.length === 0) {
    showEmptyState(true, true, 'Loading and ranking your feed. The line above shows progress.')
  }
  // Hold off any pending auto-update until this run finishes — reloading
  // mid-scoring would discard work already paid for.
  setUpdateBlocked(true)

  // Compute the "since" timestamp so both phases use the same window
  const since = Math.floor(Date.now() / 1000) - settings.hoursBack * 3600

  let pubkeyHex: string
  try {
    pubkeyHex = pubkeyToHex(settings.npub)
  } catch {
    setStatus('Invalid npub or pubkey')
    isRunning = false
    setUpdateBlocked(false)
    setBackgroundBusy(null)
    setRefreshEnabled(true)
    return
  }

  // We keep the fetcher alive across both phases so relay connections are reused
  const fetcher = createFetcher({ relays: settings.relays })

  try {
    // ── Phase 1: fetch → score → display ───────────────────────────────

    // 1. Fetch follows
    progress('Fetching follow list...')
    let follows: string[]
    try {
      follows = await fetcher.getFollows(pubkeyHex)
    } catch (err) {
      report(`Failed to fetch follows: ${(err as Error).message}`)
      fetcher.destroy()
      isRunning = false
      setRefreshEnabled(true)
      return
    }

    if (follows.length === 0) {
      report('No follows found for this pubkey')
      fetcher.destroy()
      isRunning = false
      setRefreshEnabled(true)
      return
    }

    progress(`Found ${follows.length} follows. Fetching posts...`)

    // 2. Fetch posts
    let posts: FetchedPost[]
    try {
      posts = await fetcher.getPosts(follows, {
        hoursBack: settings.hoursBack,
      })
    } catch (err) {
      report(`Failed to fetch posts: ${(err as Error).message}`)
      fetcher.destroy()
      isRunning = false
      setRefreshEnabled(true)
      return
    }

    if (posts.length === 0) {
      report('No posts found in the time window')
      if (!quiet) showEmptyState(true, true, `No posts from the people you follow in the last ${settings.hoursBack} hours. Try a longer window in Tune.`)
      fetcher.destroy()
      isRunning = false
      setRefreshEnabled(true)
      return
    }

    // 3. Fetch profiles for all post authors (including embedded + referenced in content)
    progress(`Fetched ${posts.length} posts. Loading profiles...`)
    const allPubkeys = collectPostPubkeys(posts)
    try {
      currentProfiles = await fetcher.getProfiles(allPubkeys)
      rememberProfiles(currentProfiles)
    } catch (err) {
      console.warn('Failed to fetch profiles:', err)
      // Continue without profiles
    }

    // 4. Score posts — use cache for previously scored, LLM only for new ones
    const existingLearnedPrompt = settings.learnFromLikes ? settings.learnedPrompt || undefined : undefined

    // Prune old cache entries (>30 days)
    const pruned = pruneScoreCache()
    if (pruned > 0) console.log(`[Nalgorithm] Pruned ${pruned} old score cache date-keys`)

    const scoreCache = loadScoreCache(settings)
    const cachedPosts: ScoredPost[] = []
    const uncachedPosts: FetchedPost[] = []

    for (const p of posts) {
      // Keyed by the boosted event where there is one, so a boost of something
      // already scored is a cache hit rather than a fresh LLM call.
      const cached = scoreCache.get(scoreCacheKey(p))
      // A score from the other scorer sits on a different scale, so it would
      // mis-rank the feed rather than save a call.
      if (cached && (cached.scorer ?? 'chat') === settings.scorer) {
        cachedPosts.push({ ...p, score: cached.score, justification: cached.justification })
      } else {
        uncachedPosts.push(p)
      }
    }

    console.log(
      `[Nalgorithm] ${cachedPosts.length} cached, ${uncachedPosts.length} need scoring`
    )

    let newlyScored: ScoredPost[] = []

    // Show whatever is already cached before any network call — with a warm
    // cache the feed appears instantly, and new scores slot in as they arrive.
    if (cachedPosts.length > 0) {
      setWorking([...cachedPosts].sort((a, b) => b.score - a.score))
    }

    if (uncachedPosts.length > 0) {
      progress(`Scoring ${uncachedPosts.length} new posts (${cachedPosts.length} cached)...`)
      try {
        newlyScored = await scorePosts(
          uncachedPosts,
          settings.userPrompt,
          existingLearnedPrompt,
          settings,
          (scored, total) =>
            progress(
              `Scoring posts ${scored}/${total} (${cachedPosts.length} cached)...`
            ),
          currentProfiles,
          // Re-render as each batch lands so results appear progressively
          // rather than all at once when the slowest batch finishes.
          (batch) => {
            newlyScored.push(...batch)
            setWorking([...cachedPosts, ...newlyScored].sort((a, b) => b.score - a.score))
          }
        )
      } catch (err) {
        report(`Scoring failed: ${(err as Error).message}`)
        fetcher.destroy()
        isRunning = false
        setRefreshEnabled(true)
        return
      }

      // No cache write here: onBatchScored already persisted every batch as it
      // completed, so by this point the cache is up to date.
    }

    // Merge cached + newly scored, sort by score descending
    const allScored = [...cachedPosts, ...newlyScored].sort((a, b) => b.score - a.score)
    applyRanking(allScored, settings, !auto)

    const shown = aggregateBoosts(allScored).length
    const collapsed = allScored.length - shown
    const cachedLabel = cachedPosts.length > 0 ? ` (${cachedPosts.length} from cache)` : ''
    const boostLabel = collapsed > 0 ? `, ${collapsed} duplicate boosts merged` : ''
    if (!quiet) setStatus(`Showing ${shown} posts, ranked by relevance${cachedLabel}${boostLabel}`)
    setRefreshEnabled(true)

    // ── Phase 2: background likes → re-rate ────────────────────────────

    // Fire and forget — runs in background, doesn't block UI
    if (settings.learnFromLikes) void backgroundLearnAndRerate(fetcher, pubkeyHex, since, settings)
    else fetcher.destroy()
  } catch (err) {
    report(`Error: ${(err as Error).message}`)
    console.error('Feed error:', err)
    fetcher.destroy()
    setRefreshEnabled(true)
  } finally {
    isRunning = false
    setUpdateBlocked(false)
    setBackgroundBusy(null)
  }
}

/**
 * Phase 2: fetch likes from the same timeframe, summarize preferences,
 * and save the updated learned prompt.
 *
 * Runs in the background after the initial render. Does not block UI.
 * Does NOT re-score already-displayed posts — the new prompt only affects future runs.
 */
async function backgroundLearnAndRerate(
  fetcher: ReturnType<typeof createFetcher>,
  pubkeyHex: string,
  since: number,
  settings: ReturnType<typeof loadSettings>
): Promise<void> {
  try {
    // 1. Fetch likes limited to the same time window
    const likes = await fetcher.getLikes(pubkeyHex, {
      limit: 200,
      since,
    })

    fetcher.destroy()

    if (likes.length === 0) {
      console.log('[Nalgorithm] No likes in time window, skipping learn phase')
      return
    }

    console.log(`[Nalgorithm] Found ${likes.length} likes in time window, summarizing...`)

    // 2. Summarize preferences
    const learner = createLearner({
      apiBaseUrl: settings.apiBaseUrl,
      apiKey: settings.apiKey,
      model: settings.learnerModel.trim() || settings.model,
    })

    const newLearnedPrompt = await learner.summarizeLikes(likes)

    if (!newLearnedPrompt) {
      console.log('[Nalgorithm] Learner returned empty prompt')
      return
    }

    // 3. Save the new learned prompt (no re-scoring)
    const freshSettings = loadSettings()
    freshSettings.learnedPrompt = newLearnedPrompt
    saveSettings(freshSettings)
    setLearnedPrompt(newLearnedPrompt)

    console.log('[Nalgorithm] Learned prompt updated (will apply to next refresh)')
  } catch (err) {
    console.warn('[Nalgorithm] Background learn failed:', err)
    // Don't overwrite the main status — user already has their ranked feed
  }
}

// ─── Manual regenerate ───────────────────────────────────────────────────────

async function regenerateLearnedPrompt(): Promise<void> {
  if (isRunning) return

  const settings = loadSettings()

  const error = validateSettings(settings)
  if (error) {
    setStatus(`Config error: ${error}`)
    return
  }

  isRunning = true
  setRefreshEnabled(false)

  try {
    let pubkeyHex: string
    try {
      pubkeyHex = pubkeyToHex(settings.npub)
    } catch {
      setStatus('Invalid npub or pubkey')
      return
    }

    const since = Math.floor(Date.now() / 1000) - settings.hoursBack * 3600

    setStatusLoading('Fetching likes...')
    const fetcher = createFetcher({ relays: settings.relays })

    const likes = await fetcher.getLikes(pubkeyHex, {
      limit: 200,
      since,
    })

    fetcher.destroy()

    if (likes.length === 0) {
      setStatus('No likes found in the time window')
      return
    }

    setStatusLoading(`Found ${likes.length} liked posts. Summarizing preferences...`)

    const learner = createLearner({
      apiBaseUrl: settings.apiBaseUrl,
      apiKey: settings.apiKey,
      model: settings.learnerModel.trim() || settings.model,
    })

    const learnedPrompt = await learner.summarizeLikes(likes)

    if (learnedPrompt) {
      const updated = loadSettings()
      updated.learnedPrompt = learnedPrompt
      saveSettings(updated)
      setLearnedPrompt(learnedPrompt)
      setStatus('Learned prompt updated (will apply to next refresh)')
    } else {
      setStatus('Could not generate learned prompt (LLM error)')
      return
    }
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`)
    console.error('Regenerate error:', err)
  } finally {
    isRunning = false
    setRefreshEnabled(true)
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * The posts a digest is written from: what is on screen, or (when nothing is
 * yet) a fresh feed run first, so "Write a digest" works from a cold start.
 */
async function ensureFeed(): Promise<{ posts: ScoredPost[]; profiles: Map<string, ProfileData> }> {
  const settings = loadSettings()
  const problem = validateSettings(settings)
  if (problem) throw new Error(`${problem}. Open Tune to finish setting up.`)
  if (currentPosts.length === 0) {
    setMakeStatus('Loading your feed first…')
    await runFeed()
  }
  if (currentPosts.length === 0) {
    throw new Error(document.getElementById('status')?.textContent || 'No posts to write from yet.')
  }
  return { posts: currentPosts, profiles: currentProfiles }
}

document.addEventListener('DOMContentLoaded', () => {
  initVersionCheck()
  initShell()
  document.getElementById('app-version')!.textContent = `Version ${APP_VERSION.split('+')[0]}`

  // Exactly one mode's UI is wired up per page load; switching reloads.
  const mode = resolveMode()
  document.body.dataset.mode = mode
  if (mode === 'choose') {
    document.getElementById('btn-choose-hosted')!.addEventListener('click', () => switchMode('hosted'))
    document.getElementById('btn-choose-byok')!.addEventListener('click', () => switchMode('byok'))
    return
  }
  if (mode === 'hosted') {
    initHosted()
    return
  }

  // Whose key note actions sign for: the npub this reader set up.
  setActorProvider(() => {
    const npub = loadSettings().npub.trim()
    return npub ? pubkeyToHex(npub) : null
  })

  document.getElementById('mode-line')!.textContent = 'You are using your own model key. Everything runs in this browser.'
  document.getElementById('btn-switch-hosted')!.addEventListener('click', () => switchMode('hosted'))
  const settings = initUI(runFeed, regenerateLearnedPrompt)

  initDigestView(
    byokBackend({
      ensureFeed,
      readSettings: loadSettings,
      setStatus: setMakeStatus,
    })
  )
  setDigests(loadLocalDigests())

  // The feed from last time is on screen at once; a background run follows when it is stale
  // and the reader allows it (Tune: "Update my feed automatically when I open the app").
  const stored = showStoredFeed(settings)
  const valid = !validateSettings(settings)
  if (!stored && valid && !settings.autoRefresh) showEmptyState(true, true)
  startLiveChecks({ check: autoCheck, tick: paintAge })
  document.addEventListener('nalgorithm:settings-saved', autoCheck)
})
