import { pubkeyToHex, refreshLearnedPrompt, type Fetcher, type LearnedState, type PipelineStore } from 'nalgorithm'
import { deviceStorage } from './storage.js'
import { loadSettings, type AppSettings } from './settings.js'

const running = new Map<string, Promise<string | undefined>>()
export function learnedKey(identity: string): string {
  try { return `nalgorithm_learned_v2_${pubkeyToHex(identity)}` } catch { return 'nalgorithm_learned_v2_unconfigured' }
}
export function learnIncrementally(fetcher: Fetcher, settings: AppSettings, force = false): Promise<string | undefined> {
  const key = learnedKey(settings.npub)
  const existing = running.get(key)
  if (existing) { fetcher.destroy(); return existing }
  const work = (async () => {
    let state: LearnedState | null = null
    try { state = JSON.parse(deviceStorage.getItem(key) ?? 'null') } catch { /* corrupt state */ }
    if (!force && state && Date.now() - Date.parse(state.updatedAt) < 60 * 60_000) return state.prompt
    const store: PipelineStore = {
      async getLearned() { return state },
      async putLearned(value) { state = value; deviceStorage.setItem(key, JSON.stringify(value)) },
      async getScores() { return {} }, async putScores() {},
    }
    return refreshLearnedPrompt({ fetcher, store, pubkeyHex: pubkeyToHex(settings.npub),
      llm: { apiBaseUrl: settings.apiBaseUrl, apiKey: settings.apiKey, model: settings.learnerModel || settings.model }, pauseMs: 0 })
  })().finally(() => { fetcher.destroy(); running.delete(key) })
  running.set(key, work)
  return work
}
export function activeLearningResult(settings: AppSettings): boolean {
  const current = loadSettings()
  return current.learnFromLikes && learnedKey(current.npub) === learnedKey(settings.npub)
}
