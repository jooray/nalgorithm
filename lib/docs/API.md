# Nalgorithm API Reference

Full type and function reference for the `nalgorithm` library.

## Exports

```typescript
// Factory functions
createFetcher(config: FetcherConfig): Fetcher
createRanker(config: RankerConfig): Ranker
createLearner(config: LearnerConfig): Learner

// Utility
sortByRelevance(posts: ScoredPost[]): ScoredPost[]
pubkeyToHex(input: string): string
chatCompletion(config: LLMConfig, messages: ChatMessage[], jsonMode?: boolean): Promise<string>
chatCompletionWithRetry(config: LLMConfig, messages: ChatMessage[], jsonMode?: boolean): Promise<string>
```

---

## `createFetcher(config)`

Creates a Fetcher instance for connecting to Nostr relays.

### Config

```typescript
interface FetcherConfig {
  relays: string[]  // Relay WebSocket URLs
}
```

### Returns: `Fetcher`

```typescript
interface Fetcher {
  getFollows(pubkey: string): Promise<string[]>
  getPosts(follows: string[], options?: FetchPostsOptions): Promise<FetchedPost[]>
  getLikes(pubkey: string, options?: FetchLikesOptions): Promise<LikedPostContent[]>
  destroy(): void
}
```

### `fetcher.getFollows(pubkey)`

Fetches the follow list (kind 3 event) for a given pubkey.

- **pubkey**: hex pubkey or npub string
- **Returns**: Array of hex pubkeys the user follows

### `fetcher.getPosts(follows, options?)`

Fetches posts from followed users within a time window.

- **follows**: Array of hex pubkeys
- **options.hoursBack**: How far back to fetch (default: `24`)
- **options.maxPosts**: Maximum posts to return (default: `500`)
- **Returns**: Array of `FetchedPost` objects, sorted by time descending

What this does:
1. Fetches kind 1 (text notes) and kind 6 (reposts) from all followed pubkeys
2. Filters out replies (kind 1 events with `root`/`reply` e-tags)
3. Classifies remaining events as `original`, `quote`, or `boost`
4. Resolves embedded/original posts for quotes and boosts by fetching them from relays

### `fetcher.getLikes(pubkey, options?)`

Fetches the user's recent likes and resolves the liked posts' content.

- **pubkey**: hex pubkey or npub string
- **options.limit**: Maximum likes to fetch (default: `200`)
- **Returns**: Array of `LikedPostContent` objects (only kind 1 posts with actual content)

### `fetcher.destroy()`

Closes all relay connections. Call this when done fetching.

---

## `createRanker(config)`

Creates a Ranker instance for scoring posts via an LLM.

### Config

```typescript
interface RankerConfig {
  apiBaseUrl: string   // OpenAI-compatible API endpoint
  apiKey: string       // API key
  model: string        // Model name
  batchSize?: number   // Posts per LLM call (default: 20)
}
```

### Returns: `Ranker`

```typescript
interface Ranker {
  score(posts: FetchedPost[], options: ScoreOptions): Promise<ScoredPost[]>
}
```

### `ranker.score(posts, options)`

Scores an array of posts for relevance using the LLM.

- **posts**: Array of `FetchedPost` objects from the Fetcher
- **options.userPrompt**: User-supplied prompt describing their interests (required)
- **options.learnedPrompt**: Auto-generated prompt from likes (optional)
- **Returns**: Array of `ScoredPost` objects, sorted by relevance (highest first)

How scoring works:
1. Posts are split into batches (default: 20 per batch)
2. Each batch is sent to the LLM with the user prompt and learned prompt as context
3. The LLM returns `[[post_id, score], ...]` JSON
4. Response is validated: must be valid JSON, correct schema, known post IDs, scores 0-10
5. On validation failure: retry once, then assign default score of 5
6. Results are sorted by score descending, with creation time as tiebreaker

---

## `createLearner(config)`

Creates a Learner instance for generating the learned preference prompt.

### Config

```typescript
interface LearnerConfig {
  apiBaseUrl: string
  apiKey: string
  model: string
}
```

### Returns: `Learner`

```typescript
interface Learner {
  summarizeLikes(likedPosts: LikedPostContent[]): Promise<string>
}
```

### `learner.summarizeLikes(likedPosts)`

Analyzes liked post content and generates a summary of user preferences.

- **likedPosts**: Array of `LikedPostContent` objects from the Fetcher
- **Returns**: A 2-4 sentence summary string (the "learned prompt"), or empty string if no likes or LLM fails

Uses at most 100 liked posts to avoid exceeding LLM context limits.

---

## `sortByRelevance(posts)`

Standalone sort function. Sorts scored posts by relevance score (descending), then by creation time (descending) as tiebreaker.

```typescript
function sortByRelevance(posts: ScoredPost[]): ScoredPost[]
```

Returns a new sorted array (does not mutate the input).

---

## `pubkeyToHex(input)`

Converts an npub or nprofile string to a hex pubkey. Passes through 64-character hex strings unchanged.

```typescript
function pubkeyToHex(input: string): string
```

Throws an `Error` if the input is not a valid npub, nprofile, or hex pubkey.

---

## `chatCompletion(config, messages, jsonMode?)`

Low-level function to call an OpenAI-compatible chat completions endpoint.

```typescript
function chatCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
  jsonMode?: boolean
): Promise<string>
```

- **config**: `{ apiBaseUrl, apiKey, model }`
- **messages**: Array of `{ role: 'system' | 'user' | 'assistant', content: string }`
- **jsonMode**: If `true`, requests JSON response format (default: `false`)
- **Returns**: The assistant's response content string
- **Throws**: On HTTP errors or empty responses

## `chatCompletionWithRetry(config, messages, jsonMode?)`

Same as `chatCompletion` but retries once on failure.

---

## Types

### `FetchedPost`

```typescript
interface FetchedPost {
  id: string                  // Event ID (hex)
  type: 'original' | 'quote' | 'boost'
  author: string              // Pubkey of the follow (hex)
  content: string             // Text content
  createdAt: number           // Unix timestamp (seconds)
  quotedPost?: EmbeddedPost   // For quote posts
  originalPost?: EmbeddedPost // For boosts
  rawEvent: NostrEvent        // The raw Nostr event
}
```

### `ScoredPost`

```typescript
interface ScoredPost extends FetchedPost {
  score: number  // 0-10 relevance score
}
```

### `EmbeddedPost`

```typescript
interface EmbeddedPost {
  id: string       // Event ID (hex)
  author: string   // Author pubkey (hex)
  content: string  // Text content
}
```

### `LikedPostContent`

```typescript
interface LikedPostContent {
  id: string       // Event ID of the liked post
  content: string  // Text content
  author: string   // Author pubkey
}
```

### `NalgorithmConfig`

Full configuration combining all modules:

```typescript
interface NalgorithmConfig {
  relays: string[]
  apiBaseUrl: string
  apiKey: string
  model: string
  batchSize?: number  // default: 20
}
```

### `ChatMessage`

```typescript
interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
```

### `PostType`

```typescript
type PostType = 'original' | 'quote' | 'boost'
```
