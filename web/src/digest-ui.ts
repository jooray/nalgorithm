/**
 * Nalgorithm Web — digest panel
 *
 * Writes a narrative summary of the top-scored posts and, optionally, reads it
 * aloud with the browser's own speech engine.
 */

import { generateDigest, type ProfileData, type ScoredPost } from 'nalgorithm'
import {
  isSpeechSupported,
  listVoices,
  speak,
  type SpeechSession,
} from './speech.js'
import type { AppSettings } from './settings.js'

let panel: HTMLElement | null = null
let session: SpeechSession | null = null
let currentText = ''

/** Remember the chosen voice across digests within a session. */
let preferredVoice = ''

export function isDigestOpen(): boolean {
  return panel !== null && !panel.classList.contains('hidden')
}

/** Stop any playback. Called when the feed refreshes under us. */
export function stopDigestSpeech(): void {
  session?.stop()
  session = null
  updateSpeechButtons(false)
}

/**
 * Generate and show a digest for the given posts.
 */
export async function showDigest(
  posts: ScoredPost[],
  profiles: Map<string, ProfileData>,
  settings: AppSettings
): Promise<void> {
  const el = ensurePanel()
  el.classList.remove('hidden')

  const body = el.querySelector<HTMLElement>('.digest-body')!
  const status = el.querySelector<HTMLElement>('.digest-status')!
  const controls = el.querySelector<HTMLElement>('.digest-controls')!

  stopDigestSpeech()
  controls.classList.add('hidden')
  body.textContent = ''

  if (posts.length === 0) {
    status.textContent = 'Nothing to summarize yet — refresh your feed first.'
    return
  }

  // Blank means "reuse the scoring model", so the user only fills this in when
  // they actually want a different one.
  const model = settings.digestModel.trim() || settings.model
  status.textContent = `Writing digest with ${model}…`

  try {
    const text = await generateDigest(
      {
        apiBaseUrl: settings.apiBaseUrl,
        apiKey: settings.apiKey,
        model,
      },
      {
        posts,
        profiles,
        userPrompt: settings.userPrompt,
        learnedPrompt: settings.learnedPrompt || undefined,
        topN: settings.digestTopN,
        forSpeech: settings.digestForSpeech,
      }
    )

    currentText = text.trim()
    renderDigestText(body, currentText)

    const used = Math.min(settings.digestTopN, posts.length)
    status.textContent = `${used} posts, ${wordCount(currentText)} words, ${model}`
    controls.classList.remove('hidden')
    await populateVoices(el)
  } catch (err) {
    status.textContent = `Digest failed: ${(err as Error).message}`
  }
}

function renderDigestText(body: HTMLElement, text: string): void {
  body.textContent = ''
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue
    const p = document.createElement('p')
    // textContent, not innerHTML — this string came from an LLM.
    p.textContent = trimmed
    body.appendChild(p)
  }
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

async function populateVoices(el: HTMLElement): Promise<void> {
  const select = el.querySelector<HTMLSelectElement>('.digest-voice')!
  const speakBtn = el.querySelector<HTMLButtonElement>('.digest-speak')!

  if (!isSpeechSupported()) {
    select.classList.add('hidden')
    speakBtn.disabled = true
    speakBtn.title = 'This browser has no built-in speech synthesis'
    return
  }

  if (select.options.length > 0) return

  const voices = await listVoices()
  if (voices.length === 0) {
    // Engine present but no voices installed — speaking would silently do
    // nothing, so say so rather than offering a dead button.
    select.classList.add('hidden')
    speakBtn.disabled = true
    speakBtn.title = 'No speech voices are installed on this system'
    return
  }

  const preferred = navigator.language?.toLowerCase() ?? 'en'
  for (const v of voices) {
    const option = document.createElement('option')
    option.value = v.name
    option.textContent = `${v.name} (${v.lang})`
    select.appendChild(option)
  }
  select.value =
    preferredVoice ||
    voices.find((v) => v.lang.toLowerCase() === preferred)?.name ||
    voices.find((v) => v.lang.toLowerCase().startsWith(preferred.slice(0, 2)))?.name ||
    voices[0].name
  preferredVoice = select.value
}

function updateSpeechButtons(playing: boolean): void {
  if (!panel) return
  const speakBtn = panel.querySelector<HTMLButtonElement>('.digest-speak')
  const stopBtn = panel.querySelector<HTMLButtonElement>('.digest-stop')
  if (speakBtn) speakBtn.textContent = playing ? 'Pause' : 'Read aloud'
  if (stopBtn) stopBtn.classList.toggle('hidden', !playing)
}

function ensurePanel(): HTMLElement {
  if (panel) return panel

  panel = document.createElement('section')
  panel.className = 'digest-panel hidden'
  panel.innerHTML = `
    <div class="digest-header">
      <h2>Digest</h2>
      <button class="btn-icon digest-close" aria-label="Close">&times;</button>
    </div>
    <p class="digest-status"></p>
    <div class="digest-controls hidden">
      <button class="btn btn-primary btn-small digest-speak">Read aloud</button>
      <button class="btn btn-small digest-stop hidden">Stop</button>
      <select class="digest-voice" aria-label="Voice"></select>
      <label class="digest-rate">
        Speed <input type="range" class="digest-rate-input" min="0.6" max="1.8" step="0.1" value="1">
        <span class="digest-rate-value">1.0x</span>
      </label>
      <button class="btn btn-small digest-copy">Copy</button>
    </div>
    <div class="digest-body"></div>
  `

  const status = panel.querySelector<HTMLElement>('.digest-status')!
  const speakBtn = panel.querySelector<HTMLButtonElement>('.digest-speak')!
  const stopBtn = panel.querySelector<HTMLButtonElement>('.digest-stop')!
  const voiceSelect = panel.querySelector<HTMLSelectElement>('.digest-voice')!
  const rateInput = panel.querySelector<HTMLInputElement>('.digest-rate-input')!
  const rateValue = panel.querySelector<HTMLElement>('.digest-rate-value')!

  panel.querySelector<HTMLButtonElement>('.digest-close')!.addEventListener('click', () => {
    stopDigestSpeech()
    panel!.classList.add('hidden')
  })

  rateInput.addEventListener('input', () => {
    rateValue.textContent = `${Number(rateInput.value).toFixed(1)}x`
  })

  voiceSelect.addEventListener('change', () => {
    preferredVoice = voiceSelect.value
    // A voice change only takes effect on the next utterance, so restart if
    // we're mid-read rather than leaving the selection looking ignored.
    if (session) startSpeaking()
  })

  speakBtn.addEventListener('click', () => {
    if (!session) {
      startSpeaking()
    } else if (session.isPaused()) {
      session.resume()
      speakBtn.textContent = 'Pause'
    } else {
      session.pause()
      speakBtn.textContent = 'Resume'
    }
  })

  stopBtn.addEventListener('click', () => {
    stopDigestSpeech()
    status.textContent = 'Stopped.'
  })

  panel.querySelector<HTMLButtonElement>('.digest-copy')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentText)
      status.textContent = 'Copied to clipboard.'
    } catch {
      status.textContent = 'Could not copy — select the text manually.'
    }
  })

  function startSpeaking(): void {
    session?.stop()
    session = speak(currentText, {
      voiceName: voiceSelect.value || undefined,
      rate: Number(rateInput.value) || 1,
      onProgress: (chunk, total) => {
        status.textContent = `Reading ${chunk} of ${total}…`
      },
      onEnd: () => {
        session = null
        updateSpeechButtons(false)
        status.textContent = 'Finished.'
      },
      onError: (message) => {
        session = null
        updateSpeechButtons(false)
        status.textContent = message
      },
    })
    updateSpeechButtons(true)
  }

  const feed = document.querySelector('#feed')
  feed?.parentElement?.insertBefore(panel, feed)
  return panel
}
