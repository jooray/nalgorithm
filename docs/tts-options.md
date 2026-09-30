# Text-to-speech options for the digest

2026-09-29. Prices are Venice's list prices from `GET /api/v1/models?type=tts`, read as USD per million input characters. A 1000-word digest is about 7,000 characters; monthly figures assume one digest a day. Nothing here was measured for quality beyond listening to short samples.

## Venice models

| Model | USD / M chars | One digest | Per month | Voices | Formats | Privacy tier |
|---|---:|---:|---:|---:|---|---|
| `tts-kokoro` | 3.50 | $0.025 | $0.74 | 54 | mp3 opus aac flac wav pcm | private |
| `tts-inworld-1-5-max` | 12.50 | $0.09 | $2.63 | 14 | wav | anonymized |
| `tts-xai-v1` | 18.75 | $0.13 | $3.94 | 26 | mp3 wav pcm | anonymized |
| `tts-gradium-v1` | 47.50 | $0.33 | $9.98 | 12 | wav pcm opus | anonymized |
| `tts-chatterbox-hd` | 50.00 | $0.35 | $10.50 | 9 (+ zero-shot voice cloning) | wav | private |
| `tts-orpheus` | 62.50 | $0.44 | $13.13 | 8 | wav | private |
| `tts-elevenlabs-turbo-v2-5` | 62.50 | $0.44 | $13.13 | 21 (+ custom voice id) | mp3 | anonymized |
| `tts-qwen3-0-6b` | 87.50 | $0.61 | $18.38 | 9 | mp3 | private |
| `tts-qwen3-1-7b` | 112.50 | $0.79 | $23.63 | 9 | mp3 | private |
| `tts-minimax-speech-02-hd` | 125.00 | $0.88 | $26.25 | 15 | mp3 pcm flac | anonymized |
| `tts-gemini-3-1-flash` | 187.50 | $1.31 | $39.38 | 30 | mp3 opus wav | anonymized |

Kokoro voices (54): American `af_*`/`am_*` (alloy, aoede, bella, heart, jadzia, jessica, kore, nicole, nova, river, sarah, sky; adam, echo, eric, fenrir, liam, michael, onyx, puck, santa), British `bf_*`/`bm_*` (alice, emma, lily; daniel, fable, george, lewis), plus Spanish, French, Hindi, Italian, Japanese, Portuguese and Chinese voices. Only English is relevant unless digests are localised.

Points that matter for the hosted service:
- **Privacy tier.** The digest text summarises a user's follows and taste. `private` models (Kokoro, Qwen, Chatterbox, Orpheus) are the safer default; `anonymized` ones go through a third party.
- **Format.** The lib's `synthesizeSpeech` joins chunks for mp3 and pcm only, and the DM plan wants a `.mp3` link. That fits Kokoro, xAI, ElevenLabs, Qwen, MiniMax and Gemini. Inworld, Orpheus, Chatterbox and Gradium return wav (about 2.4 MB for 25 s, so roughly 25 MB per digest) and would need an ffmpeg step to mp3 or opus.
- **Cost against the price.** At 10,000 sats a month, Kokoro's under a dollar a month is negligible, xAI and Inworld are small, and Gemini or MiniMax would eat a large share of the subscription.

## Samples

Generated on 2026-09-29 for the same short "Good morning, nostrich" digest excerpt, one file per model and voice: Kokoro (af_sky, af_heart, af_bella, am_michael, am_adam, bf_emma, bm_george), Qwen 1.7B (Ryan, Serena), xAI (eve, rex), ElevenLabs (Rachel, Daniel), Gemini (Kore, Puck), MiniMax (CalmWoman, CasualGuy), Inworld (Ashley, Mark), Orpheus (tara, leo), Chatterbox (Carl, Vicky), Gradium (Emma, Jack). The Qwen clips are about 15 s against about 22 s for the rest, so check whether they are clipped or just faster.

## Existing local TTS

The digest can also be voiced by a self-hosted TTS service instead of Venice. The digest CLI's `ttsApi` speaks the OpenAI `/audio/speech` shape, so a self-hosted engine needs an OpenAI-compatible endpoint or a small shim. Its speed and load characteristics depend on the hardware it runs on and are noted privately by the operator. The shipped example config points at Venice `tts-kokoro`, voice `af_sky`, and moving a deployment to Venice is a config change, not a code change.

## Recommendation

Start the hosted service on `tts-kokoro` (private tier, mp3, about 2.5 cents per digest, no load on our servers). Offer a second voice model only if listening tests show Kokoro is not good enough; xAI and Inworld are the cheap upgrades, but they are anonymized-tier and Inworld needs ffmpeg.
