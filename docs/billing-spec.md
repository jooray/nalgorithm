# Billing service: spec (Nalgorithm, Lievik, Emanator)

Status: DRAFT, 2026-09-29 (round 2 answers folded in). Nothing implemented. Lives in the nalgorithm repo for now; it moves to its own repo when the service is created.

## 1. Goal

One small service that answers "which products has this npub paid for, and until when?" for three clients: Nalgorithm (TypeScript), Lievik and Emanator (Rails 8.1). It takes payment through BTCPay, records it in an append-only ledger, and later accepts zaps and DMs as payment triggers.

## 2. Decisions taken

- Separate service with an HTTP API (Rails cannot import a TypeScript module).
- Key: the user's **login npub** (`users.npub` in both Rails apps), never an account, channel or source npub.
- BTCPay Server, own store, Greenfield API. Sats are paid straight into the operator's store.
- Prepaid time, pro rata: sats convert to days at the plan's rate.
- Products and rules:

| Product | Free part | Paid part | Trial |
|---|---|---|---|
| `nalgorithm` | nothing hosted | ranked feed + digests | 3 days per npub |
| `emanator-ai` | the whole app: composing, scheduling, reposts, profiles, DMs, Blossom, MCP | AI assist (generate and refine posts) | 3 days, started on first use of an AI feature, not on registration |
| `lievik` | source management, manual events, browsing, manual content | AI ranking, RAG chat, channel proposal, content generation | 3 days, started on first AI activation (first rating run or AI feature), not on registration |
| `all-access` | | grants all three above | none of its own |

- Prices per 30 days: `nalgorithm` 10,000 sats, `emanator-ai` 10,000, `lievik` 15,000, `all-access` 25,000 (the three sum to 35,000, so the bundle is a 29% discount).
- Trials are always 3 days, per (npub, product), started explicitly by the client on first AI activation with `POST /v1/trials`, never implicitly by a lookup.
- No rating cap. `jev-latest` costs $0.042 per million input tokens and nothing for output (checked against Venice's model list 2026-09-29), so ranking is negligible; it is flagged as a beta model though. The expensive calls are the Claude-based ones (digest, RAG chat, content generation, Emanator post generation). Those get a generous daily safety cap through `consume`, defaults in section 5.

## 3. Identity and trust

- Billing never authenticates humans. The apps already do (NIP-46, NIP-07 in both Rails apps; challenge signature plus DM for Nalgorithm). Each app calls billing server to server with its own API key and passes the login npub.
- Consequence: anyone may pay for any npub (gifting works), and nobody can read anything sensitive from billing, because it only holds npub, product, dates and sats.
- Apps must send `users.npub` (or hex) of the **logged-in user**. In Emanator the login npub is usually also the first managed `Account`, so a lookup by `accounts.npub` would be wrong. In Lievik `Source` rows are followed npubs and `Channel` is an output, neither is an identity.
- Per-client API keys (one for each app), stored hashed, revocable. Requests are rate limited per key.

## 4. Data model (SQLite)

- `payments` (append-only): `id`, `provider` (`btcpay` | `zap` | `manual`), `ref` (unique with provider), `npub`, `plan`, `sats`, `created_at`.
- `grants`: `npub`, `product`, `starts_at`, `until`, `payment_id` (nullable for trials). Entitlement for a product is the max `until` over its grants. A payment for plan `all-access` writes one grant per included product, each extended from `max(now, current until)`.
- `trials`: `npub`, `product`, `started_at`, `ends_at`, `units_used`. One row per (npub, product), unique.
- `usage`: `npub`, `product`, `kind`, `units`, `day`. Summed per day for caps.
- `clients`: `id`, `name`, `key_hash`.
- Corrections and refunds are new payment rows with negative sats, never edits.

Pro rata: `days = sats / plan.sats * plan.days`, rounded down to whole seconds of entitlement.

## 5. API

All calls carry `Authorization: Bearer <client key>`. JSON in and out.

| Call | Purpose |
|---|---|
| `GET /v1/entitlement/{npub}` | State for every product: `{ product: { state: "active"|"trial"|"expired"|"none", until } }`. Read only. |
| `POST /v1/trials` | `{ npub, product }` starts the 3-day trial once per (npub, product); 409 if already used. Called by the app on first AI activation. |
| `POST /v1/consume` | `{ npub, product, kind, units }` returns `{ allowed, remaining }`. Used for trial caps and daily fair-use caps. Idempotent with an optional `key`. |
| `POST /v1/charges` | `{ npub, plan }` creates a BTCPay invoice and returns `{ checkout_url, bolt11, expires_at }`. |
| `POST /webhooks/btcpay` | Signed by BTCPay. Verify `BTCPay-Sig` over the raw body, re-fetch the invoice, take the npub from its metadata, write payment and grants. Idempotent on invoice id. |
| `GET /v1/plans` | Public price list, for the apps' upgrade screens. |

Payment initiation never depends on a user session at billing: the app calls `POST /v1/charges` and redirects to `checkout_url`.

Default daily safety caps (units per npub per day, tunable in billing config, generous on purpose): `nalgorithm` digests 10, `emanator-ai` generations 200, `lievik` chat and content generations 500, `lievik` ratings 100,000.

Later: `POST /zap` receipts and DM activation (Nalgorithm spec section 5.4) write into the same ledger.

## 6. Client behaviour and failure policy

- Apps cache `GET /entitlement` for 60 seconds (`Rails.cache` in Rails).
- Billing unreachable: use the last cached value for up to 24 hours (stale while error), otherwise deny the paid feature and keep every free feature working. A billing outage must never break free features.
- `consume` failures for trial caps deny; for paid users they allow and log (never block a paying user on our outage).

## 7. Integration per app

### 7.1 Nalgorithm
The server checks entitlement before feed requests and before each scheduled digest job, and calls `consume` for trial caps. Bot DM commands work for trial and active users only; an expired user gets a single payment reply.

### 7.2 Emanator (Rails)
Free: everything except AI assist. Gate exactly `AiAssistController` (`generate`, `generate_stream`, `refine`, `refine_stream`) with `before_action :require_ai_entitlement!` for product `emanator-ai`. Return HTTP 402 JSON with the `checkout_url` for the JSON endpoints; the composer shows an upgrade prompt instead of the AI buttons. Keep the existing `rate_limit` (20 generate and 40 refine per hour) as the abuse ceiling. Each streamed call costs two LLM calls (draft then humanize), so a per-day cap through `consume` is worth adding. No AI in MCP tools or jobs, so nothing else to gate.

### 7.3 Lievik (Rails)
Ranking is the cost driver and it runs unattended: `SourceIngestionJob` enqueues `RateEventsJob` for every channel whenever new events arrive, and `RefreshAllSourcesJob` runs every 30 minutes for every user. So the gate must be at the job level, not only on buttons:
- `RateEventsJob#perform`: check the channel owner's entitlement before rating; for trials, `consume` per batch of up to 50 events and stop when denied.
- `RefreshAllSourcesJob` and `SourceIngestionJob`: skip users with state `expired` or `none`, so ingestion (relay and RSS load) also pauses; data stays readable, and it resumes on payment.
- Interactive AI: `RagChatController`, `ChannelAiChatController`, `ChannelContentsController` (`generate_stream`, `refine_stream`) with the same `before_action`. These have no rate limits today; add them.
- MCP: `rate_channel` and `search_events` (embeddings) need the same check.
Trial: time only, 3 days, started on first AI activation.

### 7.4 Rails plumbing (both apps)
`Billing::Client` using `httpx` (already a dependency; same as `Ai::Client`), a small `Billing::Entitlement` cache wrapper, and a concern for the `before_action`. Config: `BILLING_API_URL` and `BILLING_API_TOKEN` in the service's environment, non-secret settings in a `billing:` block in `config/emanator.yml` / `config/lievik.yml`. Lievik routes outbound calls through `Security::EgressGuard`; the billing host must be allowlisted there.

## 8. Bundle

`all-access` (25,000 sats per 30 days) grants `nalgorithm`, `lievik` and `emanator-ai` together. Grants extend independently per product, so a user with existing paid time on one product loses nothing by buying the bundle. At the current prices the bundle is 25k against 35k separately.

## 9. Deployment

Node, TypeScript, SQLite or MariaDB (`DATABASE_URL`), run as a service behind a reverse proxy on its own path or subdomain, reachable only from the apps. Secrets (`BTCPAY_API_KEY`, webhook secret, client keys) in a mode 600 `.env`. Back up the database regularly, because the ledger is the only irreplaceable data.

## 10. Phases

1. Ledger, entitlement API, client keys, manual grants by admin CLI. Nalgorithm and both Rails clients can integrate against this.
2. BTCPay charges and webhook.
3. Trials and `consume`.
4. Zap and DM activation.

## 11. Open questions

Answered 2026-09-29: standalone prices (emanator-ai 10k, lievik 15k), 3-day trials started on AI activation, no rating cap, ingestion stops after trial or expiry.

Still open:
Q5. Should existing Lievik and Emanator users be grandfathered, or start a trial on first AI activation after launch? (Proposed: trial on first activation, no grandfathering.)
Q6. Which of the safety caps in section 5 are acceptable, and should they live in billing config or each app?
Q7. Lievik after expiry: confirm the data stays readable and resumes ingestion on payment.
