/**
 * Nalgorithm Web — digest panel
 *
 * Writes a narrative summary of the top-scored posts and, optionally, reads it
 * aloud with the browser's own speech engine.
 */

import { generateDigest, synthesizeSpeech, type ProfileData, type ScoredPost } from 'nalgorithm'
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
/** Kept so the download button can reach the TTS credentials. */
let lastSettings: AppSettings | null = null

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
  settings: AppSettings,
  onStatus?: (text: string) => void
): Promise<void> {
  const el = ensurePanel()
  el.classList.remove('hidden')
  // The panel sits above the feed, so someone who clicked Digest while scrolled
  // down would otherwise see nothing happen at all.
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const body = el.querySelector<HTMLElement>('.digest-body')!
  const status = el.querySelector<HTMLElement>('.digest-status')!
  const controls = el.querySelector<HTMLElement>('.digest-controls')!

  lastSettings = settings
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
  onStatus?.(`Writing digest with ${model}…`)

  // Reasoning models buffer before emitting anything — kimi-k3 measured 5.7s of
  // silence out of a 6.4s generation. So the spinner runs on its own clock and
  // shows elapsed seconds: during the quiet stretch that is the only signal
  // distinguishing "thinking" from "hung", and the word count takes over once
  // tokens actually start arriving.
  const frames = ['|', '/', '-', '\\']
  let frame = 0
  let streamed = ''
  const startedAt = Date.now()
  const tick = window.setInterval(() => {
    frame = (frame + 1) % frames.length
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const progress = streamed ? `${seconds}s, ${wordCount(streamed)} words` : `${seconds}s, thinking`
    status.textContent = `${frames[frame]} Writing digest with ${model} (${progress})…`
  }, 120)

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
        onDelta: (piece) => {
          streamed += piece
          renderDigestText(body, streamed)
        },
      }
    )

    clearInterval(tick)
    currentText = text.trim()
    renderDigestText(body, currentText)

    const used = Math.min(settings.digestTopN, posts.length)
    const summary = `${used} posts, ${wordCount(currentText)} words, ${model}`
    status.textContent = summary
    onStatus?.(`Digest ready — ${summary}`)
    controls.classList.remove('hidden')
    await populateVoices(el)
  } catch (err) {
    clearInterval(tick)
    const message = `Digest failed: ${(err as Error).message}`
    // Whatever streamed in before the failure is real text and stays on screen;
    // adopt it so Copy, Read aloud and Download work on what is actually there.
    if (streamed.trim()) {
      currentText = streamed.trim()
      renderDigestText(body, currentText)
      controls.classList.remove('hidden')
      await populateVoices(el)
      status.textContent = `${message} — keeping the ${wordCount(currentText)} words that arrived.`
    } else {
      status.textContent = message
    }
    onStatus?.(message)
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
      <button class="btn btn-small digest-download">Download MP3</button>
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

  // Download: the browser's speech engine gives no access to its audio, so
  // this goes through the configured TTS provider instead. Requires a ttsApi
  // model to be set; browser playback stays free and instant.
  panel.querySelector<HTMLButtonElement>('.digest-download')!.addEventListener('click', async () => {
    const btn = panel!.querySelector<HTMLButtonElement>('.digest-download')!
    if (!lastSettings?.ttsModel.trim()) {
      status.textContent =
        'Set a TTS model in Settings to download audio (browser speech cannot be recorded).'
      return
    }
    btn.disabled = true
    const original = btn.textContent
    try {
      const audio = await synthesizeSpeech(
        {
          apiBaseUrl: lastSettings.apiBaseUrl,
          apiKey: lastSettings.apiKey,
          model: lastSettings.ttsModel.trim(),
          voice: lastSettings.ttsVoice.trim() || undefined,
          format: 'mp3',
        },
        currentText,
        {
          onProgress: (chunk, total) => {
            btn.textContent = total > 1 ? `Synthesizing ${chunk}/${total}…` : 'Synthesizing…'
          },
        }
      )
      const blob = new Blob([audio as BlobPart], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `nalgorithm-digest-${new Date().toISOString().slice(0, 10)}.mp3`
      link.click()
      URL.revokeObjectURL(url)
      status.textContent = `Downloaded ${(blob.size / 1024 / 1024).toFixed(1)} MB of audio.`
    } catch (err) {
      status.textContent = `Audio failed: ${(err as Error).message}`
    } finally {
      btn.disabled = false
      btn.textContent = original
    }
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
