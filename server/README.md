# nalgorithm-server

Hosted, prepaid nalgorithm: login by npub, ranked feed with the server's own Venice key, entitlement from the separate billing service (nostr-billing). Spec: `docs/paid-service-spec.md`.

```
npm run build:lib && npm test -w server
```

Environment (all required unless a default is shown): `PUBLIC_URL` (API base, for example `https://cypherpunk.today/nalgorithm/api`, the login is bound to `<PUBLIC_URL>/auth/login`), `BILLING_API_URL`, `BILLING_API_TOKEN`, `VENICE_API_KEY` (use a dedicated service key), `PORT` (8350), `HOST` (127.0.0.1), `NALGORITHM_DB_PATH`, `RELAYS`, `COOKIE_SECURE`, and model overrides `SCORING_MODEL` (jev-latest), `DIGEST_MODEL` (claude-sonnet-5-5), `HUMANIZER_MODEL` and `LEARNER_MODEL` (deepseek-v4-1-flash), `TTS_MODEL` (tts-kokoro), `TTS_VOICE` (af_sky).

Endpoints: `POST /auth/challenge`, `POST /auth/login` (`{event}`, a signed kind 27235 with tags `u`, `method=POST`, `nonce`), `POST /auth/logout`, `GET /me`, `GET|PUT /settings`, `GET /feed`, `POST /billing/checkout`. Writes require `Content-Type: application/json`. Sessions are an HttpOnly SameSite=Strict cookie or a Bearer token.

Entitlement: a never-seen npub starts its 3-day trial on its first `/feed`, not on login. Expired gets 402, unknown billing state gets 503, the daily cap 429. Free endpoints keep working during a billing outage.
