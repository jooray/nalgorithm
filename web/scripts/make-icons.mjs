/**
 * Generate the PWA icons.
 *
 * Writes a minimal PNG by hand (zlib is in the standard library) so the repo
 * needs no image toolchain to regenerate them. The mark is three ascending
 * bars — the ranking the app does — on the app's dark surface colour.
 *
 * Run: node web/scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const BG = [22, 27, 34] // --bg-surface #161b22
const ACCENT = [124, 92, 191] // --accent   #7c5cbf
const ACCENT_LIGHT = [157, 127, 214] // --accent-light #9d7fd6

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([len, typeAndData, crc])
}

/** Encode RGBA pixel data as a PNG buffer. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10-12: compression, filter, interlace — all 0

  // Each scanline is prefixed with a filter byte (0 = none).
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function makeIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4)
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = a
  }

  // Background. Maskable icons must fill the whole square (the launcher crops
  // to its own shape); the regular icon gets rounded corners.
  const radius = maskable ? 0 : Math.round(size * 0.18)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (radius > 0) {
        const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x
        const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue
      }
      set(x, y, BG)
    }
  }

  // Three ascending bars. Maskable keeps them inside the ~80% safe zone.
  const inset = maskable ? 0.28 : 0.2
  const left = Math.round(size * inset)
  const right = size - left
  const bottom = size - Math.round(size * inset)
  const usableW = right - left
  const barW = Math.round(usableW / 4)
  const gap = Math.round((usableW - barW * 3) / 2)
  const heights = [0.32, 0.6, 1.0]

  heights.forEach((h, i) => {
    const x0 = left + i * (barW + gap)
    const barH = Math.round((bottom - size * inset) * h)
    const y0 = bottom - barH
    const colour = i === 2 ? ACCENT_LIGHT : ACCENT
    for (let y = y0; y < bottom; y++) {
      for (let x = x0; x < x0 + barW; x++) set(x, y, colour)
    }
  })

  return encodePng(size, size, px)
}

mkdirSync(OUT_DIR, { recursive: true })
const outputs = [
  ['icon-192.png', makeIcon(192)],
  ['icon-512.png', makeIcon(512)],
  ['icon-maskable-512.png', makeIcon(512, { maskable: true })],
  ['apple-touch-icon.png', makeIcon(180, { maskable: true })],
]
for (const [name, buf] of outputs) {
  writeFileSync(join(OUT_DIR, name), buf)
  console.log(`wrote ${name} (${buf.length} bytes)`)
}
