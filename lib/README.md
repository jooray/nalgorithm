# Nalgorithm

Nostr relevance library. Fetches posts from your follows and ranks them by personal relevance using an LLM, instead of sorting by time.

## How it works

1. You provide your npub (Nostr public key) and a text prompt describing what you care about
2. The library fetches your follow list, then fetches posts from those follows
3. Posts are classified: original notes, quote posts, boosts. Replies are filtered out.
4. Your Nostr likes (kind 7 reactions) are fetched and summarized by the LLM into a "learned prompt"
5. Posts are scored 0-10 for relevance using your user prompt + learned prompt
6. Results come back sorted by relevance

## Install

```bash
npm install nalgorithm
```

## Quick start

```typescript
import { createFetcher, createRanker, createLearner, sortByRelevance } from 'nalgorithm'

const relays = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol']

const apiConfig = {
  apiBaseUrl: 'https://api.venice.ai/api/v1',
  apiKey: 'your-api-key',
  model: 'grok-3-mini',
}

// 1. Fetch
const fetcher = createFetcher({ relays })
const follows = await fetcher.getFollows('npub1...')
const posts = await fetcher.getPosts(follows, { hoursBack: 24 })
const likes = await fetcher.getLikes('npub1...', { limit: 200 })
fetcher.destroy()

// 2. Learn
const learner = createLearner(apiConfig)
const learnedPrompt = await learner.summarizeLikes(likes)

// 3. Rank
const ranker = createRanker({ ...apiConfig, batchSize: 20 })
const scored = await ranker.score(posts, {
  userPrompt: 'I like cypherpunk culture, Bitcoin, and decentralized tech.',
  learnedPrompt,
})

// scored is already sorted by relevance
console.log(scored[0].score, scored[0].content)
```

## Three modules

### Fetcher

Connects to Nostr relays and retrieves events. No scoring logic.

- `getFollows(pubkey)` -- get the follow list (kind 3)
- `getPosts(follows, options)` -- fetch posts from followed users (kind 1 + kind 6), filter out replies, resolve embedded posts for quotes and boosts
- `getLikes(pubkey, options)` -- fetch the user's likes (kind 7) and resolve the liked post content
- `destroy()` -- close relay connections

### Ranker

Scores posts using an LLM. Sends posts in batches, validates the JSON response.

- `score(posts, options)` -- score an array of posts, returns `ScoredPost[]` sorted by relevance
- `sortByRelevance(posts)` -- standalone sort function (exported separately)

### Learner

Fetches a user's likes and summarizes what they tend to engage with.

- `summarizeLikes(likedPosts)` -- takes liked post content, returns a 2-4 sentence summary

## Configuration

All three modules accept an OpenAI-compatible API configuration:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `apiBaseUrl` | API endpoint URL | `https://api.venice.ai/api/v1` |
| `apiKey` | API key | (required) |
| `model` | Model name | `grok-3-mini` |
| `batchSize` | Posts per LLM call (ranker only) | `20` |
| `relays` | Nostr relay URLs (fetcher only) | (required) |

Works with any OpenAI-compatible endpoint: Venice AI, OpenRouter, Ollama, etc.

## Post types

The library handles three types of posts:

| Type | Nostr kind | What it is | How it's scored |
|------|------------|------------|-----------------|
| `original` | 1 | Text note (not a reply) | Scored on its content |
| `quote` | 1 (with `nostr:` ref) | Commentary + embedded post | Scored on both the commentary and the embedded post |
| `boost` | 6 | Repost by a follow | Original post is resolved and scored on its content |

Replies (kind 1 events with `root`/`reply` tags) are filtered out since they lack standalone context.

## Prompt injection defense

LLM responses are validated against a strict schema:

1. Must be valid JSON
2. Must be an array of `[post_id, score]` pairs
3. Each post ID must exist in the input batch
4. Each score must be a number between 0 and 10
5. On validation failure: retry once, then fall back to default score (5)

## Types

See [docs/API.md](docs/API.md) for the full type reference.

Key types:

```typescript
interface FetchedPost {
  id: string               // event ID (hex)
  type: 'original' | 'quote' | 'boost'
  author: string           // pubkey (hex)
  content: string          // text content
  createdAt: number        // unix timestamp
  quotedPost?: EmbeddedPost    // for quotes
  originalPost?: EmbeddedPost  // for boosts
  rawEvent: NostrEvent
}

interface ScoredPost extends FetchedPost {
  score: number  // 0-10 relevance
}

interface LikedPostContent {
  id: string
  content: string
  author: string
}
```

## License

MIT
