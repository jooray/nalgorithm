# Nalgorithm Web

A test web frontend for the [nalgorithm](../lib/) library. Demonstrates fetching, learning, and ranking Nostr posts by personal relevance.

## Running

From the project root:

```bash
npm install
npm run dev
```

This starts a Vite dev server at `http://localhost:3000`.

Or build for production:

```bash
npm run build -w web
```

Output goes to `web/dist/`.

## Setup

1. Open the app in your browser
2. Click **Settings** (top right)
3. Fill in:
   - **npub**: your Nostr public key (npub1... or hex)
   - **API Key**: key for your chosen LLM provider
   - **User Prompt**: describe what you care about (e.g. "I like cypherpunk culture, Bitcoin, decentralized tech. I don't care about price speculation or GM posts.")
4. Optionally adjust: relays, API provider, model, time window
5. Click **Save Settings**
6. Click **Refresh**

The app will:
1. Fetch your follow list from relays
2. Fetch posts from your follows (last 24h by default)
3. Fetch your recent likes and generate a learned prompt
4. Score all posts via the LLM
5. Display them ranked by relevance

## Settings

All settings are stored in `localStorage` and persist across sessions.

| Setting | Default | Description |
|---------|---------|-------------|
| npub | (required) | Your Nostr public key |
| Relays | damus, primal, nos.lol | Nostr relay WebSocket URLs |
| Provider | Venice AI | Predefined: Venice, OpenRouter, Ollama. Or custom. |
| API Base URL | `https://api.venice.ai/api/v1` | OpenAI-compatible endpoint |
| API Key | (required) | LLM provider API key |
| Model | `grok-3-mini` | Model name |
| User Prompt | (required) | Text describing your interests |
| Learned Prompt | (auto) | Generated from your likes. Read-only, with regenerate button. |
| Time Window | 24 hours | How far back to fetch posts |
| Batch Size | 20 | Posts per LLM scoring call |

## Post display

- **Original posts**: content, author (truncated pubkey), timestamp, inline media
- **Quote posts**: the follow's commentary text, then the quoted post in an indented card
- **Boosts**: "Boosted" label, then the original post in an indented card
- **Score badge**: colored circle (green 7-10, yellow 4-6, gray 0-3)
- **Media**: images rendered inline, videos with controls
- **Links**: clickable

## LLM providers

The app works with any OpenAI-compatible chat completions API:

| Provider | Base URL | Notes |
|----------|----------|-------|
| Venice AI | `https://api.venice.ai/api/v1` | Default. Supports grok-3-mini and others. |
| OpenRouter | `https://openrouter.ai/api/v1` | Access to many models. |
| Ollama | `http://localhost:11434/v1` | Local, free. Requires Ollama running locally. |
| Custom | (any URL) | Any OpenAI-compatible endpoint. |

## What's stored locally

- **localStorage**: settings (npub, relays, API config, prompts) and date-keyed score cache
- Scores are cached per day and pruned after 30 days. No full events are stored.
- No data is sent anywhere except the configured LLM API endpoint

## Tech stack

- Vanilla TypeScript (no framework)
- Vite for dev server and bundling
- nalgorithm library (workspace dependency)
- Dark theme, responsive layout
