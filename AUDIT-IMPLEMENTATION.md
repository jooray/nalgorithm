# Audit implementation — single release

Source audit: `AUDIT-GPT61.md`. Started 2026-10-05. No intermediate deployments.

## Confirmed decisions

- Implement the entire audit in focused commits, followed by one coordinated release/deploy.
- Retain all action permissions at hosted login; accurately explain them.
- New arrivals first by default, with best-first available.
- Learning off means ignore learned preferences while retaining them for re-enabling.
- Download MP3, plus bounded local caching for the newest three digests.
- Preserve the existing visual identity and TypeScript architecture. Daily scheduling remains opt-in.

## Delivery groups

| Group | Findings | Status |
|---|---|---|
| Ranking context and unique digest selection | F01, F13 | Pending |
| Validated setup, storage and provider configuration | F02, F03, F07, F17, F26, F35 | Pending |
| Visible recovery, truthful scores, permissions and accessibility | F04, F05, F06, F08, F18, F32, F39 | Pending |
| Incremental learning, bounded fetching and cleanup | F09, F10, F11 | Pending |
| Shared pipeline/provider budget and durable jobs/delivery | F12, F14, F15, F41 | Pending |
| Safe updates, drafts and navigation | F16, F33, F37 | Pending |
| Offline/download audio and efficient playback | F19, F23, F24 | Pending |
| Stable rendering, storage and payloads | F20, F21, F22 | Pending |
| Activation, schedule, ordering and private feedback | F25, F27, F28, F29 | Pending |
| Media, responsive design, device privacy and visual refinement | F30, F31, F34, F40 | Pending |
| Documentation, fixtures, tests and observability | F36, F38 | Pending |
| Final release and coordinated deployment | All | Pending |

Each group will record changes, tests, limitations and commit references. A finding is not marked complete merely because a recommendation was documented. Real-device/provider/payment checks that cannot be performed safely will remain explicit limitations.

## Verification and deployment

- Build library, web, CLI and server; run existing and new deterministic tests with disposable databases.
- BrowserOS neo for live/local browser checks. No fallback browser without authorization.
- Do not touch pre-existing untracked `web/PRODUCT.md`, `web/.impeccable/` or `web/regions.json`.
- Do not edit the vendored humanizer skill.
- Version the release once; deploy hosted server, app and landing together only after verification.
- Send one concise SimpleX completion summary, or a blocker if the release cannot safely proceed.
