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

## Digest in the browser

The web app can do the same thing the CLI does: click **Digest** and it writes
a narrative summary of your top-ranked posts. It reuses posts already fetched
and scored, so it costs exactly one extra LLM call.

**Read aloud** uses the browser's own speech engine (Web Speech API). No TTS
provider, no API key, nothing leaves the device — the tradeoff is that voice
quality is whatever your OS ships. Pick a voice, set the speed, pause and
resume. For better voices, use the CLI's `ttsApi` with a real TTS model.

Two Chrome quirks are handled, because both make long text fail in ways that
look like your fault: utterances over a couple hundred characters get truncated
or never fire their end event, and speech stops after roughly 15 seconds unless
it is nudged. The text is chunked on sentence boundaries and queued, with a
keep-alive timer running during playback.

The **Phrase it for speech** setting adds instructions to drop markdown and
spell out version numbers and abbreviations ("N I P nineteen", not "NIP-19").
Leave it on if you plan to listen, turn it off if you'd rather read.

### Per-role models

The web app uses one model for everything by default, but the digest and the
learner can each be pointed somewhere else:

| Setting | What it does | Notes |
|---|---|---|
| Model (scoring) | Scores every post | The volume consumer. Keep it cheap. |
| Model (digest) | Writes the narrative | One call over ~15 posts, so a stronger model is affordable |
| Model (learning from likes) | Summarizes your likes | Needs a large context window |

Leave the last two blank to reuse the scoring model.

**Load model list** fetches the provider's catalog from `/models` and attaches
it to all three fields. They stay free-text inputs — the list is a suggestion,
not an allowlist, so a provider that can't be enumerated never stops you typing
a model name. On Venice the catalog also carries context size and pricing,
shown next to each entry, and **Use recommended** fills in a known-good model
per role. The list is cached for a day.

## Signing in

The web app needs to know your public key and nothing else — it reads your
follow list, your feed, and your likes. It never publishes, never reacts, never
signs. Three ways to tell it who you are:

- **Browser extension (NIP-07)** — one click, reads your pubkey from Alby, nos2x, or similar.
- **Remote signer (NIP-46)** — scan a QR code with Amber or another bunker. The
  connection requests **no permissions at all**: it calls `get_public_key`, then
  closes. Your signer is never asked for the ability to sign, so granting this
  cannot result in anything being posted as you.
- **Paste an npub** — no signer involved. Works for reading any public feed,
  including someone else's.

The signer relays are configurable, and worth a thought: the handshake rides on
kind 24133, which is *ephemeral*, so a relay that accepts the event without
relaying it live looks exactly like a signer that never answered. Every default
in the list was verified by publishing on one connection and receiving on
another. When that list was set, `relay.nsec.app` — the dedicated bunker relay,
and the obvious first choice — was returning HTTP 502, and `relay.damus.io`
would not complete a WebSocket handshake. Probe before you add one.

Another detail worth knowing if you implement this yourself: on NIP-46 the
pubkey on the signer's response frames is a per-connection *routing* key, not
the user's identity. Newer Amber builds generate a fresh one per connection, so
treating it as the npub silently logs you in as an ephemeral key that follows
nobody. `get_public_key` is the only correct source.

## LLM providers

The app works with any OpenAI-compatible chat completions API. You configure the endpoint, key, and model.

Some options I've tested:

- **Venice AI** -- works from the browser (permissive CORS). Also works with their E2E encrypted proxy, though since Nostr posts are public anyway, encrypting the prompts doesn't add much.
- **OpenRouter** -- works from the browser (permissive CORS).
- **Ollama local** -- works if you set `OLLAMA_ORIGINS=*` before starting it.
- **Ollama Cloud** (`https://ollama.com/v1`) -- no CORS headers, so you need a proxy for the web app. I use a simple Caddy reverse proxy on localhost.

For the web app I've run **gemma3:27b** through Ollama Cloud for scoring -- cheap, fast at structured JSON output, and it works on the free tier. `minimax-m2.5` and `qwen3-next:80b` also work if you want more depth.

My daily digest runs on Venice: `deepseek-v4-flash-0731` for scoring, `kimi-k3` for writing the digest and for learning from likes, `qwen-3-6-plus` as the digest fallback, and `tts-kokoro` for the audio.

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
| Scoring | `rankingApi` | Scores posts 0-10 by relevance | Fast, cheap model (`deepseek-v4-flash-0731`) |
| Learning | `learnerApi` | Summarizes your likes into preferences | Large context (`kimi-k3`); falls back to `rankingApi` |
| Digest | `digestApi` | Writes the final narrative | Stronger model (`kimi-k3`) |
| Digest fallback | `digestFallbackApi` | Retries the digest if the primary fails | Different model (`qwen-3-6-plus`) |
| Speech | `ttsApi` | Reads the digest aloud | `tts-kokoro` (see below) |

They can all point to different providers and models.

The scoring model does the bulk of the work (hundreds of posts per day), so it
should be cheap. The digest model runs once per day on ~15 posts, so it can
afford to be good. The learner needs a large context window because it
summarizes up to 50 likes in one prompt — small-context models return HTTP 400
here.

### Reasoning models and JSON

Any API block accepts `reasoningEffort` (`none`, `low`, `medium`, `high`,
`max`), sent as `reasoning_effort`. It's omitted from the request entirely when
unset, so models that don't support it are unaffected.

Scoring is high-volume and not hard, so it's the place to turn reasoning down.

### Why JSON mode is off by default

`rankingApi.jsonMode` controls whether scoring calls send
`response_format: {type: "json_object"}`. It defaults to **false**, which is
worth explaining because "ask for JSON, get JSON" sounds obviously right.

The problem is that JSON mode requires a top-level *object* while the scoring
prompt asks for an *array*. The model is pulled two ways and drifts into
wrapper shapes — or, on a reasoning model, leaks its `<think>` block into the
JSON and destroys the batch outright. Measured on Venice, 5 runs of a 20-post
batch, counting runs where all 20 posts came back scored:

| Model | JSON mode on | off |
|-------|-------------:|----:|
| `deepseek-v4-flash` (0423) | 4/5 | 5/5 |
| `deepseek-v4-flash-0731` + `reasoningEffort: low` | 0/5 | 5/5 |
| `google-gemma-3-27b-it` | 5/5 | 5/5 |

Never better on, sometimes catastrophically worse — and the failure is quiet,
because an unparseable batch just gives every post the fallback score of 5.
The tolerance JSON mode used to buy is now in the parser instead, which accepts
`{"scores": [...]}`, `{"posts": [{...}]}`, `{"1": {...}}`, fenced code blocks,
prose preambles, and leaked think blocks.

If you see `0 scored by LLM, N got default score` in the logs, that is this
class of problem: check `jsonMode` first, then try `reasoningEffort: "none"`.

### Digest fallback

Strong models are the ones most likely to be rate-limited. If `digestApi` fails
after its retries are exhausted (429, overload, network), and `digestFallbackApi`
is set, the whole digest prompt is retried against that second model. Without
it, a 429 at the digest step loses the run — including the scoring you already
paid for.

### Score caching

Scores are saved to a local JSON file (`digest.scores.json` by default). On each run, only new posts get scored -- cached scores are reused. Entries older than `scoreCacheTTLDays` (90 by default) are pruned on load. Posts that failed scoring and got a default fallback score are not cached, so they get another chance next run.

Scores are deterministic, so a long TTL is fine and re-scoring old posts buys you nothing. The side effect is that the cache accumulates a few months of scored posts, which you can query directly if you want "best of the last quarter" rather than "best of today".

### Pre-warming the cache (`--score-only`)

A cold run has to score everything before it can write anything. With
`maxPosts: 500` and `batchSize: 20` that's 25 sequential LLM calls -- around ten
minutes.

`--score-only` fetches and scores posts, updates the cache, and exits without
generating a digest or writing to stdout:

```bash
node digest/dist/main.js digest.config.json --score-only
```

Run it on a timer through the day, and the daily digest only has to score the
handful of posts that arrived since the last pass. This is the reason to keep
`maxPosts` high rather than lowering it to make cold runs bearable -- and
`"concurrency": 3` in `rankingApi` scores three batches in parallel on top of
that.

### Learned prompt

If `learnFromLikes` is true (the default), the tool fetches your recent Nostr likes and uses them to build a preference summary. This learned prompt is saved to a file (`digest.learned.json`) and evolves with each run:

- **First run**: generates a prompt from scratch based on your likes
- **Later runs**: only fetches likes newer than what was last processed, asks the LLM to refine the existing prompt with the new signal
- **No new likes**: skips the LLM call entirely, uses whatever was cached

The learned prompt is passed alongside your `userPrompt` to both the scoring and digest generation steps.

### Text to speech

The digest can read itself aloud. Add a `ttsApi` block and the finished text is
synthesized to an audio file alongside the stdout output:

```json
"ttsApi": {
  "apiBaseUrl": "https://api.venice.ai/api/v1",
  "apiKey": "$VENICE_API_KEY",
  "model": "tts-kokoro",
  "voice": "af_sky",
  "speed": 1.0,
  "format": "mp3"
},
"ttsOutputPath": "./digests/nalgorithm-%Y-%m-%d.mp3"
```

Then run with `--tts`:

```bash
node digest/dist/main.js digest.config.json --tts
node digest/dist/main.js digest.config.json --tts /tmp/today.mp3   # override the path
```

`ttsOutputPath` understands `%Y %m %d %H %M %S`, so each run gets its own file
instead of overwriting yesterday's.

This uses the OpenAI-compatible `/audio/speech` endpoint, so it works with
Venice, OpenAI, or a local server that speaks the same shape. Venice's TTS
models, cheapest first:

| Model | $/M chars | Voices | Notes |
|-------|----------:|-------:|-------|
| `tts-kokoro` | 3.50 | 54 | Best value; the only one offering formats beyond mp3/wav |
| `tts-inworld-1-5-max` | 12.50 | 14 | wav only |
| `tts-xai-v1` | 18.75 | 26 | |
| `tts-gradium-v1` | 47.50 | 12 | |
| `tts-chatterbox-hd` | 50.00 | 9 | |
| `tts-orpheus` | 62.50 | 8 | |
| `tts-elevenlabs-turbo-v2-5` | 62.50 | 21 | |
| `tts-qwen3-0-6b` | 87.50 | 9 | |
| `tts-qwen3-1-7b` | 112.50 | 9 | |
| `tts-minimax-speech-02-hd` | 125.00 | 15 | |
| `tts-gemini-3-1-flash` | 187.50 | 30 | |

A 1000-word digest is roughly 6000 characters, so `tts-kokoro` costs about two
cents per run and `tts-gemini-3-1-flash` a bit over a dollar.

**On chunking:** Venice rejects any single request over **4096 characters**, and
a spoken digest is comfortably longer than that. The text is split on paragraph
breaks (falling back to sentences, then words) and the audio is joined back
together, with ID3 tags stripped from continuation chunks so the result is one
clean stream. This is why `format` should stay `mp3` for long digests -- `wav`,
`flac`, `opus` and `aac` carry per-file headers that cannot be concatenated
without a real muxer, so the tool refuses rather than emitting a broken file.
`pcm` is also safe to join.

Keep the TTS-tuned prompts in mind too: `digest.config.tts.example.json` has
prompts that suppress markdown, spell out version numbers and abbreviations, and
target ~800-1200 words. Feeding a markdown-formatted digest to a TTS engine
means listening to it read asterisks aloud.

### All config options

| Option | Default | Description |
|--------|---------|-------------|
| `npub` | required | Your Nostr npub |
| `relays` | required | Array of relay WebSocket URLs |
| `rankingApi` | required | `{apiBaseUrl, apiKey, model, reasoningEffort?, batchSize?, concurrency?}` for post scoring |
| `digestApi` | required | `{apiBaseUrl, apiKey, model, temperature?, reasoningEffort?}` for digest generation |
| `digestFallbackApi` | none | Same shape as `digestApi`. Used if the primary digest model fails after retries |
| `learnerApi` | falls back to `rankingApi` | `{apiBaseUrl, apiKey, model}` for preference learning |
| `ttsApi` | none | `{apiBaseUrl, apiKey, model, voice?, speed?, format?, maxChars?}` for speech synthesis |
| `ttsOutputPath` | none | Where to write audio. Supports `%Y %m %d %H %M %S` |
| `userPrompt` | required | Describe your interests and what to filter out |
| `learnFromLikes` | `true` | Whether to learn preferences from your likes |
| `likesBatchSize` | `50` | Likes per preference-learning batch. Reduce if your model has a small context window |
| `learnedPromptCache` | `./digest.learned.json` | Path to the learned prompt file |
| `scoreCachePath` | `./digest.scores.json` | Path to the score cache file |
| `scoreCacheTTLDays` | `90` | How long to keep cached scores before pruning |
| `hoursBack` | `24` | How far back to fetch posts |
| `maxPosts` | `500` | Cap on posts fetched per run. Prefer `--score-only` pre-warming over lowering this |
| `topN` | `15` | Number of top posts to include in the digest |
| `digestSystemPrompt` | built-in | System prompt for digest generation. Humanizer rules are always appended automatically |
| `digestPrompt` | built-in | User prompt template for digest generation |

### Command-line flags

| Flag | What it does |
|------|--------------|
| *(first positional arg)* | Path to the config file. Defaults to `./digest.config.json` |
| `--score-only` | Score posts into the cache and exit. No digest, no stdout output |
| `--tts [path]` | Also synthesize the digest to audio. Without a path, uses `ttsOutputPath` |

## Running it on a schedule

This is how the digest runs daily on my server: two systemd user timers, one
pre-warming the score cache through the day, one generating the digest in the
morning. Adapt the paths and drop them in `~/.config/systemd/user/`.

`nalgorithm-score.service` -- keeps the cache warm so the morning run is fast:

```ini
[Unit]
Description=Nalgorithm score cache refresh
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/nalgorithm/digest
EnvironmentFile=%h/.config/nalgorithm/env
ExecStart=/usr/bin/node dist/main.js digest.config.json --score-only
```

`nalgorithm-score.timer`:

```ini
[Unit]
Description=Nalgorithm score cache refresh every 3 hours

[Timer]
OnCalendar=*-*-* 04,07,10,13,16,19,22:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

`nalgorithm-digest.service` -- the daily digest, with audio:

```ini
[Unit]
Description=Generate the Nalgorithm morning digest
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/nalgorithm/digest
EnvironmentFile=%h/.config/nalgorithm/env
ExecStart=/usr/bin/node dist/main.js digest.config.json --tts
```

`nalgorithm-digest.timer` (same shape, `OnCalendar=*-*-* 07:00:00`).

Put your key in `~/.config/nalgorithm/env` as `VENICE_API_KEY=...` and reference
it as `$VENICE_API_KEY` in the config -- `EnvironmentFile` keeps it out of the
unit file, which is world-readable. `chmod 600` it.

Enable with:

```bash
systemctl --user daemon-reload
systemctl --user enable --now nalgorithm-score.timer nalgorithm-digest.timer
systemctl --user list-timers | grep nalgorithm
```

Two things worth knowing:

- **`Persistent=true`** re-runs a timer that was missed while the machine was
  off. Without it, a laptop that sleeps through 07:00 silently gets no digest.
- **Order matters.** Anything consuming the digest (a voice bot, a note in your
  vault) should be scheduled after the generator, not alongside it.

To keep the text as well as the audio, redirect stdout:

```bash
node dist/main.js digest.config.json --tts > "$HOME/digests/$(date +%F).md"
```

## Hosting the web app

`npm run build -w web` writes a static site to `web/dist/`. Copy it anywhere
that serves files. For a subdirectory install, set the base path at build time:

```bash
VITE_BASE=/nalgorithm/ npm run build -w web
```

It's a PWA: installable, works offline once loaded, and **checks for new
versions while running**. Each build stamps a version into the bundle, the
service worker, and a `version.json`; the running page polls that file and
reloads itself when it changes, so a deploy reaches people with the app already
open without anyone being told to hard-refresh.

That only works if your web server lets the shell revalidate. The trap is that
`index.html` is usually served with just `Last-Modified`/`ETag` and no
`Cache-Control`, so browsers apply heuristic freshness, keep serving the old
shell, and the old shell keeps pulling the old content-hashed bundles — the
update looks deployed but never lands. Under nginx:

```nginx
location ^~ /nalgorithm/ {
    try_files $uri $uri/ =404;

    # Content-hashed bundles are immutable.
    location ^~ /nalgorithm/assets/ { expires max; }

    # Anything that gates an update must revalidate.
    location ~* \.(html|json|webmanifest)$ { expires -1; }
    location = /nalgorithm/sw.js          { expires -1; }
    location = /nalgorithm/               { expires -1; }
}
```

Use the `expires` directive rather than `add_header Cache-Control ...`: an
`add_header` inside a location block discards every `add_header` inherited from
the server level, which will quietly strip your security headers.

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
