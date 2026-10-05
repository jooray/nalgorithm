# Changelog

## 0.18.0 — 2026-10-05

Fixes from a second review of 0.17.0, a visible line for hosted rankings, and a
shorter first setup. Deploy the hosted server before the web app: the app polls
the new `GET /feed/progress`. The server migrates `learned.processed_reactions`
to MEDIUMTEXT on MariaDB and adds two indexes on start.

### Hosted
- Rankings wait in a visible line: two score at once, the rest in order, and the app says how many are ahead, then "Ranking n of m new notes". Runs whose scores are all cached skip the line. A first ranking that meets a full server counts down and tries again by itself.
- Charged only for real work: not when the server answers busy, and not again for a result another request just paid for. A timeout while voicing a digest still saves and sends its text.
- A restart releases its own unfinished jobs at once instead of blocking readers for ten minutes.
- Rankings from cached scores carry author names again; one bad scoring batch no longer fails the whole run.
- Learning reads only the newest likes on a first run and never catches up further than 30 days.

### App
- First BYOK setup shows only your identity, your words and the model connection; everything else waits behind Show all settings.
- An Undo toast closes at your next action elsewhere and answers Cmd/Ctrl+Z; Undo works over open sheets and only ever undoes its own action, for the account that made it.
- A more/less rule removed on one device stays removed on the others.
- Updates can no longer be held back for good by a paused player, and Reload now always reloads; a new service worker takes over without closing every tab.
- Storage failures (such as iOS dropping the database of a backgrounded app) no longer break sign-out, auto-refresh or Clear this device, and Clear this device also resets the app's other open tabs.
- Keyboard: focus stays near a hidden note, the skip link no longer switches tabs, and view headings show no stray focus ring.

## 0.17.0 — 2026-10-05

A release built from a full usability, performance and resource audit. Deploy
the hosted server before the web app: the app sends settings (`digestMinutes`,
`feedback`) that an older server rejects.

### Reading and ranking
- Relevance caches are scoped to the ranking context and identity; failed scores read "Not ranked yet" and sort behind real ones; digests no longer spend slots on duplicate boosts.
- The feed updates cards in place while ranking (loaded media and focus survive), shows 50 notes at a time, keeps your reading order while you scroll, and says how many posts were ranked, from which window and in which order.
- New arrivals first by default, best match first as an option. Why this? opens a note at its explanation.
- Private feedback from a note's menu: More like this, Less like this, Hide, Hide a person's notes, Save for later, each with Undo. More/less steers future rankings in both modes. Learned taste can be inspected and reset.
- Turning off "Learn from my likes" now ignores learned taste everywhere, including BYOK digests.

### Digests and listening
- Target length (about 3, 6 or 10 minutes) now reaches the writer.
- Download MP3, and the newest three digests kept offline (up to 30 MB).
- Daily delivery is offered once, after a first real listen, and never turned on otherwise; the Digests tab says whether it is on and when the next one is.
- "Which app reads your DMs?" replaces the protocol question; unknown clients get DMs that Primal, Damus and modern apps all read. Short voice samples for the recommended voices.
- A digest whose DM did not go through is shown as ready, resent for six hours in its original format, and no longer blocks a new day's digest.

### Setup and recovery
- "Try without an API key" or "Use my own model"; landing buttons open the chosen mode. BYOK setup lists the three essentials and validates them; local models need no key.
- Visible, retryable errors; storage failures no longer block entry; updates wait while you edit, play, pay or publish.

### Privacy and data
- Feeds, digests and scores live in IndexedDB per identity; switching accounts never shows the previous one's data.
- Tune explains what is kept where. Export settings (no secrets unless asked), disconnect signer, clear this device; hosted accounts can download or delete what the server keeps.
- Images keep their proportions and descriptions; Tap to load remote media withholds images and avatars until asked.
- The app shell has a Content-Security-Policy.

### Server and operations
- Shared provider budget, durable digest jobs and DM outbox, lighter polling (summary lists, ETag/304, `since`), bounded caches, daily retention for operational records, and one log line per run with phase times.
