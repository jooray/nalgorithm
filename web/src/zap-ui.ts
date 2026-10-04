/**
 * Nalgorithm Web — zap a note (NIP-57, external wallet)
 *
 * Flow in one bottom sheet:
 *   1. find the author's Lightning address (lud16, else lud06) in their profile
 *   2. fetch the LNURL-pay parameters and check them (untrusted server)
 *   3. pick an amount and an optional comment
 *   4. sign a kind 9734 zap request, ask the server's callback for an invoice,
 *      check the invoice's amount and that it commits to our zap request
 *   5. show the invoice as a QR code with Open in wallet and Copy invoice
 *   6. watch the relays for the kind 9735 receipt, check it, and flip to Zapped
 *
 * The browser talks to the LNURL server directly. If that server does not send
 * CORS headers the request is blocked, and the sheet says so and offers the
 * Lightning address to copy. There is no proxy.
 */

import qrcode from 'qrcode-generator'
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import { openSheet, type SheetHandle } from './sheet.js'
import { icon } from './icons.js'
import { copyText } from './clipboard.js'
import { showToast } from './toast.js'
import { signChecked, type ActiveSigner } from './signer.js'
import { fetchMetadata, getRelayList, INDEXER_RELAYS, readRelaysFor, defaultRelays, watchEvents } from './relays.js'
import { setMark } from './note-state.js'
import { requireSigner, type NoteTarget } from './note-ui.js'
import { beginActivity } from './activity.js'
import {
  buildInvoiceUrl,
  checkAmount,
  parsePayParams,
  payTargetFromProfile,
  validateInvoice,
  validateReceipt,
  zapRequestTemplate,
  type PayParams,
  type PayTarget,
} from './note-logic.js'

const PRESETS = [21, 100, 1000, 5000]
const AMOUNT_KEY = 'nalgorithm_zap_amount'
const MAX_COMMENT = 200
const LNURL_TIMEOUT_MS = 9000
const MAX_RESPONSE_CHARS = 20000
const WATCH_GRACE_S = 120

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function lastAmount(): number {
  try {
    const n = Number(localStorage.getItem(AMOUNT_KEY))
    return Number.isInteger(n) && n > 0 ? n : 21
  } catch {
    return 21
  }
}

function rememberAmount(sats: number): void {
  try {
    localStorage.setItem(AMOUNT_KEY, String(sats))
  } catch {
    // not remembered
  }
}

// ─── LNURL fetch ─────────────────────────────────────────────────────────────

class LnurlError extends Error {
  constructor(
    message: string,
    /** True when the browser blocked or could not make the request (CORS or network). */
    readonly blocked = false
  ) {
    super(message)
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const host = new URL(url).hostname
  let response: Response
  try {
    response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LNURL_TIMEOUT_MS),
    })
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new LnurlError(
      timedOut
        ? `${host} did not answer in time.`
        : `Your browser could not reach ${host}. That server most likely does not allow requests from web pages (CORS), or you are offline.`,
      true
    )
  }
  if (!response.ok) throw new LnurlError(`${host} answered with an error (${response.status}).`)
  const text = await response.text()
  if (text.length > MAX_RESPONSE_CHARS) throw new LnurlError(`${host} sent an oversized response.`)
  try {
    return JSON.parse(text)
  } catch {
    throw new LnurlError(`${host} did not send a valid response.`)
  }
}

// ─── The sheet ───────────────────────────────────────────────────────────────

export async function zapNote(t: NoteTarget): Promise<void> {
  const signer = await requireSigner()
  if (!signer) return
  const finishActivity = beginActivity('zap payment')
  const sheet = openSheet({ title: `Zap ${t.authorName}`, onClose: finishActivity })
  await run(sheet, t, signer)
}

function loading(sheet: SheetHandle, text: string): void {
  sheet.body.replaceChildren(h('p', 'sheet-note', text))
  sheet.footer.replaceChildren()
}

function problem(sheet: SheetHandle, text: string, options: { address?: string; retry?: () => void } = {}): void {
  const p = h('p', 'sheet-problem', text)
  p.setAttribute('role', 'alert')
  sheet.body.replaceChildren(p)
  const actions: HTMLElement[] = []
  if (options.address) {
    const addr = options.address
    const copy = h('button', 'btn btn-secondary', 'Copy Lightning address')
    copy.type = 'button'
    copy.addEventListener('click', async () => {
      copy.textContent = (await copyText(addr)) ? 'Copied' : 'Copy failed'
      setTimeout(() => (copy.textContent = 'Copy Lightning address'), 1400)
    })
    sheet.body.append(h('p', 'sheet-note', 'You can still zap from your wallet with this address:'), h('p', 'zap-address', addr))
    actions.push(copy)
  }
  if (options.retry) {
    const retry = h('button', 'btn btn-primary', 'Try again')
    retry.type = 'button'
    retry.addEventListener('click', options.retry)
    actions.push(retry)
  }
  sheet.footer.replaceChildren(...actions)
}

async function run(sheet: SheetHandle, t: NoteTarget, signer: ActiveSigner): Promise<void> {
  loading(sheet, `Looking up ${t.authorName}'s Lightning address…`)

  const relays = await readRelaysFor(t.author, t.relay ? [t.relay] : [])
  const meta = await fetchMetadata(t.author, relays)
  const target = meta ? payTargetFromProfile(meta) : null
  if (!target) {
    return problem(
      sheet,
      meta
        ? `${t.authorName} has no Lightning address on their profile, so there is nowhere to send a zap.`
        : `I could not load ${t.authorName}'s profile from your relays, so I cannot find where to send a zap.`,
      { retry: meta ? undefined : () => void run(sheet, t, signer) }
    )
  }

  loading(sheet, `Asking ${target.label} for zap details…`)
  let params: PayParams
  try {
    const parsed = parsePayParams(await fetchJson(target.url))
    if (!parsed.ok) return problem(sheet, parsed.error, { address: target.address })
    params = parsed.value
  } catch (err) {
    const e = err as LnurlError
    return problem(sheet, e.message, {
      address: target.address,
      retry: () => void run(sheet, t, signer),
    })
  }
  chooseAmount(sheet, t, signer, target, params)
}

function chooseAmount(sheet: SheetHandle, t: NoteTarget, signer: ActiveSigner, target: PayTarget, params: PayParams): void {
  const minSats = Math.ceil(params.minSendable / 1000)
  const maxSats = Math.floor(params.maxSendable / 1000)
  let sats = lastAmount()

  const form = h('div', 'zap')
  form.appendChild(h('p', 'sheet-lead', `Send sats to ${target.label}`))

  const chips = h('div', 'zap-presets')
  chips.setAttribute('role', 'group')
  chips.setAttribute('aria-label', 'Amount in sats')
  const chipButtons = PRESETS.map((n) => {
    const b = h('button', 'zap-chip', n.toLocaleString('en'))
    b.type = 'button'
    b.addEventListener('click', () => {
      custom.value = ''
      setAmount(n)
    })
    chips.appendChild(b)
    return { n, b }
  })

  const customLabel = h('label', 'zap-label', 'Or your own amount, in sats')
  const custom = h('input', 'zap-custom')
  custom.type = 'number'
  custom.inputMode = 'numeric'
  custom.min = String(minSats)
  custom.max = String(maxSats)
  custom.step = '1'
  custom.id = 'zap-custom'
  customLabel.htmlFor = custom.id
  custom.addEventListener('input', () => setAmount(custom.value === '' ? NaN : Number(custom.value)))

  const range = h('p', 'sheet-note', `This address accepts ${minSats.toLocaleString('en')} to ${maxSats.toLocaleString('en')} sats.`)
  const error = h('p', 'sheet-problem')
  error.setAttribute('role', 'alert')

  const commentLabel = h('label', 'zap-label', 'Comment (optional)')
  const comment = h('textarea', 'zap-comment')
  comment.id = 'zap-comment'
  commentLabel.htmlFor = comment.id
  comment.rows = 2
  comment.maxLength = MAX_COMMENT

  form.append(chips, customLabel, custom, range, error, commentLabel, comment)
  sheet.body.replaceChildren(form)

  const go = h('button', 'btn btn-primary', '')
  go.type = 'button'
  const cancel = h('button', 'btn btn-ghost', 'Cancel')
  cancel.type = 'button'
  cancel.addEventListener('click', () => sheet.close())
  sheet.footer.replaceChildren(cancel, go)

  function setAmount(n: number): void {
    sats = n
    for (const { n: preset, b } of chipButtons) b.setAttribute('aria-pressed', String(preset === n && custom.value === ''))
    const check = Number.isFinite(n) ? checkAmount(params, n) : undefined
    error.textContent = check && !check.ok ? check.error : ''
    go.disabled = !check?.ok
    go.textContent = check?.ok ? `Zap ${n.toLocaleString('en')} sats` : 'Zap'
  }
  if (PRESETS.includes(sats)) setAmount(sats)
  else {
    custom.value = String(sats)
    setAmount(sats)
  }

  go.addEventListener('click', async () => {
    const check = checkAmount(params, sats)
    if (!check.ok) return
    go.disabled = true
    cancel.disabled = true
    chips.querySelectorAll('button').forEach((b) => (b.disabled = true))
    custom.disabled = true
    comment.disabled = true
    error.textContent = ''
    const status = h('p', 'sheet-note', 'Waiting for your signer to sign the zap request…')
    status.setAttribute('role', 'status')
    form.appendChild(status)
    try {
      await requestInvoice(sheet, t, signer, target, params, check.value, comment.value)
      rememberAmount(sats)
    } catch (err) {
      const e = err as Error
      problem(sheet, e.message, {
        address: e instanceof LnurlError && e.blocked ? target.address : undefined,
        retry: () => chooseAmount(sheet, t, signer, target, params),
      })
    }
  })
}

async function requestInvoice(
  sheet: SheetHandle,
  t: NoteTarget,
  signer: ActiveSigner,
  target: PayTarget,
  params: PayParams,
  msats: number,
  commentText: string
): Promise<void> {
  const own = await getRelayList(signer.pubkey)
  const zapRelays = [...new Set([...(own?.read ?? []), ...defaultRelays(), ...INDEXER_RELAYS.slice(0, 1)])].slice(0, 6)
  const template = zapRequestTemplate({
    recipient: t.author,
    eventId: t.id,
    eventKind: t.event?.kind ?? t.kind,
    msats,
    relays: zapRelays,
    lnurl: target.lnurl,
    comment: commentText,
  })
  const zapRequest = await signChecked(signer, template)
  const zapRequestJson = JSON.stringify(zapRequest)

  const reply = (await fetchJson(buildInvoiceUrl(params, { msats, zapRequestJson, lnurl: target.lnurl, comment: commentText }))) as Record<string, unknown> | null
  if (!reply || typeof reply !== 'object') throw new LnurlError('The Lightning server did not send an invoice.')
  if (reply.status === 'ERROR') {
    const reason = typeof reply.reason === 'string' ? reply.reason.replace(/\s+/g, ' ').slice(0, 200) : ''
    throw new LnurlError(`The Lightning server refused: ${reason || 'no reason given'}.`)
  }
  const checked = await validateInvoice(reply.pr, { msats, zapRequestJson })
  if (!checked.ok) throw new LnurlError(checked.error)
  const invoice = (reply.pr as string).trim().toLowerCase()
  showInvoice(sheet, t, signer, params, { zapRequest, zapRequestJson, invoice, msats, target, expiresAt: checked.value.timestamp + checked.value.expiry })
}

interface Pending {
  zapRequest: NostrEvent
  zapRequestJson: string
  invoice: string
  msats: number
  target: PayTarget
  expiresAt: number
}

function qrSvg(text: string): string {
  const qr = qrcode(0, 'L')
  qr.addData(text.toUpperCase(), 'Alphanumeric')
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })
}

function showInvoice(sheet: SheetHandle, t: NoteTarget, signer: ActiveSigner, params: PayParams, p: Pending): void {
  const sats = p.msats / 1000
  const box = h('div', 'zap-invoice')
  box.appendChild(h('p', 'sheet-lead', `${sats.toLocaleString('en')} sats to ${t.authorName}`))

  const qr = h('div', 'login-qr zap-qr')
  qr.innerHTML = qrSvg(p.invoice) // generated from a validated bech32 string, not from free text
  qr.setAttribute('role', 'img')
  qr.setAttribute('aria-label', 'Lightning invoice QR code')
  const status = h('p', 'zap-status', 'Waiting for the payment. This turns to Zapped when the receipt arrives.')
  status.setAttribute('role', 'status')
  box.append(qr, status)
  sheet.body.replaceChildren(box)

  const wallet = h('a', 'btn btn-primary', 'Open in wallet')
  wallet.href = `lightning:${p.invoice}`
  const copy = h('button', 'btn btn-secondary', 'Copy invoice')
  copy.type = 'button'
  copy.addEventListener('click', async () => {
    copy.textContent = (await copyText(p.invoice)) ? 'Copied' : 'Copy failed'
    setTimeout(() => (copy.textContent = 'Copy invoice'), 1400)
  })
  sheet.footer.replaceChildren(copy, wallet)

  let stopped = false
  const stop = watchEvents(
    p.zapRequest.tags.find((x) => x[0] === 'relays')?.slice(1) ?? defaultRelays(),
    { kinds: [9735], '#p': [t.author], '#e': [t.id], since: p.zapRequest.created_at - 30 },
    (receipt) => void onReceipt(receipt)
  )
  const halt = (): void => {
    if (stopped) return
    stopped = true
    stop()
    clearTimeout(expiry)
  }

  async function onReceipt(receipt: NostrEvent): Promise<void> {
    if (stopped || !verifyEvent(receipt)) return
    const ok = await validateReceipt(receipt, {
      zapRequest: p.zapRequest,
      zapRequestJson: p.zapRequestJson,
      nostrPubkey: params.nostrPubkey,
      invoice: p.invoice,
    })
    if (!ok.ok || stopped) return
    halt()
    setMark(signer.pubkey, 'zapped', t.id, sats)
    if (sheet.el.isConnected) showZapped(sheet, t, sats)
    else showToast(`Zapped ${sats.toLocaleString('en')} sats to ${t.authorName}.`)
  }

  // Stop watching a couple of minutes after the invoice can no longer be paid.
  const secondsLeft = Math.max(0, p.expiresAt - Math.floor(Date.now() / 1000))
  const expiry = window.setTimeout(() => {
    halt()
    if (!sheet.el.isConnected) return
    status.textContent = 'The invoice expired before a receipt arrived. If you paid, the receipt may still show up later; otherwise create a new one.'
    wallet.remove()
    const again = h('button', 'btn btn-primary', 'New invoice')
    again.type = 'button'
    again.addEventListener('click', () => chooseAmount(sheet, t, signer, p.target, params))
    sheet.footer.replaceChildren(again)
  }, (secondsLeft + WATCH_GRACE_S) * 1000)
}

function showZapped(sheet: SheetHandle, t: NoteTarget, sats: number): void {
  const head = h('div', 'sent')
  const mark = h('span', 'sent-mark')
  mark.innerHTML = icon('check', 26)
  const text = h('div', 'sent-text')
  text.appendChild(h('p', 'sent-title', 'Zapped'))
  const line = h('p', 'sent-line', `${sats.toLocaleString('en')} sats reached ${t.authorName}.`)
  line.setAttribute('role', 'status')
  text.appendChild(line)
  head.append(mark, text)
  sheet.body.replaceChildren(head)
  const done = h('button', 'btn btn-primary', 'Done')
  done.type = 'button'
  done.addEventListener('click', () => sheet.close())
  sheet.footer.replaceChildren(done)
}
