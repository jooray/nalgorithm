# Nalgorithm

A Nostr relevance feed. Fetches posts from your follows and ranks them by what you actually care about, using an LLM instead of reverse chronological order.

## How it works

You write a short profile describing your interests ("I like cypherpunk culture, Bitcoin, cats, thoughtful longform writing. I don't care about price speculation or GM posts"). The app sends batches of posts to your chosen LLM along with this profile, and each post gets a 0-10 relevance score.

There's also a secondary "learned prompt" that gets built automatically from your Nostr likes (kind 7 reactions). You just keep using your regular Nostr client, like the posts you enjoy, and nalgorithm picks up on those preferences. The learned prompt updates in the background after each feed load, but it only affects the *next* ranking -- already-scored posts keep their scores.

Scores are cached locally, so refreshing the feed only scores posts the LLM hasn't seen before. No wasted tokens.

## What it handles

- **Original posts** (kind 1, no reply tags)
- **Quote posts** (kind 1 with `nostr:` references) -- scores the quote + embedded post together
- **Boosts** (kind 6) -- resolves and scores the original content
- Replies are filtered out
- Profile pictures and display names are fetched and shown
- `nostr:npub` and `nostr:nprofile` references in post content are resolved to clickable @names

## No server

Everything runs in the browser. Settings, scores, and the learned prompt live in localStorage. The app connects directly to Nostr relays for posts and to your chosen LLM provider for scoring. There's nothing in between.

## LLM providers

The app works with any OpenAI-compatible chat completions API. You configure the endpoint, key, and model in settings.

Some options I've tested:

- **Venice AI** -- works from the browser (permissive CORS). Also works with their E2E encrypted proxy, though since Nostr posts are public anyway, encrypting the prompts doesn't add much.
- **OpenRouter** -- works from the browser (permissive CORS).
- **Ollama local** -- works if you set `OLLAMA_ORIGINS=*` before starting it.
- **Ollama Cloud** (`https://ollama.com/v1`) -- no CORS headers, so you need a proxy. I use a simple Caddy reverse proxy on localhost.

I run **gemma3:27b** through Ollama Cloud. It's cheap, fast at structured JSON output, and works on the free tier. Other models that work well: `minimax-m2.5`, `qwen3-next:80b` if you want more depth.

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
├── web/               # Test web frontend (Vite)
│   └── src/
│       ├── app.ts       # Two-phase flow: fetch/score/render, then background learn
│       ├── settings.ts  # localStorage settings + date-keyed score cache
│       ├── render.ts    # Post card rendering, content formatting
│       └── ui.ts        # DOM bindings, settings panel
└── package.json       # npm workspaces root
```

The library (`lib/`) is a standalone package. The web frontend (`web/`) imports it via a Vite alias during development. They're connected through npm workspaces.

## Setup

```bash
npm install
npm run build     # builds lib (tsc) then web (vite)
npm run dev        # starts vite dev server on localhost:3000
```

Open the app, go to Settings, fill in:
- Your npub
- An API key and endpoint for your LLM provider
- A user prompt describing what you like to see in your feed

Click Refresh.

## Caddy CORS proxy for Ollama Cloud

If you want to use Ollama Cloud from the browser, you need a local CORS proxy since their API doesn't send CORS headers. Here's a minimal Caddyfile:

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
