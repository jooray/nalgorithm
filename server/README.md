# nalgorithm-server

Hosted, prepaid nalgorithm: login by npub, ranked feed with the server's own Venice key, entitlement from the separate billing service (nostr-billing). Spec: `docs/paid-service-spec.md`.

```
npm run build:lib && npm test -w server
```

Runs on Node 22.13 or newer; 24 is recommended. Environment (all required unless a default is shown): `PUBLIC_URL` (API base, for example `https://cypherpunk.today/nalgorithm/api`, the login is bound to `<PUBLIC_URL>/auth/login`), `BILLING_API_URL`, `BILLING_API_TOKEN`, `VENICE_API_KEY` (use a dedicated service key), `PORT` (8350), `HOST` (127.0.0.1), `DATABASE_URL`, `RELAYS`, `COOKIE_SECURE`, and model overrides `SCORING_MODEL` (jev-latest), `DIGEST_MODEL` (claude-sonnet-5-5), `HUMANIZER_MODEL` and `LEARNER_MODEL` (deepseek-v4-1-flash), `TTS_MODEL` (tts-kokoro), `TTS_VOICE` (af_bella).

Storage: SQLite (`DATABASE_URL=sqlite:./nalgorithm-server.db`, the default, or a bare path) or MariaDB (`DATABASE_URL=mariadb://user:password@host:3306/database`). The tables are created on first start. `TEST_DATABASE_URL=mariadb://... npm test -w server` runs the suite against a MariaDB test database, which the tests empty first, so never point it at real data.

Optional DM delivery (all off when `BOT_NSEC` is unset): `BOT_NSEC` (the service account's nsec or 64-hex secret key), `DM_RELAYS` (relays the bot listens on and publishes self-copies to; the ones in its DM inbox list; relays that ask for a NIP-42 login are answered as the bot), `DM_FALLBACK_RELAYS` (where to send when a recipient has published no relay list), `BLOSSOM_SERVERS` (comma separated, tried in order; default `https://blossom.primal.net`), `WEB_URL` (public web app URL used in DM replies).

Endpoints: `POST /auth/challenge`, `POST /auth/login` (`{event}`, a signed kind 27235 with tags `u`, `method=POST`, `nonce`), `POST /auth/logout`, `GET /me`, `GET|PUT /settings`, `GET|PUT /schedule` (`enabled`, `time` as `HH:MM`, `tz`, `voice`, `dmFormat`), `GET /digests`, `POST /digest/now`, `GET /feed`, `POST /billing/checkout`. Writes require `Content-Type: application/json`. Sessions are an HttpOnly SameSite=Strict cookie or a Bearer token.

Entitlement: a never-seen npub starts its 3-day trial on its first `/feed`, not on login. Expired gets 402, unknown billing state gets 503, the daily cap 429. Free endpoints keep working during a billing outage.

## Voice digests by direct message

When `BOT_NSEC` is set the server runs a bot account. Each user gets, at the time they choose, a digest written for speech (no markdown, abbreviations spelled out), edited by the humanizer pass, voiced by Venice `tts-kokoro`, uploaded to Blossom as a plain `.mp3` URL and sent as a Nostr DM: the link first, then the text. A failed voice or upload step still delivers the text.

Users control everything by DM to the bot, or with `/schedule` and `/settings` from the web app. Commands are strict; free text is never treated as a prompt.

| Command | Effect |
|---|---|
| `prompt: ...` | what to rank for |
| `time 07:30`, `tz Europe/Bratislava` | when the digest arrives; `time` turns it on |
| `voice af_bella`, `top 15`, `hours 24` | voice, posts in the digest, look-back window |
| `digest` | send one now (counts against the daily cap) |
| `pause` / `resume` | stop or restart daily digests |
| `status` | settings, next run, subscription |
| `pay`, `pay 5000`, `pay all` | payment link for the plan, a partial amount, or all apps |
| `legacy` / `nip17` | old-style (kind 4) or modern DMs |
| `delete my data` (then `... confirm`) | erase everything stored about the user |

Replies use the format the user last wrote in unless they chose one; a message is never sent in both. Inbound sender identity is only the verified seal signature of a NIP-17 message (or the author of a kind 4 event).
