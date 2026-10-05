# Changelog

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
