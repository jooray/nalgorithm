# Nalgorithm — Nostr Relevance Library

## What It Does

A JavaScript/TypeScript library that takes a user's npub, fetches posts from their follows, and ranks them by personal relevance using an LLM instead of sorting by time. The user provides a text prompt describing what they care about ("I like cypherpunk, decentralized tech, cats"). The library also learns from the user's Nostr likes (kind 7) to build a secondary "learned prompt" that evolves over time.

The library does NOT implement a Nostr client. It is a scoring/ranking engine that a client consumes.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              Consumer (Web UI / CLI / Bot)            │
│  Calls library functions, displays results           │
├──────────────────────────────────────────────────────┤
│              Nalgorithm Library                       │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │   Fetcher    │  │   Ranker     │  │  Learner   │  │
│  │             │  │              │  │            │  │
│  │ - follows   │  │ - LLM calls  │  │ - fetch    │  │
│  │ - posts     │  │ - scoring    │  │   likes    │  │
│  │ - boosts    │  │ - sorting    │  │ - summarize│  │
│  │ - quotes    │  │ - JSON valid │  │ - update   │  │
│  │ - likes     │  │              │  │   prompt   │  │
│  └─────────────┘  └──────────────┘  └────────────┘  │
└──────────────────────────────────────────────────────┘
```

Three distinct modules:
1. **Fetcher** — Connects to relays, retrieves events. No scoring logic.
2. **Ranker** — Takes fetched events + prompts, calls LLM, returns scored + sorted results.
3. **Learner** — Fetches user's likes, resolves liked content, asks LLM to summarize patterns, produces the learned prompt.

## Core Flow

```
1. User provides: npub + user prompt + API config + relays
2. Fetcher: get follow list (kind 3) for npub
3. Fetcher: get posts from follows for time window (default 24h)
   - kind 1 (text notes) — original posts only (no replies)
   - kind 6 (reposts/boosts) — resolve original post from tags
   - kind 1 with embedded nostr: references (quote posts) — resolve embedded post
4. Learner: fetch user's likes (kind 7), resolve liked posts, summarize via LLM
5. Ranker: combine user prompt + learned prompt, score all posts via LLM
6. Ranker: return sorted results (highest relevance first, time as tiebreaker)
```

## Event Types and How They Are Handled

### Original Posts (kind 1, no reply tags)

Standard text notes. Sent to LLM as-is for scoring.

Example — a kind 1 post:
```json
{
  "kind": 1,
  "id": "f863d3ec774704bd2407fbee7291cddee68d3d7f2ef0432e7084ad0ec37df3f8",
  "pubkey": "a1b4ff418c3cb7f6cb4a8ea5442f2e7b7973e33c352b6013902b87f6277ff6a5",
  "content": "Tamers of Entropy is a lunarpunk novel about consciousness and what happens when it outgrows its biological container. It's a meditation on freedom — from surveillance, from jurisdiction, from the limits of carbon-based intelligence, and finally from the physics of the universe itself...",
  "tags": [
    ["imeta", "url https://blossom.primal.net/...mp4", "m video/mp4", "dim 1080x1080"],
    ["client", "Primal Web"]
  ]
}
```

This is a straightforward original post. It has no `e` tags with `root` or `reply` markers. It gets scored directly on its content.

### Quote Posts (kind 1 with embedded `nostr:` references)

A follow writes commentary and embeds another post. The `content` field contains `nostr:nevent1...` references. The embedded post is referenced in an `e` tag with `"mention"` marker.

Example — a quote post:
```json
{
  "kind": 1,
  "id": "0991d519bae218ab37802238fc9f5d10a8ea9db3f7250049778578068328ca17",
  "pubkey": "dab6c6065c439b9bafb0b0f1ff5a0c68273bce5c1959a4158ad6a70851f507b6",
  "content": "My child is being born.\n\nCouldn't be more excited.\n\nnostr:nevent1qvzqqqqqqypzpgd5laqcc09h7m954r49gshju7mew03ncdftvqfeq2u87cnhla49qythwumn8ghj7un9d3shjtnswf5k6ctv9ehx2ap0qyt8wumn8ghj7enfv3hj6mn9waeju73h9eskjtcqyrux85lvwarsf0fyqla7uu53eh0wdrfa0uh0qsewwzz26rkr0hels6aqyty",
  "tags": [
    ["e", "f863d3ec774704bd2407fbee7291cddee68d3d7f2ef0432e7084ad0ec37df3f8", "wss://relay.primal.net/", "mention"],
    ["client", "Primal Web"]
  ]
}
```

Here `dab6c6...` (the follow) quotes post `f863d3ec...` (the Tamers of Entropy post above). The library must:
1. Detect `nostr:` references in content or `"mention"` marker in `e` tags
2. Fetch the embedded post (`f863d3ec...`)
3. Send BOTH the quote text and the embedded post content to the LLM for scoring as a unit

### Boosts/Reposts (kind 6)

A follow reposts someone else's post without commentary. The `content` field contains the JSON of the original post. The original post ID is in the `e` tag.

Example — a repost:
```json
{
  "kind": 6,
  "id": "49219b48de17d3cd340de01fd6a3e00914eba93993a28d88150c254b6561d845",
  "pubkey": "dab6c6065c439b9bafb0b0f1ff5a0c68273bce5c1959a4158ad6a70851f507b6",
  "tags": [
    ["e", "81029764e3b01040abd9181db47ff389661eed9498c7864b914e0ed5c0fad7f2", ""],
    ["p", "aff8712a4c1e85e839193bcf8d7731a48ea929020e379e1b0bc1213a8376866e"]
  ],
  "content": "{\"pubkey\":\"aff8712a4c1e85e839193bcf8d7731a48ea929020e379e1b0bc1213a8376866e\",\"content\":\"people don't appreciate how powerful eegs really are...\"}"
}
```

The library should:
1. Parse the original post from `content` (JSON string) or fetch it via the `e` tag if content is empty
2. Score the **original post's content**, not the repost event itself
3. Track that it was boosted by the follow (for display: "Boosted by @follow")

### Replies (kind 1 with reply tags) — EXCLUDED

Events with `e` tags marked `"root"` or `"reply"` are replies to other posts. These are **not scored** because they lack context without the parent thread.

Example — a reply (excluded):
```json
{
  "kind": 1,
  "id": "f7498c548825d16b2b32230c8f6d4613b6b57d8c84a5e12ded51724101ec22a5",
  "pubkey": "deab79dafa1c2be4b4a6d3aca1357b6caa0b744bf46ad529a5ae464288579e68",
  "content": "https://i.nostr.build/B51um3tNwMZAGBiB.jpg",
  "tags": [
    ["e", "59b42b33cbcd954762ebd4103003b2612463fc3531524fa5850bf01e99dbd425", "wss://nostr.wine/", "root", "deab79da..."],
    ["e", "c42dda3d9a8743a700b57fc92bc4bf9ea21311635988e5d668af0bc5e8a53259", "wss://relay.damus.io/", "reply", "d662c10f..."]
  ]
}
```

This has both `root` and `reply` `e` tags — it is a reply within a thread. It's just an image URL with no standalone context. The library filters these out.

### Likes (kind 7) — For Learning Only

Likes are fetched to build the learned prompt, not for display. The `e` tag points to the liked post. Content is typically `"+"`.

Example — a like:
```json
{
  "kind": 7,
  "id": "991d5d7a55f23a30219c9824ced9372bf02f8bacdb43e0069273cc88b92e66ff",
  "pubkey": "dab6c6065c439b9bafb0b0f1ff5a0c68273bce5c1959a4158ad6a70851f507b6",
  "tags": [
    ["e", "809514369577e92eb0c059789c630f64389720508b54681f39f72dc8e10e0ce3", ""],
    ["p", "554616acfaeaaddedaaec370197f040b0ca59f0ad4891945877d183ed22cc997"],
    ["k", "1"]
  ],
  "content": "+"
}
```

The library fetches the user's recent likes, resolves the liked posts' content, and feeds them to the LLM with a prompt like: "Based on these posts the user liked, summarize their interests and preferences in 2-3 sentences." This becomes the learned prompt.

## The Two Prompts

### User Prompt (manual, static)

Provided by the user. Describes what they care about. Examples:

- "I like cypherpunk culture, decentralized technology, Bitcoin, cats, and thoughtful longform posts. I don't care about price speculation, GM posts, or memes."
- "Show me posts about Nostr development, Cashu, and mesh networking. Deprioritize political content."

This prompt does not change unless the user edits it.

### Learned Prompt (auto-generated, evolves)

Built by the Learner module. On each run:
1. Fetch the user's recent likes (kind 7) — e.g. last 200 likes
2. Resolve the liked posts (fetch their content via `e` tags)
3. Send liked post contents to LLM with a summarization prompt
4. LLM returns something like: "User tends to engage with posts about freedom technology, neuroscience, independent publishing, and personal relationships. They like both philosophical reflections and practical technical content."
5. This text is stored as the learned prompt
6. On next run, new likes are checked — if new ones found, the learned prompt is regenerated

Both prompts are combined when scoring: the LLM sees the user prompt + learned prompt as context for ranking posts.

## Fetcher Module

### Input
- `npub` or hex pubkey
- List of relay URLs
- Time window (default: 24 hours)

### Operations

1. **Fetch follow list**: `kind: 3` for the user's pubkey. Extract all `p` tags — these are the follows.
2. **Fetch posts from follows**: `kind: 1` and `kind: 6` from all followed pubkeys within the time window.
3. **Filter out replies**: Discard kind 1 events that have `e` tags with `root` or `reply` markers.
4. **Classify remaining events**:
   - kind 1 with no `e` tags → **original post**
   - kind 1 with `e` tag marked `mention` or `nostr:` in content → **quote post** (resolve embedded)
   - kind 6 → **repost/boost** (resolve original from content JSON or `e` tag)
5. **Resolve embedded/original posts**: For quote posts and boosts, fetch the referenced posts if not already in the batch. These may be from authors outside the follow list.
6. **Return**: Array of processed events, each with type classification and resolved content.

### Output Structure

```typescript
interface FetchedPost {
  id: string               // event ID (hex)
  type: 'original' | 'quote' | 'boost'
  author: string           // pubkey of the follow who posted/boosted/quoted
  content: string          // text content of the post
  createdAt: number        // unix timestamp
  // For quote posts:
  quotedPost?: {
    id: string
    author: string
    content: string
  }
  // For boosts:
  originalPost?: {
    id: string
    author: string
    content: string
  }
  rawEvent: NostrEvent     // the original nostr event
}
```

## Ranker Module

### Input
- Array of `FetchedPost` objects from the Fetcher
- User prompt (string)
- Learned prompt (string, may be empty on first run)
- API configuration (endpoint, model, key)

### Scoring via LLM

Posts are sent to the LLM in batches (default: 20 posts per batch). The prompt structure:

```
System: You are a Nostr post relevance scorer. You will receive a user profile
and a list of posts. Score each post from 0 to 10 for relevance to this user.
Return ONLY a JSON array of [post_id, score] pairs. No other text.

User profile:
{user_prompt}

Learned preferences:
{learned_prompt}

Posts to score:
1. [id: abc123] "Tamers of Entropy is a lunarpunk novel..."
2. [id: def456] Quote by @follow: "My child is being born" — Original: "Tamers of Entropy..."
3. [id: ghi789] Boosted by @follow: "people don't appreciate how powerful eegs really are..."
...

Respond with JSON only:
[[post_id, score], [post_id, score], ...]
```

### JSON Validation (Prompt Injection Defense)

The LLM response MUST be validated:
1. Parse as JSON — reject if not valid JSON
2. Must be an array of arrays
3. Each inner array must be `[string, number]` where:
   - First element is a post ID that exists in the input batch
   - Second element is a number between 0 and 10
4. All post IDs from the input must be present in the output
5. If validation fails: log the error, retry once. If retry fails, assign default score (5) to the batch.

This prevents prompt injection where malicious post content tricks the LLM into returning arbitrary data.

### Sorting

After scoring, the Ranker sorts posts:
1. Primary sort: relevance score (descending, highest first)
2. Tiebreaker: creation timestamp (descending, newest first)

### Output Structure

```typescript
interface ScoredPost extends FetchedPost {
  score: number  // 0-10 relevance score from LLM
}

// Ranker returns ScoredPost[] sorted by score desc, then time desc
```

The sorting function should be exported separately so consumers can re-sort if needed:

```typescript
function sortByRelevance(posts: ScoredPost[]): ScoredPost[]
```

## Learner Module

### Input
- User's npub / hex pubkey
- List of relay URLs
- Current learned prompt (string, may be empty)
- API configuration (endpoint, model, key)
- Number of recent likes to fetch (default: 200)

### Operations

1. Fetch user's reactions: `kind: 7` for the user's pubkey, limited to recent N events
2. Extract liked post IDs from `e` tags
3. Fetch the liked posts' content from relays
4. Filter to kind 1 posts only (skip likes on other event types)
5. Send liked post contents to LLM with summarization prompt:

```
System: Analyze these Nostr posts that a user has liked. Summarize their
interests, preferences, and the types of content they engage with.
Write 2-4 sentences. Be specific about topics and tone they prefer.

Liked posts:
1. "people don't appreciate how powerful eegs really are..."
2. "the limit of central planners is that they don't know what they can't know..."
3. "Being in love is dope..."
...

Summary:
```

6. Store the LLM's response as the new learned prompt
7. Return the learned prompt string

### When to Re-run

The Learner runs:
- On first use (learned prompt is empty)
- On each run if new likes are found since the last learned prompt generation
- The consumer (web UI) can store the last-checked timestamp and only re-run if newer likes exist

## Library API

```typescript
import { createFetcher, createRanker, createLearner, sortByRelevance } from 'nalgorithm'

// Configuration
interface NalgorithmConfig {
  relays: string[]           // default: ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol']
  apiBaseUrl: string         // OpenAI-compatible endpoint, default: 'https://api.venice.ai/api/v1'
  apiKey: string             // API key for the LLM endpoint
  model: string              // default: 'grok-3-mini'
  batchSize?: number         // posts per LLM call, default: 20
}

// Fetcher
const fetcher = createFetcher({ relays })
const follows = await fetcher.getFollows(pubkey)
const posts = await fetcher.getPosts(follows, { hoursBack: 24 })
const likes = await fetcher.getLikes(pubkey, { limit: 200 })

// Learner
const learner = createLearner({ apiBaseUrl, apiKey, model })
const learnedPrompt = await learner.summarizeLikes(likedPostContents)

// Ranker
const ranker = createRanker({ apiBaseUrl, apiKey, model, batchSize })
const scoredPosts = await ranker.score(posts, { userPrompt, learnedPrompt })
const sorted = sortByRelevance(scoredPosts)
```

## Web Frontend (Test Application)

A single-page web application that uses the library. Vanilla HTML/CSS/JS or lightweight framework (Svelte/Preact). Purpose: demonstrate and test the library.

### Settings (stored in localStorage)

| Setting | Default | Notes |
|---------|---------|-------|
| npub | (required) | User's Nostr public key |
| Relays | `wss://relay.damus.io`, `wss://relay.primal.net`, `wss://nos.lol` | Editable list |
| API Base URL | `https://api.venice.ai/api/v1` | Predefined options: Venice, OpenRouter. Custom allowed. |
| API Key | (required) | Key for the LLM endpoint |
| Model | `grok-3-mini` | Text input, editable |
| User Prompt | (empty) | Textarea for manual profile prompt |
| Learned Prompt | (auto-generated) | Read-only display, with "Regenerate" button |
| Time Window | 24 hours | How far back to fetch posts |
| Rated Event IDs | (auto) | Set of nevent/hex IDs already scored, stored in localStorage. No need to store full events. |

All settings are editable in the UI. Changes take effect on next run.

### UI Layout

```
┌─────────────────────────────────────────────────┐
│  [Settings]  [Refresh]  [Status: Scoring...]    │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │ 9.2  @tamersofentropy                     │  │
│  │      Tamers of Entropy is a lunarpunk     │  │
│  │      novel about consciousness and what   │  │
│  │      happens when it outgrows its...      │  │
│  │      [video thumbnail]                    │  │
│  │      12:42 PM · Mar 25                    │  │
│  ├───────────────────────────────────────────┤  │
│  │ 8.7  @juraj · Boosted                     │  │
│  │      ┌─ @originalauthor ──────────────┐   │  │
│  │      │ people don't appreciate how    │   │  │
│  │      │ powerful eegs really are...    │   │  │
│  │      └────────────────────────────────┘   │  │
│  │      2:30 PM · Mar 25                     │  │
│  ├───────────────────────────────────────────┤  │
│  │ 8.1  @juraj · Quoted                      │  │
│  │      My child is being born.              │  │
│  │      Couldn't be more excited.            │  │
│  │      ┌─ @tamersofentropy ─────────────┐   │  │
│  │      │ Tamers of Entropy is a         │   │  │
│  │      │ lunarpunk novel...             │   │  │
│  │      └────────────────────────────────┘   │  │
│  │      11:23 AM · Mar 25                    │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Post Rendering

- **Original posts**: Show content, author, timestamp, media (images, video thumbnails)
- **Quote posts**: Show the follow's text, then the embedded post in a card/box underneath
- **Boosts**: Show "Boosted by @follow", then the original post's content in a card
- **Score badge**: Visible on each post (e.g. colored 0-10 badge)
- **Media**: Render images inline. Video as thumbnails/links. Parse `imeta` tags for media URLs.
- **Links**: Render as clickable links
- **nostr: references**: Render inline as @mentions or embedded cards

### Flow

1. User enters npub and API key in settings, writes their user prompt
2. Clicks "Refresh" (or auto-runs on load)
3. Library fetches follows → fetches posts → filters replies → resolves quotes/boosts
4. Library fetches likes → generates/updates learned prompt (shown read-only in settings)
5. Library scores posts via LLM → sorts by relevance
6. UI renders sorted posts
7. Scored event IDs stored in localStorage (just IDs, not full events) to avoid re-scoring on refresh

## Configuration Defaults

```javascript
const DEFAULTS = {
  relays: [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol'
  ],
  apiBaseUrl: 'https://api.venice.ai/api/v1',
  model: 'grok-3-mini',
  batchSize: 20,
  hoursBack: 24,
  likesToFetch: 200,
  maxPosts: 500
}
```

## Implementation Notes

### Technology
- Library: TypeScript, compiled to ESM. No framework dependencies.
- Nostr: `nostr-tools` for event parsing, NIP-19 encoding, WebSocket relay connections.
- Web frontend: Lightweight — Svelte, Preact, or vanilla. Must work in browser.
- LLM calls: Standard `fetch()` to OpenAI-compatible chat completions endpoint.

### What the Library Does NOT Do
- It does not implement a Nostr client (no posting, signing, or key management)
- It does not provide in-app rating/feedback (likes come from Nostr only)
- It does not store full events long-term (only scored IDs for dedup)
- It does not handle replies or threading
- It does not sync data across devices

### Error Handling
- Relay connection failures: try next relay, log warning
- LLM API errors: retry once, then assign default score (5) to batch
- Invalid LLM JSON: retry once, then default score
- Missing embedded/original posts: score the event with available content only, note "(embedded post unavailable)"

## Package Structure

```
nalgorithm/
├── src/
│   ├── fetcher.ts      # Relay connections, event fetching, classification
│   ├── ranker.ts       # LLM scoring, JSON validation, sorting
│   ├── learner.ts      # Like fetching, preference summarization
│   ├── types.ts        # Shared TypeScript types
│   └── index.ts        # Public API exports
├── web/                # Test web frontend
│   ├── index.html
│   ├── app.ts          # Main application logic
│   ├── settings.ts     # Settings management (localStorage)
│   ├── render.ts       # Post rendering
│   └── style.css
├── package.json
└── tsconfig.json
```

## Open Questions

1. **Batch size tuning**: 20 posts per LLM call is a starting point. May need adjustment based on context window limits and response quality.
2. **Learned prompt staleness**: How often should likes be re-checked? Every run? Only if N new likes since last check?
3. **Deduplication**: If the same post appears as an original AND is boosted by another follow, show it once with higher confidence (or note "also boosted by @X").
4. **Rate limiting**: Should the library throttle relay connections or LLM calls? Probably yes for relays (don't hammer with 500 concurrent requests).
5. **Media in LLM scoring**: Images/video can't be scored by text LLM. Should media-only posts get a neutral score or be flagged separately?
