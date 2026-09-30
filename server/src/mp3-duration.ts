/**
 * The exact length of an MP3, from its frames.
 *
 * Speech is stitched together from several TTS calls with no length header, so
 * a player can only guess from the bitrate. Walking the frames gives the real
 * figure. Only MPEG Layer III (what the speech service returns) is read.
 */

/** kbit/s by index; index 0 means "free format" and 15 is invalid. */
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const RATES_V1 = [44100, 48000, 32000]
const RATES_V2 = [22050, 24000, 16000]
const RATES_V25 = [11025, 12000, 8000]

interface Frame {
  length: number
  samples: number
  sampleRate: number
  /** The bytes of the frame after its 4-byte header where a Xing/Info/VBRI tag would start. */
  tagAt: number[]
}

/** Parse the header at `i`, or null when it is not a valid Layer III header. */
function readFrame(b: Uint8Array, i: number): Frame | null {
  if (i + 4 > b.length) return null
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null
  const versionBits = (b[i + 1] >> 3) & 3
  const layerBits = (b[i + 1] >> 1) & 3
  if (versionBits === 1 || layerBits !== 1) return null // reserved version; only Layer III
  const bitrateIndex = b[i + 2] >> 4
  const rateIndex = (b[i + 2] >> 2) & 3
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null

  const v1 = versionBits === 3
  const bitrate = (v1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]
  const sampleRate = (v1 ? RATES_V1 : versionBits === 2 ? RATES_V2 : RATES_V25)[rateIndex]
  const padding = (b[i + 2] >> 1) & 1
  const samples = v1 ? 1152 : 576
  const length = Math.floor(((v1 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding
  if (length < 4) return null

  const mono = ((b[i + 3] >> 6) & 3) === 3
  const crc = (b[i + 1] & 1) === 0 ? 2 : 0
  const sideInfo = v1 ? (mono ? 17 : 32) : mono ? 9 : 17
  return { length, samples, sampleRate, tagAt: [4 + crc + sideInfo, 4 + crc + 32] }
}

/** The tag in the first frame that carries no audio (Xing/Info for VBR and LAME, VBRI for Fraunhofer). */
function isInfoFrame(b: Uint8Array, i: number, f: Frame): boolean {
  const at = (off: number, s: string): boolean => {
    if (i + off + s.length > b.length) return false
    for (let k = 0; k < s.length; k++) if (b[i + off + k] !== s.charCodeAt(k)) return false
    return true
  }
  return at(f.tagAt[0], 'Xing') || at(f.tagAt[0], 'Info') || at(f.tagAt[1], 'VBRI')
}

/** Skip an ID3v2 tag at the start. Returns the first byte after it. */
function skipId3v2(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
  const footer = b[5] & 0x10 ? 10 : 0
  return 10 + size + footer
}

/**
 * Duration in seconds, to the millisecond, or null when the bytes hold no MP3 audio.
 *
 * A frame counts only when the next one follows it (or the data ends there), so
 * a stray 0xFFE0 pattern inside an ID3 tag or garbage does not add time. After
 * garbage the parser resyncs on the next valid chain. A partial last frame and
 * a trailing ID3v1 tag are ignored.
 */
export function mp3DurationSeconds(buf: Uint8Array): number | null {
  let pos = skipId3v2(buf)
  let seconds = 0
  let frames = 0
  let first = true
  // Where the previous frame said the next one starts: a frame there is already confirmed.
  let confirmedAt = -1

  while (pos + 4 <= buf.length) {
    const f = readFrame(buf, pos)
    if (!f) {
      pos++
      continue
    }
    const end = pos + f.length
    if (end > buf.length) break // a partial last frame
    const followed = buf.length - end < 4 || readFrame(buf, end) !== null || isTrailer(buf, end)
    if (pos !== confirmedAt && !followed) {
      pos++
      continue
    }
    confirmedAt = followed ? end : -1
    if (first && isInfoFrame(buf, pos, f)) {
      first = false
      pos = end
      continue
    }
    first = false
    seconds += f.samples / f.sampleRate
    frames++
    pos = end
  }
  return frames > 0 ? Math.round(seconds * 1000) / 1000 : null
}

/** ID3v1 ("TAG", 128 bytes) or an APE tag footer after the last frame. */
function isTrailer(b: Uint8Array, at: number): boolean {
  if (at + 3 <= b.length && b[at] === 0x54 && b[at + 1] === 0x41 && b[at + 2] === 0x47) return true
  return false
}
