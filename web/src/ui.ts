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
import { openLoginDialog } from './login-ui.js'
import { toNpub } from './nostr-login.js'
import {
  fetchModels,
  loadCachedModels,
  suggestModels,
  describeModel,
  isVenice,
  type ModelInfo,
} from './models.js'

type RefreshCallback = () => Promise<void>
type RegenerateCallback = () => Promise<void>

/**
 * Initialize all UI bindings. Returns the current settings.
 */
export function initUI(
  onRefresh: RefreshCallback,
  onRegenerate: RegenerateCallback,
  onDigest: RefreshCallback
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

  // Connect Nostr identity (NIP-07 extension or NIP-46 remote signer)
  const btnConnect = $<HTMLButtonElement>('#btn-connect')
  const inputNpub = $<HTMLInputElement>('#input-npub')
  btnConnect.addEventListener('click', () => {
    openLoginDialog(readSignerRelays())
      .then((pubkey) => {
        if (!pubkey) return
        // Store the npub form — it round-trips through pubkeyToHex either way,
        // and it is the form a user recognizes when they look at the field.
        inputNpub.value = pubkey.startsWith('npub') ? pubkey : toNpub(pubkey)
        updateIdentityState()
        setStatus('Nostr identity connected')
      })
      .catch((err) => setStatus(`Login failed: ${(err as Error).message}`))
  })
  // Typing or clearing the npub by hand must move the indicator too.
  inputNpub.addEventListener('input', updateIdentityState)
  updateIdentityState()

  // Model catalog
  const btnLoadModels = $<HTMLButtonElement>('#btn-load-models')
  const btnRecommend = $<HTMLButtonElement>('#btn-recommend-models')
  const catalogStatus = $('#model-catalog-status')

  const applyCatalog = (models: ModelInfo[], note: string): void => {
    fillModelList(models)
    catalogStatus.textContent = `${models.length} models ${note}`
    const base = $<HTMLInputElement>('#input-api-base').value.trim()
    btnRecommend.classList.toggle('hidden', !isVenice(base))
  }

  // Show a cached catalog immediately so the pickers are useful on open.
  const cachedBase = $<HTMLInputElement>('#input-api-base').value.trim()
  if (cachedBase) {
    const cached = loadCachedModels(cachedBase)
    if (cached) applyCatalog(cached, '(cached)')
  }

  btnLoadModels.addEventListener('click', () => {
    const base = $<HTMLInputElement>('#input-api-base').value.trim()
    const key = $<HTMLInputElement>('#input-api-key').value.trim()
    catalogStatus.textContent = 'Loading…'
    btnLoadModels.disabled = true
    fetchModels(base, key, true)
      .then((models) => applyCatalog(models, 'available'))
      .catch((err) => {
        catalogStatus.textContent = (err as Error).message
      })
      .finally(() => {
        btnLoadModels.disabled = false
      })
  })

  btnRecommend.addEventListener('click', () => {
    const base = $<HTMLInputElement>('#input-api-base').value.trim()
    const models = loadCachedModels(base)
    if (!models) {
      catalogStatus.textContent = 'Load the model list first'
      return
    }
    const picks = suggestModels(base, models)
    if (picks.scoring) $<HTMLInputElement>('#input-model').value = picks.scoring
    if (picks.digest) $<HTMLInputElement>('#input-digest-model').value = picks.digest
    if (picks.learner) $<HTMLInputElement>('#input-learner-model').value = picks.learner
    catalogStatus.textContent = 'Recommended models filled in'
  })

  // Client picker: the custom field only matters for the custom option
  const selectClient = $<HTMLSelectElement>('#select-client')
  selectClient.addEventListener('change', () => toggleCustomClientField(selectClient.value))

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

  // Digest
  const btnDigest = $<HTMLButtonElement>('#btn-digest')
  btnDigest.addEventListener('click', () => {
    onDigest().catch((err) => setStatus(`Digest error: ${(err as Error).message}`))
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

/** The digest button only makes sense once there are scored posts to summarize. */
export function setDigestEnabled(enabled: boolean): void {
  $<HTMLButtonElement>('#btn-digest').disabled = !enabled
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
    digestModel: $<HTMLInputElement>('#input-digest-model').value.trim(),
    learnerModel: $<HTMLInputElement>('#input-learner-model').value.trim(),
    digestTopN: parseInt($<HTMLInputElement>('#input-digest-topn').value, 10) || 15,
    digestForSpeech: $<HTMLInputElement>('#input-digest-speech').checked,
    signerRelays: readSignerRelays(),
    userPrompt: $<HTMLTextAreaElement>('#input-user-prompt').value.trim(),
    learnedPrompt: $<HTMLTextAreaElement>('#input-learned-prompt').value,
    hoursBack: parseInt($<HTMLInputElement>('#input-hours-back').value, 10) || 24,
    batchSize: parseInt($<HTMLInputElement>('#input-batch-size').value, 10) || 20,
    concurrency: Math.max(1, parseInt($<HTMLInputElement>('#input-concurrency').value, 10) || 1),
    clientPreset: $<HTMLSelectElement>('#select-client').value as AppSettings['clientPreset'],
    clientCustomUrl: $<HTMLInputElement>('#input-client-custom').value.trim(),
    autoRefresh: $<HTMLInputElement>('#input-auto-refresh').checked,
    ttsModel: $<HTMLInputElement>('#input-tts-model').value.trim(),
    ttsVoice: $<HTMLInputElement>('#input-tts-voice').value.trim(),
  }
}

/**
 * Reflect whether an identity is set.
 *
 * The connect button stays primary-styled only while there is nothing to
 * connect to — once a pubkey is present it steps down to a secondary
 * "Change identity", and the npub is shown, so the panel does not look like it
 * is still asking you to do something you already did.
 */
export function updateIdentityState(): void {
  const npub = $<HTMLInputElement>('#input-npub').value.trim()
  const banner = $('#identity-connected')
  const btn = $<HTMLButtonElement>('#btn-connect')
  const label = $('#identity-npub')

  if (npub) {
    banner.classList.remove('hidden')
    label.textContent = npub.length > 24 ? `${npub.slice(0, 14)}…${npub.slice(-6)}` : npub
    btn.textContent = 'Change identity'
    btn.classList.remove('btn-primary')
    btn.classList.add('btn-secondary')
  } else {
    banner.classList.add('hidden')
    label.textContent = ''
    btn.textContent = 'Connect Nostr identity'
    btn.classList.add('btn-primary')
    btn.classList.remove('btn-secondary')
  }
}

function toggleCustomClientField(preset: string): void {
  $('#input-client-custom').classList.toggle('hidden', preset !== 'custom')
  $('#client-hint').classList.toggle('hidden', preset !== 'custom')
}

/** Populate the shared <datalist> backing all three model inputs. */
function fillModelList(models: ModelInfo[]): void {
  const list = $<HTMLDataListElement>('#model-list')
  list.textContent = ''
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model.id
    const label = describeModel(model)
    if (label) option.label = label
    list.appendChild(option)
  }
}

function readSignerRelays(): string[] {
  return $<HTMLTextAreaElement>('#input-signer-relays').value
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function populateFields(settings: AppSettings): void {
  $<HTMLInputElement>('#input-npub').value = settings.npub
  $<HTMLTextAreaElement>('#input-relays').value = settings.relays.join('\n')
  $<HTMLSelectElement>('#select-provider').value = settings.provider
  $<HTMLInputElement>('#input-api-base').value = settings.apiBaseUrl
  $<HTMLInputElement>('#input-api-key').value = settings.apiKey
  $<HTMLInputElement>('#input-model').value = settings.model
  $<HTMLInputElement>('#input-digest-model').value = settings.digestModel
  $<HTMLInputElement>('#input-learner-model').value = settings.learnerModel
  $<HTMLInputElement>('#input-digest-topn').value = String(settings.digestTopN)
  $<HTMLInputElement>('#input-digest-speech').checked = settings.digestForSpeech
  $<HTMLTextAreaElement>('#input-signer-relays').value = settings.signerRelays.join('\n')
  $<HTMLTextAreaElement>('#input-user-prompt').value = settings.userPrompt
  $<HTMLTextAreaElement>('#input-learned-prompt').value = settings.learnedPrompt
  $<HTMLInputElement>('#input-hours-back').value = String(settings.hoursBack)
  $<HTMLInputElement>('#input-batch-size').value = String(settings.batchSize)
  $<HTMLInputElement>('#input-concurrency').value = String(settings.concurrency)
  $<HTMLSelectElement>('#select-client').value = settings.clientPreset
  $<HTMLInputElement>('#input-client-custom').value = settings.clientCustomUrl
  $<HTMLInputElement>('#input-auto-refresh').checked = settings.autoRefresh
  $<HTMLInputElement>('#input-tts-model').value = settings.ttsModel
  $<HTMLInputElement>('#input-tts-voice').value = settings.ttsVoice
  toggleCustomClientField(settings.clientPreset)

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
