/**
 * Nalgorithm Web — login dialog
 *
 * Presents the two ways to tell Nalgorithm who you are: a NIP-07 browser
 * extension, or a NIP-46 remote signer (Amber and friends) via QR code.
 *
 * In bring-your-own-key mode both are read-only. The dialog says so explicitly,
 * because "connect your Nostr signer" normally implies granting signing power,
 * and there it does not.
 *
 * The hosted variant of the same dialog additionally needs one signature over
 * a login event, so it has no "paste an npub" option: a public key alone
 * cannot prove anyone holds the key.
 */

import qrcode from 'qrcode-generator'
import {
  hasNip07,
  loginWithExtension,
  signWithExtension,
  startRemoteSignerLogin,
  toNpub,
  type RemoteSignerSession,
  type SignFn,
} from './nostr-login.js'

/** A completed login. `sign`/`close` are present only for hosted logins. */
export interface LoginResult {
  pubkey: string
  sign?: SignFn
  /** Release the signer connection once the signature has been used. */
  close?: () => void
}

const READONLY_NOTICE = `
  <strong>Read-only.</strong> Nalgorithm only needs your public key, so it can
  read your follow list, your feed, and your likes. It never signs, posts,
  or reacts on your behalf, and it asks your signer for no permission to do so.`

const HOSTED_NOTICE = `
  <strong>One signature, nothing posted.</strong> Signing in to the hosted service
  asks your signer to sign a single one-time login event for this site. It is
  never published to a relay and cannot post or spend anything for you. No API
  key is involved.`

let dialog: HTMLDialogElement | null = null
let activeSession: RemoteSignerSession | null = null

/**
 * Open the login dialog.
 *
 * @returns the user's hex pubkey, or null if they closed the dialog.
 */
export async function openLoginDialog(signerRelays?: string[]): Promise<string | null> {
  return (await openDialog(signerRelays, false))?.pubkey ?? null
}

/**
 * Open the login dialog for hosted mode: signer only, and the result can sign
 * one login event. The caller must call `close()` on the result when done.
 */
export function openHostedLoginDialog(signerRelays?: string[]): Promise<LoginResult | null> {
  return openDialog(signerRelays, true)
}

function openDialog(signerRelays: string[] | undefined, hosted: boolean): Promise<LoginResult | null> {
  return new Promise((resolve) => {
    const el = ensureDialog()
    el.querySelector<HTMLElement>('.login-readonly')!.innerHTML = hosted ? HOSTED_NOTICE : READONLY_NOTICE
    el.querySelector<HTMLElement>('.login-header h2')!.textContent = hosted
      ? 'Sign in to hosted Nalgorithm'
      : 'Connect your Nostr identity'
    const body = el.querySelector<HTMLElement>('.login-body')!
    const status = el.querySelector<HTMLElement>('.login-status')!

    let settled = false
    const finish = (result: LoginResult | null): void => {
      if (settled) return
      settled = true
      // A finished hosted login keeps its signer open for the caller; anything
      // else (closed dialog, failure) tears the handshake down.
      if (!result?.close) activeSession?.cancel()
      activeSession = null
      el.close()
      resolve(result)
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
        const pubkey = await loginWithExtension()
        finish(hosted ? { pubkey, sign: signWithExtension, close: () => {} } : { pubkey })
      } catch (err) {
        setStatus(status, (err as Error).message, true)
      }
    })
    body.appendChild(extBtn)

    const hint = document.createElement('p')
    hint.className = 'login-hint'
    hint.textContent = hasNip07()
      ? hosted
        ? 'Reads your public key from Alby, nos2x, or a similar extension, then asks it to sign one login event.'
        : 'Reads your public key from Alby, nos2x, or a similar extension.'
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
      beginRemoteSigner(signerWrap, status, finish, signerRelays, hosted)
    })
    signerWrap.appendChild(startBtn)

    body.appendChild(divider('or'))

    if (hosted) {
      // No manual entry: an npub someone pasted proves nothing about who holds
      // the key, and the server only accepts a signed login.
      const why = document.createElement('p')
      why.className = 'login-hint'
      why.textContent =
        'Pasting an npub is not available here. Hosted mode keeps your settings and subscription under your key, so the server needs a signature to know it is really you. To only look at a feed without signing anything, use bring-your-own-key mode.'
      body.appendChild(why)
    } else {
      // ── Manual entry escape hatch ──────────────────────────────────────
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
        finish({ pubkey: value })
      })
    }

    el.querySelector<HTMLButtonElement>('.login-close')!.onclick = () => finish(null)
    el.onclose = () => finish(null)
    el.showModal()
  })
}

/** Kick off the NIP-46 handshake and render the QR + deep link. */
function beginRemoteSigner(
  wrap: HTMLElement,
  status: HTMLElement,
  finish: (result: LoginResult | null) => void,
  relays?: string[],
  hosted = false
): void {
  let session: RemoteSignerSession
  try {
    session = startRemoteSignerLogin(relays?.length ? relays : undefined, { sign: hosted })
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
  caption.textContent = hosted
    ? 'Scan with Amber, or open the link below if your signer is on this device. Approve the connection and the login signature.'
    : 'Scan with Amber, or open the link below if your signer is on this device.'
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
      finish(hosted ? { pubkey, sign: session.sign, close: session.close } : { pubkey })
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
    <p class="login-readonly"></p>
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
