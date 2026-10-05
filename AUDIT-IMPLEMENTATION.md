# Audit implementation — single release

Source audit: `AUDIT-GPT61.md`. Started 2026-10-05. No intermediate deployments.

## Confirmed decisions

- Implement the entire audit in focused commits, followed by one coordinated release/deploy.
- Retain all action permissions at hosted login; accurately explain them.
- New arrivals first by default, with best-first available.
- Learning off means ignore learned preferences while retaining them for re-enabling.
- Download MP3, plus bounded local caching for the newest three digests.
- Preserve the existing visual identity and TypeScript architecture. Daily scheduling remains opt-in.

## Delivery groups

| Group | Findings | Status |
|---|---|---|
| Ranking context and unique digest selection | F01, F13 | Implemented; library regressions and web/server typechecks pass |
| Validated setup, storage and provider configuration | F02, F03, F07, F17, F26, F35 | Core implementation done; draft persistence and section saves follow |
| Visible recovery, truthful scores, permissions and accessibility | F04, F05, F06, F08, F18, F32, F39 | Implemented; automated checks pass, live rendering pending |
| Incremental learning, bounded fetching and cleanup | F09, F10, F11 | Implemented; resource and incremental-learning regressions pass |
| Shared pipeline/provider budget and durable jobs/delivery | F12, F14, F15, F41 | Core jobs/outbox implemented; retention and diagnostics continue |
| Safe updates, drafts and navigation | F16, F33, F37 | Implemented; atomic deployment integration remains for release |
| Offline/download audio and efficient playback | F19, F23, F24 | Implemented; IndexedDB and playback logic regressions pass |
| Stable rendering, storage and payloads | F20, F21, F22 | Implemented; DOM, IndexedDB and API regressions pass |
| Activation, schedule, ordering and private feedback | F25, F27, F28, F29 | Implemented; logic, DOM and server regressions pass |
| Media, responsive design, device privacy and visual refinement | F30, F31, F34, F40 | Implemented; DOM/server regressions pass, live layout pending |
| Documentation, fixtures, tests and observability | F36, F38 | Implemented; retention and diagnostics added |
| Final release and coordinated deployment | All | Pending |

Each group will record changes, tests, limitations and commit references. A finding is not marked complete merely because a recommendation was documented. Real-device/provider/payment checks that cannot be performed safely will remain explicit limitations.

## Verification and deployment

- Build library, web, CLI and server; run existing and new deterministic tests with disposable databases.
- BrowserOS neo for live/local browser checks. No fallback browser without authorization.
- Do not touch pre-existing untracked `web/PRODUCT.md`, `web/.impeccable/` or `web/regions.json`.
- Do not edit the vendored humanizer skill.
- Version the release once; deploy hosted server, app and landing together only after verification.
- Send one concise SimpleX completion summary, or a blocker if the release cannot safely proceed.

## Implementation log

### Ranking context and unique selections

- SHA-256 ranking fingerprints include explicit interests, provider/model/scorer/rubric and learning policy, never credentials. Hosted cache keys include context; BYOK namespaces include canonical identity. Old unknown-provenance scores are not reused in a new context.
- Original notes and boosts share one digest slot, before top-N selection. Fallback/unranked notes do not enter the best-note digest.
- Hosted learning-off no longer applies previously learned taste.
- Tests: fresh library build and 32 tests pass; web no-emit check and server build pass.
- BrowserOS neo still reports no browser window. Live verification remains pending.

### Validated setup and provider connection

- First BYOK save validates public identity, endpoint/relay schemes and finite whole-number bounds, points at the bad field, and starts the first ranking. Live checks are installed even before setup is complete.
- Refresh/digest use saved settings instead of silently committing an unsaved Tune draft. Inline save confirmation is persistent.
- Keyless local Ollama is accepted; a deliberately small paid-capable model test is disclosed. Provider switching clears credentials/hidden overrides/catalog, restoring nonsensitive provider-specific model choices.
- Guarded preferences survive blocked/quota storage in memory. Mode is carried in the URL rather than depending on persistence before reload. Session-only model keys are available.
- Added learning, ordering, media and length preference controls; both modes validate custom post and profile link templates.
- Verification: web typecheck and all 167 web tests pass.

### Visible recovery and accessibility

- Unified shell/action toasts; visible/clickable popover state and persistent Retry with Dismiss. Removed the unused legacy toast element.
- Hosted cold startup errors have their own visible recovery gate. Permissions accurately describe retained action permission at login.
- Failed scores read “Not ranked yet” and sort behind genuine results. Permanent provider errors stop retries/batches; optional Authorization supports local models. Ranker rejects invalid chunk/concurrency bounds.
- Show-notes tabs have Arrow/Home/End behavior and panel associations; named login dialog announces progress. Light focus, tertiary contrast, narrow action/menu layouts and explicit reduced-motion states corrected.
- Verification: 201 combined library/web tests and web typecheck pass. No live WCAG certification is claimed.

### Learning and relay resources

- Native relay max-wait plus bounded worker pools/deadlines for content, embed and profile queries. Internally owned pools are destroyed; test-injected pools close all touched fallback/outbox relays.
- Profiles enrich without holding up cached/scored content. Learning uses the previous taste immediately and runs independently, single-flight per identity, no more than hourly automatically.
- BYOK and hosted share incremental learning with processed reaction IDs, reaction-time watermarks, overlap and a durable bounded-page catch-up cursor. Context changes cannot commit another reader's taste; learning-off does not use learned taste.
- Manual Update learned taste uses the same incremental path and guaranteed teardown.
- Full workspace build passes; 204 combined library/web tests pass. Server selection fixture now asserts best unique notes are selected before cutting, rather than preserving the old premature-cut bug.

### Shared jobs, provider capacity and durable delivery

- Feed lock precedes billing awaits. Same-context feed/digest work is single-flight and short-lived results are reused; database-owned renewable pipeline claims prevent competing processes from doing the same ranking.
- One shared provider budget spans scoring, learning, writing, humanizing and TTS; hosted uses 3 active calls / 90 request starts per minute with bounded intake/queues. Scheduler fills a free slot immediately.
- Digest claims have owner tokens and renewable heartbeats; startup preserves other healthy owners. Manual/scheduled work carries a 30-minute abort deadline through scoring/writer/TTS requests.
- Saved delivery-pending artifacts are retried without regeneration or another billing consumption. The durable DM outbox persists signed encrypted events before publication and retries the same IDs; accepted parts are skipped.
- No-upload servers do not synthesize unusable audio. Humanizer remains on by default and is configurable via `HUMANIZER_ENABLED=false`; vendored prompt untouched.
- Verification: full workspace build, 205 combined library/web tests, and 226 disposable-SQLite/mock-relay server tests pass, including race, lease and durable retry regressions.

### Safe updates, drafts and navigation

- Named idempotent activity gates protect overlapping ranking/payment, writer/TTS/learning, playback, signing/publication and open reply/zap tasks. Reload-now and worker-controller changes respect blockers.
- Public Tune/reply drafts persist per context without API keys; separate schedule/general saves clear only their own draft scope. Session-only API keys survive safe reloads in tab-scoped sessionStorage.
- Tab/digest/note routes restore meaningful navigation without autoplay; browser Back closes native sheets. Skip link and intentional view focus added.
- Release identity is no longer minute-resolution. Worker precaches actual shell dependencies, waits for safe activation and preserves the preceding cache for other active clients; version polling pauses hidden and rechecks online.
- Web production build and 168 tests pass. Actual browser history/focus/offline/update flows still require the unavailable live-browser pass.

### MP3 downloads, offline audio and playback resources

- Download MP3 for hosted and generated audio; authenticated ownership-checked, SSRF-guarded same-origin download fallback avoids third-party CORS failures. Download concurrency/rate/size are bounded.
- IndexedDB binary cache retains the newest three audio digests, at most 30 MB (15 MB per cached item), with opt-out, clear/size controls and truthful persistence failure messages. Explicit downloads allow up to 60 MB. Cached audio restores as a playable blob without network.
- Generated audio completion does not change a newer digest selection. Removed/cleared object URLs are revoked; source selection no longer preloads remote MP3 metadata.
- Resume records are parsed once and shared between player/history, playback only paints the visible player/mini, history paints on meaningful state changes, and unchanged icons/time strings are not rewritten. Waveform caches dimensions/theme colors.
- Added test-only IndexedDB and DOM fixtures dependencies. Production dependency audit reports zero vulnerabilities; npm flags three development dependency advisories for review before release.
- Verification: web/server builds and 170 web tests pass, including newest-three binary eviction/isolation/size tests. Actual airplane-mode/lock-screen playback still needs a live device.

### Stable rendering, storage and payloads (d92bda2, 7a08700, a2c3a19)

- Feed cards are reconciled in place by note id and content signature: score, name and avatar changes patch the existing card, so focus and loaded video survive progressive ranking. 50 cards at a time with an accessible Show next that moves focus to the first new note. While the reader is scrolled, rescoring keeps their reading order, but only when the "new" set is unchanged; a real refresh lays out afresh. One top-match edge, also announced in the card label. Mark subscriptions and preview observers are disposed with their cards and sheets.
- Feed snapshots and digest histories are IndexedDB records per mode and canonical identity; score day buckets are written per batch, in order, off the main thread. Existing localStorage data migrates on first read and the old key is removed only after a successful write; a legacy mode-global history is adopted only by the identity it belonged to. Snapshot trimming measures encoded bytes once per post. An unsaved BYOK digest says so.
- Hosted paints the last verified account's cache only until `/me` answers; another account or no session clears it first. BYOK identity changes in Tune clear the screen, and a run in flight saves only to its own identity.
- `GET /digests?summary=1` omits show notes and answers 304 to a matching ETag; background reads use it and coincident triggers share one request. Show notes load per digest and are kept on the device. `GET /feed/latest?since=` answers without posts when unchanged. Job polling pauses in hidden tabs.
- A digest seen in the list while its job runs is offered as ready, not delivered. An undelivered DM now finishes as `delivery_pending` (not `failed`), is resent for six hours, and an older one no longer blocks a new day's digest.

### Activation, scheduling, ordering and private feedback (bb72f12, af4bf60, fb08608, 4a8ef02, f6e6ff5)

- Mode gate: "Try without an API key" (recommended) and "Use my own model" (free), switching keeps both setups, link to the sample. Landing pricing buttons open their mode (`?mode=`), which is remembered. Landing claims corrected: daily DM delivery is hosted and opt-in, BYOK digests are on request, providers may charge. Sample player shows Pause only once playing, falls back to the transcript, seeks with Home/End.
- Unconfigured BYOK lists the three essentials with the next one marked; Finish setup focuses it. Both prompt fields have editable starters. A one-time note after the first ranking explains the scores (BYOK adds Try a digest).
- Daily delivery: after the first real listen (half a digest or to the end), one offer per account with zone, readable format and public-audio disclosure; never enabled otherwise. The Digests tab states whether delivery is on and the next run with its zone. "Which app reads your DMs?" replaces the protocol question; an unknown client now gets legacy DMs that Primal, Damus and modern apps read. Shortlisted voices have a server-made sample (one fixed sentence per voice per process; no digest written). The digest account opens in the chosen client.
- Status lines state coverage, window and order, and when the newest-500 cap applied. Why this? opens the note at its explanation, which calls the score the model's estimate against the reader's words and says it read the first 500 characters.
- The 3/6/10-minute digest length now reaches the writer in both modes as an upper bound; hosted stores it server-side. BYOK digests no longer use learned taste with learning off.
- Private feedback per identity: More like this, Less like this (also hides), Hide note, Hide a person's notes, Save for later; each with Undo, none published. More/less rules steer future ranking as explicit context after learned preferences (both modes; hosted via settings), so they apply with learning off and keep cached scores. Tune lists rules, hidden people and hidden notes with reversal; saved notes open from the feed header. Learned taste can be inspected and reset in both modes; a reset keeps which likes were already read.

### Media, responsive design, device privacy and visual refinement (7ebf98a, 7076ee0, 47b2068)

- Shared imeta contract (url, size, alt, type); the hosted server sends it with each post so tag-only media shows in both modes. Images reserve space when sized, show tall media whole, use the author's description or say there is none, decode asynchronously and link to the full file. Tap to load remote media now actually withholds images and avatars until asked.
- Tune explains per mode what is kept where and what goes to providers, relays, media hosts and billing. Export settings omits the model key unless separately ticked and never includes signer secrets. Disconnect signer; Clear this device (all storage, session storage, IndexedDB; hosted also signs out). Hosted Download my data (`GET /account/export`) and Delete my hosted data (`POST /account/delete`, the bot's transactional erasure), with in-place confirmations naming what stays (public audio, billing records). App shell has a CSP allowing scripts only from its own origin.
- Long menus scroll within a capped height, the new-notes pill only moves below the mini player when it shows, narrow cards keep full-height touch targets.

### Reliability details, docs and diagnostics (b2b2310, 828bae7, 4646cde, 7e9aaf3)

- Browser profile and relay-list caches are bounded (relay misses retried after ten minutes). Server retention prunes operational records daily in one tested routine; readers' data stays until they delete it.
- README and server README describe both modes, the current address, signer behaviour, new endpoints, DM fallback and retention, without local paths.
- One log line per hosted feed and digest run with phase times and counts, an 8-character key prefix and no content.
- Development advisories (vite, postcss, nanoid) resolved within range; `npm audit` reports none.
- Reviewed: sheet history replacement, activity gates and single-flight learning; no change needed.

### Still not verified

No live browser session was available (BrowserOS neo had no window/profile earlier in the work). Layout at real widths, 200% text, virtual keyboards, screen readers, offline/airplane playback, update activation during blocked work and the CSP in a real browser remain unverified beyond DOM fixtures. No real provider, payment, relay or DM delivery was exercised.
