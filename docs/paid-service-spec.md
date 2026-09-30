# Nalgorithm hosted (prepaid) service: research and spec

Status: DRAFT for discussion, 2026-09-29. Nothing here is implemented.

Decisions so far: BTCPay Server for payment; server code in this repo under MIT; DM voice as kind 14 with a Blossom URL plus digest text; service signing key in an env var.

Round 3 (same day): billing becomes a separate service shared with Lievik and Emanator (`docs/billing-spec.md`); humanizer on by default with `deepseek-v4-1-flash` (about $0.01 per digest at Venice list prices, to be A/B-tested against `kimi-k3`); BTCPay takes payment directly; the bot has its own npub (see 8.5).

Round 2 (same day): the hosted feed is paid too, with a 3-day free trial per npub; price 10k sats per 30 days, partial periods credited pro rata; sats are paid straight into the operator's BTCPay store; rate limiting across users is out of scope for now; Nostr DMs are a first-class control channel (sections 4 and 8).

## 1. Goal

A hosted version of nalgorithm where an npub prepays for a period of time and gets:

1. a web feed ranked server-side (Venice `jev-latest` decision scorer),
2. scheduled voice digests: LLM digest, optional humanizer, Venice TTS, upload to Blossom, delivered as a Nostr DM.

The free BYOK web app and the CLI stay. All three must use the same ranking engine.

## 2. What the research found

### 2.1 nsite-clay is a weaker precedent than assumed

nsite-clay has no server and no npub-bound account. The npub only encrypts a Routstr API key into a NIP-78 vault event. Payment is a Cashu mint quote (Lightning invoice paid to a mint), polled by the browser, then split: half to the user's Routstr balance, half forwarded as a Cashu token to a donation endpoint. There is no expiry, no NIP-98, no zaps, no DMs.

The Cashu flow is not reused (BTCPay was chosen, section 5.3). Everything else (accounts, entitlement, auth, scheduler, delivery) is new.

### 2.2 The nalgorithm core is already server-ready

- `lib/` has no browser APIs and no `node:` imports. It is stateless; callers own the caches.
- `digest/` (Node CLI) already runs the full pipeline headless: follows, posts, profiles, learned prompt, scoring with cache, top-N, digest, fallback model, humanizer, TTS.
- Gaps: the CLI duplicates digest prompt building instead of calling lib `generateDigest`; the pipeline orchestration lives in `digest/src/main.ts`, not in lib; caches are JSON files; lib logs with `console.warn`; `createPacer` is per instance (a shared Venice key needs a shared limiter); there are no tests; `lib/docs/API.md` is stale.
- Login in the web app only reads a pubkey (NIP-07 / NIP-46 `get_public_key` / pasted npub). Nothing proves key ownership. A paid service needs real proof.
- No DM code exists. `nostr-tools` 2.23 ships `nip17`, `nip44`, `nip59`.
- Relay reads are public only (no NIP-42).

### 2.3 External facts (verified by search, re-check before building)

- **NIP-17** DMs: kind 14 chat message, kind 15 file message (encrypted file, MIME in `file-type` tag), sealed (kind 13) and gift-wrapped (kind 1059), one wrap per recipient and one for the sender. Recipient relays come from kind 10050.
- **NIP-A0** voice messages (kind 1222/1244) are public notes, not DMs. Not suitable here.
- **NIP-57** zaps: a zap receipt (kind 9735) is only trustworthy if signed by the `nostrPubkey` advertised by the LNURL endpoint of the recipient. If we run that endpoint ourselves, we know the key.
- **BTCPay Greenfield**: create invoice with `metadata`, signed webhooks (`BTCPay-Sig`), `InvoiceSettled` event.
- **Venice**: decision endpoint limit 100 req/min per key with a 30 s lockout after 50 failures (from lib code comments). TTS model `tts-kokoro`.

## 3. Architecture

```
web (existing PWA)  --hosted mode-->  server (new, Node)  --imports-->  lib (shared engine)
                                        |- auth (NIP-98 challenge -> session)
                                        |- payments (provider interface)
                                        |- storage (SQLite)
                                        |- scheduler + job runner
                                        |- delivery (TTS, Blossom, NIP-17)
```

### 3.1 One engine, no divergence

Move the pipeline out of `digest/src/main.ts` into `lib` as `runDigestPipeline(deps)`, with injected:

- `Store` interface (score cache, learned prompt, last-like watermark). Implementations: JSON files (CLI), SQLite (server), localStorage (web, later).
- `Logger` interface (replaces `console.warn`).
- `RateLimiter` interface (shared across users on the server).

The CLI is then a thin wrapper, and the server calls the same function. Add tests for the pure parts (score parsing, cache keys, chunking) before refactoring, since none exist.

### 3.2 Repository and licence

Decided: new workspace `server/` in this repo, MIT like the rest. Reasons: no private fork to keep in sync, the engine is already public, and payment logic has no secrets in code (keys come from env). Only deployment config and secrets stay private. Closed source is possible later by moving `server/` to a private repo that depends on the published `nalgorithm` package; the `Store`/`Logger` seams make that cheap.

### 3.3 Web app

Add a `Backend` abstraction: `local` (today's BYOK path) and `hosted` (calls the server, no API key in the browser). Same renderer. Hosted mode streams progressive scores over SSE so the current progressive UI keeps working. Must keep the PWA version check (mandatory per user rule): bump `web` version on every release; the server API also reports a min client version.

## 4. Authentication and control channels

Why proof of key ownership at all: not for reading a public feed, but so a stranger who types your npub cannot change your prompt or schedule, redirect your digest DMs, or burn your prepaid time.

Two channels, one account (hex pubkey). Payments and entitlements never reference a session.

**Web (Amber / NIP-46 or NIP-07).** `POST /auth/challenge` returns a nonce; the client signs a kind 27235 event (tags `u`, `method`, nonce); the server verifies signature, freshness and single use, then issues an opaque session token (stored hashed, 30 days, revocable). One signature per device, since signing every request is impractical with Amber. The NIP-46 login must request `sign_event:27235`.

**Nostr DM (no web at all).** An incoming NIP-17 DM is authenticated by the seal signature, so a valid DM is a login. The bot accepts commands such as `prompt: ...`, `time: 07:30`, `tz: Europe/Bratislava`, `voice: ...`, `status`, `pause`, `stop`, and replies by DM. Rules taken from nostr-emanator (section 8.3): enforce `seal.pubkey == rumor.pubkey`, dedupe on wrap id and rumor id, and treat the wrap timestamp as random (track our own "seen at" watermark).

Both channels write the same `settings` row. The first DM from an unknown npub starts the 3-day trial and replies with how to pay.

## 5. Payments

> Superseded in structure by `docs/billing-spec.md`: payment, ledger and entitlement live in a separate billing service shared with Lievik and Emanator. This section stays as the nalgorithm-side view (what it asks billing for, and the BTCPay and zap details that the billing service implements).

### 5.1 Model

Prepaid time. `paid_until = max(now, paid_until) + period`. Append-only `payments` ledger; entitlement is derived, so refunds or corrections are new rows.

Price: 10,000 sats per 30 days (about 333 sats per day). Partial periods are credited pro rata (5,000 sats gives 15 days), so `paid_until` advances by `sats / 10000 * 30 days`. Trial: 3 days per npub, with a cap on scored posts and digests so farming fresh keys yields little. Per-user costs still need measuring with `scripts/bench-scorers.mjs` to confirm the margin.

### 5.2 Provider interface

```ts
interface PaymentProvider {
  createCharge(npub: string, plan: Plan): Promise<{ id: string; bolt11: string; expiresAt: number }>
  // provider calls back (webhook/poll) -> recordPayment({ npub, provider, ref, sats, plan })
}
```

Idempotent on `(provider, ref)`.

### 5.3 Provider (decided): BTCPay Server

Decision 2026-09-29: BTCPay Server, via the Greenfield API.

Flow:
1. `POST /api/v1/stores/{storeId}/invoices` with `amount` in sats (currency `SATS`), `metadata: { npub, plan }`, and a short expiry. Show the returned Lightning invoice / checkout link.
2. Register a webhook for `InvoiceSettled`. Verify the `BTCPay-Sig` HMAC over the raw body, then re-fetch the invoice by id before crediting (do not trust the payload alone). Take the npub from invoice metadata, never from the request.
3. `recordPayment({ provider: 'btcpay', ref: invoiceId, npub, sats })`, idempotent on `(provider, ref)`. Poll `GET invoices/{id}` as a fallback if a webhook is missed.
4. Use a dedicated store with a scoped API key (`btcpay.store.cancreateinvoice`, `btcpay.store.canviewinvoices`, webhook management only if needed).

Settlement (decided): users pay BTCPay invoices directly and the sats land in the operator's BTCPay store. There is no other settlement step. The store is created by hand and paired with the billing service through a Greenfield API key.

Reused from the earlier idea: none of the nsite-clay Cashu code is needed. A Cashu provider can still be added behind the same `PaymentProvider` interface later.

Trust: BTCPay is self-hosted (or the user's instance), so there is no third-party mint in the path. The server holds only an API key and a webhook secret.

### 5.4 Zap activation (later, design now)

With BTCPay the zap path changes: we do not control the LNURL endpoint unless BTCPay provides one. Two routes, to be verified before committing (I have not checked BTCPay's current Nostr zap support):

- **A. BTCPay LNURL / Lightning address with `allowsNostr`.** If the BTCPay store's Lightning address supports NIP-57 and publishes zap receipts signed by a known `nostrPubkey`, the server subscribes to kind 9735 events tagged `p` = nalgorithm npub, and accepts a receipt only if (1) signed by that `nostrPubkey`, (2) the embedded kind 9734 request is valid and its `amount` matches the receipt's BOLT11 amount, (3) the invoice was actually settled (cross-check the BTCPay invoice by payment hash). Payer npub = zap request `pubkey`.
- **B. Own thin LNURL-pay endpoint on the server**, whose callback creates a BTCPay invoice (metadata carries the zap request) and, on `InvoiceSettled`, signs and publishes the kind 9735 receipt with the service key. Full control, more code.

Either way the ledger takes `provider: 'zap'` with `ref = zapRequestId` and anonymous/privacy zaps (no usable payer) credit nothing and get a guidance reply. Partial periods are pro rata, as in 5.1.

**Zapping on behalf of another npub.** The zap request (kind 9734) is signed by the payer, so the payer is authenticated. Wallets rarely let users add custom tags, but they always allow a comment. Rule: if the comment contains an `npub1...` or `nprofile1...`, credit that npub; otherwise credit the payer. This is safe because crediting a stranger only benefits them. Anonymous zaps work when the comment names an npub. The bot DMs the credited npub (and the payer, if known) so nobody is surprised.

## 6. Storage

SQLite (Node 26 has `node:sqlite`, otherwise `better-sqlite3`). Tables: `accounts`, `sessions`, `payments`, `entitlements` (view), `settings` (prompt, relays, schedule, timezone, voice, delivery on/off), `score_cache`, `learned_prompt`, `digests`, `deliveries`, `jobs`.

Privacy: the server sees follows, likes and the user's taste prompt. Retention limits: score cache 30 days, digest history 30 days, all deletable by the user. State this on the pricing page.

## 7. Feed and digest jobs

- Feed request: `runDigestPipeline` in feed mode (score only), cache-first, SSE progress. Rate limited per npub.
- Digest job per user at their local time: pipeline, then `generateDigest(forSpeech: true)` and `humanizeText` (both on by default, decided 2026-09-30, so no markdown reaches the voice), then delivery. Humanizer adds a ~16k-token prompt call, so it is a plan option.
- Scheduler: in-process tick every minute reading the `jobs` table (survives restart). Jobs are staggered with jitter to respect the shared Venice limit.
- Hosted default is `scorer: 'decision'`, `jev-latest`. Cross-user rate limiting is out of scope until there are many users; jobs are still staggered with jitter and the `RateLimiter` interface stays as a seam.
- Cost guard: per-user daily caps (posts scored, digests, TTS characters), so a paid npub cannot exceed margin.
- Expired npubs: jobs stop; data kept for a grace period, then deleted.

## 8. Delivery: TTS, Blossom, DM

### 8.1 Pipeline

1. `synthesizeSpeech` (Venice `tts-kokoro`, mp3, existing chunking).
2. Upload to Blossom (BUD-02 `PUT /upload`) with a kind 24242 auth event (`t`, `x` = sha256, `expiration`) signed by the service key. Two servers for redundancy. The returned URL must end in `.mp3` (append it if the server omits it) and be served as `audio/mpeg`; verify on the chosen servers, because clients and browsers decide inline playback by extension and type.
3. DM the user (8.2).

### 8.2 Message format (decided: widest reach)

One NIP-17 kind 14 message whose content is the digest text followed by the plain https `.mp3` URL. Clients that render audio show a player; every other client shows a link that plays in any browser. No kind 15 encrypted audio for now (no client support to lean on, and emanator itself cannot send or open it). Trade-off accepted: the audio URL is unguessable but not secret.

Plus a self-copy wrap to the service npub, as emanator does (NIP-17 has no sent history).

### 8.3 Deliverability rules (from nostr-emanator; it is Rails, so we port decisions, not code)

nostr-emanator is a Rails 8 scheduler with a NIP-17 messaging tab. It sends a single format per message via a fallback ladder, cannot send kind 15, has no audio DMs, and signs through NIP-46. Its value is the measured client-compatibility knowledge in `AGENTS.md` ("Cross-client reach"), `config/emanator.yml` comments and commits 6fa1d1b, 53bf35a, f44ef46. Port these:

- Crypto: kind 14 rumor (unsigned) -> NIP-44 -> kind 13 seal (signed by us) -> NIP-44 with a fresh throwaway key -> kind 1059 wrap with a `p` tag. Seal and wrap `created_at` independently random, backdated 0-2 days, never future-dated (inbox.nostr.wine rejects skew over 300 s). In TypeScript use `nostr-tools` `nip17`/`nip59`/`nip44`.
- Relay targets, in order: recipient kind 10050 (up to 6), then their NIP-65 read relays, then fixed fallback DM relays, plus up to 3 observed relays where that peer's wraps have arrived (appended, never substituted; this is what reaches 0xchat and Keychat). Record the tier used per delivery. Filter attacker-controlled relay URLs.
- 10050 lookup: two phases (indexer relays incl. purplepag.es, then the recipient's write relays) before concluding "none". Unauthenticated lookup. Never publish a 10050 for a user unprompted (it overwrites theirs).
- Publish: fan out to at most 8 relays, 10 s timeout each, wait for `OK` matched on event id; delivered means at least one non-self relay accepted. emanator does no retries; we add retry with backoff and a read-back check.
- Known gaps to plan for: Primal and Damus do not read NIP-17 (Primal is kind 4 only), Amethyst needs a 10050, Coracle can silently publish to zero relays, Keychat has no 10050 and only answers `#p`-scoped 1059 filters, inbox.nostr.wine and auth.nostr1.com need NIP-42 to read 1059.
- **Kind 4 versus NIP-17 (decided design).** Neither emanator nor nostrautica detects this (both are NIP-17 only; nostrautica bans NIP-04), so the rule is ours. Signals, in order:
  1. **Mirror the peer.** Track per npub the kind of the last DM they sent us (`peer_dm_kind`). A kind 4 from them means their client speaks kind 4, so we reply and deliver in kind 4. A kind 1059 means NIP-17.
  2. **Explicit setting.** `dm: nip17 | legacy` set by DM command or in the web settings overrides the guess. A DM `legacy` command is the escape hatch for a user who never received anything.
  3. **Default for a user we have never heard from** (web signup, zap): NIP-17, and the first message says "if you see nothing, reply `legacy`". If they have no kind 10050 we still send NIP-17 to the fallback relays.
  We never send both formats for one message. The bot subscribes to kinds 4 and 1059 (`#p` = bot). Kind 4 needs the bot key on the relay whitelist (done, see 8.5), and inbound kind 4 is decrypted with NIP-04 (`nostr-tools/nip04`). Kind 4 leaks metadata and uses weaker crypto, so it is only ever used for users who chose it or wrote to us that way.
- Receiving: subscribe `{"kinds":[1059],"#p":[servicePubkey]}` on the service's 10050 relays plus a small discovery set; decrypt wrap -> seal -> rumor; check seal signature and `seal.pubkey == rumor.pubkey`; accept rumor kinds 14 only (15 gets a "please send text" reply); dedupe on wrap id and rumor id; watermark on our own seen-at time; poll every few minutes as a safety net; NIP-42 AUTH on relays that require it. The service must publish its own kind 10050 and NIP-65 lists.
- Service key is an env var, so unlike emanator there is no remote-signer round trip; local crypto is enough.

### 8.4 Reuse decision (nostrautica and deltachat read)

Neither project has kind 4 handling, kind 4 versus NIP-17 detection, or audio-link DMs.

- **nostrautica** (MIT): `packages/protocol/src/giftwrap.ts` has the hardened unwrap we want (wrap kind and signature, seal kind 13 and signature, `rumor.pubkey === seal.pubkey`, rumor id recomputed, `created_at` clamped). It is a private pnpm package with a kind allowlist (14 and its own kinds), so we copy the checks rather than depend on it. Its transport (`coordinator/src/nostr/client.ts`) proves headless Node works: `useWebSocketImplementation` plus `new SimplePool({ enableReconnect: true, enablePing: true })`. Without those two options a dropped socket leaves a daemon silently deaf. Also copied: send two wraps per message (recipient and self) around one rumor built once, a 3-day `since` on wrap subscriptions, and a durable seen-rumor ledger.
- **deltachat-desktop-nostr**: GPL-3.0, so we do not copy code. Its unwrap skips seal signature, seal/rumor pubkey and id checks, which for a command bot is an authorization hole; its `relayPool.publish` uses `allSettled` and reports success even when every relay failed. Both are things to avoid.
- Build on `nostr-tools` `nip59`, `nip44`, `nip04`, add the checks above, add publish with per-relay OK tracking, retries and a persisted outbox (3 attempts at 0.5 s and 2 s, then a durable queue with backoff, as nostrautica does).
- Sender authorization for commands is the verified seal pubkey only. Never trust the outer wrap author or an unverified rumor pubkey.

### 8.5 Bot identity and relay

Bot npub `npub1dka50zsfvru0tsv2sqd40ktnwyd3236c3hzx62hhlxw9un408tcqz6wkt0` (hex `6dbb478a...af3af0`), generated 2026-09-29. The nsec is held by the owner and is supplied to the server through its environment, never through the repo.

The account has a kind 0 profile (`bot: true`, NIP-05, icon on a Blossom server), a kind 10002 relay list and a kind 10050 DM inbox list. The service's own relay must accept the bot's writes for the kinds it uses: gift wraps and inbox lists are open to anyone there, but kind 4 (the legacy fallback) and kind 1 need the key to be allowlisted. The bot must publish its kind 0, 10002 and 10050 before it sends anything. Operational details of the relay allowlist and backups are kept in the private infrastructure notes, not in this repository.

## 9. Deployment

One Node process behind a reverse proxy, with the API on the same origin as the web app (no CORS). The static web deploy is unchanged. Secrets come from the environment: the Venice key (a dedicated service key), the bot key, the billing API token. Two storage back ends are supported, SQLite and MariaDB, chosen by `DATABASE_URL`. Host names, unit files, user accounts, ports and backup arrangements are documented in the operator's private infrastructure notes.

## 10. Phases

0. Core refactor (mostly done, uncommitted): `lib/src/pipeline.ts` with `PipelineStore`/`PipelineLogger`, `refreshLearnedPrompt`, `scorePostsCached`, `writeDigest`; CLI switched to it with a JSON-file store; 10 tests in `lib/test`. Not yet verified against live relays and Venice. Still to do: fix stale `lib/docs/API.md`, decide on a `RateLimiter` seam (dropped for now).
1. Server MVP (done): `server/` workspace, SQLite or MariaDB storage, login by signed challenge, settings, feed with the decision scorer, billing client with trial, daily cap and outage policy. The web app's hosted mode (login by NIP-07 or NIP-46, settings, feed, paywall with checkout) is done; it has not been exercised against a real NIP-46 signer such as Amber.
2. Payments (done): BTCPay provider through the separate billing service, ledger, trials, gifts, trial credit, expiry; verified with a real payment.
3. Digests (done, first live run pending): scheduler with per-zone times, TTS, Blossom upload, NIP-17 delivery with a kind 4 fallback, DM commands, schedule UI. Verified end to end against an in-process relay and, for the command loop, against the public relays. The first real scheduled digest with audio for a user with follows has still to be observed.
4. Zap activation: LNURL endpoint, zap receipts.
5. Optional: BTCPay provider.

## 11. Risks

- Shared Venice key: one abuser or one outage hits everyone. Caps and a queue are mandatory.
- No existing tests; refactoring the CLI pipeline without them is risky, hence phase 0.
- Custody of the service key (env var, decided) and the BTCPay API key / webhook secret.
- Client support for voice DMs is uneven; needs testing on the clients the user cares about.
- Legal/tax: worth a deliberate decision on how service revenue is booked.

## 12. Open questions

Answered: Q1 (settlement), Q2 (paid feed, 3-day trial), Q3 (10k sats/month), Q4 (pro rata, zap on behalf via comment npub), Q5 (widest reach: kind 14 + plain URL), Q6 (humanizer on by default, with the speech prompt; `deepseek-v4-1-flash` to start), Q7 (BTCPay direct), Q8 (new bot npub, relay whitelist and mirror done), Q11 (kind 4 rule in 8.3).

Still open:
Q9. Data retention, and self-service deletion (a `delete my data` DM command?).
Q10. API path prefix and BTCPay store to use.
Q12. Which DM commands, and should prompt setting also accept free text without a `prompt:` prefix?
