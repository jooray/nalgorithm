/**
 * Nalgorithm Web — UI management (Tune form, status line, bindings), bring-your-own-key mode
 */

import {
  loadSettings,
  saveSettings,
  validateSettings,
  clearScoreCache,
  PROVIDER_URLS,
  providerDraft,
  saveProviderDraft,
  type AppSettings,
} from './settings.js'
import { openLoginDialog } from './login-ui.js'
import { icon } from './icons.js'
import { currentTab, showTab, toast } from './shell.js'
import { listVoices } from './speech.js'
import { loadVoiceName, saveVoiceName } from './audio-logic.js'
import { safeStorage } from './player.js'
import { toNpub } from './nostr-login.js'
import { setupProblem } from './settings-validation.js'
import { chatCompletion } from 'nalgorithm'
import { initTuneDrafts } from './drafts.js'
import { initPromptStarters } from './prompt-starters.js'
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

/** The refresh button, in both modes: icon and label. */
export function refreshButtonHtml(): string {
  return `${icon('refresh', 18)}<span>Refresh</span>`
}

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

  $<HTMLButtonElement>('#btn-refresh').innerHTML = refreshButtonHtml()
  $('#btn-go-tune').addEventListener('click', () => {
    showTab('tune')
    // Straight to the first missing essential.
    const next = setupSteps(loadSettings()).find((step) => step.state === 'next')
    if (next) document.getElementById(next.field)?.focus()
  })
  initPromptCount('#input-user-prompt', '#input-user-prompt-count')
  initPromptStarters($<HTMLTextAreaElement>('#input-user-prompt'), $('#input-user-prompt-starters'))
  void populateSpeechVoices()

  // Provider change updates API base URL
  const selectProvider = $<HTMLSelectElement>('#select-provider')
  const inputApiBase = $<HTMLInputElement>('#input-api-base')
  let previousProvider = selectProvider.value

  selectProvider.addEventListener('change', () => {
    saveProviderDraft(previousProvider, readFieldsToSettings())
    const provider = selectProvider.value
    const draft = providerDraft(provider)
    inputApiBase.value = draft.apiBaseUrl
    // Keys are never kept per provider; switching back to the saved provider brings its saved key back.
    const saved = loadSettings()
    $<HTMLInputElement>('#input-api-key').value = provider === saved.provider ? saved.apiKey : ''
    $<HTMLInputElement>('#input-model').value = draft.model
    $<HTMLInputElement>('#input-digest-model').value = draft.digestModel
    $<HTMLInputElement>('#input-learner-model').value = draft.learnerModel
    $<HTMLSelectElement>('#select-scorer').value = 'chat'
    toggleDecisionFields('chat')
    $('#model-list').replaceChildren()
    $('#model-catalog-status').textContent = 'Provider changed. Add its key and test the connection.'
    $('#btn-recommend-models').classList.add('hidden')
    previousProvider = provider
    inputApiBase.readOnly = provider !== 'custom'
  })

  // Set initial readonly state
  inputApiBase.readOnly = selectProvider.value !== 'custom'

  // Save settings
  const btnSave = $<HTMLButtonElement>('#btn-save-settings')
  let firstSetup = Boolean(validateSettings(settings))
  if (firstSetup) btnSave.textContent = 'Save and rank my feed'
  // Until the first save, Tune shows only the three essentials; the rest has working defaults.
  const showAll = $<HTMLButtonElement>('#btn-show-all-settings')
  const revealAll = (): void => {
    document.body.classList.add('show-all-settings')
    showAll.setAttribute('aria-expanded', 'true')
    showAll.textContent = 'All settings are shown'
    showAll.disabled = true
  }
  const paintSetup = (): void => {
    if (document.body.dataset.mode === 'byok' && validateSettings(loadSettings())) document.body.dataset.setup = 'incomplete'
    else delete document.body.dataset.setup
  }
  showAll.addEventListener('click', revealAll)
  paintSetup()
  document.addEventListener('nalgorithm:settings-saved', paintSetup)
  btnSave.addEventListener('click', () => {
    const updated = readFieldsToSettings()
    const problem = setupProblem(updated)
    const error = validateSettings(updated)
    if (error) {
      setTuneStatus(error, true)
      if (problem) {
        const field = document.getElementById(problem.field)
        if (field?.closest('.setup-extra')) revealAll()
        field?.closest('details')?.setAttribute('open', '')
        field?.setAttribute('aria-invalid', 'true')
        field?.setAttribute('aria-describedby', 'tune-status')
        field?.focus()
      }
      return
    }
    for (const field of document.querySelectorAll('[aria-invalid="true"]')) field.removeAttribute('aria-invalid')
    const notice = saveSettings(updated)
    saveVoiceName(safeStorage(), $<HTMLSelectElement>('#select-speech-voice').value)
    setTuneStatus(notice || 'Interests and feed settings saved.')
    document.dispatchEvent(new Event('nalgorithm:settings-saved'))
    // A feed that was waiting on setup now only waits for Refresh.
    if (!validateSettings(updated) && $('#feed-list').childElementCount === 0) showEmptyState(true, true)

    // Enable refresh button if settings look valid
    const btnRefresh = $<HTMLButtonElement>('#btn-refresh')
    btnRefresh.disabled = false
    if (firstSetup) {
      firstSetup = false
      btnSave.textContent = 'Save interests and feed'
      showTab('feed')
      void onRefresh().catch((err) => setStatus((err as Error).message))
    }
  })

  $('#btn-test-model').addEventListener('click', async () => {
    const s = readFieldsToSettings()
    const button = $<HTMLButtonElement>('#btn-test-model')
    button.disabled = true
    $('#model-catalog-status').textContent = 'Testing one small model request…'
    try {
      await chatCompletion({ apiBaseUrl: s.apiBaseUrl, apiKey: s.apiKey, model: s.model, timeoutMs: 15000 }, [{ role: 'user', content: 'Reply with OK only.' }])
      $('#model-catalog-status').textContent = 'Model connection works. Save and rank your feed.'
    } catch (err) {
      $('#model-catalog-status').textContent = `${(err as Error).message}. Check the key/model. For local Ollama, allow this app origin in OLLAMA_ORIGINS and restart Ollama.`
    } finally { button.disabled = false }
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

  const selectScorer = $<HTMLSelectElement>('#select-scorer')
  selectScorer.addEventListener('change', () => toggleDecisionFields(selectScorer.value))

  // Clear scores
  const btnClearScores = $<HTMLButtonElement>('#btn-clear-scores')
  btnClearScores.addEventListener('click', () => {
    void clearScoreCache().then(() => setStatus('Cached scores cleared'))
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
  if (!validateSettings(settings)) {
    btnRefresh.disabled = false
  }

  // First run: nothing is set up, so start where the setup is.
  if (!settings.npub.trim()) showTab('tune')
  initTuneDrafts(() => loadSettings().npub || 'setup')
  // Drafts belong to an identity: after a switch, edits go under (and restore from) the new one.
  let draftIdentity = loadSettings().npub || 'setup'
  document.addEventListener('nalgorithm:settings-saved', () => {
    const now = loadSettings().npub || 'setup'
    if (now === draftIdentity) return
    draftIdentity = now
    initTuneDrafts(() => now)
  })

  return settings
}

/**
 * Set the status line (Feed tab). A message that would otherwise go unseen
 * because another tab is showing also appears as a short toast.
 */
export function setStatus(text: string): void {
  const el = $('#status')
  el.textContent = text
  if (text && currentTab() !== 'feed') toast(text)
}

/**
 * Set the status line with a spinner.
 */
export function setStatusLoading(text: string): void {
  const el = $('#status')
  el.innerHTML = `<span class="spinner"></span>${escapeHtml(text)}`
}

/** The line beside the Save button on the Tune tab. */
export function setTuneStatus(text: string, isError = false): void {
  const el = $('#tune-status')
  el.textContent = text
  el.classList.toggle('is-error', isError)
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
  btn.classList.toggle('is-busy', !enabled)
}

/**
 * Show/hide the empty state. `configured` picks the copy: a feed that simply
 * has no posts, or one that is not set up yet.
 */
export function showEmptyState(show: boolean, configured = false, message?: string): void {
  const empty = $('#feed-empty')
  const list = $('#feed-list')
  empty.style.display = show ? 'block' : 'none'
  list.style.display = show ? 'none' : 'flex'
  if (!show) return
  $('#feed-empty-title').textContent = configured ? 'Nothing to rank yet' : 'Three things before I can rank'
  const text = $('#feed-empty-text')
  const steps = $('#feed-empty-steps')
  steps.replaceChildren()
  steps.hidden = configured || message !== undefined
  text.textContent = message ?? (configured ? 'Press Refresh to load the people you follow and rank their posts.' : 'Everything runs in your browser; your key and settings stay on this device.')
  if (!steps.hidden) {
    for (const step of setupSteps(loadSettings())) {
      const li = document.createElement('li')
      li.className = step.state === 'done' ? 'is-done' : step.state === 'next' ? 'is-next' : ''
      li.textContent = step.label
      if (step.state === 'done') li.setAttribute('aria-label', `${step.label}: done`)
      if (step.state === 'next') li.setAttribute('aria-current', 'step')
      steps.appendChild(li)
    }
  }
  const go = $<HTMLButtonElement>('#btn-go-tune')
  go.style.display = configured ? 'none' : ''
  go.textContent = 'Finish setup'
}

/** The essentials of a first run, in order, and which one is next. */
export function setupSteps(s: AppSettings): Array<{ label: string; field: string; state: 'done' | 'next' | 'todo' }> {
  // Each essential judged on its own: the other two filled with placeholders that pass.
  const fieldOf = (patch: Partial<AppSettings>): string | null => setupProblem({ ...s, ...patch })?.field ?? null
  const npubOk = fieldOf({}) !== 'input-npub'
  const connectionProblem = fieldOf({ npub: '0'.repeat(64), userPrompt: 'x' })
  const groups = [
    { label: 'Your public key (npub)', field: 'input-npub', done: npubOk },
    { label: 'What you care about, in your own words', field: 'input-user-prompt', done: s.userPrompt.trim().length > 0 },
    {
      label: 'A model connection',
      field: connectionProblem && ['input-api-key', 'input-model', 'select-scorer'].includes(connectionProblem) ? connectionProblem : 'input-api-base',
      done: !connectionProblem || !['input-api-base', 'input-api-key', 'input-model', 'select-scorer'].includes(connectionProblem),
    },
  ]
  let nextGiven = false
  return groups.map((g) => {
    if (g.done) return { label: g.label, field: g.field, state: 'done' as const }
    const state = nextGiven ? ('todo' as const) : ('next' as const)
    nextGiven = true
    return { label: g.label, field: g.field, state }
  })
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
    cacheAudio: $<HTMLInputElement>('#input-cache-audio').checked,
    learnFromLikes: $<HTMLInputElement>('#input-learn').checked,
    rememberKey: $<HTMLInputElement>('#input-remember-key').checked,
    feedOrder: $<HTMLSelectElement>('#select-feed-order').value === 'best' ? 'best' : 'new',
    dataSaver: $<HTMLInputElement>('#input-data-saver').checked,
    digestMinutes: Number($<HTMLSelectElement>('#select-digest-minutes').value),
    npub: $<HTMLInputElement>('#input-npub').value.trim(),
    relays: $<HTMLTextAreaElement>('#input-relays').value
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r.length > 0),
    provider: $<HTMLSelectElement>('#select-provider').value,
    apiBaseUrl: $<HTMLInputElement>('#input-api-base').value.trim(),
    apiKey: $<HTMLInputElement>('#input-api-key').value.trim(),
    model: $<HTMLInputElement>('#input-model').value.trim(),
    scorer: $<HTMLSelectElement>('#select-scorer').value === 'decision' ? 'decision' : 'chat',
    decisionModel: $<HTMLInputElement>('#input-decision-model').value.trim() || 'jev-latest',
    digestModel: $<HTMLInputElement>('#input-digest-model').value.trim(),
    learnerModel: $<HTMLInputElement>('#input-learner-model').value.trim(),
    digestTopN: Number($<HTMLInputElement>('#input-digest-topn').value),
    digestForSpeech: $<HTMLInputElement>('#input-digest-speech').checked,
    signerRelays: readSignerRelays(),
    userPrompt: $<HTMLTextAreaElement>('#input-user-prompt').value.trim(),
    learnedPrompt: $<HTMLTextAreaElement>('#input-learned-prompt').value,
    hoursBack: Number($<HTMLInputElement>('#input-hours-back').value),
    batchSize: Number($<HTMLInputElement>('#input-batch-size').value),
    concurrency: Number($<HTMLInputElement>('#input-concurrency').value),
    clientPreset: $<HTMLSelectElement>('#select-client').value as AppSettings['clientPreset'],
    clientCustomUrl: $<HTMLInputElement>('#input-client-custom').value.trim(),
    clientCustomProfileUrl: $<HTMLInputElement>('#input-client-custom-profile').value.trim(),
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

/** Live "N characters" under a prompt box. */
export function initPromptCount(field: string, counter: string): void {
  const input = $<HTMLTextAreaElement>(field)
  const out = $(counter)
  const update = (): void => {
    out.textContent = `${input.value.length} characters`
  }
  input.addEventListener('input', update)
  update()
}

/** Fill the browser-voice picker in Tune. Stays "Browser default" when the engine lists none. */
async function populateSpeechVoices(): Promise<void> {
  const select = $<HTMLSelectElement>('#select-speech-voice')
  const voices = await listVoices()
  for (const v of voices) select.append(new Option(`${v.name} (${v.lang})`, v.name))
  select.value = loadVoiceName(safeStorage())
  if (select.value !== loadVoiceName(safeStorage())) select.value = ''
}

function toggleDecisionFields(scorer: string): void {
  $('#decision-fields').classList.toggle('hidden', scorer !== 'decision')
}

function toggleCustomClientField(preset: string): void {
  $('#input-client-custom').classList.toggle('hidden', preset !== 'custom')
  $('#input-client-custom-profile').classList.toggle('hidden', preset !== 'custom')
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
  $<HTMLInputElement>('#input-cache-audio').checked = settings.cacheAudio
  $<HTMLInputElement>('#input-learn').checked = settings.learnFromLikes
  $<HTMLInputElement>('#input-remember-key').checked = settings.rememberKey
  $<HTMLSelectElement>('#select-feed-order').value = settings.feedOrder
  $<HTMLInputElement>('#input-data-saver').checked = settings.dataSaver
  $<HTMLSelectElement>('#select-digest-minutes').value = String(settings.digestMinutes)
  $<HTMLInputElement>('#input-npub').value = settings.npub
  $<HTMLTextAreaElement>('#input-relays').value = settings.relays.join('\n')
  $<HTMLSelectElement>('#select-provider').value = settings.provider
  $<HTMLInputElement>('#input-api-base').value = settings.apiBaseUrl
  $<HTMLInputElement>('#input-api-key').value = settings.apiKey
  $<HTMLInputElement>('#input-model').value = settings.model
  $<HTMLSelectElement>('#select-scorer').value = settings.scorer
  $<HTMLInputElement>('#input-decision-model').value = settings.decisionModel
  toggleDecisionFields(settings.scorer)
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
  $<HTMLInputElement>('#input-client-custom-profile').value = settings.clientCustomProfileUrl
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
