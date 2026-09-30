/**
 * JSON-file PipelineStore for the CLI.
 *
 * Keeps the on-disk formats the CLI has always written, so existing
 * digest.scores.json and digest.learned.json files keep working.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { CachedScore, LearnedState, PipelineLogger, PipelineStore } from 'nalgorithm'

interface ScoreCacheFile {
  /** ISO date string of when this cache was last written */
  updatedAt: string
  scores: Record<string, CachedScore>
}

export interface JsonStoreOptions {
  learnedPath: string
  scoresPath: string
  /** Scores older than this (by post time) are dropped on load. */
  maxScoreAgeSeconds: number
  log: PipelineLogger
  /** Minimum ms between score-file rewrites while scoring (default: 5000). */
  flushIntervalMs?: number
}

export function createJsonStore(opts: JsonStoreOptions): PipelineStore {
  const { learnedPath, scoresPath, log } = opts
  const flushIntervalMs = opts.flushIntervalMs ?? 5000
  let scores: Record<string, CachedScore> | null = null
  let lastFlush = 0
  let dirty = false

  function load(): Record<string, CachedScore> {
    if (scores) return scores
    scores = {}
    try {
      const data = JSON.parse(readFileSync(scoresPath, 'utf-8')) as ScoreCacheFile
      if (data.scores) {
        const cutoff = Math.floor(Date.now() / 1000) - opts.maxScoreAgeSeconds
        let dropped = 0
        for (const [id, entry] of Object.entries(data.scores)) {
          if (entry.createdAt >= cutoff) scores[id] = entry
          else dropped++
        }
        if (dropped > 0) {
          log.info(`Score cache: pruned ${dropped} old entries, kept ${Object.keys(scores).length}`)
        }
      }
    } catch {
      // No file or invalid JSON: start empty.
    }
    return scores
  }

  function write(): void {
    try {
      const file: ScoreCacheFile = { updatedAt: new Date().toISOString(), scores: load() }
      writeFileSync(scoresPath, JSON.stringify(file, null, 2))
      log.info(`Saved ${Object.keys(file.scores).length} scores to ${scoresPath}`)
      dirty = false
      lastFlush = Date.now()
    } catch (err) {
      log.warn(`could not save score cache: ${(err as Error).message}`)
    }
  }

  return {
    async getLearned() {
      try {
        const data = JSON.parse(readFileSync(learnedPath, 'utf-8')) as LearnedState
        if (data.prompt) return data
      } catch {
        // No file or invalid JSON
      }
      return null
    },
    async putLearned(state) {
      try {
        writeFileSync(learnedPath, JSON.stringify(state, null, 2))
        log.info(`Saved learned prompt to ${learnedPath}`)
      } catch (err) {
        log.warn(`could not save learned prompt: ${(err as Error).message}`)
      }
    },
    async getScores(keys) {
      const all = load()
      const out: Record<string, CachedScore> = {}
      for (const k of keys) if (all[k]) out[k] = all[k]
      return out
    },
    async putScores(entries) {
      Object.assign(load(), entries)
      dirty = true
      // Throttled: the file runs to several MB, and rewriting it on every
      // batch would cost more IO than the scoring saves.
      if (Date.now() - lastFlush >= flushIntervalMs) write()
    },
    async flush() {
      if (dirty) write()
    },
  }
}
