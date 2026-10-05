# nalgorithm-server

Hosted, prepaid nalgorithm: login by npub, ranked feed with the server's own Venice key, entitlement from the separate billing service (nostr-billing). Spec: `docs/paid-service-spec.md`.

```
npm run build:lib && npm test -w server
```

Runs on Node 22.13 or newer; 24 is recommended. Environment (all required unless a default is shown): `PUBLIC_URL` (API base, for example `https://example.com/app/api`, the login is bound to `<PUBLIC_URL>/auth/login`), `BILLING_API_URL`, `BILLING_API_TOKEN`, `VENICE_API_KEY` (use a dedicated service key), `PORT` (8350), `HOST` (127.0.0.1), `DATABASE_URL`, `RELAYS`, `COOKIE_SECURE`, and model overrides `SCORING_MODEL` (jev-latest), `DIGEST_MODEL` (claude-sonnet-5-5), `HUMANIZER_MODEL` and `LEARNER_MODEL` (deepseek-v4-1-flash), `TTS_MODEL` (tts-kokoro), `TTS_VOICE` (af_bella).

Storage: SQLite (`DATABASE_URL=sqlite:./nalgorithm-server.db`, the default, or a bare path) or MariaDB (`DATABASE_URL=mariadb://user:password@host:3306/database`). The tables are created on first start. `TEST_DATABASE_URL=mariadb://... npm test -w server` runs the suite against a MariaDB test database, which the tests empty first, so never point it at real data.

Optional DM delivery (all off when `BOT_NSEC` is unset): `BOT_NSEC` (the service account's nsec or 64-hex secret key), `DM_RELAYS` (relays the bot listens on and publishes self-copies to; the ones in its DM inbox list; relays that ask for a NIP-42 login are answered as the bot), `DM_FALLBACK_RELAYS` (where to send when a recipient has published no relay list), `BLOSSOM_SERVERS` (comma separated, tried in order; default `https://blossom.primal.net`), `WEB_URL` (public web app URL used in DM replies).

Endpoints: `POST /auth/challenge`, `POST /auth/login` (`{event}`, a signed kind 27235 with tags `u`, `method=POST`, `nonce`), `POST /auth/logout`, `GET /me`, `GET|PUT /settings` (also `digestMinutes` 3/6/10 and private `feedback` rules), `GET|PUT /schedule` (`enabled`, `time` as `HH:MM`, `tz`, `voice`, `dmFormat`), `GET /digests` (`summary=1` omits show notes; answers 304 to a matching `If-None-Match`), `GET /digests/:id`, `GET /digests/:id/audio`, `GET /digest/status`, `POST /digest/now`, `GET /feed`, `GET /feed/latest` (`since=` answers without posts when unchanged), `GET /learned`, `POST /learned/reset`, `GET /voices/:voice/sample` (shortlisted voices only), `GET /account/export`, `POST /account/delete` (`{"confirm":"delete"}`), `GET /preview`, `GET /preview/image`, `POST /billing/checkout`. Writes require `Content-Type: application/json`. Sessions are an HttpOnly SameSite=Strict cookie or a Bearer token.

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

Replies and digests use the format the user chose, else the one they last wrote in, else legacy kind 4, which nearly every client can read; a message is never sent in both. A digest whose DM is not accepted stays readable in the app as `delivery_pending` and is resent for six hours; after that a new day's run writes a new digest instead. Inbound sender identity is only the verified seal signature of a NIP-17 message (or the author of a kind 4 event).

## Link previews

A post that contains a link can show a card with the page's title, description and image. This is a hosted-mode feature, and the reason is CORS: a browser will not let a script read another site's page, so a web app with no server of its own cannot build the card. This server can. Bring-your-own-key mode has no server of ours, so it keeps showing plain links, and it sends those URLs to no third-party service. Readers can turn previews off in the hosted settings (`linkPreviews`, on by default).

`GET /preview?url=<encoded url>` (session required) answers `{url, finalUrl, title, description, siteName, image, type}`, or `{unavailable: true}` when there is nothing to show. It reads OpenGraph tags, then Twitter card tags, then `<title>` and the meta description, from the first 256 KB of the page. The parser is a small linear scan that never builds a DOM or runs anything; entities are decoded, control characters removed, title cut at 200 and description at 400 characters. The client shows all of it as text.

Limits: 60 previews per minute per user (429 above that), at most 4 pages fetched at once with a queue of 50 behind them (503 beyond), the same URL fetched once however many readers ask. Image, video and audio URLs and the app's own host are skipped. Results are cached in the `link_previews` table, keyed by a SHA-256 of the normalised URL (fragment removed) and holding no user: 7 days for a page, 1 hour for a failure. The daily prune removes rows older than 7 days.

Fetch rules (`src/preview/ssrf.ts`), applied to the URL and to every redirect:

- http and https only, no credentials in the URL, ports 80 and 443 only. The URL parser first turns spellings such as `2130706433`, `0x7f.1` and `0177.0.0.1` into dotted form, so they are judged as the addresses they are.
- The hostname is resolved by the server, and the request is refused if any answer is loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, which includes cloud metadata), CGNAT (100.64/10), unspecified, multicast, broadcast or otherwise reserved. For IPv6 that covers `::1`, `::`, unique local, link-local, multicast, and IPv4-mapped, NAT64 and 6to4 forms of the blocked IPv4 ranges.
- The connection is made to the vetted address itself (the socket's DNS lookup is pinned to it), so a DNS answer that changes after the check cannot swap the target. The Host header and TLS server name stay the hostname.
- At most 3 redirects, each one vetted again, never from https to http, never to another scheme.
- 5 seconds for everything, 1 MB of body (reading stops there), `text/html` or `application/xhtml+xml` only, fixed `User-Agent: nalgorithm-link-preview`, no cookies sent or kept, no compression.

The resolver and the transport are parameters, so the tests run without a network. Allowing loopback (and other ports) exists only as an option of the fetcher that tests pass; nothing in the environment or configuration can turn it on.

Images are not loaded from the third-party host by the reader's browser, which would tell that host who reads what. The card's `image` is a path, `preview/image?u=<image url>&s=<signature>`, and `GET /preview/image` fetches it for the reader under the same rules, with a 2 MB cap and only PNG, JPEG, WebP and GIF (never SVG). The type is taken from the file's first bytes, not from the response header. The signature is an HMAC of the image URL under a random secret that lives only in the server process, and only preview parsing produces one, so the endpoint cannot be used as an open proxy: a URL a caller made up has no valid signature and gets 404. After a restart the secret changes, so old paths stop working and the next preview issues new ones. Responses are `private, max-age=604800, immutable`, with `nosniff` and a locked-down CSP.

## Retention

What a reader keeps (settings, words, learned taste, digests, schedule) stays until they delete it: from the web app (Tune, Privacy and this device, Delete my hosted data), with `POST /account/delete`, or by DM (`delete my data`). `GET /account/export` downloads it first. Billing records live in the billing service, and audio already uploaded to Blossom stays reachable by its link.

Operational records are pruned once a day: expired sessions and login nonces, delivery attempts after 180 days, unsent DM outbox entries after 30, cached public profiles after 90, link previews after 7, scores older than the score TTL, and pipeline claims whose owner stopped renewing them an hour ago.
