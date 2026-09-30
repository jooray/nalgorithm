/**
 * Generate the PWA icons from the master image.
 *
 * The master is `web/assets/icon-source.png` (1024x1024, full-bleed black, the
 * mark kept well inside the centre so the same image also serves as the
 * maskable icon). It was generated with Venice `nano-banana-pro`.
 *
 * Resizing uses `sips` (macOS) or ImageMagick's `magick`, whichever exists.
 *
 * Run: node web/scripts/make-icons.mjs
 */

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'assets', 'icon-source.png')
const OUT_DIR = join(ROOT, 'public')

const TARGETS = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
]

function resize(size, out) {
  try {
    execFileSync('sips', ['-z', String(size), String(size), SOURCE, '--out', out], { stdio: 'ignore' })
    return
  } catch {
    // no sips, try ImageMagick
  }
  try {
    execFileSync('magick', [SOURCE, '-resize', `${size}x${size}`, out], { stdio: 'ignore' })
  } catch {
    throw new Error('Need `sips` (macOS) or ImageMagick `magick` to resize the icon.')
  }
}

for (const [name, size] of TARGETS) {
  resize(size, join(OUT_DIR, name))
  console.log(`wrote public/${name} (${size}x${size})`)
}
