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
| Safe updates, drafts and navigation | F16, F33, F37 | Pending |
| Offline/download audio and efficient playback | F19, F23, F24 | Pending |
| Stable rendering, storage and payloads | F20, F21, F22 | Pending |
| Activation, schedule, ordering and private feedback | F25, F27, F28, F29 | Pending |
| Media, responsive design, device privacy and visual refinement | F30, F31, F34, F40 | Pending |
| Documentation, fixtures, tests and observability | F36, F38 | Pending |
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
