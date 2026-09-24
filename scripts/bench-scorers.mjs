#!/usr/bin/env node
/**
 * Benchmark the chat scorer against the decision scorer on a real feed.
 *
 *   npm run build:lib
 *   node scripts/bench-scorers.mjs [digest.config.json] [--hours 48] [--out DIR]
 *                                  [--runs 2] [--only chat,pq,ps] [--chat-model M] [--chat-effort low]
 *
 * Fetches the feed once (from the config's npub, relays and hoursBack) and
 * freezes it to DIR/fixture.json, so every scorer sees identical posts; a
 * second invocation with the same --out reuses it. Each scorer runs `--runs`
 * times, because the interesting question is not only "do they agree with
 * each other" but "does either agree with itself".
 *
 * Ground truth, such as it is: the user's likes (kind 7). The feed window
 * holds only a few, so the last `--likes` liked posts are added to the pool
 * and the table reports how well each scorer separates them from the feed
 * (AUC). A like is a weak label (people like friends' GMs, and the learned
 * prompt is itself distilled from likes), but it is the same for both scorers.
 *
 * Output: DIR/<scorer>-<run>.json with every score, and a summary table on
 * stdout. Nothing is written to the digest's score cache.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createFetcher, createRanker, pubkeyToHex, scoreCacheKey } from '../lib/dist/index.js'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const configPath = resolve(argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? './digest.config.json')
const outDir = resolve(flag('--out', './bench-out'))
const runs = Number(flag('--runs', '2'))
const only = flag('--only', 'chat,pq,ps').split(',')
mkdirSync(outDir, { recursive: true })

const interpolate = (v) =>
  typeof v === 'string'
    ? v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, n) => {
        if (process.env[n] === undefined) throw new Error(`env ${n} not set`)
        return process.env[n]
      })
    : Array.isArray(v)
      ? v.map(interpolate)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x)]))
        : v

const config = interpolate(JSON.parse(readFileSync(configPath, 'utf-8')))
const learnedPath = resolve(dirname(configPath), config.learnedPromptCache ?? './digest.learned.json')
let learnedPrompt
try {
  learnedPrompt = JSON.parse(readFileSync(learnedPath, 'utf-8')).prompt
} catch {
  console.warn(`No learned prompt at ${learnedPath}; scoring with the user prompt alone`)
}
const hoursBack = Number(flag('--hours', String(config.hoursBack ?? 24)))
const api = config.rankingApi

// ─── Fixture ─────────────────────────────────────────────────────────────────

const fixturePath = resolve(outDir, 'fixture.json')
let fixture
if (existsSync(fixturePath)) {
  fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))
  console.log(`Reusing fixture: ${fixture.posts.length} posts, ${fixture.likedIds.length} liked`)
} else {
  const fetcher = createFetcher({ relays: config.relays })
  const pubkey = pubkeyToHex(config.npub)
  const follows = await fetcher.getFollows(pubkey)
  const posts = await fetcher.getPosts(follows, { hoursBack, maxPosts: config.maxPosts ?? 500 })
  const since = Math.floor(Date.now() / 1000) - hoursBack * 3600 - 86400
  const likes = await fetcher.getLikes(pubkey, { since, limit: 500 })
  const authors = new Set()
  for (const p of posts) {
    authors.add(p.author)
    if (p.originalPost) authors.add(p.originalPost.author)
    if (p.quotedPost) authors.add(p.quotedPost.author)
  }
  const profiles = await fetcher.getProfiles([...authors])
  fetcher.destroy()
  const likedIds = likes.map((l) => l.id)
  fixture = {
    fetchedAt: new Date().toISOString(),
    hoursBack,
    posts,
    likedIds,
    profiles: [...profiles.entries()],
  }
  writeFileSync(fixturePath, JSON.stringify(fixture))
  console.log(`Fetched ${posts.length} posts from ${follows.length} follows, ${likedIds.length} likes`)
}

// The feed window rarely holds more than a handful of likes, too few to rank
// anything by. So the user's recent likes are also mixed into the pool as
// posts of their own: a scorer that knows the user should put them above the
// ordinary feed. Fetched once and frozen with the rest of the fixture.
if (!fixture.likedPosts) {
  const fetcher = createFetcher({ relays: config.relays })
  const likes = await fetcher.getLikes(pubkeyToHex(config.npub), { limit: Number(flag('--likes', '200')) })
  fetcher.destroy()
  fixture.likedPosts = likes
    .filter((l) => l.content && l.content.trim().length > 0)
    .map((l) => ({ id: l.id, type: 'original', author: l.author, content: l.content, createdAt: 0, rawEvent: null }))
  writeFileSync(fixturePath, JSON.stringify(fixture))
  console.log(`Added ${fixture.likedPosts.length} liked posts to the fixture`)
}
for (const l of fixture.likedPosts) fixture.likedIds.includes(l.id) || fixture.likedIds.push(l.id)

// Score each identity once, as the digest does.
const seen = new Set()
const posts = [...fixture.posts, ...fixture.likedPosts].filter((p) => {
  const k = scoreCacheKey(p)
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
const profiles = new Map(fixture.profiles)
const liked = new Set(fixture.likedIds)
const likedInFeed = posts.filter((p) => liked.has(scoreCacheKey(p)) || liked.has(p.id)).map(scoreCacheKey)
console.log(`${posts.length} distinct posts; ${likedInFeed.length} of them liked by the user`)

// ─── Scorers ─────────────────────────────────────────────────────────────────

const chatModel = flag('--chat-model', api.model)
const chatEffort = flag('--chat-effort', api.reasoningEffort)
const decisionModel = flag('--decision-model', 'jev-latest')
const scorers = {
  chat: {
    label: `chat ${chatModel}${chatEffort ? ` (${chatEffort})` : ''}`,
    config: {
      apiBaseUrl: api.apiBaseUrl,
      apiKey: api.apiKey,
      model: chatModel,
      reasoningEffort: chatEffort,
      batchSize: api.batchSize ?? 20,
      concurrency: api.concurrency ?? 3,
      jsonMode: api.jsonMode ?? false,
    },
  },
  pq: {
    label: `decision ${decisionModel}, profile in question`,
    config: { apiBaseUrl: api.apiBaseUrl, apiKey: api.apiKey, model: decisionModel, scorer: 'decision', decisionShape: 'profile-in-question', batchSize: 20, concurrency: 4 },
  },
  ps: {
    label: `decision ${decisionModel}, profile in state`,
    config: { apiBaseUrl: api.apiBaseUrl, apiKey: api.apiKey, model: decisionModel, scorer: 'decision', decisionShape: 'profile-in-state', batchSize: 20, concurrency: 4 },
  },
}

const results = {}
for (const key of only) {
  const scorer = scorers[key]
  if (!scorer) throw new Error(`unknown scorer ${key}`)
  for (let run = 1; run <= runs; run++) {
    const file = resolve(outDir, `${key}-${run}.json`)
    if (existsSync(file)) {
      results[`${key}-${run}`] = JSON.parse(readFileSync(file, 'utf-8'))
      continue
    }
    const debug = []
    const started = Date.now()
    const scored = await createRanker(scorer.config).score(posts, {
      userPrompt: config.userPrompt,
      learnedPrompt,
      profiles,
      debug,
    })
    const wallMs = Date.now() - started
    let inputTokens = 0
    for (const d of debug) {
      try {
        inputTokens += JSON.parse(d.rawResponse ?? '{}').usage?.input_tokens ?? 0
      } catch {
        // chat responses are not JSON usage blocks
      }
    }
    const out = {
      scorer: key,
      label: scorer.label,
      run,
      wallMs,
      inputTokens,
      defaults: scored.filter((p) => p.defaultScore).length,
      scores: Object.fromEntries(
        scored.map((p) => [scoreCacheKey(p), { score: p.score, justification: p.justification, defaultScore: !!p.defaultScore }])
      ),
    }
    writeFileSync(file, JSON.stringify(out, null, 1))
    results[`${key}-${run}`] = out
    console.log(`${scorer.label} run ${run}: ${(wallMs / 1000).toFixed(1)}s, ${out.defaults} defaults`)
  }
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

const ids = posts.map(scoreCacheKey)
const vec = (r) => ids.map((id) => r.scores[id]?.score ?? NaN)

function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0])
  const r = new Array(xs.length)
  for (let i = 0; i < idx.length; ) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2
    i = j + 1
  }
  return r
}
function spearman(a, b) {
  const ra = ranks(a)
  const rb = ranks(b)
  const n = ra.length
  const ma = ra.reduce((s, x) => s + x, 0) / n
  const mb = rb.reduce((s, x) => s + x, 0) / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb)
    da += (ra[i] - ma) ** 2
    db += (rb[i] - mb) ** 2
  }
  return num / Math.sqrt(da * db)
}
/** The digest's top N, with ties broken by recency exactly as sortByRelevance does. */
function topN(r, n) {
  return posts
    .map((p) => ({ id: scoreCacheKey(p), s: r.scores[scoreCacheKey(p)]?.score ?? 0, t: p.createdAt }))
    .sort((a, b) => b.s - a.s || b.t - a.t)
    .slice(0, n)
    .map((e) => e.id)
}
const jaccard = (a, b) => {
  const A = new Set(a)
  const B = new Set(b)
  const inter = [...A].filter((x) => B.has(x)).length
  return inter / (A.size + B.size - inter)
}
/** Posts tied with the Nth-ranked score: the ones recency, not relevance, decides. */
function tiedAtCutoff(r, n) {
  const sorted = ids.map((id) => r.scores[id]?.score ?? 0).sort((a, b) => b - a)
  const cut = sorted[n - 1]
  return sorted.filter((s) => s === cut).length
}
/** P(a liked post outscores an unliked one); ties count half. */
function likedAuc(r) {
  const likedSet = new Set(likedInFeed)
  const pos = ids.filter((id) => likedSet.has(id)).map((id) => r.scores[id].score)
  const neg = ids.filter((id) => !likedSet.has(id)).map((id) => r.scores[id].score)
  let wins = 0
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0
  return wins / (pos.length * neg.length)
}
const likedInTop = (r, n) => topN(r, n).filter((id) => likedInFeed.includes(id)).length

const N = config.topN ?? 15
const rows = []
for (const key of only) {
  const rs = Array.from({ length: runs }, (_, i) => results[`${key}-${i + 1}`]).filter(Boolean)
  const r1 = rs[0]
  const v = vec(r1)
  rows.push({
    scorer: r1.label,
    'p50 wall s': (rs.map((r) => r.wallMs).sort((a, b) => a - b)[Math.floor(rs.length / 2)] / 1000).toFixed(1),
    defaults: rs.map((r) => r.defaults).join('/'),
    'distinct values': new Set(v).size,
    [`ties at #${N}`]: rs.map((r) => tiedAtCutoff(r, N)).join('/'),
    'self ρ': rs.length > 1 ? spearman(vec(rs[0]), vec(rs[1])).toFixed(3) : '-',
    [`self top${N} J`]: rs.length > 1 ? jaccard(topN(rs[0], N), topN(rs[1], N)).toFixed(2) : '-',
    'mean |Δ| run2': rs.length > 1 ? (ids.reduce((s, id) => s + Math.abs(rs[0].scores[id].score - rs[1].scores[id].score), 0) / ids.length).toFixed(2) : '-',
    'liked AUC': rs.map((r) => likedAuc(r).toFixed(3)).join('/'),
    'liked in top100': rs.map((r) => likedInTop(r, 100)).join('/'),
    'input tok': r1.inputTokens || '-',
  })
}
console.log(`\n${posts.length} posts, ${likedInFeed.length} liked, top N = ${N}\n`)
console.table(rows)

const cross = []
for (let i = 0; i < only.length; i++) {
  for (let j = i + 1; j < only.length; j++) {
    const a = results[`${only[i]}-1`]
    const b = results[`${only[j]}-1`]
    cross.push({ a: a.label, b: b.label, 'ρ': spearman(vec(a), vec(b)).toFixed(3), [`top${N} J`]: jaccard(topN(a, N), topN(b, N)).toFixed(2) })
  }
}
console.table(cross)
writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify({ rows, cross }, null, 1))
