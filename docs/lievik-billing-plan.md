# Lievik: billing integration plan

From a read-only exploration of the lievik repository on 2026-09-29 (Rails 8.1, RSpec). Nothing has been changed in Lievik. Product `lievik`, 15k sats per 30 days (all-access 25k also grants it), 3-day trial started on first AI activation, no rating cap, ingestion stops after trial end or payment expiry. Companion: `emanator-billing-plan.md`.

## Facts that shape it

- Tests are RSpec (`spec/`), stubbing with `allow(...)`/`allow_any_instance_of(ApplicationController).to receive(:current_user)`. `spec/i18n/locale_files_spec.rb` requires identical keys in en, sk, cs, es. `spec/requests/csp_compliance_spec.rb` bans inline handlers. `test: ai: provider: mock` in `config/lievik.yml` is inert; the billing mock must be real code.
- Test cache is `:null_store`, production `:solid_cache_store`. Job locks live in `Rails.cache`: `rate-events-job:channel:<id>`, `rate-events-job:user:<id>`, `source-ingestion-lock:<id>` (30 min TTL).
- `Security::EgressGuard` is GET only and blocks loopback and private ranges, so it cannot serve billing. `Ai::Client` already calls configured endpoints with HTTPX directly, which is the precedent. Validate the billing URL at boot instead (https, or http only for loopback).
- CSP `form_action :self` breaks a form-post redirect to the checkout URL, so use a plain link plus polling.
- Ranking runs unattended: `SourceIngestionJob` enqueues `RateEventsJob` per channel when new events arrive, and `RefreshAllSourcesJob` runs every 30 minutes for all users. The gate must be in the jobs, not only on buttons.

## Rule (needs the owner's confirmation, see Q1)

`allows_ai?` is true for `active` and `trial`. `allows_ingestion?` is true for `active`, `trial` and `none`, false for `expired`, false for unknown without a stale cache. Jobs skip and never raise. User actions tell the user. Reason for allowing `none`: the trial starts on the first AI action, which needs data to exist; blocking `none` would leave a new user with nothing to rate. Blocking `expired` is exactly "after trial ends or payment runs out".

## Files to add

- `app/services/billing/client.rb` (HTTPX, Bearer token from `ENV["BILLING_API_TOKEN"]`, URL from `ENV["BILLING_API_URL"]`, timeouts 2/3/3/5, GET retried once; errors `Unavailable` for timeouts, 5xx, 401, 429, 503, and `Conflict` for 409 with the reason). Methods: `entitlement`, `start_trial`, `consume`, `create_charge`, `charge`.
- `app/services/billing/mock_client.rb` (in-memory, settable state and consume result, default `:active` so existing specs pass).
- `app/services/billing/entitlement.rb`: `Snapshot` with source `fresh|cache|stale|unknown|disabled`; keys `billing:ent:v1:<npub>` (60 s) and `billing:ent:stale:v1:<npub>` (24 h), a 15 s `billing:down:v1` circuit breaker, `race_condition_ttl: 10`, `allows_ai?`, `allows_ingestion?`, `invalidate!`, `ensure_trial!` (409 is fine, then re-read), `consume` with unique keys `lievik:<kind>:<user.id>:<uuid>` (returns `:allowed`, `:capped`, `:unavailable`; on outage allow only if cached state was active).
- `app/jobs/concerns/billing_gated.rb` (`skip_unless_entitled!`, never raises).
- `app/controllers/concerns/billing_gate.rb` (`gate_ai only:, kind:, deny: :json|:redirect, activate:`), included in `ApplicationController`, nothing gated by default.
- `app/controllers/billing_controller.rb` (`show`, `status` lazy frame, `start_trial`, `create_charge`, `charge` HTML and JSON), `app/services/billing/resume.rb`, `config/initializers/billing.rb`, views, `billing_poll_controller.js`, locale area `billing/` in four languages.

## Gating points

Jobs (check before `claim_lock` so a denied job never strands a lock):
- `RateEventsJob#perform`: right after finding the channel, before the batch re-split and before `claim_lock`; return after one log line.
- `SourceIngestionJob#perform`: after `Source.find_by`, before the lock write.
- `RefreshAllSourcesJob#perform`: filter at enqueue time, evaluating each user once, so denied users' sources are never enqueued.
- Optional: skip AI link summarization (`Links::SummarizationService`) for denied owners (Q6). Leave embeddings ungated (local Ollama).

Interactive AI (JSON 402 before any stream header; 429 `daily_cap`; 503 `billing_unavailable`):
- `RagChatController#ask`, `#ask_stream` (kind `chat`).
- `ChannelAiChatController#stream` (kind `chat`); `#bulk_create` still creates channels, only skips the initial rating and returns `rating_skipped: true`.
- `ChannelContentsController#generate_stream`, `#refine_stream` (kind `content`), declared after `set_channel` so 404s win, and before `add_version` so a denied generation saves nothing.
- One consume unit per request (a stream counts 1 for `content`, Q5).

Enqueue buttons (HTML, redirect to `/billing` with an alert): `DashboardController#rate_all`, `ChannelsController#rate`, `ChannelEventsController#bulk_rate`, `EventsController#bulk_rate`, `ActivityLogsController#retry_job`, `ChannelsController#create` (channel saved, rating skipped), `SourcesController#refresh`, `#refresh_all`, `#create` (source saved, import paused).

MCP: `rate_channel` and `search_events` need entitlement, `refresh_source` needs the ingestion check; denial is a JSON-RPC error `-32001 payment_required` with a billing URL (`app/services/mcp/tools/base.rb`, `app/controllers/mcp/server_controller.rb`). `add_manual_event` is never denied. `ManualEvents::Creator` always creates the event and only skips the rating enqueue (`rating_skipped` in its result).

UI: a lazy `<turbo-frame id="billing-status">` in `layouts/application.html.erb` so pages never wait on billing; strips for trial, expired, and none; a Billing nav link with a state chip; `billing/_locked` partial in `rag_chat/index`, `channel_ai_chat/index`, `channel_contents/edit`; the dashboard's rate-all button becomes an upgrade CTA when denied; JS handlers for 402/429/503 in `rag_chat_controller.js`, `channel_ai_chat_controller.js`, `content_builder_controller.js`.

## First AI activation (trial start)

`POST /v1/trials` only from a user-initiated request about to do AI work, via `BillingGate activate: true`: first message in `ChannelAiChatController#stream`; channel create with a prompt when events exist to back-rate; RAG chat; content generate/refine; the explicit Start trial button; MCP `rate_channel`; and the explicit rate buttons. Never from a job, a GET, `ManualEvents::Creator` or login. After starting, invalidate the cache, re-read, and call `Billing::Resume` if now trial or active.

Do not start the trial from the first background rating run: at launch that would silently start the trial for every existing user on the next 30-minute cycle, and three days later everything would stop without warning (Q2).

## Payment flow

`GET /billing` shows state, the Lievik plan (15,000 sats), all-access (25,000), and an optional sats field (1,000 to 1,000,000, pro rata). `POST /billing/charges` allowlists the plan, calls create_charge for `current_user.npub`, stores `{id, checkout_url}` in `session[:billing_charges]` (billing's `GET /v1/charges/:id` does not return the URL and does not prove ownership), then redirects to `/billing/charges/:id`, which shows a "Pay now" link (`target=_blank rel=noopener`) and polls the `.json` variant every 3 s for about 15 minutes. On settled: invalidate the cache, `Billing::Resume.call` once (guarded by a cache key), show "ranking resumes". `Resume` matters because skipped jobs are consumed, not retried: it enqueues a refresh and one unrated-path `RateEventsJob` per channel.

## Data

None. Billing is the source of truth; `Rails.cache` holds the state. Worst case after a cache eviction is `unknown` (AI denied, free features fine).

## Tests (RSpec)

`spec/support/billing_helpers.rb` (`stub_billing(state:, until:, consume:)`, a memory-store cache helper); specs for the client, the entitlement cache (fresh/stale/unknown, breaker, trial 409, consume outage policy), `RateEventsJob` (denied leaves no ActivityLog, no lock, no follow-up), ingestion jobs (denied users not enqueued, one entitlement call per user), request specs for every gated endpoint (402/429/redirect, `add_version` not called), first activation calls `start_trial` exactly once, free pages return 200 when billing is unknown, billing pages in four locales and in the CSP walk, MCP errors, `ManualEvents::Creator`. Run `bundle exec rspec`, `bin/rubocop`, `bin/brakeman`.

## Rollout

Ship dark (`billing.enforce: false`), set the URL and token only once billing is deployed with a Lievik client key, run a shadow phase logging `would_deny`, announce, then enforce. Existing users are all `none`: rating and AI stop until they start a trial, so the banner and a Start trial button must exist on day one. Watch the rate of `unknown`.

## Open questions

1. Confirm: ingestion runs for `none`, blocked for `expired` only.
2. Trial start only from explicit user actions and the button, not from the first background rating run (recommended)?
3. Fail closed in production if `BILLING_API_URL` is missing; everyone `active` in dev and test?
4. Billing service on 127.0.0.1, a private network, or a public domain? Confirms bypassing `EgressGuard`.
5. Caps in billing config only; does a `generate_stream` count 1 unit or 2; should `search_events` consume anything? (No rating consume, per the decision.)
6. Gate AI link summarization for denied users?
7. Payment page: fixed plan plus all-access plus optional custom sats; offer gifting another npub?
8. `BILLING_REDIRECT_URL` is one value for all apps; add a per-charge redirect (being added to billing) or rely on the polling page.
9. Who reviews the sk, cs and es strings?
