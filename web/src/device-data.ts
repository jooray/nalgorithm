/**
 * Nalgorithm Web — what this device keeps, and taking it away
 *
 * Export the settings (secrets only when separately asked), disconnect the
 * remembered signer, clear everything this app stored in the browser, and in
 * hosted mode download or delete what the server keeps. Each destructive step
 * is confirmed in place and says what it cannot reach.
 */

import { loadSettings } from './settings.js'
import { forgetSigner } from './signer.js'
import { deviceStorage, freezeStorage } from './storage.js'
import { clearRecords } from './records.js'
import { readFeedback } from './feedback.js'

export interface DeviceSectionOptions {
  mode: 'byok' | 'hosted'
  /** Hosted: end the session on the server. */
  signOut?: () => Promise<void>
  /** Hosted: download what the server keeps. */
  exportAccount?: () => Promise<Blob>
  /** Hosted: delete what the server keeps. Throws the text to show. */
  deleteAccount?: () => Promise<void>
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element not found: #${id}`)
  return el as T
}

function status(text: string, isError = false): void {
  const el = $('device-status')
  el.textContent = text
  el.classList.toggle('is-error', isError)
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const today = (): string => new Date().toISOString().slice(0, 10)

/** The settings as a file. The model key only when the reader ticked the box; signer secrets never. */
export function exportableSettings(includeKey: boolean): Record<string, unknown> {
  const { apiKey, learnedPrompt: _learned, ...rest } = loadSettings()
  const feedback = readFeedback()
  const hosted = document.body.dataset.mode === 'hosted'
  // Hosted settings live on the server (Download my hosted data); here only this device's preferences.
  const device = { feedOrder: rest.feedOrder, dataSaver: rest.dataSaver, digestMinutes: rest.digestMinutes, cacheAudio: rest.cacheAudio,
    clientPreset: rest.clientPreset, clientCustomUrl: rest.clientCustomUrl, clientCustomProfileUrl: rest.clientCustomProfileUrl }
  return {
    app: 'nalgorithm',
    exportedAt: new Date().toISOString(),
    mode: document.body.dataset.mode,
    settings: hosted ? device : includeKey ? { ...rest, apiKey } : rest,
    feedback: { rules: feedback.rules, muted: feedback.muted, saved: feedback.saved },
  }
}

/** Everything this app keeps in the browser: storage, session storage and IndexedDB records. */
export async function clearDeviceData(): Promise<void> {
  forgetSigner()
  // From here on nothing is written back: not the player's resume save on page hide,
  // not a feed run's last scores.
  freezeStorage()
  deviceStorage.clear()
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (key?.startsWith('nalgorithm_')) sessionStorage.removeItem(key)
    }
  } catch {
    // session storage blocked: nothing kept there
  }
  await clearRecords('')
  // Another open tab (the installed app and a browser tab) would otherwise write its state back.
  try {
    const channel = new BroadcastChannel(CLEAR_CHANNEL)
    channel.postMessage('cleared')
    channel.close()
  } catch {
    // no BroadcastChannel: other tabs keep running until they reload
  }
}

const CLEAR_CHANNEL = 'nalgorithm-device'

function followClearsFromOtherTabs(): void {
  try {
    new BroadcastChannel(CLEAR_CHANNEL).onmessage = () => {
      freezeStorage()
      location.replace(location.pathname)
    }
  } catch {
    // no BroadcastChannel
  }
}

let pending: (() => Promise<void>) | null = null
let opener: HTMLElement | null = null

function confirmStep(text: string, action: string, run: () => Promise<void>): void {
  pending = run
  opener = document.activeElement as HTMLElement | null
  $('device-confirm-text').textContent = text
  $('btn-device-confirm').textContent = action
  $('device-confirm').classList.remove('hidden')
  $('btn-device-cancel').focus()
}

function closeConfirm(): void {
  pending = null
  $('device-confirm').classList.add('hidden')
  opener?.focus()
  opener = null
}

export function initDeviceSection(options: DeviceSectionOptions): void {
  followClearsFromOtherTabs()
  $('btn-export-settings').addEventListener('click', () => {
    const includeKey = options.mode === 'byok' && $<HTMLInputElement>('export-include-key').checked
    download(new Blob([JSON.stringify(exportableSettings(includeKey), null, 2)], { type: 'application/json' }), `nalgorithm-settings-${today()}.json`)
    status(includeKey ? 'Exported, including your model key. Keep the file private.' : 'Exported without your model key or signer secrets.')
  })

  $('btn-disconnect-signer').addEventListener('click', () => {
    forgetSigner()
    status('This device no longer keeps a signer connection. To revoke the permission in the signer itself, remove this app there (in Amber: Applications).')
  })

  const exportAccount = options.exportAccount
  if (exportAccount) {
    $('btn-export-account').addEventListener('click', async () => {
      status('Preparing your data…')
      try {
        download(await exportAccount(), `nalgorithm-account-${today()}.json`)
        status('Downloaded what the server keeps for your account.')
      } catch (err) {
        status((err as Error).message || 'The download failed. Check your connection.', true)
      }
    })
  }

  $('btn-clear-device').addEventListener('click', () =>
    confirmStep(
      'This removes your settings, keys, signer connection, rankings, digests, cached audio and private feedback from this browser, and reloads the app. ' +
        (options.mode === 'hosted'
          ? 'It also signs you out. Your hosted account, digests on the server, audio already on public file hosts and payment records stay.'
          : 'Audio or notes already published elsewhere stay.'),
      'Clear this device',
      async () => {
        if (options.signOut) await options.signOut().catch(() => {})
        await clearDeviceData()
        location.replace(location.pathname)
      }
    )
  )

  const deleteAccount = options.deleteAccount
  if (deleteAccount) {
    $('btn-delete-account').addEventListener('click', () =>
      confirmStep(
        'This deletes your settings, words, learned taste, scores, rankings, digests and schedule from our server, and signs you out. ' +
          'It cannot be undone. Audio already uploaded to public file hosts stays reachable by its link, and payment records stay with the billing service, so paid time is not lost.',
        'Delete my hosted data',
        async () => {
          await deleteAccount()
          await clearDeviceData()
          location.replace(location.pathname)
        }
      )
    )
  }

  $('btn-device-cancel').addEventListener('click', closeConfirm)
  $('btn-device-confirm').addEventListener('click', async () => {
    const run = pending
    if (!run) return
    const button = $<HTMLButtonElement>('btn-device-confirm')
    button.disabled = true
    try {
      await run()
    } catch (err) {
      status((err as Error).message, true)
      closeConfirm()
    } finally {
      button.disabled = false
    }
  })
}
