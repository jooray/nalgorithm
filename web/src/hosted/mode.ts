/**
 * Nalgorithm Web — which mode the app runs in (hosted or bring-your-own-key)
 *
 * The choice is remembered in localStorage. Storage can be blocked or throw
 * (private windows, disabled site data), so every access is guarded and the
 * app still works, just without remembering.
 */

import { loadSettings } from '../settings.js'
import { chooseMode, type AppMode } from './logic.js'
import { deviceStorage as localStorage } from '../storage.js'

const MODE_KEY = 'nalgorithm_mode'

export function getStoredMode(): string | null {
  const chosen = new URL(location.href).searchParams.get('mode')
  if (chosen === 'hosted' || chosen === 'byok') return chosen
  try {
    return localStorage.getItem(MODE_KEY)
  } catch {
    return null
  }
}

export function setStoredMode(mode: AppMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // Not remembered; the caller reloads into the default choice screen.
  }
}

/** The mode to start in, or `choose` when the person has not picked yet. */
export function resolveMode(): AppMode | 'choose' {
  let hasByok = false
  try {
    const s = loadSettings()
    hasByok = Boolean(s.npub.trim() || s.apiKey.trim())
  } catch {
    // Unreadable settings count as none.
  }
  return chooseMode(getStoredMode(), hasByok)
}

/** Remember a mode and restart, so exactly one mode's UI is ever wired up. */
export function switchMode(mode: AppMode): void {
  setStoredMode(mode)
  const url = new URL(location.href)
  url.searchParams.set('mode', mode)
  location.assign(url.toString())
}
