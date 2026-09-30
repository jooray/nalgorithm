# Emanator: billing integration plan

From a read-only exploration of the nostr-emanator repository on 2026-09-29 (Rails 8.1). Nothing has been changed in Emanator. Product `emanator-ai`, 10k sats per 30 days, 3-day trial on first AI use, everything else stays free. Billing API: the nostr-billing README.

## Facts that shape it

- The only AI code is `app/controllers/ai_assist_controller.rb`: `generate`, `generate_stream`, `refine`, `refine_stream` (routes `config/routes.rb` 111-114). The non-stream actions have no UI caller, but all four must be gated. Only the `_stream` URLs are wired in `app/views/posts/new.html.erb` and `edit.html.erb`. Each stream makes two LLM calls (draft, then humanize) and answers as SSE (`phase`, `chunk`, `complete`, `error`).
- Existing limits: `rate_limit` 20/hour (generate) and 40/hour (refine) keyed by `current_user&.id`, handled by `ai_rate_limited` (stream actions answer HTTP 200 with an SSE `error` frame, JSON actions 429).
- No job and no MCP tool calls AI (grep of `app/jobs` and `app/services/mcp/tools`). API-token users cannot reach `AiAssistController`. Nothing else to gate.
- Login npub versus account npub: `users.npub` is the login npub. `SessionsController#import_primary_account` creates the first `Account` with the same key as the login, and AI actions look up `current_user.accounts.find(params[:account_id])`. The billing key must be `current_user.npub`, never `account.npub`.
- `ai.provider: mock` in `config/emanator.yml` is inert today (no code reads it). The billing mock must be a real object.
- Test env uses `:null_store`; `test/support/cache_helper.rb` swaps in a `MemoryStore`. No mocha or webmock in the Gemfile.
- CSP has `form_action :self` and `connect_src :self`, which breaks a redirect to the checkout URL after a form post.
- Locales: en, sk, cs, es under `config/locales/<area>/<locale>.yml`; `test/i18n/locale_files_test.rb` requires key parity.

## Files to add

- `app/services/billing.rb` (facade: `Billing.client`, `Billing.client=` test seam, `enabled?`, `PRODUCT = "emanator-ai"`; provider `http | mock | off`).
- `app/services/billing/client.rb`: httpx client like `Ai::Client`, Bearer token from `ENV["BILLING_API_TOKEN"]`, URL from `ENV["BILLING_API_URL"]`, timeouts connect 2 / read 4 / request 5, no automatic retries. Errors: `Unavailable` (timeout, 5xx, 429), `Conflict` (409), `BadRequest`, `Error` (401/403, a configuration bug). Methods: `entitlement`, `start_trial`, `consume`, `create_charge`, `charge`.
- `app/services/billing/entitlement.rb`: cache wrapper. Fresh key 60 s, stale key 24 h written on every success, circuit-breaker key 10 s. Re-checks `until` locally so stale data never grants past its own end. `start_trial!` treats 409 as success and then re-reads (the re-read is the truth). `consume!` on outage: allow if last known state was active, deny for trial or unknown.
- `app/controllers/concerns/require_ai_entitlement.rb`: `before_action :require_ai_entitlement!` (402 or 503) plus `consume_ai_units!` (daily cap 429), included in `AiAssistController` only.
- `app/controllers/billing_controller.rb`, `app/helpers/billing_helper.rb`, views `billing/{show,checkout,return}`, `posts/_ai_paywall`, Stimulus `billing_poll_controller.js`, locale files, `test/support/billing_helper.rb`, tests.

## Files to change

`ai_assist_controller.rb`, `posts_controller.rb` (`@ai_entitlement` in `new`/`edit`, rescued), `posts/new` and `edit` views, `content_builder_controller.js` (handle 402/503/429 in `streamSSE`), `routes.rb`, `config/emanator.yml` (`billing:` block; `development: provider: off`, `test: provider: mock`), `config/locales/posts/*`, `.env.example`, `AGENTS.md`, `README.md`.

## Behaviour

- Callback order: `authenticate_user!`, `require_ai_entitlement!`, the two `rate_limit` lines, `consume_ai_units!`. An unpaid user never touches the hourly bucket or the daily units, and a rate-limited request never spends units.
- First use starts the trial: in `require_ai_entitlement!` when the state is `none`, after checking that the account belongs to the user and the prompt is not blank (a forged request must not burn the one-time trial). No local trial column: billing is the only source of truth.
- Denials come as real HTTP statuses with JSON before any SSE header is written: 402 `{code: "paywall", billing_url: "/billing"}`, 503 `billing_unavailable`, 429 `daily_cap` (distinct from the hourly `rate_limited`). The composer shows an upgrade card. A stream counts 2 consume units, a JSON call 1, kinds `generate` and `refine`. Units are not refunded if the model call then fails.
- The 402 carries `/billing`, not a ready `checkout_url`, so blocked clicks do not create BTCPay invoices.
- Payment: `/billing` page, `POST /billing/charge` with an allowlisted plan, then an interstitial page with a plain link to the validated `checkout_url` (not a `redirect_to` from a form post, because of CSP), then polling `GET /billing/charges/:id` (which checks the id against the session, since billing does not authenticate users) and `refresh!` on settle.
- Billing outage never breaks free features; a cold cache denies only the AI actions.
- `Security::UrlGuard` is not used on the billing API URL (operator config, loopback in production); only `UrlGuard.parse(checkout_url, %w[https])` for the redirect target.

## Rollout

1. Billing live with a client key for Emanator; check the endpoints with curl.
2. Ship Emanator code with `provider: off` (allow all). No visible change.
3. Shadow mode: `provider: http`, log the result without enforcing.
4. Enable enforcement together with BTCPay payments, never before payments work.
5. Ship the `/billing` pages and test with a small `sats` charge.
6. Tell existing users first: their first AI use starts a 3-day trial.

## Open questions for the owner

1. 402 body: `/billing` only (recommended) or a ready `checkout_url`?
2. Return URL after payment: billing currently has one `BILLING_REDIRECT_URL` for all apps. Add a per-client or per-charge redirect, or poll from the original tab (the plan builds the polling first).
3. Existing Emanator users: fresh 3-day trial on first AI use, or a longer grace period granted through the admin CLI?
4. Should caps live in billing config or `emanator.yml`, and is 2 units per stream right?
5. Is 503 on a cold cache during a billing outage acceptable?
6. Billing URL internal (`http://127.0.0.1:8340`) or public HTTPS?
7. Should `/billing` on Emanator also offer the 25k all-access bundle?

Answered by billing already: `POST /v1/charges` returns `invoice_id` and `checkout_url`.
