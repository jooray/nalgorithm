// Builds MP3 byte streams out of valid Layer III frame headers with silent bodies.
const V1_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const V2_BITRATES = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const RATES = { 3: { 44100: 0, 48000: 1, 32000: 2 }, 2: { 22050: 0, 24000: 1, 16000: 2 }, 0: { 11025: 0, 12000: 1, 8000: 2 } }

/** One frame. `version`: 1 (MPEG1), 2 (MPEG2) or 2.5. */
export function frame({ version = 1, bitrate = 128, rate = 44100, padding = 0, mono = false } = {}) {
  const bits = version === 1 ? 3 : version === 2 ? 2 : 0
  const table = version === 1 ? V1_BITRATES : V2_BITRATES
  const bitrateIndex = table.indexOf(bitrate) + 1
  if (bitrateIndex === 0) throw new Error(`bad bitrate ${bitrate}`)
  const rateIndex = RATES[bits][rate]
  if (rateIndex === undefined) throw new Error(`bad rate ${rate}`)
  const length = Math.floor(((version === 1 ? 144 : 72) * bitrate * 1000) / rate) + padding
  const b = new Uint8Array(length)
  b[0] = 0xff
  b[1] = 0xe0 | (bits << 3) | (1 << 1) | 1 // sync, version, Layer III, no CRC
  b[2] = (bitrateIndex << 4) | (rateIndex << 2) | (padding << 1)
  b[3] = mono ? 0xc0 : 0x00
  return b
}

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** `frames` identical frames. */
export function mp3(opts = {}) {
  const f = frame(opts)
  return concat(...Array.from({ length: opts.frames ?? 10 }, () => f))
}

/** An ID3v2 tag of `size` payload bytes (sync-safe size). */
export function id3v2(size, { footer = false } = {}) {
  const h = new Uint8Array(10 + size + (footer ? 10 : 0))
  h.set([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
  return h
}
