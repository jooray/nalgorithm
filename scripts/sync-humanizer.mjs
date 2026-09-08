#!/usr/bin/env node
/**
 * Generate `lib/src/humanizer-skill.generated.ts` from the vendored
 * `lib/skills/humanizer/SKILL.md`.
 *
 * The skill is markdown, but it has to reach a browser bundle as well as a Node
 * CLI, so it cannot be read from disk at runtime. This turns it into a plain TS
 * module that both builds can import.
 *
 * Runs automatically before `npm run build` in `lib` and `web`; the generated
 * file is gitignored, so there is no second copy to drift.
 *
 * Usage:
 *   node scripts/sync-humanizer.mjs           write the generated module
 *   node scripts/sync-humanizer.mjs --check   exit 1 if it is missing or stale
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(root, 'lib/skills/humanizer/SKILL.md')
const TARGET = resolve(root, 'lib/src/humanizer-skill.generated.ts')

/**
 * Split the flat frontmatter the embedded skill uses.
 *
 * Deliberately not a YAML parser: the five keys are scalars, and a dependency
 * here would have to be installed before the library can build.
 */
function parseSkill(text) {
  if (!text.startsWith('---')) {
    throw new Error(`${SOURCE}: expected YAML frontmatter, got none`)
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) {
    throw new Error(`${SOURCE}: frontmatter is not terminated`)
  }

  const frontmatter = {}
  for (const line of text.slice(3, end).split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim())
    if (match) frontmatter[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }

  return { frontmatter, prompt: text.slice(end + 4).trim() }
}

function render() {
  const { frontmatter, prompt } = parseSkill(readFileSync(SOURCE, 'utf-8'))

  if (!frontmatter.version) throw new Error(`${SOURCE}: frontmatter has no "version"`)
  if (!prompt) throw new Error(`${SOURCE}: no prompt body below the frontmatter`)

  const temperature = Number(frontmatter.temperature ?? 0.4)

  return `/**
 * GENERATED FILE — do not edit.
 *
 * Built from lib/skills/humanizer/SKILL.md by scripts/sync-humanizer.mjs.
 * To change the prompt, update the vendored skill and rebuild.
 *
 * Source: github.com/jooray/humanizer (MIT), embedded variant, v${frontmatter.version}
 */

export const HUMANIZER_SKILL = {
  version: ${JSON.stringify(frontmatter.version)},
  temperature: ${JSON.stringify(temperature)},
  prompt: ${JSON.stringify(prompt)},
} as const
`
}

const generated = render()

if (process.argv.includes('--check')) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf-8') : ''
  if (current !== generated) {
    process.stderr.write(
      'humanizer skill module is stale — run `node scripts/sync-humanizer.mjs`\n'
    )
    process.exit(1)
  }
  process.exit(0)
}

// Only write when the content actually changed, so a build does not touch the
// file's mtime and force every downstream rebuild.
if (!existsSync(TARGET) || readFileSync(TARGET, 'utf-8') !== generated) {
  writeFileSync(TARGET, generated)
  process.stderr.write(`sync-humanizer: wrote ${TARGET}\n`)
}
