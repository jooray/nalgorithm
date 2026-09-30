/**
 * Nalgorithm Digest — Main CLI script
 *
 * Fetches posts from a user's follows, ranks them by relevance,
 * then generates a spoken-word radio-show-style digest using an LLM.
 *
 * Usage:
 *   node dist/main.js [path/to/config.json]
 *
 * Output goes to stdout so you can pipe it wherever you like.
 */

import {
  createFetcher,
  createRanker,
  refreshLearnedPrompt,
  scorePostsCached,
  writeDigest,
  HUMANIZER_SKILL_VERSION,
  synthesizeSpeech,
  pubkeyToHex,
  sortByRelevance,
} from 'nalgorithm'
import type { DebugEntry, LLMConfig, PipelineLogger } from 'nalgorithm'

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { loadConfig, parseArgs } from './config.js'
import { createJsonStore } from './json-store.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[digest] ${msg}\n`)
}

const logger: PipelineLogger = {
  info: log,
  warn: (msg) => log(`Warning: ${msg}`),
}

// ─── TTS output ──────────────────────────────────────────────────────────────

/**
 * Expand strftime-style tokens in an output path so repeated runs do not
 * overwrite each other.
 */
function expandPathTokens(path: string, now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const tokens: Record<string, string> = {
    '%Y': String(now.getFullYear()),
    '%m': pad(now.getMonth() + 1),
    '%d': pad(now.getDate()),
    '%H': pad(now.getHours()),
    '%M': pad(now.getMinutes()),
    '%S': pad(now.getSeconds()),
  }
  return path.replace(/%[YmdHMS]/g, (t) => tokens[t] ?? t)
}

/**
 * Resolve where the audio should be written, or null if TTS was not requested.
 * An explicit `--tts <path>` wins over the configured `ttsOutputPath`.
 */
function resolveTtsTarget(flag: string | boolean, configured?: string): string | null {
  if (flag === false) return null
  const target = typeof flag === 'string' ? flag : configured
  if (!target) {
    throw new Error(
      '--tts was passed without a path and no "ttsOutputPath" is set in the config. ' +
        'Either give the flag a path (--tts digest.mp3) or add "ttsOutputPath".'
    )
  }
  return resolve(expandPathTokens(target))
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs()
  const scoreOnly = args.scoreOnly
  const config = loadConfig()

  // Resolve the audio target up front: a misconfigured path should fail now,
  // not after a full fetch/score/generate cycle has been paid for.
  const ttsTarget = scoreOnly ? null : resolveTtsTarget(args.tts, config.ttsOutputPath)
  if (ttsTarget && !config.ttsApi) {
    throw new Error('TTS output was requested but no "ttsApi" block is configured.')
  }

  const pubkeyHex = pubkeyToHex(config.npub)
  log(`Pubkey: ${pubkeyHex.slice(0, 12)}...`)

  // Create library instances
  const fetcher = createFetcher({ relays: config.relays })
  const ranker = createRanker({
    apiBaseUrl: config.rankingApi.apiBaseUrl,
    apiKey: config.rankingApi.apiKey,
    model: config.rankingApi.model,
    reasoningEffort: config.rankingApi.reasoningEffort,
    batchSize: config.rankingApi.batchSize,
    concurrency: config.rankingApi.concurrency,
    jsonMode: config.rankingApi.jsonMode,
    scorer: config.rankingApi.scorer,
    decisionShape: config.rankingApi.decisionShape,
    requestsPerMinute: config.rankingApi.requestsPerMinute,
  })

  try {
    // 1. Get follows
    log('Fetching follow list...')
    const follows = await fetcher.getFollows(pubkeyHex)
    log(`Found ${follows.length} follows`)

    if (follows.length === 0) {
      throw new Error('No follows found for this pubkey. Check the npub in your config.')
    }

    // 2. Fetch posts
    log(`Fetching posts from the last ${config.hoursBack} hours...`)
    const posts = await fetcher.getPosts(follows, {
      hoursBack: config.hoursBack,
      maxPosts: config.maxPosts ?? 500,
    })
    log(`Fetched ${posts.length} posts`)

    if (posts.length === 0) {
      throw new Error('No posts found in the specified time range.')
    }

    // 3. Fetch profiles for author names
    const authorPubkeys = [...new Set(posts.map((p) => p.author))]
    log(`Fetching profiles for ${authorPubkeys.length} authors...`)
    const profiles = await fetcher.getProfiles(authorPubkeys)
    log(`Resolved ${profiles.size} profiles`)

    // Persistence: the CLI keeps JSON files, a hosted service would not.
    // Scores are deterministic, so old ones are kept for up to 90 days by default.
    const store = createJsonStore({
      learnedPath: resolve(config.learnedPromptCache ?? './digest.learned.json'),
      scoresPath: resolve(config.scoreCachePath ?? './digest.scores.json'),
      maxScoreAgeSeconds: (config.scoreCacheTTLDays ?? 90) * 86400,
      log: logger,
    })

    // 4. Evolve learned prompt from likes
    let learnedPrompt: string | undefined
    if (config.learnFromLikes) {
      const learnerCfg = config.learnerApi ?? config.rankingApi
      const llm: LLMConfig = {
        apiBaseUrl: learnerCfg.apiBaseUrl,
        apiKey: learnerCfg.apiKey,
        model: learnerCfg.model,
        reasoningEffort: learnerCfg.reasoningEffort,
      }
      learnedPrompt = await refreshLearnedPrompt({
        fetcher,
        store,
        llm,
        pubkeyHex,
        log: logger,
        batchSize: config.likesBatchSize ?? 50,
      })
    }

    // 5. Score posts (cached scores are reused, new ones are stored as they land)
    const debug: DebugEntry[] = []
    const allScoredPosts = await scorePostsCached(
      { ranker, store, scorer: config.rankingApi.scorer ?? 'chat', log: logger },
      posts,
      {
        userPrompt: config.userPrompt,
        learnedPrompt,
        profiles,
        debug,
        modelLabel: config.rankingApi.model,
      },
    )

    if (scoreOnly) {
      log(`Score-only mode: scored ${allScoredPosts.length} posts. Done.`)
      return
    }

    // 6. Take top N
    const topN = config.topN ?? 15
    const topPosts = sortByRelevance(allScoredPosts).slice(0, topN)
    log(`Top ${topPosts.length} posts selected (scores: ${topPosts[0]?.score ?? 0} to ${topPosts[topPosts.length - 1]?.score ?? 0})`)

    // 7-9. Write the digest (with fallback), then the humanizer pass.
    // The humanizer runs before stdout so what is published is what was
    // edited; on any failure it returns the original, so it cannot cost a digest.
    const model = (api: { apiBaseUrl: string; apiKey: string; model: string; reasoningEffort?: LLMConfig['reasoningEffort']; temperature?: number }) => ({
      llm: {
        apiBaseUrl: api.apiBaseUrl,
        apiKey: api.apiKey,
        model: api.model,
        reasoningEffort: api.reasoningEffort,
      },
      temperature: api.temperature,
    })
    if (config.humanizerApi && !args.noHumanize) log(`Humanizer ${HUMANIZER_SKILL_VERSION}`)
    const digest = await writeDigest({
      primary: model(config.digestApi),
      fallback: config.digestFallbackApi ? model(config.digestFallbackApi) : undefined,
      humanizer: config.humanizerApi && !args.noHumanize ? model(config.humanizerApi) : undefined,
      digest: {
        posts: topPosts,
        profiles,
        userPrompt: config.userPrompt,
        learnedPrompt,
        systemPrompt: config.digestSystemPrompt,
        digestPrompt: config.digestPrompt,
        topN,
      },
      log: logger,
    })

    // 10. Output to stdout
    process.stdout.write(digest)
    process.stdout.write('\n')

    // 11. Optionally synthesize the digest to audio.
    // Deliberately after stdout: the text is the primary product, so a TTS
    // failure must not cost you the digest you already paid to generate.
    if (ttsTarget && config.ttsApi) {
      log(`Synthesizing speech with ${config.ttsApi.model} → ${ttsTarget}`)
      const audio = await synthesizeSpeech(config.ttsApi, digest, {
        onProgress: (chunk, total) => {
          if (total > 1) log(`  TTS chunk ${chunk}/${total}`)
        },
      })
      mkdirSync(dirname(ttsTarget), { recursive: true })
      writeFileSync(ttsTarget, audio)
      log(`Wrote ${(audio.length / 1024).toFixed(0)} KB of audio to ${ttsTarget}`)
    }

    log('Done!')
  } finally {
    fetcher.destroy()
  }
}

main().catch((err) => {
  process.stderr.write(`\n[digest] Fatal error: ${(err as Error).message}\n`)
  process.exit(1)
})
