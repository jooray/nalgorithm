/**
 * Nalgorithm — OpenAI-compatible text-to-speech helper
 *
 * Works with any `/audio/speech` endpoint that follows the OpenAI shape
 * (Venice AI, OpenAI, and most local servers).
 *
 * The reason this module is more than a single `fetch` call: providers cap the
 * input length per request (Venice rejects anything over 4096 characters with
 * HTTP 400), while a spoken-word digest is typically 5000-8000 characters. So
 * the text is split on natural boundaries and the resulting audio is stitched
 * back together.
 */

import type { TTSConfig, TTSFormat } from './types.js'

/** Provider-side cap on a single `/audio/speech` request. Venice enforces 4096. */
export const DEFAULT_TTS_MAX_CHARS = 4096

/**
 * Audio formats whose byte streams can be concatenated directly.
 * Container formats (wav, flac, aac, opus) carry per-file headers, so joining
 * them needs a real muxer — use mp3 when the text spans multiple chunks.
 */
const CONCATENABLE_FORMATS: readonly TTSFormat[] = ['mp3', 'pcm']

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Split text into chunks of at most `maxChars`, preferring natural boundaries.
 *
 * Tries paragraph breaks first, then sentence ends, then whitespace, so a
 * chunk boundary lands in a place where a short pause sounds intentional
 * rather than mid-word. Falls back to a hard character cut only when a single
 * "word" is longer than the limit.
 */
export function splitTextForTTS(text: string, maxChars = DEFAULT_TTS_MAX_CHARS): string[] {
  if (maxChars <= 0) throw new Error('splitTextForTTS: maxChars must be positive')

  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (trimmed.length <= maxChars) return [trimmed]

  // Paragraphs are the most natural seam, so start there and only break a
  // paragraph down further when it does not fit on its own.
  const units = splitKeepingSeparators(trimmed, /\n{2,}/g)
  const chunks: string[] = []
  let current = ''

  const flush = (): void => {
    const value = current.trim()
    if (value.length > 0) chunks.push(value)
    current = ''
  }

  for (const unit of units) {
    if (current.length + unit.length <= maxChars) {
      current += unit
      continue
    }

    flush()

    if (unit.trim().length <= maxChars) {
      current = unit
      continue
    }

    // Paragraph alone is oversized — descend to sentences, then words.
    for (const piece of splitOversized(unit, maxChars)) {
      if (current.length + piece.length <= maxChars) {
        current += piece
      } else {
        flush()
        current = piece
      }
    }
  }

  flush()
  return chunks
}

/**
 * Break an oversized block into sentence-sized pieces, descending to word and
 * finally hard character splits for anything still too long.
 */
function splitOversized(block: string, maxChars: number): string[] {
  const out: string[] = []

  for (const sentence of splitKeepingSeparators(block, /(?<=[.!?])\s+/g)) {
    if (sentence.length <= maxChars) {
      out.push(sentence)
      continue
    }

    for (const word of splitKeepingSeparators(sentence, /\s+/g)) {
      if (word.length <= maxChars) {
        out.push(word)
        continue
      }
      // A single token longer than the limit (a URL, say) — hard cut.
      for (let i = 0; i < word.length; i += maxChars) {
        out.push(word.slice(i, i + maxChars))
      }
    }
  }

  return out
}

/**
 * Split on a separator regex while keeping each separator attached to the
 * piece before it, so rejoining the results reproduces the original string.
 */
function splitKeepingSeparators(text: string, separator: RegExp): string[] {
  const pattern = new RegExp(separator.source, separator.flags.includes('g') ? separator.flags : `${separator.flags}g`)
  const pieces: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    // Zero-length matches would loop forever.
    if (match.index === pattern.lastIndex) {
      pattern.lastIndex++
      continue
    }
    pieces.push(text.slice(lastIndex, match.index + match[0].length))
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) pieces.push(text.slice(lastIndex))
  return pieces.filter((p) => p.length > 0)
}

/**
 * Strip ID3v2 (leading) and ID3v1 (trailing) metadata from an MP3 buffer.
 *
 * Concatenating raw provider responses leaves an ID3 tag sitting in the middle
 * of the stream, which some decoders read as garbage audio. Removing the tags
 * from continuation chunks yields a clean single stream.
 */
function stripId3(buffer: Uint8Array): Uint8Array {
  let start = 0
  let end = buffer.length

  // ID3v2: "ID3" + version(2) + flags(1) + syncsafe size(4)
  if (
    buffer.length >= 10 &&
    buffer[0] === 0x49 && // I
    buffer[1] === 0x44 && // D
    buffer[2] === 0x33 // 3
  ) {
    const size =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f)
    const hasFooter = (buffer[5] & 0x10) !== 0
    start = 10 + size + (hasFooter ? 10 : 0)
  }

  // ID3v1: fixed 128-byte trailer beginning with "TAG"
  if (
    end - start >= 128 &&
    buffer[end - 128] === 0x54 && // T
    buffer[end - 127] === 0x41 && // A
    buffer[end - 126] === 0x47 // G
  ) {
    end -= 128
  }

  return start === 0 && end === buffer.length ? buffer : buffer.subarray(start, end)
}

/** Synthesize a single chunk. Assumes `text` is already within the provider limit. */
async function synthesizeChunk(config: TTSConfig, text: string, format: TTSFormat): Promise<Uint8Array> {
  const url = `${config.apiBaseUrl}/audio/speech`

  const body: Record<string, unknown> = {
    model: config.model,
    input: text,
    response_format: format,
  }
  if (config.voice) body.voice = config.voice
  if (config.speed !== undefined) body.speed = config.speed

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorBody = await res.text()
    throw new Error(`TTS API error (${res.status}): ${errorBody}`)
  }

  return new Uint8Array(await res.arrayBuffer())
}

export interface SynthesizeOptions {
  /** Called before each chunk is sent, for progress reporting. */
  onProgress?: (chunk: number, total: number) => void
  /** Attempts per chunk before giving up (default: 3). */
  maxAttempts?: number
  /** Base delay for exponential backoff between retries (default: 2000ms). */
  baseDelayMs?: number
}

/**
 * Synthesize `text` to speech, transparently splitting oversized input and
 * joining the resulting audio.
 *
 * @param config - Endpoint, key, model, and voice settings
 * @param text - The text to speak
 * @returns The audio bytes in `config.format` (default mp3)
 */
export async function synthesizeSpeech(
  config: TTSConfig,
  text: string,
  options: SynthesizeOptions = {}
): Promise<Uint8Array> {
  const { onProgress, maxAttempts = 3, baseDelayMs = 2000 } = options
  const format: TTSFormat = config.format ?? 'mp3'
  const maxChars = config.maxChars ?? DEFAULT_TTS_MAX_CHARS

  const chunks = splitTextForTTS(text, maxChars)
  if (chunks.length === 0) throw new Error('TTS: nothing to synthesize (input was empty)')

  if (chunks.length > 1 && !CONCATENABLE_FORMATS.includes(format)) {
    throw new Error(
      `TTS: input needs ${chunks.length} chunks (over the ${maxChars}-character limit) but format ` +
        `"${format}" cannot be concatenated safely. Use "mp3" (or "pcm") for long text, ` +
        `or shorten the digest.`
    )
  }

  const parts: Uint8Array[] = []

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i + 1, chunks.length)

    let lastErr: Error | undefined
    let audio: Uint8Array | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        audio = await synthesizeChunk(config, chunks[i], format)
        break
      } catch (err) {
        lastErr = err as Error
        if (attempt < maxAttempts) {
          await sleep(baseDelayMs * Math.pow(2, attempt - 1))
        }
      }
    }

    if (!audio) throw lastErr ?? new Error('TTS: synthesis failed')

    // Keep the first chunk's tags (players read them); drop them from the rest
    // so the joined stream has no metadata blocks partway through.
    parts.push(format === 'mp3' && i > 0 ? stripId3(audio) : audio)
  }

  if (parts.length === 1) return parts[0]

  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
