/**
 * Nalgorithm Web — login dialog
 *
 * Presents the two ways to tell Nalgorithm who you are: a NIP-07 browser
 * extension, or a NIP-46 remote signer (Amber and friends) via QR code.
 *
 * Both are read-only. The dialog says so explicitly, because "connect your
 * Nostr signer" normally implies granting signing power, and here it does not.
 */

import qrcode from 'qrcode-generator'
import {
  hasNip07,
  loginWithExtension,
  startRemoteSignerLogin,
  toNpub,
  type RemoteSignerSession,
} from './nostr-login.js'

let dialog: HTMLDialogElement | null = null
let activeSession: RemoteSignerSession | null = null

/**
 * Open the login dialog.
 *
 * @returns the user's hex pubkey, or null if they closed the dialog.
 */
export function openLoginDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    const el = ensureDialog()
    const body = el.querySelector<HTMLElement>('.login-body')!
    const status = el.querySelector<HTMLElement>('.login-status')!

    let settled = false
    const finish = (pubkey: string | null): void => {
      if (settled) return
      settled = true
      activeSession?.cancel()
      activeSession = null
      el.close()
      resolve(pubkey)
    }

    status.textContent = ''
    status.className = 'login-status'
    body.innerHTML = ''

    // ── Option 1: browser extension ──────────────────────────────────────
    const extBtn = document.createElement('button')
    extBtn.className = 'btn btn-primary btn-full'
    extBtn.textContent = hasNip07()
      ? 'Use browser extension'
      : 'Use browser extension (none detected)'
    extBtn.disabled = !hasNip07()
    extBtn.addEventListener('click', async () => {
      setStatus(status, 'Waiting for the extension…')
      try {
        finish(await loginWithExtension())
      } catch (err) {
        setStatus(status, (err as Error).message, true)
      }
    })
    body.appendChild(extBtn)

    const hint = document.createElement('p')
    hint.className = 'login-hint'
    hint.textContent = hasNip07()
      ? 'Reads your public key from Alby, nos2x, or a similar extension.'
      : 'Install Alby or nos2x to use this option, or scan the code below.'
    body.appendChild(hint)

    body.appendChild(divider('or'))

    // ── Option 2: remote signer over NIP-46 ──────────────────────────────
    const signerWrap = document.createElement('div')
    signerWrap.className = 'login-signer'
    body.appendChild(signerWrap)

    const startBtn = document.createElement('button')
    startBtn.className = 'btn btn-secondary btn-full'
    startBtn.textContent = 'Use a remote signer (Amber)'
    startBtn.addEventListener('click', () => {
      startBtn.remove()
      beginRemoteSigner(signerWrap, status, finish)
    })
    signerWrap.appendChild(startBtn)

    // ── Manual entry escape hatch ────────────────────────────────────────
    body.appendChild(divider('or'))

    const manual = document.createElement('div')
    manual.className = 'login-manual'
    manual.innerHTML = `
      <label for="login-manual-npub">Paste an npub</label>
      <input type="text" id="login-manual-npub" placeholder="npub1… or hex pubkey" spellcheck="false">
      <button class="btn btn-small btn-full" id="login-manual-go">Use this npub</button>
    `
    body.appendChild(manual)
    manual.querySelector<HTMLButtonElement>('#login-manual-go')!.addEventListener('click', () => {
      const value = manual.querySelector<HTMLInputElement>('#login-manual-npub')!.value.trim()
      if (!value) {
        setStatus(status, 'Enter an npub or hex pubkey', true)
        return
      }
      finish(value)
    })

    el.querySelector<HTMLButtonElement>('.login-close')!.onclick = () => finish(null)
    el.onclose = () => finish(null)
    el.showModal()
  })
}

/** Kick off the NIP-46 handshake and render the QR + deep link. */
function beginRemoteSigner(
  wrap: HTMLElement,
  status: HTMLElement,
  finish: (pubkey: string | null) => void
): void {
  let session: RemoteSignerSession
  try {
    session = startRemoteSignerLogin()
  } catch (err) {
    setStatus(status, (err as Error).message, true)
    return
  }
  activeSession = session

  wrap.innerHTML = ''

  const qrBox = document.createElement('div')
  qrBox.className = 'login-qr'
  qrBox.innerHTML = renderQr(session.uri)
  wrap.appendChild(qrBox)

  const caption = document.createElement('p')
  caption.className = 'login-hint'
  caption.textContent = 'Scan with Amber, or open the link below if your signer is on this device.'
  wrap.appendChild(caption)

  const link = document.createElement('a')
  link.className = 'btn btn-small btn-full'
  link.href = session.uri
  link.textContent = 'Open in signer app'
  wrap.appendChild(link)

  const copyBtn = document.createElement('button')
  copyBtn.className = 'btn btn-small btn-full'
  copyBtn.textContent = 'Copy connection string'
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(session.uri)
      copyBtn.textContent = 'Copied'
      setTimeout(() => (copyBtn.textContent = 'Copy connection string'), 1500)
    } catch {
      setStatus(status, 'Could not copy — select the code manually', true)
    }
  })
  wrap.appendChild(copyBtn)

  setStatus(status, 'Waiting for approval in your signer…')

  session.pubkey.then(
    (pubkey) => {
      setStatus(status, `Connected as ${toNpub(pubkey).slice(0, 20)}…`)
      finish(pubkey)
    },
    (err: Error) => {
      setStatus(status, err.message, true)
    }
  )
}

/** Render a `nostrconnect://` URI as an inline SVG QR code. */
function renderQr(text: string): string {
  // Type 0 = auto-size. Error correction M survives a phone camera comfortably.
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })
}

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog

  dialog = document.createElement('dialog')
  dialog.className = 'login-dialog'
  dialog.innerHTML = `
    <div class="login-header">
      <h2>Connect your Nostr identity</h2>
      <button class="btn-icon login-close" aria-label="Close">&times;</button>
    </div>
    <p class="login-readonly">
      <strong>Read-only.</strong> Nalgorithm only needs your public key, so it can
      read your follow list, your feed, and your likes. It never signs, posts,
      or reacts on your behalf, and it asks your signer for no permission to do so.
    </p>
    <div class="login-body"></div>
    <p class="login-status"></p>
  `
  document.body.appendChild(dialog)
  return dialog
}

function divider(label: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'login-divider'
  el.innerHTML = `<span>${label}</span>`
  return el
}

function setStatus(el: HTMLElement, text: string, isError = false): void {
  el.textContent = text
  el.className = isError ? 'login-status login-status-error' : 'login-status'
}
