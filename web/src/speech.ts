/**
 * Nalgorithm Web — speech playback via the browser's built-in engine
 *
 * Uses the Web Speech API, so there is no TTS provider, no API key, and no
 * audio leaves the device. Quality is whatever the OS ships, which is a fair
 * trade for free and instant.
 *
 * Two long-standing Chrome bugs shape this code:
 *
 * 1. Long utterances get truncated or never fire `end`. So the text is split
 *    into short chunks and queued one at a time.
 * 2. Speech stops after roughly 15 seconds unless it is nudged. So a timer
 *    calls pause()/resume() while speaking.
 *
 * Both are harmless on engines that don't need them.
 */

/** Chunk target. Short enough to dodge the truncation bug, long enough to keep prosody. */
const MAX_CHUNK_CHARS = 200

/** Chrome's speech watchdog interval. */
const KEEPALIVE_MS = 10_000

export interface SpeechVoice {
  name: string
  lang: string
  /** The underlying voice, or null for the engine default. */
  voice: SpeechSynthesisVoice | null
}

export interface SpeakOptions {
  voiceName?: string
  /** 0.1–10, default 1. */
  rate?: number
  /** 0–2, default 1. */
  pitch?: number
  /** Called as each chunk starts, for progress display. */
  onProgress?: (chunk: number, total: number) => void
  onEnd?: () => void
  onError?: (message: string) => void
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * List available voices.
 *
 * Voices load asynchronously in most browsers and the first call often returns
 * an empty list, so this waits for `voiceschanged` rather than reporting
 * "no voices" prematurely.
 */
export function listVoices(timeoutMs = 2000): Promise<SpeechVoice[]> {
  if (!isSpeechSupported()) return Promise.resolve([])

  const collect = (): SpeechVoice[] =>
    speechSynthesis
      .getVoices()
      .map((v) => ({ name: v.name, lang: v.lang, voice: v }))
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))

  const immediate = collect()
  if (immediate.length > 0) return Promise.resolve(immediate)

  return new Promise((resolve) => {
    const done = (): void => {
      speechSynthesis.removeEventListener('voiceschanged', done)
      clearTimeout(timer)
      resolve(collect())
    }
    const timer = setTimeout(done, timeoutMs)
    speechSynthesis.addEventListener('voiceschanged', done)
  })
}

/**
 * Split text into speakable chunks on sentence boundaries.
 *
 * Exported for testing — the boundary choice is audible, so it is worth
 * pinning down.
 */
export function splitForSpeech(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = []

  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue

    // Keep the terminator attached so the engine hears the sentence end.
    const sentences = trimmed.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [trimmed]
    let current = ''

    for (const sentence of sentences) {
      const piece = sentence.trim()
      if (!piece) continue

      if (piece.length > maxChars) {
        if (current) {
          chunks.push(current)
          current = ''
        }
        // Overlong sentence: break on commas, then on words.
        let buffer = ''
        for (const part of piece.split(/(?<=,)\s+/)) {
          if ((buffer + ' ' + part).trim().length <= maxChars) {
            buffer = (buffer ? buffer + ' ' : '') + part
          } else {
            if (buffer) chunks.push(buffer)
            if (part.length <= maxChars) {
              buffer = part
            } else {
              buffer = ''
              for (const w of part.split(/\s+/)) {
                if ((buffer + ' ' + w).trim().length <= maxChars) {
                  buffer = (buffer ? buffer + ' ' : '') + w
                  continue
                }
                if (buffer) {
                  chunks.push(buffer)
                  buffer = ''
                }
                if (w.length <= maxChars) {
                  buffer = w
                } else {
                  // An unbreakable token (a long URL, say). Cut it hard —
                  // an over-limit utterance is what triggers the truncation
                  // bug this chunking exists to avoid.
                  for (let i = 0; i < w.length; i += maxChars) {
                    chunks.push(w.slice(i, i + maxChars))
                  }
                }
              }
            }
          }
        }
        if (buffer) chunks.push(buffer)
        continue
      }

      if ((current + ' ' + piece).trim().length <= maxChars) {
        current = (current ? current + ' ' : '') + piece
      } else {
        if (current) chunks.push(current)
        current = piece
      }
    }
    if (current) chunks.push(current)
  }

  return chunks
}

/** A speech session the caller can stop or pause. */
export interface SpeechSession {
  stop: () => void
  pause: () => void
  resume: () => void
  isPaused: () => boolean
}

let activeKeepAlive: number | undefined

function stopKeepAlive(): void {
  if (activeKeepAlive !== undefined) {
    clearInterval(activeKeepAlive)
    activeKeepAlive = undefined
  }
}

/**
 * Speak `text`, chunked and queued.
 *
 * Cancels anything already playing — two overlapping digests help nobody.
 */
export function speak(text: string, options: SpeakOptions = {}): SpeechSession {
  if (!isSpeechSupported()) {
    options.onError?.('This browser has no built-in speech synthesis.')
    return { stop: () => {}, pause: () => {}, resume: () => {}, isPaused: () => false }
  }

  speechSynthesis.cancel()
  stopKeepAlive()

  const chunks = splitForSpeech(text)
  const voice = options.voiceName
    ? speechSynthesis.getVoices().find((v) => v.name === options.voiceName) ?? null
    : null

  let index = 0
  let cancelled = false

  const finish = (): void => {
    stopKeepAlive()
    if (!cancelled) options.onEnd?.()
  }

  const speakNext = (): void => {
    if (cancelled) return
    if (index >= chunks.length) {
      finish()
      return
    }

    const utterance = new SpeechSynthesisUtterance(chunks[index])
    if (voice) utterance.voice = voice
    utterance.rate = options.rate ?? 1
    utterance.pitch = options.pitch ?? 1

    options.onProgress?.(index + 1, chunks.length)

    utterance.onend = () => {
      index++
      speakNext()
    }
    utterance.onerror = (event) => {
      // `interrupted`/`canceled` are what stop() produces — not failures.
      const reason = (event as SpeechSynthesisErrorEvent).error
      if (reason === 'interrupted' || reason === 'canceled') {
        stopKeepAlive()
        return
      }
      stopKeepAlive()
      options.onError?.(`Speech failed: ${reason}`)
    }

    speechSynthesis.speak(utterance)
  }

  // Chrome stops speaking after ~15s without this nudge.
  activeKeepAlive = window.setInterval(() => {
    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause()
      speechSynthesis.resume()
    }
  }, KEEPALIVE_MS)

  speakNext()

  return {
    stop: () => {
      cancelled = true
      stopKeepAlive()
      speechSynthesis.cancel()
    },
    pause: () => {
      if (speechSynthesis.speaking) speechSynthesis.pause()
    },
    resume: () => {
      if (speechSynthesis.paused) speechSynthesis.resume()
    },
    isPaused: () => speechSynthesis.paused,
  }
}
