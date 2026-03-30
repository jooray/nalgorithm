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
  type FetchedPost,
  type ScoredPost,
  type ProfileData,
  type DebugEntry,
} from 'nalgorithm'

import * as nip19 from 'nostr-tools/nip19'

import {
  loadSettings,
  saveSettings,
  validateSettings,
  loadScoreCache,
  cacheScores,
  pruneScoreCache,
} from './settings.js'

import { renderFeed } from './render.js'

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

// ─── App state ───────────────────────────────────────────────────────────────

let isRunning = false
let currentPosts: ScoredPost[] = []
let currentProfiles = new Map<string, ProfileData>()

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract hex pubkeys from nostr:npub1.../nostr:nprofile1... references in text.
 */
function extractReferencedPubkeys(content: string, out: Set<string>): void {
  const matches = content.matchAll(/nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+)/gi)
  for (const m of matches) {
    try {
      const decoded = nip19.decode(m[1])
      if (decoded.type === 'npub') out.add(decoded.data as string)
      if (decoded.type === 'nprofile') out.add((decoded.data as { pubkey: string }).pubkey)
    } catch {
      // Ignore decode failures
    }
  }
}

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
  profiles?: Map<string, ProfileData>
): Promise<ScoredPost[]> {
  const ranker = createRanker({
    apiBaseUrl: settings.apiBaseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    batchSize: settings.batchSize,
  })

  const debug: DebugEntry[] = []
  const scored = await ranker.score(posts, {
    userPrompt,
    learnedPrompt,
    profiles,
    debug,
    onProgress,
  })

  logDebug(debug)
  return scored
}

// ─── Main flow ───────────────────────────────────────────────────────────────

async function runFeed(): Promise<void> {
  if (isRunning) return

  // Read latest settings from form fields and save
  const settings = readFieldsToSettings()
  saveSettings(settings)

  const error = validateSettings(settings)
  if (error) {
    setStatus(`Config error: ${error}`)
    return
  }

  isRunning = true
  setRefreshEnabled(false)

  // Compute the "since" timestamp so both phases use the same window
  const since = Math.floor(Date.now() / 1000) - settings.hoursBack * 3600

  let pubkeyHex: string
  try {
    pubkeyHex = pubkeyToHex(settings.npub)
  } catch {
    setStatus('Invalid npub or pubkey')
    isRunning = false
    setRefreshEnabled(true)
    return
  }

  // We keep the fetcher alive across both phases so relay connections are reused
  const fetcher = createFetcher({ relays: settings.relays })

  try {
    // ── Phase 1: fetch → score → display ───────────────────────────────

    // 1. Fetch follows
    setStatusLoading('Fetching follow list...')
    let follows: string[]
    try {
      follows = await fetcher.getFollows(pubkeyHex)
    } catch (err) {
      setStatus(`Failed to fetch follows: ${(err as Error).message}`)
      fetcher.destroy()
      isRunning = false
      setRefreshEnabled(true)
      return
    }

    if (follows.length === 0) {
      setStatus('No follows found for this pubkey')
      fetcher.destroy()
      isRunning = false
      setRefreshEnabled(true)
      return
    }

    setStatusLoading(`Found ${follows.length} follows. Fetching posts...`)

    // 2. Fetch posts
    let posts: FetchedPost[]
    try {
      posts = await fetcher.getPosts(follows, {
        hoursBack: settings.hoursBack,
      })
    } catch (err) {
      setStatus(`Failed to fetch posts: ${(err as Error).message}`)
      fetcher.destroy()
      isRunning = false
      setRefreshEnabled(true)
      return
    }

    if (posts.length === 0) {
      setStatus('No posts found in the time window')
      showEmptyState(true)
      fetcher.destroy()
      isRunning = false
      setRefreshEnabled(true)
      return
    }

    // 3. Fetch profiles for all post authors (including embedded + referenced in content)
    setStatusLoading(`Fetched ${posts.length} posts. Loading profiles...`)
    const allPubkeys = new Set<string>()
    for (const p of posts) {
      allPubkeys.add(p.author)
      if (p.originalPost) allPubkeys.add(p.originalPost.author)
      if (p.quotedPost) allPubkeys.add(p.quotedPost.author)
      // Extract pubkeys from nostr:npub/nprofile references in content
      extractReferencedPubkeys(p.content, allPubkeys)
      if (p.originalPost) extractReferencedPubkeys(p.originalPost.content, allPubkeys)
      if (p.quotedPost) extractReferencedPubkeys(p.quotedPost.content, allPubkeys)
    }
    try {
      currentProfiles = await fetcher.getProfiles([...allPubkeys])
    } catch (err) {
      console.warn('Failed to fetch profiles:', err)
      // Continue without profiles
    }

    // 4. Score posts — use cache for previously scored, LLM only for new ones
    const existingLearnedPrompt = settings.learnedPrompt || undefined

    // Prune old cache entries (>30 days)
    const pruned = pruneScoreCache()
    if (pruned > 0) console.log(`[Nalgorithm] Pruned ${pruned} old score cache date-keys`)

    const scoreCache = loadScoreCache()
    const cachedPosts: ScoredPost[] = []
    const uncachedPosts: FetchedPost[] = []

    for (const p of posts) {
      const cached = scoreCache.get(p.id)
      if (cached) {
        cachedPosts.push({ ...p, score: cached.score, justification: cached.justification })
      } else {
        uncachedPosts.push(p)
      }
    }

    console.log(
      `[Nalgorithm] ${cachedPosts.length} cached, ${uncachedPosts.length} need scoring`
    )

    let newlyScored: ScoredPost[] = []

    if (uncachedPosts.length > 0) {
      setStatusLoading(`Scoring ${uncachedPosts.length} new posts (${cachedPosts.length} cached)...`)
      try {
        newlyScored = await scorePosts(
          uncachedPosts,
          settings.userPrompt,
          existingLearnedPrompt,
          settings,
          (scored, total) =>
            setStatusLoading(
              `Scoring posts ${scored}/${total} (${cachedPosts.length} cached)...`
            ),
          currentProfiles
        )
      } catch (err) {
        setStatus(`Scoring failed: ${(err as Error).message}`)
        fetcher.destroy()
        isRunning = false
        setRefreshEnabled(true)
        return
      }

      // Save newly scored posts to cache (skip default/fallback scores)
      const realScores = newlyScored.filter((p) => !p.defaultScore)
      if (realScores.length > 0) {
        cacheScores(realScores.map((p) => ({ id: p.id, score: p.score, justification: p.justification })))
      }
    }

    // Merge cached + newly scored, sort by score descending
    const allScored = [...cachedPosts, ...newlyScored].sort((a, b) => b.score - a.score)
    currentPosts = allScored

    // 5. Render immediately — user sees ranked results now
    showEmptyState(false)
    renderFeed(allScored, getFeedContainer(), {
      profiles: currentProfiles,
      njumpBaseUrl: settings.njumpBaseUrl,
    })

    const cachedLabel = cachedPosts.length > 0 ? ` (${cachedPosts.length} from cache)` : ''
    setStatus(`Showing ${allScored.length} posts, ranked by relevance${cachedLabel}`)
    setRefreshEnabled(true)

    // ── Phase 2: background likes → re-rate ────────────────────────────

    // Fire and forget — runs in background, doesn't block UI
    backgroundLearnAndRerate(fetcher, pubkeyHex, since, settings)
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`)
    console.error('Feed error:', err)
    fetcher.destroy()
    setRefreshEnabled(true)
  } finally {
    isRunning = false
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
      model: settings.model,
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

  const settings = readFieldsToSettings()
  saveSettings(settings)

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
      model: settings.model,
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

document.addEventListener('DOMContentLoaded', () => {
  initUI(runFeed, regenerateLearnedPrompt)
})
