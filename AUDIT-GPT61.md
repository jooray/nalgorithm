# nalgorithm — usability, design, performance, and resource audit

**Date:** 2026-10-04  
**Status:** Complete; five interim checkpoints retained.  
**Scope:** Web app and its supporting ranking, hosted-service, digest, and PWA implementation; landing-page handoff where relevant.  
**Constraint:** Audit only. No source-code changes, deployment, purchases, public posts, or production settings changes.

## Read this first

**41 prioritized findings: 19 P1, 21 P2, 1 P3; no universal P0 claimed.** Recommend a reliability-and-activation release, not a wholesale redesign. The most important fixes are relevance-cache context, invisible feedback/hidden recovery, first-run completion, duplicate/repeated paid work, and update safety. **20 owner decisions** have options and recommended defaults in the [decision register](#owner-decision-register). Read the [executive assessment](#executive-assessment), [detailed fixes](#detailed-findings-and-fixes), and [implementation sequence](#recommended-implementation-sequence) first; the investigation log records what was discovered along the way.

**Evidence limit:** BrowserOS neo had no profile/window, so visual/device and live-speed judgments still need a configured-browser pass. Source checks, targeted reproductions and local artifact measurements are documented separately. Existing tests/typechecks pass; passing helper tests do not cover the integration defects reproduced here.

## Audit approach and evidence

- Inspect actual user-facing screens in BrowserOS neo, including first-run and responsive states where available.
- Trace the main journeys in source: identity → service choice → interests → ranked feed → feedback → scheduled digest.
- Examine loading, error, empty, authentication, billing, and update states.
- Review network, memory, CPU, storage, server workload, and AI usage patterns. Separate measured observations from code-derived risks and hypotheses.
- Record interim findings here, then consolidate severity, fixes, acceptance criteria, and product decisions.
- Existing untracked files (`web/.impeccable/`, `web/PRODUCT.md`, `web/regions.json`) are pre-existing user work and will not be changed.

**Severity:** P0 = blocking failure on a supported path; P1 = major usability, accessibility, reliability, or resource problem; P2 = meaningful improvement with a workaround; P3 = polish. Severity describes impact, not proof of incidence. Findings will explicitly identify untested paths.

## Interim log

### Checkpoint 1 — product and scope

The product has a strong, distinctive promise: rank a Nostr reader's feed using their own words, explain every selection, and optionally deliver a spoken daily digest. Two materially different operating modes need to remain understandable: free bring-your-own API key and hosted service with a trial and Lightning billing. The first-run experience should deliver evidence of that promise before asking the reader to understand the infrastructure.

The existing product context prioritizes heavy Nostr readers while keeping a friendlier path for newcomers. This is a useful constraint: progressive disclosure is preferable to removing advanced capability.

Audit tooling reports that `web/.impeccable/surfaces/app.md` points at a missing `app` target. This is documentation/tooling drift, not a verified app defect; preserve the existing files and decide later whether to repoint the brief to the current app source. No repair is part of this audit.

## Continuing investigation log

Interim checkpoints are intentionally retained as the investigation record; the consolidated findings below supersede tentative hypotheses.

### Checkpoint 2 — onboarding and ranking correctness

**Live-browser limitation:** BrowserOS neo returned `CDP error: No browser window available`; creating a dedicated window returned `CDP error: No profile available`. No alternate browser or headless fetcher was used. There are no committed screenshot fixtures in the app tree, only icon assets. Visual observations below are therefore implementation-derived, not claims that screenshots or real-device flows were inspected.

Early source findings:

1. **BYOK setup does not close the loop.** First run opens Tune, but Save persists without validation, always enables Refresh, and leaves the reader in a long settings screen. Automatic checks are installed only when settings are valid during bootstrap, so completing setup in that session does not install them (`web/src/ui.ts:69–82,186–189`; `web/src/app.ts:729–734`). Recommend a validated “Save and rank my feed” first-run action, followed by visible progress and readable results.
2. **BYOK cached scores are not scoped to the reader or ranking rule.** Cache records are keyed only by event ID (and scorer type), while a changed prompt is supposed to change the ranking (`web/src/settings.ts:230–265`; `web/src/app.ts:459–469`). A different identity or explicit prompt can inherit old scores. Recommend identity + explicit-prompt/rubric fingerprint + scorer/model-policy namespaces, keeping old contexts until eviction instead of destroying all cache entries.
3. **Local Ollama is offered but keyless use is rejected.** `validateSettings` requires an API key for every provider (`web/src/settings.ts:320`), despite the local Ollama preset. Recommend provider-specific optional auth and a connection test with CORS guidance.
4. **Like learning repeats work and is not user-controllable in BYOK.** Each refresh re-fetches up to 200 likes in the full window and calls `summarizeLikes` without a watermark or the old learned prompt (`web/src/app.ts:550–590`). Recommend incremental learning, a visible on/off control, and a separate cadence from feed refresh.
5. **Permission copy is inconsistent.** BYOK says it “never signs or posts,” but the current renderer exposes replies, boosts, likes, and zaps. Hosted gate says one login event, while the remote-signer dialog additionally asks for action kinds (`web/index.html:54,214`; `web/src/login-ui.ts:39–56,215–219`). Recommend accurate read-only-until-you-act copy and optional action permission at sign-in.

**Mechanical detector:** Two warnings: `flat-type-hierarchy` on `web/index.html` and `side-tab` on `web/src/style.css:1227`. The hierarchy warning is a false positive: CSS explicitly defines 2rem view headings, larger hero headings, and differentiated section sizes. The top-note stripe is real, but a functional relevance cue rather than evidence by itself of bad design; evaluate redundancy with the score treatment before removing it.

### Checkpoint 3 — speed, resources, accessibility, and digest reliability

- **Speed bottleneck precedes scoring:** follow-author chunks, embedded-event resolution, and profile retry chunks are awaited serially. Profile fallback may perform two passes in 25-author batches with a 30-second timeout per batch (`lib/src/fetcher.ts:238–250,322–339,424–495`). Both modes wait for profiles before scoring; hosted additionally waits for learning. Recommend bounded parallelism and an overall stage deadline, ranking with cached names first and enriching later.
- **Relay cleanup does not cover every relay opened:** profiles connect to fallback/indexer and author outbox relays, but `destroy()` closes only configured feed relays (`lib/src/fetcher.ts:435–509`). Recommend tracking all opened relays and cancelling timed-out subscriptions, with an explicit shared-pool ownership contract.
- **Progressive BYOK rendering rebuilds the entire feed per completed batch:** `renderFeed` clears all cards and recreates them (`web/src/render.ts:99–126`; `web/src/app.ts:499–502`). This can lose focus/media state and make already-read notes move. Recommend keyed incremental reconciliation and a stable reading anchor, then windowing/load-more after measurement.
- **Show-notes tabs have a keyboard gap:** the inactive tab is given `tabIndex = -1`, but only click handlers are installed (`web/src/digest-view.ts:613–619,636–640`). Recommend full left/right/Home/End tab behavior and explicit tab-to-panel associations.
- **“Saved digests still play” is not an offline guarantee:** local history stores text and audio URLs, the worker does not cache cross-origin audio, and generated BYOK MP3s live only as session blob URLs (`web/index.html:21`; `web/public/sw.js:49–57`; `web/src/byok-digest.ts:124–128`). Recommend an explicit download-for-offline path and truthful fallback copy.
- **Update safety is only a global boolean:** it covers ranking/payment but not draft editing, playback, digest text generation, TTS, or a signature approval. Overlapping tasks can unblock each other (`web/src/version-check.ts:20–32,74–84`; `web/src/digest-view.ts:714–757`). Recommend named/ref-counted blockers, saved drafts, and a safe automatic reload once the active task finishes—not a permanent manual-refresh requirement.
- **A failed DM can regenerate an already-created digest:** the digest row is persisted before delivery; a failed delivery is returned as a generic failed run and the scheduler can retry the whole pipeline (`server/src/digest-job.ts:194–237`). Recommend separate generation and delivery states, retaining the artifact and retrying delivery only.

Important correction to the early hypothesis: the decision scorer does produce a justification from its probability distribution (`lib/src/ranker.ts:534–550,601–607`). The issue is not “no explanations in hosted mode”; it is that those rubric percentages are generic and harder to use than a post-specific explanation. Likewise, the implementation already deduplicates boosted scoring, persists successful batches, preserves feed snapshots, and prevents autoplay. Preserve these strengths.

### Checkpoint 4 — verified checks and additional failure paths

- Web logic tests: **164 passed**, no failures. Web, library, and server TypeScript checks completed successfully using `tsc --noEmit` (no generated source/build changes).
- Library and server test suites also exited successfully against existing `dist` files; the server test database environment variable was explicitly removed so tests used disposable in-memory SQLite rather than any configured MariaDB. Their result validates the existing built modules, not a freshly rebuilt release.
- Existing local bundle (`web/dist/version.json`: `0.16.1+202610010816`, built 2026-10-01): JS **309,025 bytes / 105,133 gzip**, CSS **40,562 / 8,753 gzip**, Latin variable font **48,256 bytes**. These are local artifact sizes, not live transfer or Core Web Vitals measurements. Other font subsets exist but are selected by unicode ranges, not all necessarily downloaded. The source map is 1,312,341 bytes and is not a normal page-load dependency.
- **Two toast implementations share incompatible CSS.** The older `.toast` sets `opacity: 0`, `pointer-events: none`, and a centering transform; the later `.toast` rule does not reset those properties. `showToast` creates an element without `.is-visible`, leaving note-action success/error/Retry toasts invisible and non-interactive by cascade analysis (`web/src/style.css:290–314,2133–2152`; `web/src/toast.ts:31–63`). Unify the component or give the popover a separate class; this is a functional feedback problem, not cosmetic polish.
- **Cold hosted startup failure is placed in a hidden view.** On a non-401 `/me` failure with no saved feed, `boot` calls `showFailure`, which displays `#hosted-notice` inside `.view`; CSS hides all views until `data-signed-in='true'` (`web/src/hosted/app.ts:231–248,681–705`; `web/src/style.css:210–214`). Recommend a visible signed-out/startup error screen with Retry and free-mode escape.
- **Digest selection is not deduplicated like the feed.** `buildDigestMessages` and `digestSourceNotes` sort/slice raw original/boost entries; several boosts can occupy the top-N slots for the same note (`lib/src/digest.ts:159–184`; `server/src/digest-job.ts:154–155`). Recommend a shared unique-note selection function used by ranking display, digest prompt, and show notes.
- **Hosted score-cache context is also incomplete.** It isolates npubs correctly, but keys are only `(npub, cache_key)` plus scorer type. Saving a new explicit prompt changes the snapshot signature, not the persisted scores (`server/src/db.ts:38–46,184–205`; `server/src/settings.ts:70–72`; `lib/src/pipeline.ts:270–289`). Re-running can therefore return yesterday's relevance judgments with a new “updated” timestamp.
- **Hosted feed locking has a race:** `running.has` is checked before awaiting billing consumption; `running.add` occurs afterward (`server/src/app.ts:353–365`). Simultaneous requests can both pass the check. Recommend claiming a shared pipeline job before awaits, covering feed and digest work for the same reader, plus a provider-wide queue.

### Checkpoint 5 — targeted reproductions (no real accounts, relays, or model calls)

Current TypeScript modules were bundled **in memory** with the installed esbuild, then executed with disposable storage and injected fake dependencies. No source or build artifact was written.

| Check | Observed result | Interpretation |
|---|---|---|
| Save score 9 (“Matches Bitcoin”), then save a different identity and “Only cooking” | Same event still returns score 9 / old reason | Confirms BYOK cache-context defect |
| Validate otherwise-complete keyless local Ollama configuration | `API Key is required` | Confirms supported local-provider path is blocked |
| Validate invalid key, negative batch size, huge hours/concurrency, negative top-N | `null` (no error) | Confirms BYOK validation does not enforce format/ranges |
| Resolve a profile on fallback indexer, then destroy fetcher | Opened main + indexer; closed main only | Confirms cleanup omits fallback relays |
| Select original + boost for a two-post digest | IDs `['note1', 'note1']` | Confirms duplicate source-note selection |
| Concurrent authenticated `/feed?force=1`, billing calls held at a barrier | 2 consumptions, 2 feed runs, both HTTP 200 | Confirms pre-await lock race; this uses source `createApp` with fake DB/billing/feed, not production |
| Choose hosted mode while storage throws | Reload invoked, mode remains `choose` | Confirms blocked-storage mode-selection loop |

Token contrast calculations (WCAG relative luminance, source tokens; not a browser scan): dark muted/ground **6.54:1**, dark muted/raised hover **5.56:1**, white/violet hero **5.82:1**, light accent/ground **5.93:1**. These are good. Light tertiary text on `--surface-3` is **4.41:1**, below 4.5:1 when used at normal text size. White focus outlines on the light gate ground are **1.07:1**. Input border/surface is **1.30:1 dark / 1.36:1 light**; assess whether the field has another sufficient visual boundary before declaring a WCAG 1.4.11 violation.

Final resource cross-check: the vendored humanizer source is **66,706 UTF-8 bytes / 66,213 characters**. The editing request sends the full generated skill prompt on every configured humanizer pass (`lib/src/humanizer.ts:57–70`). Roughly 16,500 tokens at four characters/token is only an illustrative estimate; actual provider token usage and prompt-cache discounts must be measured. This is a meaningful cost/latency lever, not a reason to edit the protected vendored skill locally.

**Audit progress:** Evidence collection is complete enough to prioritize. The following sections consolidate findings, specific fixes, owner decisions, and a verification plan. Live screenshot, Core Web Vitals, real signer/payment, and real-device conclusions remain explicitly unverified.

## Decisions requiring the owner

See the decision register below. No response is required to complete this audit.

## Verification limitations

Live browser access was unavailable because BrowserOS neo had no profile/window. No production sign-in, digest generation, subscription change, payment, public reaction, post, or deployment was performed. No screen capture, real-device timing, live network trace, heap profile, or Lighthouse score is claimed. Visual quality judgments are source-derived design assessments, and performance estimates are labeled as such. The library/server suites used existing built modules; current source additionally passed no-emit type checks and selected in-memory reproductions. The audit did not inspect private config files or credentials.

---

## Executive assessment

**The core product is compelling; the next improvement should be trust and activation, not a wholesale redesign.** The user controls the ranking rule, can inspect sources, and gets a genuinely useful read/listen workflow. The interface has a coherent vocabulary: a quiet single-column feed, violet audio surfaces, lime actions, and three labeled destinations. It is not an undifferentiated dashboard.

**Is the user path clear?** Hosted is relatively clear after login: write interests → Save → ranking and first digest. BYOK is not: a newcomer lands in a long Tune form, cannot tell which fields are required, and Save neither validates nor launches the first result. Returning readers benefit from snapshots and a new-notes pill, but errors, unsupported assumptions, and stale cache context can undermine their understanding of what the system actually did.

**Should the app nudge users?** Yes, toward one valuable next step at a time: finish essential setup; inspect the first ranking; play the first digest; then opt into a daily schedule. Do not nudge indiscriminately toward payments, public likes, or another generation run. The product's promise is time saved, not more engagement.

**Is everything intuitive and beautiful?** The implementation suggests a strong, attractive foundation, but “everything” is not intuitive: save scopes, signer permissions, DM compatibility, failed ranking, offline playback, and the relationship between freshness and relevance need clarification. Beauty cannot be honestly certified without seeing the rendered desktop/mobile screens. Preserve the current visual identity while simplifying setup and reducing competing signals.

### Highest-value changes, in order

1. **Make a change of interests actually change relevance.** Fix score-cache context in both modes; deduplicate digest selection.
2. **Repair feedback and recovery.** Fix invisible note-action toasts and hidden hosted startup errors; distinguish unranked fallback from a real score.
3. **Get a new reader to useful output.** A short required setup surface with a validated “Rank my feed” action; model testing for BYOK; a digest/schedule handoff after success.
4. **Reduce avoidable work.** Incremental learning, complete relay cleanup, pipeline deduplication, a global provider budget, and bounded profile enrichment.
5. **Make background behavior safe.** Draft-preserving automatic updates, durable digest jobs/delivery retries, truthful offline capability, and keyboard-complete controls.

### Audit health (provisional, source-derived; not a WCAG certification)

| Dimension | Score / 4 | Rationale |
|---|---:|---|
| Accessibility | 2 | Good native controls, labels and focus styles; show-notes keyboard path is incomplete and light gate focus needs correction |
| Performance/resource efficiency | 2 | Caches, lazy media and batch persistence are good; repeated learning, serial enrichment, full redraws and missing cleanup remain |
| Responsive design | 3 | Fluid column, safe-area handling and large main controls; narrow cards, overlays, zoom and landscape still need verification |
| Theming | 3 | Central tokens and intentional light/dark palettes; a few focus/contrast/cascade exceptions |
| Implementation integrity | 2 | Product-specific system, but toast collision, contradictory permission copy and disconnected storage/form semantics |
| **Total** | **12 / 20** | **Significant targeted work needed; no evidence that a visual overhaul is necessary** |

UX heuristic assessment: system status **2/4**, real-world match **3/4**, control/freedom **2/4**, consistency **2/4**, error prevention **1/4**, recognition **2/4**, efficiency **2/4**, minimalist design **3/4**, recovery **2/4**, help **2/4**: **21/40**. These are judgment calls to guide priorities, not measured user-study results. No universal P0 is claimed without live verification; several conditional paths are blocked or misleading and are marked P1.

## What should be preserved

- **Plain-language interests as the ranking rule.** This is the product's differentiator, not a settings detail to bury.
- **One shared renderer and one audio player.** Both modes use familiar feed cards; lock-screen playback, speed, skip, resume and show notes are unusually complete for a small app.
- **No autoplay.** Digest arrival does not interrupt the reader or unexpectedly play sound.
- **Warm-start snapshots and quiet updates.** Saved rankings, age labels, the new-notes pill, and keeping readable results during outages are the correct direction.
- **Paid work is persisted batch by batch.** Successful scoring survives interruptions; failed fallback scores are not cached; boosts are scored once under the original event.
- **Click-to-load video and lazy images/previews.** Do not regress into preloading every clip. Server link-preview fetching is bounded, cached and guarded against SSRF.
- **Explicit hosted billing and free BYOK escape.** Pro-rata time, unused trial credit and no required email/password are good trust-building choices.
- **Native dialogs and largely sensible control sizes.** Avoid replacing working semantic controls with visually elaborate custom widgets.
- **Versioned PWA with automatic update detection.** The mechanism exists; strengthen safety rather than disabling auto-refresh.
- **A substantial pure-logic test suite.** Extend it to integration contracts, not just more snapshots of happy-path helper outputs.

## Main journeys and the recommended path

| Journey | Current path / friction | Recommended path |
|---|---|---|
| First-time hosted | Pick hosted → signer modal → interests in Tune → Save → Feed → first digest. Permission ask is broader than gate copy; schedule remains separate | “Try hosted” → explain read-only login vs optional actions → interests with examples → “Rank my feed” → useful notes → first digest → optional schedule |
| First-time BYOK | Pick BYOK → long Tune form → identity, interests, endpoint/key/model → Save → manually find Feed/Refresh. Automatic checks not installed after first setup | Essential setup only: identity → interests → provider/key → test → “Save and rank” → visible incremental results. Advanced options remain available |
| Returning reader | Saved feed → background refresh → fresh group above remainder; freshness label doesn't prove scores match new settings | Preserve readable results; show ranking context/window, job stage and verified freshness; let the reader choose best-first vs newly arrived |
| First listen | Digest appears automatically in hosted; player is available without autoplay | Arrival cue with one primary “Play your first digest”; after listen, “Have this ready each morning?” with next-run preview |
| Schedule | Scroll through Tune → daily toggle/time/time zone/24 voices/DM format → separate Save schedule | Compact schedule summary on Digests; time zone default, small voice shortlist + preview, client-compatible delivery choice; explicit confirmation |
| Bad key/model/relay | BYOK may retry every batch, show fallback 5.0 and report ranked success; hosted initial outage error may be hidden | Stop permanent errors early; preserve cached notes; explain the specific failed stage; link to the relevant field and offer safe retry |
| Trial ends/payment | Subscription banner → paywall on Feed → another tab → polling `/me` | Explain remaining access in Tune, calm reminder near expiry, clear amount/days; invoice-specific status and recovery without another invoice |
| Offline | Snapshot/text can remain; banner promises audio playback even when only a URL was saved | State what is actually available; explicit “Save audio offline” with size/state/remove controls; text/browser speech as an honest fallback |

## Detailed findings and fixes

### F01 — [P1] Relevance caches do not capture the ranking context

**Evidence:** `web/src/settings.ts:230–265`, `web/src/app.ts:459–469`; hosted `server/src/db.ts:38–46,184–205`, `server/src/settings.ts:70–72`, `lib/src/pipeline.ts:270–289`. BYOK cache is event-keyed globally; hosted correctly isolates identities but not explicit prompts/models/rubric versions. The BYOK reproduction returned score 9 / “Matches Bitcoin” after changing identity and interests to cooking.

**Impact:** “Tune” can appear ineffective. A freshly dated ranking may embody the old rule, directly contradicting the landing promise that correcting your prompt changes the feed.

**Best fix:** Namespace by canonical identity, explicit-interest fingerprint, scorer and rubric/model-policy version. Store provenance on each score. Keep incremental learned-preference changes prospective by default, as intended, but offer “Re-rank existing notes with this taste” explicitly. Use a deliberate invalidation policy rather than invalidating everything on every like.

**Acceptance:** Changing explicit interests re-scores affected notes; switching identities cannot reuse personal scores; ordinary refresh with unchanged context makes zero unnecessary scoring calls; UI can explain which rule made an old score.

### F02 — [P1] BYOK setup stops before activation

**Evidence:** `web/src/ui.ts:69–82,186–189`; `web/src/app.ts:729–734`. Save always enables Refresh and leaves Tune selected. Live checks are installed only if bootstrap settings are already valid. Saving a complete first configuration does not install them. Already-valid users do have checks installed even if automatic refresh is initially off; enabling it should additionally trigger an immediate re-evaluation instead of waiting for the next timer/foreground event.

**Impact:** New readers complete work but see no reward, and the checked automatic-refresh option can be misleading in that session.

**Best fix:** A first-run completion handler validates, saves, installs/reconfigures checks, navigates to Feed and starts the ranking. Label the first action **“Save and rank my feed”**. Once configured, use a normal Save with persistent inline confirmation and an explicit re-rank option.

**Acceptance:** A clean-device user can reach actual ranked posts without knowing what Refresh means or reloading. Saving/enabling/disabling automatic refresh takes effect immediately.

### F03 — [P1] BYOK validation ignores format and bounds

**Evidence:** `web/src/settings.ts:316–328`; `web/src/ui.ts:263–292`. HTML has min/max attributes but Save is a button outside a validating form. The reproduction accepted an invalid identity, negative batch size/top-N and huge hours/concurrency. `lib/src/ranker.ts:555–559` assumes a positive batch size: a negative size would prevent its chunk loop from advancing correctly.

**Impact:** Invalid configuration can be saved as “success,” cause late errors, or in the negative-batch case freeze a run. Unbounded concurrency lets a typo create a request burst.

**Best fix:** Share a schema between field reading, persistence and ranker entry points: canonical public key, valid endpoint/relay schemes, finite whole numbers, sensible bounds, provider/scorer compatibility. Do not rely on `parseInt(...) || default` to silently reinterpret input. Validate before saving; show field-linked errors and focus the first invalid field.

**Acceptance:** Empty, fractional, negative, huge and malformed values never reach a pipeline. A bounded “Advanced/custom limit” escape can exist for power users; defaults remain safe.

### F04 — [P1] Note-action toast feedback is invisible and Retry is unusable

**Evidence:** `web/src/style.css:290–314,2133–2152`; `web/src/toast.ts:31–63`; `web/src/shell.ts:58–68`. Both toast systems share `.toast`. The legacy base sets opacity zero and no pointer events; the newer popover never adds `.is-visible` or overrides those properties. The newer inset/margin positioning also inherits the older horizontal transform.

**Impact:** A reader cannot reliably see like/boost success or failure, and may not be able to click Retry. The legacy settings toast can also be shifted away from intended centering by the mixed positioning rules.

**Best fix:** One toast component with explicit hidden/open state, or separate `.shell-toast` and `.action-toast` classes with no shared positioning/state rules. Keep retryable errors visible until dismissed or acted on; success notices can expire. Keep a persistent error at the operation's origin as well.

**Acceptance:** A DOM/CSS integration test checks visible opacity, clickable Retry, on-screen bounds, popover layering, and both toast callers. Confirm in both themes and with an open sheet.

### F05 — [P1] Cold hosted errors can be trapped behind the signed-out gate

**Evidence:** `web/src/hosted/app.ts:231–248,681–705`; `web/src/style.css:210–214,2250–2259`. A non-401 initial `/me` error without a snapshot reveals a notice inside a view that CSS still hides before sign-in. The loading indicator has no readable stage label.

**Impact:** A server/billing/network problem looks like indefinite startup. The recovery button exists but is not reachable in the visible UI.

**Best fix:** Explicit boot states outside authenticated views: checking account, signed out, offline-with-snapshot, failed-with-retry. Include **“Try again”** and **“Use my own key”** in the cold error screen. Set a readable status and never imply authentication was checked when it was not.

**Acceptance:** Inject `/me` timeout, 502, 503, invalid JSON and 401; each produces a visible, keyboard-accessible recovery screen rather than a hidden alert/spinner.

### F06 — [P1] Permission promises disagree with actual capabilities

**Evidence:** `web/index.html:54,214`; `web/src/login-ui.ts:39–56,215–219`; `web/src/note-ui.ts:124–317`; README “never signs/posts” claims. BYOK initially reads only a pubkey, but later note actions can connect a signer. Hosted remote login requests login plus kinds 1, 6, 7, 16, 9734.

**Impact:** Users approve a larger capability than the gate led them to expect. Absolute read-only promises are no longer true across the app.

**Best fix:** Say **“Reading needs only your public key. Replies, likes, boosts and zaps ask for your signer when you choose them.”** Hosted login should default to login-only, with an optional **“Also connect for note actions”** disclosure. Offer a visible disconnect/revoke guidance path. Do not call the NIP-46 client key a user's private identity key; they are different secrets.

**Acceptance:** Gate, modal, Tune, help and README describe the same permission model; read-only login does not request action kinds; an action never posts without the reader initiating it.

### F07 — [P1] Storage failure is handled inconsistently and can prevent entry

**Evidence:** `web/src/hosted/mode.ts:22–45`; `web/src/settings.ts:127–164,188–213,264`; `web/src/digest-history.ts:41–51`. The reproduction showed choosing hosted while storage throws returns to `choose` after reload. Settings accesses are unguarded despite defensive snapshot/history code. History can report a retained newest record even when its final write failed.

**Impact:** Disabled site data prevents mode selection, quota failures can abort paid scoring callbacks, and “saved” may not mean durable. A sensitive shared-device reader has no meaningful memory-only option.

**Best fix:** Choose mode in memory/URL without requiring successful persistence and reload. Use one guarded storage adapter with an in-memory fallback, explicit save results, and quota eviction. Keep live results when persistence fails. Explain **“Works for this session; settings could not be saved”** without exposing credentials.

**Acceptance:** Blocked get/set, corrupt JSON and a full store cannot blank the app or discard already-paid results. Reopening honestly reflects which state was persisted.

### F08 — [P1] Failed scoring is presented as genuine middle relevance

**Evidence:** `lib/src/ranker.ts:625–628,694–698`; `web/src/render.ts:390–399`; `web/src/app.ts:520–524`. Defaults become score 5, displayed like real scores with “No reason recorded”; details remain in console logs. Chat retries every error three times (`lib/src/llm.ts:262–283`), including permanent auth/model errors.

**Impact:** A wrong key or removed model can produce a supposedly “ranked” feed and an incorrect digest. The user might keep trying and pay for unrelated retries. In a 500-unique-note/20-post chat run, a permanent error can cause **25 × 3 = 75 attempts**; this is an illustrative upper count, not a measured production incident.

**Best fix:** Typed provider errors; fail fast for 400/401/403/404, retry transient errors with jitter/Retry-After and a total retry budget. Display failed notes as **“Not ranked yet”**, separate them from ranked results, and say **“X ranked, Y unavailable.”** Do not feed failed scores into the “best” digest unless a reader explicitly asks for an unranked summary.

**Acceptance:** Bad-key tests stop after one failed provider call; partial batch errors are visible and retry only missing work; no fallback 5.0 is indistinguishable from a real 5.0.

### F09 — [P1] Optional enrichment and learning delay the first useful ranking

**Evidence:** `lib/src/fetcher.ts:238–250,322–339,424–495`; `web/src/app.ts:437–487`; `server/src/feed.ts:47–78`. Author chunks and embedded/profile queries are serial. Hosted waits for like learning before score-cache lookup/ranking. Fallback profiles can require two passes of 25-author queries; only the outbox pass has an overall 15-second budget.

**Impact:** Users with many follows or unresolved profiles encounter long waits before the first scored note. “Up to a minute” is not supported by a strict overall deadline. Raising only scoring concurrency cannot solve the preceding work.

**Best fix:** Separate content fetching, cached scoring, essential embedded resolution, and cosmetic enrichment. Use small bounded worker pools, overall deadlines, partial results and persistent positive/negative profile caches. Use the previous learned prompt immediately and update it independently. Hosted should expose job stages/progressive results instead of one long request if it regularly exceeds the UI budget.

**Acceptance:** Inject many slow/missing profiles and relays: useful cached/ranked posts appear before cosmetic lookup completes; all stages terminate within an explicit budget; no falsely precise completion promise.

### F10 — [P1] Fetcher cleanup leaves fallback/outbox connections behind

**Evidence:** `lib/src/fetcher.ts:435–509`. Reproduction opened main and indexer, then closed only main. `queryWithTimeout` races the pool query but does not explicitly cancel its losing subscription. Manual learning also destroys its fetcher only on the happy path (`web/src/app.ts:627–635`).

**Impact:** Repeated browser/server runs can retain sockets and associated objects; a real owned SimplePool has a `destroy()` facility. Exact retained memory and socket incidence still require instrumentation.

**Best fix:** Track ownership: destroy an internally owned pool completely; for an injected/shared pool, close only subscriptions and connections this fetcher owns, not everyone else's. Pass the native query maxWait/abort contract rather than only an external race. Put all teardown in `finally`, including learning.

**Acceptance:** Fake-pool coverage includes configured, fallback and discovered relays. Real repeated-run tests return connections/subscriptions to baseline; cancellation leaves no in-flight relay work.

### F11 — [P1] BYOK learning repeats work and can outlive its identity/context

**Evidence:** `web/src/app.ts:550–590`; `lib/src/learner.ts:61–87`. Every refresh re-fetches the full time window, summarizes at most 100 liked posts afresh, then writes into the currently loaded settings. There is no BYOK learning toggle, watermark or identity check at commit. Main `isRunning` is cleared while this background phase continues.

**Impact:** Unchanged likes repeatedly consume tokens; learning can overlap itself; a slow result from identity A can overwrite the learned prompt after switching to B. The README describes incremental learning but this path is not incremental.

**Best fix:** Per-identity learning state and processed reaction IDs/timestamps; call shared incremental pipeline semantics with an independent cadence. Single-flight learning per context; verify identity/generation token before committing. Provide **“Learn from my likes”**, inspect/reset, last update and “used for future notes” copy. For hosted, decide whether turning learning off means freeze existing taste or ignore it: currently it still loads the existing learned prompt (`server/src/feed.ts:62–64`).

**Shared-pipeline correctness detail:** `lib/src/pipeline.ts:193–225` uses the current time after model work as the next like watermark, while resolved likes carry no reaction timestamp. Likes arriving during that work, or omitted by the 200-reaction limit/partial relay coverage, can be skipped permanently. Retain reaction timestamp/ID in the fetched contract, page bounded history, and advance only through successfully processed coverage with an overlap/dedup window—not to the completion clock.

**Acceptance:** Reopening/refreshing with no new likes makes zero learning calls; switching identity mid-learning cannot contaminate settings; disabling learning behaves as documented.

### F12 — [P1] Feed/digest work is not globally budgeted or atomically shared

**Evidence:** `server/src/app.ts:353–365` reproduced two feed runs for simultaneous requests. Digest has a separate claim (`server/src/digest-jobs.ts:42–52`) and independently calls `deps.feed` (`server/src/digest-job.ts:151`). Each new ranker gets its own 90-RPM pacer (`server/src/feed.ts:66–72`; `lib/src/ranker.ts:572`), so this is not a shared API-key budget. Scheduler concurrency covers scheduled jobs, not all manual/feed intake.

**Impact:** Multiple tabs/users or a feed plus first digest can duplicate fetching/learning/scoring and collectively exceed the provider limit. Billing consumption may happen twice before the lock exists.

**Best fix:** Claim before the first await; share a per-reader/context pipeline promise/job and a provider-key-wide request queue/rate limiter. Bound manual and scheduled work together with backpressure and fair priority. Reuse a suitable feed result for the first digest instead of immediately refetching it. If multi-process, use database/queue claims, not a module Set.

**Acceptance:** Two simultaneous same-context requests produce one pipeline and one consumption; feed + digest reuse eligible work; two users cannot exceed the shared provider budget; users can see “queued” rather than a misleading spinner.

### F13 — [P1] Digests can spend top-N slots on duplicate boosts

**Evidence:** `lib/src/digest.ts:159–184`; `server/src/digest-job.ts:154–155`. In-memory source reproduction selected `['note1', 'note1']` for original + boost. Scoring deduplication and feed folding do not automatically deduplicate the digest input.

**Impact:** The daily overview can repeat the same story and omit other valuable notes. Show notes can contain duplicates while the feed looked clean.

**Best fix:** One shared unique-content selection function, keyed by original event for boosts and by quote event for commentary. Fold before taking top N, preserve booster attribution, and use the exact selected set for writer input and show notes. Add optional author/topic diversity only as a separate transparent policy.

**Acceptance:** Ten boosts consume one digest slot; quote commentary remains eligible separately; prompt and show notes contain the same unique selections.

### F14 — [P1] Delivery failure can pay to regenerate an already-ready digest

**Evidence:** `server/src/digest-job.ts:194–237`; scheduler retries `failed`. Text/audio is stored before DM delivery; failed delivery returns the same broad failure status as failed generation. The web can infer a digest has arrived from list presence before DM outcome (`web/src/hosted/app.ts:1053–1057`).

**Impact:** A relay outage can create extra histories and repeat writer/humanizer/TTS work. “Arrived” can mean available in-app rather than delivered to the promised client.

**Best fix:** Separate states **generated → audio ready/degraded → delivery pending → relay accepted → delivery failed**. Persist artifacts and an idempotent delivery/outbox record. Retry the same message/event where protocol permits; do not regenerate. Explain “Ready here; DM delivery is still retrying.” Relay acceptance is not proof that the recipient has read or displayed it.

**Acceptance:** Fail every DM relay after generation: retry does not call the writer/TTS again or create a new digest; UI distinguishes ready-in-app from DM relay acceptance.

### F15 — [P1] Fixed digest stale time is shorter than possible legitimate work

**Evidence:** `server/src/digest-jobs.ts:6–7,45–49,70–79`; `lib/src/llm.ts:8,262–283`; `lib/src/tts.ts:198–199,272–279`; `server/src/blossom.ts:58–88`. A claim expires after 600 seconds without a heartbeat. Writer/fallback/humanizer/TTS/upload retries can cumulatively exceed that, before adding profile waits.

**Impact:** A healthy slow job can be reported idle and another job can claim its slot, producing duplicate cost/delivery. Startup also interrupts all running rows, which assumes one active server process.

**Best fix:** Renewable leases with owner/job IDs, a heartbeat, total deadline and stage checkpoints. Make startup recovery ownership-aware if multiple instances are supported. Separate “stalled/recovering” from “idle”; return the same existing job on a repeated request.

**Acceptance:** A deliberately slow healthy job renews its lease and cannot be duplicated; crashed work becomes recoverable after heartbeat expiry; max duration ends cleanly with reusable artifacts.

### F16 — [P1] Automatic updates can interrupt editing, playback and paid work

**Evidence:** `web/src/version-check.ts:20–32,74–84,109–113`; `web/src/digest-view.ts:714–757`; reply drafts are in-memory only (`web/src/note-ui.ts:225–258`). The blocker is one boolean, covers feed/payment but not all operations, and “Reload now” bypasses it.

**Impact:** A deployment can lose an unsent reply/Tune draft, stop a digest mid-generation, lose an MP3 blob, interrupt a signature, or abruptly stop listening. Concurrent operations can clear each other's block.

**Best fix:** Named/ref-counted activity blockers and durable drafts; checkpoint generated text/audio before reload. Automatically refresh once safe, preserving selected tab/reading anchor/resume. Show a human-readable version and “Updating when your current task finishes.” An emergency maximum deferral should save state and explain interruption, not rely forever on a hard refresh.

**Acceptance:** Deploy during every operation and overlapping operations; no paid work/draft is silently lost, playback resumes sensibly, and the new version eventually loads automatically. Manual reload during unsaved work warns/checkpoints first.

### F17 — [P1] Keyless local Ollama is offered but cannot run normally

**Evidence:** `web/src/settings.ts:13,320`; source reproduction returned `API Key is required`. `lib/src/llm.ts:58–61` always constructs an Authorization header. README/landing advertise local Ollama.

**Impact:** The intended free local-model reader hits an avoidable configuration block or has to invent a dummy key.

**Best fix:** Provider-aware optional auth; omit Authorization when no key is required. Validate connectivity/model before a full run. Give narrowly scoped CORS origin guidance and distinguish missing server, CORS/private-network permission, mixed content, and missing model.

**Acceptance:** A local instance with no API key completes setup/ranking; remote providers still require credentials. Never advise broad `OLLAMA_ORIGINS=*` as the only solution without explaining exposure.

### F18 — [P1] Show-notes tab navigation is incomplete for keyboard users

**Evidence:** `web/src/digest-view.ts:613–619,636–646`; `web/index.html:105–110`. Inactive tab is removed from tab order without Arrow/Home/End handlers; panels lack explicit `aria-labelledby`/tab `aria-controls` associations. Login dialog also lacks an explicit accessible name and its status paragraph is not a live region (`web/src/login-ui.ts:285–298`).

**Impact:** A keyboard reader cannot use the expected route to Digest text once the inactive tab has tabindex -1. Signer progress/errors may not be announced meaningfully.

**Best fix:** Implement the standard tabs keyboard pattern or use two ordinary buttons that both remain reachable. Name the login dialog from its heading and announce meaningful status transitions. Move focus intentionally on app view changes; don't announce whole streaming text on every tick.

**Acceptance:** Keyboard-only and screen-reader users reach both notes/text, hear signer states, close dialogs and return to their trigger. Relevant WCAG concerns: 2.1.1, 4.1.2 and 4.1.3; certify only after live assistive-tech testing.

### F19 — [P2] Offline playback is promised more strongly than implemented

**Evidence:** `web/index.html:21`; `web/public/sw.js:49–57`; `web/src/digest-history.ts:13–25`; `web/src/byok-digest.ts:124–128`. History stores URLs/text, not durable audio. A browser HTTP cache may happen to contain audio but is not an offline contract.

**Impact:** A commuter installs the PWA believing morning audio is saved, then loses playback without connectivity.

**Best fix:** Explicit **“Save offline · N MB”** with a durable audio store, range-aware serving, quota/eviction controls, downloaded status, and remove action. Keep all audio out of automatic unlimited caching. Until implemented, say **“Saved text is available; audio needs a connection unless downloaded.”** Explain browser speech can depend on installed/local voice support.

**Acceptance:** Airplane-mode app restart plays an explicitly saved digest with seeking; unsaved audio clearly requests connectivity; cleanup frees bytes. Test shell+font availability offline, not just the saved HTML.

### F20 — [P2] Progressive ranking redraws too much and can disrupt reading

**Evidence:** `web/src/app.ts:499–502`; `web/src/render.ts:99–126`; preview observer `web/src/hosted/previews.ts:73–113`. Full render clears all notes on each batch. Detached preview targets have no render-disposal/unobserve hook.

**Impact:** Work grows across batches, reading order can jump, focused controls/media instances are replaced, and detached observer targets are a retention risk. A 500-note run at batch 20 can construct roughly **20 + 40 + … + 500 = 6,500 cards**, before folding/final redraw; this illustrates algorithmic work, not a measured frame-time claim.

**Best fix:** Keyed cards with delegated actions, append/update completed scores in a batched paint, preserve focus/anchor and active media. Freeze reorder once the reader engages; offer new results via the existing pill. Add explicit observer disposal. Start with 30–50 cards/load more; use virtualization only if profiling shows it is needed and retain accessibility/search behavior.

**Acceptance:** Scoring new batches does not replace unchanged cards or restart video; refresh/disposal leaves no detached observed notes; long-feed interaction remains responsive on a midrange phone.

### F21 — [P2] Synchronous storage work grows with feed/history size

**Evidence:** `web/src/settings.ts:230–265`; `web/src/snapshot-logic.ts:197–235`; `web/src/digest-history.ts:41–51`. Every batch reparses/rewrites today's score bucket; full cache load merges up to 30 days synchronously; snapshot/history fitting repeatedly serializes. The “bytes” limit in the browser snapshot uses string length, not actual encoded size.

**Impact:** Mobile main-thread stalls and shared quota pressure are plausible as usage accumulates. Quota failure is already consequential in F07.

**Best fix:** IndexedDB for records/snapshots/audio, keep small preferences in guarded storage, bulk writes after each paid batch, bounded indexes by context/age, and byte-aware retention. Preserve per-batch durability; do not trade a little serialization for losing all work at run completion. Report when the newest history record could not be saved.

**Acceptance:** Load a realistic 30-day cache and 30 digests; no individual storage/render long task over the agreed mobile budget; offline quota eviction retains the newest useful state and no credentials are exported implicitly.

### F22 — [P2] Digest/history polling transfers and processes more than needed

**Evidence:** `server/src/app.ts:262–268` returns body/audio/notes for up to 30 digests. `web/src/hosted/app.ts:994–1001,1053–1057,1073–1076` reloads that list during running-job checks; request helper sends no conditional-read token. Feed checks use a whole snapshot to discover whether it changed.

**Impact:** Repeated full JSON transfers, parsing and local history serialization can dominate otherwise-small status checks; server and phone expend work on unchanged data.

**Best fix:** Small list summaries with revision/ETag, fetch full digest/notes on selection, incremental `since`/latest-id responses, and separate lightweight job status. Coalesce in-flight reads, pause hidden-tab polling and refresh on return. Reserve SSE for demonstrated demand; it is not automatically simpler than good polling.

**Acceptance:** An unchanged job poll transfers only status/revision, not 30 full show-note sets; backgrounded tabs do not issue periodic reads; concurrent triggers share one request.

### F23 — [P2] Playback repaints and reparses the whole history too often

**Evidence:** `web/src/player.ts:114–119,334–341`; `web/src/digest-view.ts:356–437`; `web/src/audio-logic.ts:112–165`. Each player state update loops every digest, repeatedly parses resume storage for other entries and replaces play-button SVGs. Waveform reads geometry/computed colors on every draw (`web/src/waveform.ts:105–136`).

**Impact:** Unnecessary CPU, allocation and battery use during a listen, including updating a hidden digest tab. The cost is inferred, not a measured battery drain.

**Best fix:** Cache resume state in memory and sync on storage events; update the active player/mini on progress, and history only on meaningful selection/played/resume changes. Diff text/icon values before writes; gate hidden visual work; cache waveform dimensions/theme colors until resize/theme change. Stop save timers on playback errors.

**Acceptance:** A progress tick does not reparse 29 unrelated records or recreate unchanged SVGs; hidden views do minimal work; Media Session position follows playback, not only seek/duration events.

### F24 — [P2] Audio creation/preload uses resources without a clear payoff

**Evidence:** `web/src/player.ts:198–203` sets metadata preload on selection despite the earlier no-byte promise; actual cost depends on host/range layout. `server/src/digest-job.ts:174–186` synthesizes even when `upload` is absent. `web/src/digest-view.ts:83–84,744–749` keeps MP3 blob URLs with no eviction/revocation and can switch the selected digest after a long audio operation.

**Impact:** Metadata probing can cost bandwidth before Play; text-only server configuration wastes TTS; generated audio persists only for the page lifetime while consuming memory. Completion can unexpectedly switch a reader who selected another digest.

**Best fix:** Use supplied/cached duration without metadata fetch until intent; only synthesize if the audio can be delivered/stored; persist made audio when desired, bound blob ownership and revoke on eviction. Capture the requesting digest ID and update that entry without changing a newer selection. Show chunk progress and cost hint before paid TTS.

**Adjacent model-cost choice:** Hosted always configures a second humanizer pass (`server/src/digest-job.ts:161`), whose request includes the full ~66KB skill prompt (`lib/src/humanizer.ts:57–70`), even though the digest writer already gets a short style appendix. Options: keep the full pass for every digest; make it configurable/quality-tier dependent; or skip only after a blind quality/faithfulness comparison shows the writer is sufficient. **Recommend measurement and a configurable pass**, not an unvalidated quality downgrade. Track input/output tokens, cache discounts, latency and factual preservation by stage. Keep the upstream/vendored skill byte-identical; change orchestration/configuration if needed.

**Acceptance:** Opening a digest makes no audio request when exact duration is known; no-upload configuration makes no TTS request; selection is stable while a different entry's audio completes; abandoned blobs are freed.

### F25 — [P2] The mode gate asks an infrastructure question before showing value

**Evidence:** `web/index.html:31–47`; landing pricing buttons all link to the same `app/` entry (`landing/index.html:204,215`). The reader has to know “Hosted” and “API key” before experiencing the product; a chosen pricing path is not carried through.

**Impact:** Newcomers can hesitate or choose the wrong path. Experienced BYOK readers still deserve direct access rather than upsell friction.

**Best fix:** Lead with **“Try it without an API key”** and explain hosted as recommended for convenience; preserve **“Use my own model”** as a clearly free path. Carry explicit landing intent into app URL/state. Offer a small honest sample (reuse the landing excerpt/demo), not a fabricated personalized feed or hidden trial activation.

**Acceptance:** A new reader can explain the two choices in one sentence; a landing “Use my own key” click opens that setup directly; changing mode remains reversible without deleting configuration.

### F26 — [P2] Tune has multiple save scopes without an explicit draft model

**Evidence:** `web/index.html:398,425–429`; BYOK `web/src/app.ts:324–326` silently saves current form fields on refresh; hosted `web/src/hosted/app.ts:729–738` saves client preference before remote settings succeeds. Hosted custom profile template is not validated alongside the post template (`1230–1238`).

**Impact:** A reader may save general settings but not their schedule, or refresh and unknowingly commit edits. A failed hosted save can still partially apply a local preference. “Open settings” recovery does not match the Tune destination name.

**Best fix:** Explicit draft/saved states, clear labels **“Save interests and feed”** / **“Save daily schedule”**, inline success beside the relevant action, and independent dirty markers. Alternatively use one coordinated Save with clearly handled partial failures. Validate both link templates and repaint relevant notes after a client preference changes. Avoid a generic toast as the only save record.

**Acceptance:** Dirty schedule/general preferences cannot be mistaken for saved ones; tab changes/reloads preserve or warn about drafts; Refresh uses saved settings unless an explicit “Apply and refresh” is chosen.

### F27 — [P2] Scheduling and DM compatibility require too much protocol knowledge

**Evidence:** `web/index.html:370–403`; `web/src/hosted/app.ts:937–947,959–975`; `server/src/digest-job.ts:67–72`. Default delivery chooses modern when no previous peer message exists, while help warns some common clients require legacy. Twenty-four voices are offered without preview. Hosted empty copy says “Every morning” even if the schedule is disabled.

**Impact:** The first digest can exist in-app yet not show in the reader's client; the reader may believe daily delivery is already active. Voice/time-zone choices add avoidable uncertainty.

**Best fix:** After first listen, one optional schedule nudge with time/default zone and a clear next-run summary. Ask **“Which client receives your DMs?”** and map compatibility under the hood, retaining Advanced format override. Voice shortlist + samples; show full schedule status on Digests. Add **“Follow/open the digest account”** via the selected client and a copied complete npub.

**Acceptance:** Primal/Damus and modern-capable clients receive a first compatible message; disabled schedule copy is truthful; next run is explicit across DST and travel; voice preview does not regenerate a full digest.

### F28 — [P2] Ranking coverage, order and explanations need clearer semantics

**Evidence:** `lib/src/fetcher.ts:359–361` cuts the newest 500 candidates before ranking; hosted UI asks for 100 entries (`web/src/hosted/app.ts:607`); feed renderer puts fresh notes before the rest (`web/src/render.ts:113–120`) while status says “ranked by relevance.” Decision reasons are rubric percentages (`lib/src/ranker.ts:541–549`); card reasons are one-line ellipsized (`web/src/style.css:1499–1507`). Scoring sees 500 characters, digest 800 (`lib/src/ranker.ts:87–100`; `lib/src/digest.ts:112–114`).

**Impact:** “Best of your feed” may omit older high-value posts from a busy window; newest low-score notes can sit above older high-score ones; longform preferences are judged on an excerpt. Generic percentage explanations offer less actionable guidance than the landing demo.

**Best fix:** Disclose **“Ranked 500 recent candidates; showing 100”**, time window and sampling limits. Give **Best first / Newly arrived** as an explicit preference instead of a hidden ordering policy. Describe score as a relevance estimate, not calibrated certainty; make the full explanation reachable directly. For top notes, evaluate cheap post-specific explanations or source-grounded matched-interest cues; keep full content retrieval/longform support an explicit cost/quality choice.

**Acceptance:** Readers can tell coverage, ordering and what was scored. Don't describe model probabilities as measured confidence without calibration. Compare ranking quality on representative real feeds before changing models/rubrics.

### F29 — [P2] The feedback loop only offers public engagement or a settings edit

**Evidence:** `web/src/actions.ts`, `web/src/note-ui.ts:124–190`; Tune's learned prompt is readonly in BYOK and absent from hosted Tune. There is no local “wrong recommendation,” hide/mute or saved-note action in the current markup/action flow.

**Impact:** A reader has to publicly like a note or manually rewrite a broad prompt to steer the system. They cannot easily separate “interesting to read” from “I want to endorse it.” Heavy readers have little efficient control over repeated noise.

**Best fix:** Private **More like this / Less like this / Hide** with Undo; a local save/read-later affordance; inspect/reset learned taste in both modes. Start with local explicit exclusions and suggested prompt edits that the reader approves. Keep public likes visibly distinct from private ranking feedback.

**Acceptance:** Feedback is not published to Nostr unless clearly labeled; a reader can reverse it and inspect the changed rule; feedback actually affects future ranking rather than just animating an icon.

### F30 — [P2] Media can shift/crop content and lacks meaningful descriptions

**Evidence:** `web/src/render.ts:852–886,946–950`; `web/src/style.css:1384–1398`. Images have generic “Post media” alt text and no reserved dimensions/aspect ratio; `imeta` metadata is reduced to a URL. Max-height + cover treatment can hide parts of tall images. Hosted strips raw event tags (`server/src/app.ts:120–133`), so tag-only media differs between modes.

**Impact:** Loading images can shift a reading anchor, screenshots/comics can be cropped, and nonvisual users get no useful description. Direct media/avatar hosts still see browser requests even when link previews are proxied.

**Best fix:** Preserve safe `imeta` dimensions, alt/type metadata in a normalized media contract shared by both modes. Reserve intrinsic/aspect-ratio space, lazy async decode, offer open-full-image, meaningful supplied alt and honest fallback. Add **Data saver / Tap to load remote media**, optional proxy only with explicit operational/privacy tradeoffs; no need for automatic expensive AI alt generation on every image.

**Acceptance:** Image load does not move the current note significantly; tall media is fully accessible; tag-only media appears in hosted and BYOK; content descriptions and media loading preference survive refresh.

### F31 — [P2] Small screens and overlays need targeted adaptation, not more breakpoints everywhere

**Evidence:** `.note` reserves a 44px avatar plus gap; action row contains several 44px controls (`web/src/style.css:1190–1197,1520–1536`). At 320px, the note's main column is about **200px** while five fixed-size controls plus gaps/margins can exceed it. Post menus have 250px minimum width (`1565–1573`). Mini player and new-notes pill both stick near top with z-index 6 (`2667–2675,2770–2784`). Login dialog has no authored max-height/scroll strategy (`2454–2462`).

**Impact:** Narrow action rows/menus and sticky controls can crowd or overlap the reading area; virtual keyboards, landscape and large text may expose problems. These are calculated/source-derived risks, not observed overflow screenshots.

**Best fix:** Give narrow cards a full-width action row or selectively collapse secondary actions; cap menus to available width and reposition against viewport bounds. Reserve a shared sticky stack offset and check offline/header layering. Constrain dialog height with internal scrolling. Keep ordinary controls ≥44px where practical; 40px buttons are a comfort improvement, not automatically a WCAG 2.5.8 failure.

**Acceptance:** Verify 320/360/390/768/1440 widths, 200% text, keyboard open, safe areas and landscape. No horizontal page scroll, obscured primary controls, overlapping new-notes/player bars or unreachable dialog actions.

### F32 — [P1] Light-theme gate focus is too weak; a few contrast exceptions remain

**Evidence:** `web/src/style.css:177–180` sets white focus outlines for both hero and gate. The gate is not violet; white against the light background computes to **1.07:1**. Tertiary `#66637a` on light surface-3 `#e7e0d3` is **4.41:1**. Most main text/hero/accent pairs pass comfortably.

**Impact:** Keyboard focus can disappear on the first-run choice screen. Normal-size text needs token/background-aware contrast, not a blanket claim that all colors meet AA.

**Best fix:** White focus only on violet surfaces; theme-aware accent/text focus on neutral gates. Slightly darken the light tertiary token where used on raised surfaces and verify actual combinations. Use a stronger control boundary where a border is the only input cue. Keep color roles semantic.

**Acceptance:** Every focused gate choice is unmistakable in both themes; applicable normal text ≥4.5:1 and UI/focus cues ≥3:1; test actual rendered combinations. WCAG concerns: 1.4.3, 1.4.11 and 2.4.7, subject to live verification.

### F33 — [P2] Navigation does not represent reader intent in URLs/history

**Evidence:** `web/src/shell.ts:21–49,71–81` keeps tabs/scroll in memory and always initializes Feed; notes are transient sheets; browser history is not updated.

**Impact:** Reload/share/back do not map to a specific digest/tab/note; pressing system Back can leave the app instead of closing the detail. Commuters returning to a digest must reconstruct context.

**Best fix:** Lightweight hash/path state for tab and selected digest/note, validated before restoration; integrate sheets with Back; persist last useful location/reading anchor per identity. Add a skip-to-main path and intentional focus handling. A desktop sidebar is optional, not necessary to gain good navigation.

**Acceptance:** Reload returns to the chosen digest without autoplay; Back closes a note then returns to the previous view; share/deep links do not expose secrets or require another user's account data.

### F34 — [P2] Privacy and device-data control need a visible, precise contract

**Evidence:** API keys are stored in localStorage (`web/src/settings.ts:193`); signer client secret/permissions are remembered (`web/src/signer-store.ts:13–23,65–70`). BYOK history and hosted cached history use mode-global keys (`web/src/digest-history.ts:13–15`), with no identity namespace. Hosted tries to clear history on explicit logout, but init reads cached history before `/me` verification (`web/src/hosted/app.ts:198–199,353–371`). Public Blossom audio is uploaded as ordinary bytes (`server/src/blossom.ts:52–65`).

**Impact:** A public-content digest still reveals a personal selection of interests. A same-origin script can read stored keys/client capabilities; cached history can be briefly wrong for another identity or unavailable-session state. A DM containing an audio URL does not make the uploaded audio encrypted/private.

**Best fix:** Scope all personal caches/drafts/history/marks to canonical identity; clear/suspend them before unverified account transitions. Offer **Remember key on this device** vs session-only and **Disconnect signer / clear device data / export settings** with secrets excluded by default. Explain server/provider/media-host data flows and public audio URLs before schedule activation. A local PIN/encryption does not cure same-origin XSS; assess CSP and deployment headers separately rather than claiming encryption guarantees.

**Acceptance:** A→B account transitions never show A's digest/taste; a device wipe removes all owned data and active signer capability; exported settings omit API/signing secrets unless separately confirmed. Data deletion explains external uploads/payment-record limits.

### F35 — [P2] Provider switching lacks a coherent tested model configuration

**Evidence:** `web/src/ui.ts:58–64` changes URL but leaves model/key/per-role selections and old datalist intact. Recommended models are shown only after catalog load and only for Venice (`108–148`). Basic setup exposes base URL and raw model before validating the connection.

**Impact:** Switching Venice → Ollama/OpenRouter can leave an incompatible model, invisible advanced overrides or the wrong stored key. “Load model list” is not a test of actual scoring/streaming/TTS capability.

**Best fix:** Per-provider profiles with key/model separation; a compact default model choice; test connection and one cheap scoring request with explicit cost. Show capability-specific status and CORS/proxy recovery. Invalidate stale catalogs on provider change; retain advanced custom endpoint/model fields. Mask key by default with deliberate reveal/copy and clear actions.

**Acceptance:** Switching providers selects an available provider-appropriate default or asks to choose; no stale hidden overrides execute unexpectedly; failed test points to the correct field rather than dumping raw API JSON.

### F36 — [P2] Landing/documentation promises and entry links have drifted

**Evidence:** README line 19 points at the obsolete `cypherpunk.today/nalgorithm/` location; “No server” and absolute read-only sections predate hosted/actions. `landing/index.html:184–185,207–215` implies the same daily digest experience for both paths, but BYOK is browser/manual rather than a hosted daily DM scheduler. Both pricing CTAs go to generic `app/`; the sample player calls `audio.play()` without handling rejection (`254`).

**Impact:** Readers form the wrong expectation or begin at the wrong mode; landing demos/claims create trust debt when the real path differs.

**Best fix:** Current canonical URL `https://nalgorithm.cypherpunk.today/app/`; mode-specific privacy/cost/daily-delivery comparison; direct mode intent in CTA. Clarify **app fee free; provider usage may cost**. Keep the honest illustrative demo and real excerpt; handle sample playback errors and keyboard seeking rather than showing Pause before playback succeeds.

**Acceptance:** Every onboarding/documentation link resolves to the intended current mode, all read-only/server/daily-delivery claims match behavior, and unavailable sample audio has a readable recovery/transcript.

### F37 — [P2] Build identity and worker activation need release-contract tests

**Evidence:** `web/vite.config.ts:16` uses a minute-resolution stamp despite promising every rebuild is distinct. `web/public/sw.js:21–40` immediately skips waiting and deletes other version buckets; the page may still be deferring reload. `web/src/version-check.ts:42–47` polls at intervals even hidden; no online-triggered immediate update check is installed.

**Impact:** Same-version rebuilds within a minute can share identity; an active old page can lose its cached asset set before it is safe to reload. Offline-after-update behavior is not guaranteed merely by caching HTML.

**Best fix:** Semantic release plus content/commit build hash (or genuinely unique stamp), atomic deployment of assets/shell/version marker, retain old assets until clients finish, and coordinate activation with F16. Pause hidden polling and check on online/foreground. Confirm all shell/font dependencies are available offline before announcing an offline-ready install.

**Acceptance:** Two different same-minute builds have distinct identity; version mismatch never loops; deploy during a blocked activity then go offline and still recover. Deploy only via the repository's scripts/current `/app/` destination when fixes are separately authorized.

### F38 — [P2] Integration tests and instrumentation lag behind the feature set

**Evidence:** Web tests pass but mainly import pure helpers; current failures involve orchestration, CSS, storage and async contexts. Library/server tests run built JS; typechecking alone cannot establish live quality. No live metrics were collected in this audit.

**Impact:** A green suite can coexist with an invisible Retry, stale personal ranking and duplicate work. Model/relay incidents are often only visible to a developer console.

**Best fix:** Add a deterministic local fixture app/API for full first-run, error, keyboard, offline, update and race tests; use actual browser QA in a configured BrowserOS neo session. Instrument time-to-cached-feed/first-ranked-note, phase durations, cache hits, provider calls/tokens/retries, unranked counts, job queue age, DM acceptance and retained sockets/storage. Store sensitive prompts/content only when explicitly needed for debugging, not in default analytics.

**Acceptance:** The specific regressions F01–F18 have tests that fail on today's behavior; release smoke tests cover both modes and themes; operators can identify slow stages and cost spikes without reading personal feeds.

### F39 — [P2] Reduced-motion support should preserve meaningful state deliberately

**Evidence:** `web/src/style.css:187–195` globally shortens all animations/transitions to 0.001ms. Later indeterminate-bar rules do provide a good static alternative (`2753–2763`), but spinners do not. Shell active-tab scroll explicitly uses smooth JS behavior (`web/src/shell.ts:77`); not every JS scroll respects reduced motion.

**Impact:** Motion reduction is partly supported, but global disabling can erase useful feedback and JS scroll behavior can bypass the intended preference.

**Best fix:** Component-level alternatives: steady progress/text for ongoing work, immediate state changes for sheets/toasts, no movement for success animation; central reduced-motion-aware scroll helper. Keep deliberate static progress treatment rather than a universal timing hack.

**Acceptance:** Reduced-motion users still recognize work/progress/success without moving spinners or smooth page movement; accessibility tests cover preference changes while the app is open.

### F40 — [P3] Visual refinement should strengthen the reading hierarchy

**Evidence:** Large violet hero, lime score pills/reasons, top-note stripe and sticky mini player coexist; the app is a centered 680px column at desktop (`web/src/style.css:42–46,670–704,1478–1506,2770–2784`). There is no explicit reader-selected theme/density option. The deterministic type-hierarchy warning was false.

**Impact:** The foundation is coherent, but score/UI accents can compete with the content, and a dense user may want fewer large surfaces. These are design hypotheses to test, not screenshot-confirmed defects.

**Best fix:** Preserve violet for listening and lime for action/selection; make explanations quieter until asked, with a strong accessible “Why this?” path. Prefer content over score decoration, distinguish the actual highest-ranked note from first-in-fresh-group, and add comfortable/compact and system/light/dark preferences only if users need them. Keep the readable desktop column; a navigation rail is an optional convenience, not a reason to widen prose.

**Acceptance:** In a bounded desktop/mobile visual review, one primary next action is apparent, note text outranks metadata, full reasons remain discoverable, and both themes feel authored. Do not redesign the icon/type/palette merely to satisfy a style detector.

### F41 — [P2] Retention and scaling policies need limits beyond visible UI caps

**Evidence:** Scores/previews are pruned daily (`server/src/main.ts:141–145`), but digest/delivery/profile/account storage has no comparable retention in this entry point; expired sessions are not periodically pruned (`server/src/auth.ts:78–94`). Browser profile/preview/relay-list maps are session-long, and preview observers lack teardown. Scheduled jobs run in fixed windows of concurrency 2 (`server/src/scheduler.ts:87–91`), idling a fast slot behind its slow peer.

**Impact:** A 30-item UI cap is not a server retention policy. Growth, queued morning bursts, stale identity metadata and memory use become visible as more readers arrive.

**Best fix:** Explicit database/audio retention and deletion/export policies, periodic expired-session/unused metadata cleanup with suitable indexes, bounded LRU/negative-cache TTLs, and a work-conserving global queue. Track pool/DB sizes before optimizing every Map; preserve valuable public profile caching and paying-user history by agreement.

**Acceptance:** Load tests at expected concurrent-reader levels show bounded queues/maps/sockets; database size follows policy; users understand history/audio expiry and can export anything the service promises to retain.

## Owner decision register

These are product/policy choices, not questions blocking this unattended report. Recommended defaults are stated explicitly. Fixing correctness, hidden errors, inaccessible controls and cleanup does **not** require deciding on a full redesign.

| Decision | Options | Recommendation and tradeoff |
|---|---|---|
| D01: What is the default first-run promise? | A. Feed first; B. Digest first; C. Ask reader to choose | **Feed first for initial evidence, digest next for the signature payoff.** A few ranked notes show that the user's words worked while audio is being made. Returning listeners can reopen their last digest. Do not add a permanent first-run product-choice hurdle. |
| D02: How strongly to recommend hosted? | A. Equal technical choices; B. Convenient hosted recommendation with free BYOK secondary; C. Hosted-only onboarding | **B.** “Try without an API key” is clearer than “Hosted,” while a direct free BYOK path remains visible. Do not hide the free option or call third-party API usage universally free. |
| D03: Signer permissions at hosted login | A. Login only, actions later; B. Optional action checkbox; C. Require all action kinds up front | **A with optional B for experienced readers.** Reduces trust friction and requested capability. C saves one scan but is not necessary for the core read/listen task. Provide a remember-connection choice and disconnect guidance. |
| D04: Cache behavior when taste changes | A. Never reconsider old scores; B. Re-score on every learned update; C. Re-score on explicit-interest/rubric change, learned changes prospective with optional rerank | **C.** Corrects a broken user promise without making every like trigger costly churn. Keep old contexts until eviction, show provenance, and provide a cost-aware “Apply new taste to existing notes.” |
| D05: Meaning of “Learn from my likes” off | A. Freeze current learned taste; B. Ignore learned taste entirely; C. Ask every time | **B as the intuitive off state**, with “Pause learning” separately available for A. Keep explicit interests authoritative and let people inspect/delete learned taste. Current hosted behavior is effectively A but is not labeled as such. |
| D06: Automatic refresh vs privacy/cost | A. Every stale interval by default; B. Open/foreground plus budget-aware updates; C. Manual only | **B.** Default to a predictable open/return refresh and a conservative visible cadence with cache hits, shared work and daily budget. Expose “Manual only” and pause on permanent errors. Cross-tab leadership prevents paying twice. |
| D07: What should go first in the feed? | A. Best score regardless of age; B. New group above all older notes; C. User-selectable with explicit labels | **C, default A for the core promise**, with a new-note badge/pill and a remembered Newly arrived option. Current B is useful but must not be described as pure global best-first order. |
| D08: How much intelligence to add to explanations? | A. Existing generic rubric percentages; B. Generate prose for every post; C. Cheap matched-interest view and optional/top-note explanation generation | **C after cache correctness.** B can erase the decision scorer's speed/cost advantage and creates another generated claim to validate. Keep percentages in Advanced, avoid treating them as calibrated confidence. |
| D09: Digest length/control | A. Number of notes only; B. Target minutes only; C. Target minutes with an advanced note cap | **C.** “A 3/6/10-minute catch-up” maps to listener time better than “15 posts.” Start with a 6-minute default consistent with current prompts, adapt length to meaningful input rather than padding, and retain advanced caps. |
| D10: Daily schedule activation | A. Automatically enable on sign-in; B. First listen → opt-in schedule; C. Tune-only setup | **B.** First prove value, then nudge once. Never enable recurring DMs merely because the user tried a first digest. A clear one-off first-digest request can be bundled into “Rank my feed and make a sample digest” if disclosed. |
| D11: Default DM compatibility | A. Modern by default; B. Legacy by default; C. Ask receiving client/use peer capability | **C.** Use the client's capability and last received DM, with manual format override. Modern offers better privacy; legacy is still necessary for some clients. Explain the tradeoff in Advanced rather than making every reader understand NIP numbers. |
| D12: Offline scope | A. Text/snapshot only; B. Explicit selected-audio downloads; C. Automatically cache all audio | **B.** Most useful for morning commuters with controllable storage/bandwidth. A is an honest near-term fallback; avoid C without quota limits and clear consent. |
| D13: Digest audio privacy | A. Public Blossom URLs with disclosure; B. Authenticated private playback; C. Encrypted audio with client-compatible playback tools | **A for current cross-client compatibility, with prominent disclosure**, while evaluating B if sensitive-interest users need it. B/C change the “plain link plays anywhere” promise and operational complexity. This is not solved by encrypting the DM alone. |
| D14: Private feedback scope | A. Public likes only; B. Local hide/exclusions and approved prompt edits; C. Full learned recommendation-feedback model | **B first.** Small, transparent and reversible; measure usefulness before building C. Private feedback and public likes must stay separate actions. |
| D15: Source media privacy/data savings | A. Current direct lazy loading; B. Tap-to-load/data saver; C. Server proxy all media | **B as a user choice**, retaining A for convenience. C can hide IP/referrer from origin sites but moves traffic/storage/abuse load to your service; do not imply link-preview proxying already protects all media. |
| D16: Settings save model | A. One global Save; B. Independently saved sections; C. Autosave | **B with explicit dirty/saved indicators**, because server settings, local preferences and schedules have different persistence/contracts. First-run essential setup still has one “Save and rank.” Autosave needs rollback/error semantics before it is safe. |
| D17: Frontend architecture | A. Rewrite in a framework; B. Keep vanilla TypeScript with lifecycle/store boundaries; C. Split modes into separate apps | **B.** Most defects are solvable with a storage adapter, context-scoped job controller, keyed renderer and unified toast. A is not justified by a 105KB-gzip bundle or by helper tests alone; C risks UX divergence and duplicate maintenance. |
| D18: Job/queue infrastructure | A. In-process promises/locks; B. Durable DB-backed jobs + global in-process provider budget; C. External queue service | **B for this app's current scale.** Add leases/stages/outbox and cross-process claims where needed. An external queue is appropriate only if multiple workers/instances and operational load require it. |
| D19: History retention | A. Indefinite; B. Fixed 30/90-day retention; C. Tiered/policy-driven retention with export | **C, choose a documented initial bound** (for example 90 days of digest text/source notes, shorter local/offline caps). Do not purge existing data as a “cleanup” without user-facing policy and migration. Audio-host retention may differ. |
| D20: Visual direction | A. Full rebrand; B. Refine existing violet/lime reading/listening system; C. Conventional monochrome Nostr client | **B.** Fix hierarchy/state first; retain personality and the audio identity. Validate a desktop/mobile visual pass before investing in new imagery/fonts or a navigation redesign. |

## Nudges: exactly when and what to ask the reader to do

Nudges should be contextual, dismissible, once-per-milestone, and grounded in a useful result. No permanent checklist clutter after activation.

1. **Empty/unconfigured BYOK:** “Three things before I can rank: your public key, your interests, and a model connection.” Highlight the next missing item and hide optional controls. CTA: **Finish setup**.
2. **Interests field:** Offer two or three editable example starters plus “Things to avoid,” not a large topic taxonomy. Say **“Use your own words; you can change this later.”** Do not auto-infer a sensitive taste without showing it.
3. **Model credentials entered:** **Test model connection** before a 500-note job. Explain the tiny test's cost and distinguish key/model/CORS failures.
4. **First ranking ready:** A one-time inline note **“These are ranked against your words. Open ‘Why this?’ to see the match.”** CTA: **Try a digest** while hosted automatically making one uses a calm status, not a second actionable generation button.
5. **First digest arrives:** **Play your first digest · ~6 min**. Keep it visible in the right context; no autoplay, browser notification permission or forced tab switch.
6. **After first useful listen:** **“Have this ready tomorrow at 7:30?”** Show detected zone and receiving-client compatibility. CTA: **Set daily delivery**; secondary **Not now**. Never silently enable the schedule.
7. **Poor recommendation:** **Less like this** → private undoable rule/suggested prompt edit. Do not use a public heart as the only way to train taste.
8. **Trial close to ending, after demonstrated value:** A quiet remaining-time line with **Add time**, exact sats/days and BYOK alternative. Avoid urgency graphics, repeated modal paywalls or “you'll lose everything” copy.
9. **Offline/listening use:** Offer **Save this digest offline** after the reader selects/listens, show size, and ask for installation only after repeat usage. PWA install should be helpful, not a mandatory setup step.
10. **Incomplete/failed operation:** The nudge is a recovery action—fix model, retry delivery, widen window, re-connect signer—not a generic Refresh loop. Leave enough context to know whether it will spend again.

## Recommended implementation sequence

No changes are made by this report. The following sequence minimizes regressions and avoids polishing around broken behavior.

### Phase 1 — correctness and visible recovery (first release)

- F01/F13: context-correct score cache and unique digest selection; include cache migration/provenance and tests.
- F04/F05/F08: toast isolation, visible boot failures, truthful partial ranking/permanent-error handling.
- F02/F03/F07/F17: validated first setup, memory-only fallback, local-provider support and live-check lifecycle.
- F06/F18/F32: honest permissions, keyboard reachability and light focus contrast.
- F16: protect drafts/generation/playback during mandatory automatic updates.

**Release gate:** A clean-device reader in either mode reaches useful output; bad credentials and offline startup never look like successful ranking or an indefinite spinner; keyboard-only use can read digest text; only correct-context scores are reused.

### Phase 2 — eliminate unnecessary spending and fragile background work

- F09/F10/F11/F12: stage budgets, teardown, incremental learning, shared pipelines and provider-wide queue.
- F14/F15: durable artifact/job/delivery states, renewable leases, idempotent retry.
- F20–F24: keyed render/observer lifecycle, storage efficiency, conditional payloads, active-only playback paints and intentional audio loading.
- F37/F41: release/worker contract and bounded retention/queues.

**Release gate:** Unchanged revisits cause no new scoring/learning charges; duplicate tabs do not duplicate a pipeline; delivery failure does not regenerate audio; resources settle after repeated runs.

### Phase 3 — activation, listening habit and control

- F25–F29/F33/F35/F36: direct mode handoff, short essential setup, clear saves, schedule nudge/compatibility, private feedback and source-grounded explanations.
- F19/F30/F31/F34: explicit offline audio, normalized media/data saver, responsive/large-text behavior, device/privacy controls.
- F39/F40: intentional reduced motion and final visual hierarchy refinement.

**Release gate:** New readers can explain what happens next and why; listening works in the actual daily-use contexts; every new control has an honest persistence/privacy contract.

### Appropriate design workflows if implementation is authorized later

1. `/impeccable harden` — source-specific error, storage, accessibility and update-state fixes.
2. `/impeccable onboard` and `/impeccable clarify` — essential first-run path, permission/save/DM copy and contextual nudges.
3. `/impeccable optimize` — measured stage, rendering, payload and playback improvements.
4. `/impeccable adapt` — narrow layouts, zoom, keyboard and overlay stack.
5. `/impeccable audit` — repeat technical checks with a working browser and actual screenshots.
6. `/impeccable polish` — final bounded visual pass, after behavior is correct.

The engineering acceptance criteria above matter more than invoking a particular design command.

## Measurement plan and resource budgets

These are proposed initial targets, **not current measured performance**. Baseline on real fixtures/devices before treating targets as a release SLA.

| Measure | Suggested starting target | Why / how |
|---|---|---|
| Warm saved-feed paint | ≤500ms after JS starts on representative midrange phone | Measure local snapshot restore independently of network/model work |
| First actionable fresh result | Progressive once first valid batch is available; communicate stage beyond 10s | Record follows/posts/embedded/profile/score stages separately; track P50/P95 |
| UI interaction | INP ≤200ms; no unnecessary >50ms storage/render task | Measure long feeds and 30-day caches while scoring/listening, not just the empty gate |
| Layout stability | CLS ≤0.1 during initial use; maintain reader anchor on late media/new results | Reserve media space and capture viewport anchor under asynchronous enrichment |
| Cold code transfer | Keep JS around/below current ~105KB gzip unless features justify growth | Existing artifact is modest; optionally defer signer/zap/TTS UI. Do not bundle all font subsets into a measured “initial download” estimate |
| Repeat feed/model cost | 0 scoring calls for identical candidates/context; 0 learning calls for no new likes | Expose counters, verify cache provenance and incremental state |
| Concurrency | One same-context pipeline per reader; provider-key-wide cap with headroom | Test feed + manual/scheduled digest + multiple users together |
| Hidden-tab behavior | No periodic feed/digest-list network reads; active audio continues | Refresh once on return; lightweight job recovery can be deferred without losing server work |
| Relay lifetime | Owned connections/subscriptions return to baseline after work | Instrument creates/closes; distinguish intentionally retained signer/action pool from leaked fetcher pools |
| Memory/storage | Stable after 20 refreshes/detail opens/digest switches | Heap/DOM observer profiling; bounded offline bytes and LRU maps rather than an invented MB cap |
| Generation/delivery | One artifact per logical job, delivery retries reuse it | Track job IDs, stages, TTS bytes/cost and DM relay outcomes |
| Billing recovery | Invoice-specific confirmation without unnecessary entitlement refetches | Current 4s polling can do 150 HTTP reads in 10 minutes; backend 60s cache can delay confirmation. Measure before choosing push vs polling |

### Resource priority: where to spend effort first

**Highest:** unnecessary provider calls, long blocking enrichment, leaked relay work, duplicated pipelines, repeat generation on delivery failure. These affect actual money, first-result latency and service capacity.

**Next:** full feed redraws, synchronous cache/history parsing, large repeated digest payloads and hidden-view playback painting. These affect smoothness and battery on phones.

**Later/only with measurements:** splitting a modest initial bundle, changing framework, replacing canvas waveform, trimming already-unrequested font subsets, or adding an external queue. Avoid optimizing decoration while a wrong key triggers every scoring batch's retries.

## Regression and real-device verification matrix

### Deterministic automated checks

- Fresh hosted and BYOK activation; Save installs/reconfigures checks; no optional field required accidentally.
- Context change: explicit prompt, identity, scorer/model-policy; unchanged context remains cached; existing learned preference policy is preserved.
- Keyless Ollama; provider switch with old hidden overrides; malformed endpoint/key/relay and all numeric boundaries.
- Bad API credentials/model: one early permanent failure, truthful unranked state; mixed successful/failed batches cache only successes.
- Storage disabled/full/corrupt: still usable, no misleading saved success, no mode loop or scoring callback failure.
- Two requests/tabs, feed + digest, manual + scheduled, two users sharing one provider key; same-context single-flight and bounded queue.
- Digest original/boost/quote selection; source list equals writer input; delivery failure/partial relay acceptance does not regenerate.
- Long healthy job renews its lease; process crash recovers work; startup cannot clobber another active owner if multi-instance is supported.
- Version deploy while editing/signing/ranking/generating/TTS/paying/playing; overlapping blockers; draft restoration and automatic eventual update.
- Toast DOM/CSS visibility/clickability; hosted boot error outside signed-in gate; complete tabs keyboard and named login statuses.
- Repeated rendering closes observers, frees abandoned audio URLs and leaves stable sockets/DOM counts.

### Browser/device checks still required

- Desktop Chrome/Firefox/Safari; Android with Amber; iOS Safari/PWA and a receiving Nostr client; keyboard-only + VoiceOver/NVDA where available.
- Both themes; system-theme change; reduced motion; 320px up to wide desktop; 200% text/zoom; portrait/landscape; keyboard open; long names/npubs/URLs/prompts.
- 0 follows, unavailable follow-list relays, replies-only window, 100/1,000+ follows, duplicate boosts, longform, media-only posts and slow profiles. Distinguish “no content” from “couldn't fetch content.”
- Slow mobile network, real relay/provider timing, offline startup, return after several days, shared device A→B, expired session, blocked storage.
- Real audio with range headers and slow buffering; resume/replay/speed/background/lock screen; audio failure with text fallback; downloaded offline seeking.
- Real signer approval delay/cancel/revoke/wrong key and expired login challenge. Current event freshness is 60s while remote signing can wait 120s (`server/src/auth.ts:11`; `web/src/nostr-login.ts:67`): renew/retry safely if approval is legitimately slow, without extending replay risk casually.
- Trial not consumed by merely opening the gate; trial start only on disclosed first use; plan credit; popup blocked; paid-but-confirmation-delayed; session expires during payment; no accidental new invoice on retry.
- Actual screenshots of gates, populated Feed, empty/ready Digests, Tune, payment, composer, error/toast states and sticky overlays. Use one batched inspection and one confirmation pass rather than endless visual tweaking.

## Scope and maintenance notes

- No full security review is claimed. Auth has good signed-event/identity/nonce checks and HttpOnly hosted sessions; this audit flags privacy/permission issues where they affect user trust and resource use.
- Do not modify the vendored `lib/skills/humanizer/SKILL.md` locally. If humanizer cost/quality changes are considered, change configuration/integration or follow its upstream update process. The skill text should not be edited as a performance shortcut.
- Existing untracked product/surface/region files were preserved. The surface brief's stale `app` target should be repointed after the owner confirms the intended source, not deleted automatically.
- A newer Impeccable v4.5.0 was reported (installed v4.3.1). Optional maintenance: update in a later authorized session with `npx impeccable update`; no tooling update is needed to act on the audit findings.
- No questions were sent because the user explicitly requested an unattended audit. The decision register supplies options/recommendations instead.

## Closing recommendation

**Ship a reliability-and-activation release before a design makeover.** The small set of existing beta users is an excellent opportunity to fix the end-to-end promise now: the reader's words must measurably affect ranking, failures must be visible, the first value must arrive with little setup, and repeated use must not repeat expensive work. Then validate the listening/scheduling habit and refine the already-coherent visual language with real desktop/mobile evidence.
