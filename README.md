# Nalgorithm

A Nostr relevance feed. Fetches posts from your follows and ranks them by what you actually care about, using an LLM instead of reverse chronological order.

**Live demo:** https://cypherpunk.today/nalgorithm/

## How it works

You write a short profile describing your interests ("I like cypherpunk culture, Bitcoin, cats, thoughtful longform writing. I don't care about price speculation or GM posts"). The app sends batches of posts to your chosen LLM along with this profile, and each post gets a 0-10 relevance score.

There's also a "learned prompt" that gets built automatically from your Nostr likes (kind 7 reactions). You keep using your regular Nostr client, like the posts you enjoy, and nalgorithm picks up on those patterns. The learned prompt evolves incrementally -- each run only looks at likes since the last run and refines the existing prompt, rather than regenerating from scratch. It only affects future rankings; already-scored posts keep their scores.

Scores are cached locally (localStorage in the web app, a JSON file for the CLI), so re-running only scores posts the LLM hasn't seen before. No wasted tokens.

## What it handles

- **Original posts** (kind 1, no reply tags)
- **Quote posts** (kind 1 with `nostr:` references) -- scores the quote + embedded post together
- **Boosts** (kind 6) -- resolves and scores the original content
- Replies are filtered out
- Profile pictures and display names are fetched and shown
- `nostr:npub` and `nostr:nprofile` references in post content are resolved to clickable @names

## No server

Everything runs in the browser (web app) or locally (CLI). Settings, scores, and the learned prompt live in localStorage or local files. The app connects directly to Nostr relays for posts and to your chosen LLM provider for scoring. There's nothing in between.

## LLM providers

The app works with any OpenAI-compatible chat completions API. You configure the endpoint, key, and model.

Some options I've tested:

- **Venice AI** -- works from the browser (permissive CORS). Also works with their E2E encrypted proxy, though since Nostr posts are public anyway, encrypting the prompts doesn't add much.
- **OpenRouter** -- works from the browser (permissive CORS).
- **Ollama local** -- works if you set `OLLAMA_ORIGINS=*` before starting it.
- **Ollama Cloud** (`https://ollama.com/v1`) -- no CORS headers, so you need a proxy for the web app. I use a simple Caddy reverse proxy on localhost.

I run **gemma3:27b** through Ollama Cloud for scoring. It's cheap, fast at structured JSON output, and works on the free tier. Other models that work well: `minimax-m2.5`, `qwen3-next:80b` if you want more depth.

## Project structure

```
nalgorithm/
├── lib/               # Library (TypeScript, npm package)
│   └── src/
│       ├── fetcher.ts   # Relay connections, post/profile/like fetching
│       ├── ranker.ts    # LLM scoring with batched calls and JSON validation
│       ├── learner.ts   # Like analysis, learned prompt generation
│       ├── llm.ts       # Generic OpenAI-compatible API client
│       └── types.ts     # All shared types
├── web/               # Web frontend (Vite)
│   └── src/
│       ├── app.ts       # Two-phase flow: fetch/score/render, then background learn
│       ├── settings.ts  # localStorage settings + date-keyed score cache
│       ├── render.ts    # Post card rendering, content formatting
│       └── ui.ts        # DOM bindings, settings panel
├── digest/            # CLI digest tool
│   └── src/
│       ├── main.ts      # Fetch, rank, generate spoken-word digest
│       └── config.ts    # JSON config loader with env var interpolation
└── package.json       # npm workspaces root
```

The library (`lib/`) is a standalone package. The web frontend (`web/`) and digest CLI (`digest/`) both import it. They're connected through npm workspaces.

## Setup

```bash
npm install
npm run build     # builds lib, web, and digest
npm run dev       # starts vite dev server for the web app
```

Open the app, go to Settings, fill in:
- Your npub
- An API key and endpoint for your LLM provider
- A user prompt describing what you like to see in your feed

Click Refresh.

## Digest tool

A CLI tool that generates a radio-show-style digest of what happened on your Nostr feed. It fetches posts from your follows, ranks them, picks the top ones, and sends them to an LLM to write a cohesive narrative. Output goes to stdout.

### Quick start

```bash
# Copy and edit the config
cp digest.config.example.json digest.config.json
# Fill in your npub and API keys, then:

npm run digest

# Or with a custom config path:
node digest/dist/main.js /path/to/my-config.json
```

### Configuration

The config supports `$ENV_VAR` and `${ENV_VAR}` syntax for API keys so you don't hardcode secrets:

```json
{
  "rankingApi": {
    "apiKey": "$VENICE_API_KEY"
  }
}
```

You can use different LLM models for each step:

| Step | Config key | What it does | Recommended |
|------|-----------|--------------|-------------|
| Scoring | `rankingApi` | Scores posts 0-10 by relevance | Fast, cheap model (`google-gemma-3-27b-it`) |
| Learning | `learnerApi` | Summarizes your likes into preferences | Optional, falls back to `rankingApi` |
| Digest | `digestApi` | Writes the final narrative | Stronger model (`claude-sonnet-4-6`) |

All three can point to different providers and models.

### Score caching

Scores are saved to a local JSON file (`digest.scores.json` by default). On each run, only new posts get scored -- cached scores are reused. The cache auto-prunes entries older than 2x your `hoursBack` setting (minimum 48 hours). Posts that failed scoring and got a default fallback score are not cached.

### Learned prompt

If `learnFromLikes` is true (the default), the tool fetches your recent Nostr likes and uses them to build a preference summary. This learned prompt is saved to a file (`digest.learned.json`) and evolves with each run:

- **First run**: generates a prompt from scratch based on your likes
- **Later runs**: only fetches likes newer than what was last processed, asks the LLM to refine the existing prompt with the new signal
- **No new likes**: skips the LLM call entirely, uses whatever was cached

The learned prompt is passed alongside your `userPrompt` to both the scoring and digest generation steps.

### TTS variant

There's a TTS-aware config example (`digest.config.tts.example.json`) with prompts tuned for text-to-speech output: no markdown formatting, spelled-out version numbers and abbreviations, shorter format (~800-1200 words). Use this if you're piping the output into a TTS engine.

### All config options

| Option | Default | Description |
|--------|---------|-------------|
| `npub` | required | Your Nostr npub |
| `relays` | required | Array of relay WebSocket URLs |
| `rankingApi` | required | `{apiBaseUrl, apiKey, model, batchSize?}` for post scoring |
| `digestApi` | required | `{apiBaseUrl, apiKey, model, temperature?}` for digest generation |
| `learnerApi` | falls back to `rankingApi` | `{apiBaseUrl, apiKey, model}` for preference learning |
| `userPrompt` | required | Describe your interests and what to filter out |
| `learnFromLikes` | `true` | Whether to learn preferences from your likes |
| `learnedPromptCache` | `./digest.learned.json` | Path to the learned prompt file |
| `scoreCachePath` | `./digest.scores.json` | Path to the score cache file |
| `hoursBack` | `24` | How far back to fetch posts |
| `topN` | `15` | Number of top posts to include in the digest |
| `digestSystemPrompt` | built-in | System prompt for digest generation |
| `digestPrompt` | built-in | User prompt template for digest generation |

## Caddy CORS proxy for Ollama Cloud

If you want to use Ollama Cloud from the browser, you need a local CORS proxy since their API doesn't send CORS headers. Minimal Caddyfile:

```
:9292 {
    reverse_proxy https://ollama.com {
        header_up Host ollama.com
    }
    header Access-Control-Allow-Origin *
    header Access-Control-Allow-Methods "GET, POST, OPTIONS"
    header Access-Control-Allow-Headers *
}
```

Run with `caddy run --config Caddyfile`, then set `http://localhost:9292/v1` as the API Base URL in nalgorithm settings.

## License

MIT
