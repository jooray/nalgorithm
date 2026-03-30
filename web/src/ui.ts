/**
 * Nalgorithm Web — UI management (settings panel, status, bindings)
 */

import {
  loadSettings,
  saveSettings,
  clearScoreCache,
  PROVIDER_URLS,
  type AppSettings,
} from './settings.js'

type RefreshCallback = () => Promise<void>
type RegenerateCallback = () => Promise<void>

/**
 * Initialize all UI bindings. Returns the current settings.
 */
export function initUI(
  onRefresh: RefreshCallback,
  onRegenerate: RegenerateCallback
): AppSettings {
  const settings = loadSettings()

  // Populate fields
  populateFields(settings)

  // Settings panel toggle
  const btnSettings = $<HTMLButtonElement>('#btn-settings')
  const btnClose = $<HTMLButtonElement>('#btn-close-settings')
  const overlay = $('#settings-overlay')
  const panel = $('#settings-panel')

  btnSettings.addEventListener('click', () => {
    panel.classList.remove('hidden')
    overlay.classList.remove('hidden')
  })

  const closeSettings = () => {
    panel.classList.add('hidden')
    overlay.classList.add('hidden')
  }

  btnClose.addEventListener('click', closeSettings)
  overlay.addEventListener('click', closeSettings)

  // Provider change updates API base URL
  const selectProvider = $<HTMLSelectElement>('#select-provider')
  const inputApiBase = $<HTMLInputElement>('#input-api-base')

  selectProvider.addEventListener('change', () => {
    const provider = selectProvider.value
    if (provider !== 'custom') {
      inputApiBase.value = PROVIDER_URLS[provider] ?? ''
    }
    inputApiBase.readOnly = provider !== 'custom'
  })

  // Set initial readonly state
  inputApiBase.readOnly = selectProvider.value !== 'custom'

  // Save settings
  const btnSave = $<HTMLButtonElement>('#btn-save-settings')
  btnSave.addEventListener('click', () => {
    const updated = readFieldsToSettings()
    saveSettings(updated)
    setStatus('Settings saved')
    closeSettings()

    // Enable refresh button if settings look valid
    const btnRefresh = $<HTMLButtonElement>('#btn-refresh')
    btnRefresh.disabled = false
  })

  // Clear scores
  const btnClearScores = $<HTMLButtonElement>('#btn-clear-scores')
  btnClearScores.addEventListener('click', () => {
    clearScoreCache()
    setStatus('Cached scores cleared')
  })

  // Refresh
  const btnRefresh = $<HTMLButtonElement>('#btn-refresh')
  btnRefresh.addEventListener('click', () => {
    onRefresh().catch((err) => {
      setStatus(`Error: ${(err as Error).message}`)
    })
  })

  // Regenerate learned prompt
  const btnRegenerate = $<HTMLButtonElement>('#btn-regenerate-learned')
  btnRegenerate.addEventListener('click', () => {
    onRegenerate().catch((err) => {
      setStatus(`Error: ${(err as Error).message}`)
    })
  })

  // Enable refresh if settings look valid
  if (settings.npub && settings.apiKey && settings.userPrompt) {
    btnRefresh.disabled = false
  }

  // Auto-open settings if npub is not configured yet
  if (!settings.npub.trim()) {
    panel.classList.remove('hidden')
    overlay.classList.remove('hidden')
  }

  return settings
}

/**
 * Set the status bar text.
 */
export function setStatus(text: string): void {
  const el = $('#status')
  el.textContent = text
}

/**
 * Set the status bar with a spinner.
 */
export function setStatusLoading(text: string): void {
  const el = $('#status')
  el.innerHTML = `<span class="spinner"></span>${escapeHtml(text)}`
}

/**
 * Update the learned prompt display.
 */
export function setLearnedPrompt(prompt: string): void {
  const el = $<HTMLTextAreaElement>('#input-learned-prompt')
  el.value = prompt
}

/**
 * Disable/enable the refresh button.
 */
export function setRefreshEnabled(enabled: boolean): void {
  const btn = $<HTMLButtonElement>('#btn-refresh')
  btn.disabled = !enabled
}

/**
 * Show/hide the empty state.
 */
export function showEmptyState(show: boolean): void {
  const empty = $('#feed-empty')
  const list = $('#feed-list')
  empty.style.display = show ? 'block' : 'none'
  list.style.display = show ? 'none' : 'flex'
}

/**
 * Get the feed list container element.
 */
export function getFeedContainer(): HTMLElement {
  return $('#feed-list')
}

/**
 * Read current settings from the form fields.
 */
export function readFieldsToSettings(): AppSettings {
  return {
    npub: $<HTMLInputElement>('#input-npub').value.trim(),
    relays: $<HTMLTextAreaElement>('#input-relays').value
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r.length > 0),
    provider: $<HTMLSelectElement>('#select-provider').value,
    apiBaseUrl: $<HTMLInputElement>('#input-api-base').value.trim(),
    apiKey: $<HTMLInputElement>('#input-api-key').value.trim(),
    model: $<HTMLInputElement>('#input-model').value.trim(),
    userPrompt: $<HTMLTextAreaElement>('#input-user-prompt').value.trim(),
    learnedPrompt: $<HTMLTextAreaElement>('#input-learned-prompt').value,
    hoursBack: parseInt($<HTMLInputElement>('#input-hours-back').value, 10) || 24,
    batchSize: parseInt($<HTMLInputElement>('#input-batch-size').value, 10) || 20,
    njumpBaseUrl: $<HTMLInputElement>('#input-njump-base').value.trim() || 'https://njump.me/',
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function populateFields(settings: AppSettings): void {
  $<HTMLInputElement>('#input-npub').value = settings.npub
  $<HTMLTextAreaElement>('#input-relays').value = settings.relays.join('\n')
  $<HTMLSelectElement>('#select-provider').value = settings.provider
  $<HTMLInputElement>('#input-api-base').value = settings.apiBaseUrl
  $<HTMLInputElement>('#input-api-key').value = settings.apiKey
  $<HTMLInputElement>('#input-model').value = settings.model
  $<HTMLTextAreaElement>('#input-user-prompt').value = settings.userPrompt
  $<HTMLTextAreaElement>('#input-learned-prompt').value = settings.learnedPrompt
  $<HTMLInputElement>('#input-hours-back').value = String(settings.hoursBack)
  $<HTMLInputElement>('#input-batch-size').value = String(settings.batchSize)
  $<HTMLInputElement>('#input-njump-base').value = settings.njumpBaseUrl

  // Set provider select and base URL readonly state
  const provider = settings.provider
  const inputApiBase = $<HTMLInputElement>('#input-api-base')
  inputApiBase.readOnly = provider !== 'custom'

  // If the apiBaseUrl matches a known provider, select it
  for (const [key, url] of Object.entries(PROVIDER_URLS)) {
    if (settings.apiBaseUrl === url && key !== 'custom') {
      $<HTMLSelectElement>('#select-provider').value = key
      break
    }
  }
}

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  return el
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
