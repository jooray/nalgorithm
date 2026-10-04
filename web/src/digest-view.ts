/**
 * Nalgorithm Web — the Digests tab
 *
 * Hero player, show notes for the selected digest, and the digest feed below.
 * Mode-agnostic: hosted and bring-your-own-key each provide a `DigestBackend`
 * (where digests come from, how a new one is made, how notes get profiles).
 */

import type { ProfileData } from 'nalgorithm'
import { ResumeStore, formatClock, formatSpeed, resumeHint, SPEEDS } from './audio-logic.js'
import {
  digestKey,
  firstLines,
  formatLength,
  digestLengthLabel,
  newestFirst,
  toScoredPost,
  notePubkeys,
  type DigestRecord,
} from './digest-model.js'
import { icon } from './icons.js'
import { DigestPlayer, safeStorage, type PlayerState } from './player.js'
import { knownProfiles, loadProfiles, rememberSnapshots } from './profiles.js'
import { renderFeed, type RenderOptions } from './render.js'
import { clockLabel, dayLabel } from './time.js'
import { Waveform } from './waveform.js'
import { safeAudioUrl } from './hosted/logic.js'
import { ANOTHER_DIGEST_HINT, makeButtonView } from './digest-job-logic.js'
import { miniView, scrollAfterInsert } from './mini-player-logic.js'
import { showTab } from './shell.js'
import { beginActivity } from './activity.js'

export interface DigestBackend {
  mode: 'hosted' | 'byok'
  /** The button that makes the first digest. */
  makeLabel: string
  /** The same button once a digest exists. */
  makeAnotherLabel: string
  /** What the empty hero says about getting the first one. */
  emptyText: string
  make(): Promise<void>
  /** Hosted: fetch one digest with its notes when the list did not carry them. */
  loadFull?(d: DigestRecord): Promise<DigestRecord | null>
  /** Bring your own key with a TTS model set: turn the text into an audio file. */
  makeAudio?(d: DigestRecord): Promise<{ url: string; filename: string }>
  /** Whether `makeAudio` is configured right now. */
  canMakeAudio?(): boolean
  renderOptions(profiles: Map<string, ProfileData>): RenderOptions
  relays(): string[]
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element not found: #${id}`)
  return el as T
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

let backend: DigestBackend
let player: DigestPlayer
let wave: Waveform
let resume: ResumeStore
let digests: DigestRecord[] = []
let selectedId: string | null = null
let notesOpen = false
let notesTab: 'notes' | 'text' = 'notes'
let scrubFraction: number | null = null
let makeBusy = false
/** A digest is being written somewhere else (the server), reported by the backend. */
let jobRunning = false
let lastShell = ''
/** When the digest being written started (seconds), for the mini player's clock. */
let runStartedAt: number | null = null
let miniTick: number | undefined
let miniShown = false
/** Audio files made in this session (bring your own key): digest id to blob URL. */
const madeAudio = new Map<string, { url: string; filename: string }>()

// ─── public API ──────────────────────────────────────────────────────────────

export function initDigestView(b: DigestBackend): void {
  backend = b
  resume = new ResumeStore(safeStorage())
  player = new DigestPlayer()

  wave = new Waveform($('wave'), {
    onScrub: (f) => {
      scrubFraction = f
      paintTimes(player.current)
    },
    onCommit: (f) => {
      scrubFraction = null
      player.seek(f * player.current.dur)
    },
    onStep: (s) => player.skip(s),
  })

  $('btn-play').innerHTML = icon('play', 40)
  $('btn-back').innerHTML = `${icon('back15', 26)}<span class="skip-n">15</span>`
  $('btn-fwd').innerHTML = `${icon('fwd30', 26)}<span class="skip-n">30</span>`
  $('btn-play').addEventListener('click', () => player.toggle())
  $('btn-back').addEventListener('click', () => player.skip(-15))
  $('btn-fwd').addEventListener('click', () => player.skip(30))
  $('btn-shownotes').addEventListener('click', () => toggleNotes())
  $('btn-make').addEventListener('click', () => void runMake())
  $('btn-make-list').addEventListener('click', () => void runMake())
  $('hero-empty-text').textContent = b.emptyText
  $('btn-audio').addEventListener('click', () => void onAudioButton())
  initSpeedMenu()
  initNotesTabs()
  initMini()

  player.onChange((s) => paint(s))
  renderAll()
}

/** Replace the list (newest first is enforced). Keeps the selection when it still exists. */
export function setDigests(list: DigestRecord[], options: { select?: string } = {}): void {
  digests = newestFirst(list)
  for (const d of digests) rememberSnapshots(d.profiles)
  const routeId = location.hash.startsWith('#digest/') ? location.hash.split('/')[1] : null
  const saved = safeStorage()?.getItem(selectionKey())
  const want = options.select ?? selectedId ?? routeId ?? saved
  const keep = want && digests.some((d) => d.id === want) ? want : (digests[0]?.id ?? null)
  setListError(null)
  selectInternal(keep, false)
  renderAll()
}

/** Put one digest in front of the list and select it. */
export function addDigest(d: DigestRecord, options: { openNotes?: boolean } = {}): void {
  digests = newestFirst([d, ...digests.filter((x) => x.id !== d.id)])
  rememberSnapshots(d.profiles)
  selectInternal(d.id, options.openNotes ?? false)
  renderAll()
}

export function digestCount(): number {
  return digests.length
}

export function digestIds(): string[] {
  return digests.map((d) => d.id)
}

export function stopPlayback(): void {
  if (player?.current.playing) player.pause()
}

export function setMakeStatus(text: string, isError = false): void {
  // One line, where the reader is looking: under the hero button while the hero asks for the
  // first digest, in the list header once there are digests.
  const heroShown = !$('hero-empty').classList.contains('hidden')
  for (const id of ['hero-empty-status', 'list-status']) {
    const el = $(id)
    el.textContent = (id === 'hero-empty-status') === heroShown ? text : ''
    el.classList.toggle('is-error', isError)
  }
}

export function setMakeBusy(busy: boolean): void {
  makeBusy = busy
  syncRunClock()
  applyMakeState()
}

/**
 * A digest is (or is no longer) being written on the server. While it is, every
 * make button is disabled and says so, and a progress bar shows where the reader looks.
 */
export function setDigestJobRunning(running: boolean, startedAtSec?: number | null): void {
  jobRunning = running
  syncRunClock(startedAtSec ?? undefined)
  applyMakeState()
}

export function digestJobRunning(): boolean {
  return jobRunning || makeBusy
}

/** Label, disabled state and progress bars of the make buttons, from the current state. */
export function applyMakeState(): void {
  if (!backend) return
  const running = jobRunning || makeBusy
  const has = digests.length > 0
  const view = makeButtonView({ running, hasDigests: has, firstLabel: backend.makeLabel, anotherLabel: backend.makeAnotherLabel })
  for (const id of ['btn-make', 'btn-make-list']) {
    const b = $<HTMLButtonElement>(id)
    b.textContent = view.label
    b.disabled = view.disabled
    b.classList.toggle('is-busy', view.busy)
    b.setAttribute('aria-busy', String(view.busy))
  }
  $('make-bar-hero').classList.toggle('hidden', !running)
  $('make-bar-list').classList.toggle('hidden', !(running && has))
  const hint = $('make-again-hint')
  hint.textContent = ANOTHER_DIGEST_HINT
  hint.classList.toggle('hidden', !has || running)
  for (const id of ['btn-digest-now']) {
    const tune = document.getElementById(id) as HTMLButtonElement | null
    if (!tune) continue
    tune.textContent = running ? view.label : has ? 'Send me another digest now' : 'Send me a digest now'
    tune.disabled = running
    tune.classList.toggle('is-busy', running)
  }
  document.getElementById('make-bar-tune')?.classList.toggle('hidden', !running)
  paintMini()
}

/** Streaming progress of a digest being written in the browser. */
export function showGenerating(active: boolean, status = '', text = ''): void {
  const box = $('gen')
  box.classList.toggle('hidden', !active)
  if (!active) return
  $('gen-status').textContent = status
  const body = $('gen-body')
  body.replaceChildren()
  for (const para of text.split(/\n{2,}/)) {
    if (para.trim()) body.appendChild(h('p', undefined, para.trim()))
  }
}

export function setListError(message: string | null, retry?: () => void): void {
  const box = $('list-error')
  box.classList.toggle('hidden', !message)
  $('list-error-text').textContent = message ?? ''
  const btn = $<HTMLButtonElement>('btn-list-retry')
  btn.onclick = () => retry?.()
  btn.classList.toggle('hidden', !retry)
}

export function setListLoading(loading: boolean): void {
  $('list-loading').classList.toggle('hidden', !loading)
}

// ─── selection ───────────────────────────────────────────────────────────────

function selected(): DigestRecord | null {
  return digests.find((d) => d.id === selectedId) ?? null
}
function selectionKey(): string {
  const store = safeStorage()
  const identity = store?.getItem(document.body.dataset.mode === 'hosted' ? 'nalgorithm_hosted_npub' : 'nalgorithm_npub') ?? 'setup'
  return `nalgorithm_selected_digest_${backend.mode}_${identity}`
}

function playableUrl(d: DigestRecord): string | null {
  return madeAudio.get(d.id)?.url ?? safeAudioUrl(d.audioUrl)
}

/** Key for resume marks: a session-made audio file still belongs to its digest, not a throwaway blob URL. */
function keyOf(d: DigestRecord): string {
  return digestKey({ id: d.id, audioUrl: safeAudioUrl(d.audioUrl) })
}

function sourceFor(d: DigestRecord) {
  return {
    key: keyOf(d),
    title: 'Your morning digest',
    subtitle: `${dayLabel(d.createdAt)}, ${clockLabel(d.createdAt)}`,
    audioUrl: playableUrl(d),
    text: d.text,
    durationSeconds: exactSeconds(d),
  }
}

function selectInternal(id: string | null, openNotes: boolean): void {
  const changed = id !== selectedId
  selectedId = id
  if (id) {
    safeStorage()?.setItem(selectionKey(), id)
    if (location.hash.split('/')[0] === '#digest' && !document.querySelector('dialog[open]')) history.replaceState(history.state, '', `#digest/${encodeURIComponent(id)}`)
  }
  if (changed) notesTab = 'notes'
  if (openNotes) notesOpen = true
  if (changed && !openNotes) notesOpen = false
  const d = selected()
  player.load(d ? sourceFor(d) : null)
}

function selectDigest(id: string, options: { openNotes: boolean; play?: boolean }): void {
  selectInternal(id, options.openNotes)
  renderAll()
  if (options.openNotes) {
    $('shownotes').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
  }
  // Only ever from a press on a play button.
  if (options.play) player.play()
}

// ─── rendering ───────────────────────────────────────────────────────────────

function renderAll(): void {
  const d = selected()
  const has = digests.length > 0
  $('hero').classList.toggle('is-empty', !d)
  $('player').classList.toggle('hidden', !d)
  $('hero-empty').classList.toggle('hidden', Boolean(d))
  $('hero-sub').classList.toggle('hidden', !d)
  $('hero-line1').textContent = d ? 'Your morning,' : 'No digest yet.'
  $('digest-list-empty').classList.toggle('hidden', has)
  $('btn-make-list').classList.toggle('hidden', !has)
  applyMakeState()
  lastShell = ''
  renderList()
  renderShowNotes()
  paint(player.current)
}

/** The server's exact length, when this digest has audio to go with it. */
function exactSeconds(d: DigestRecord): number | undefined {
  return d.durationSeconds && safeAudioUrl(d.audioUrl) ? d.durationSeconds : undefined
}

function entryLength(d: DigestRecord): string {
  return digestLengthLabel({ knownSeconds: resume.durationOf(keyOf(d)), played: resume.isPlayed(keyOf(d)), serverSeconds: exactSeconds(d), text: d.text })
}

function renderList(): void {
  const list = $('digest-list')
  list.replaceChildren()
  for (const d of digests) {
    const li = h('li')
    const card = h('article', d.id === selectedId ? 'digest-entry is-selected' : 'digest-entry')
    card.dataset.id = d.id

    const play = h('button', 'entry-play')
    play.type = 'button'
    play.dataset.role = 'play'
    play.innerHTML = icon('play', 22)
    play.setAttribute('aria-label', `Play the digest from ${dayLabel(d.createdAt)}, ${clockLabel(d.createdAt)}`)
    play.addEventListener('click', () => {
      if (d.id === selectedId && player.current.playing) player.pause()
      else if (d.id === selectedId) player.play()
      else selectDigest(d.id, { openNotes: false, play: true })
    })

    const open = h('button', 'entry-open')
    open.type = 'button'
    open.setAttribute('aria-label', `Open the digest from ${dayLabel(d.createdAt)} and its show notes`)
    const head = h('span', 'entry-head')
    head.append(h('strong', 'entry-day', dayLabel(d.createdAt)), h('span', 'entry-meta', `${clockLabel(d.createdAt)} · ${entryLength(d)}`))
    const state = h('span', 'entry-state')
    state.dataset.role = 'state'
    head.append(state)
    const text = h('span', 'entry-text', firstLines(d.text, 2) || 'No text')
    const foot = h('span', 'entry-foot')
    const count = d.notes?.length
    foot.textContent = count === undefined ? 'Show notes' : count === 1 ? '1 note in the show notes' : `${count} notes in the show notes`
    open.append(head, text, foot)
    open.addEventListener('click', () => selectDigest(d.id, { openNotes: true }))

    card.append(play, open)
    li.append(card)
    list.append(li)
  }
  paintEntries(player.current)
}

/** Cheap, in place: state text, selection and play icon on each entry. */
function paintEntries(s: PlayerState): void {
  for (const card of document.querySelectorAll<HTMLElement>('#digest-list .digest-entry')) {
    const d = digests.find((x) => x.id === card.dataset.id)
    if (!d) continue
    const isSel = d.id === selectedId
    card.classList.toggle('is-selected', isSel)
    const key = keyOf(d)
    const hint = isSel ? resumeHint(s.resumeAt) : resumeHint(resume.resumeAt(key))
    const played = isSel ? s.played : resume.isPlayed(key)
    const state = card.querySelector<HTMLElement>('[data-role="state"]')!
    state.textContent = hint ?? (played ? 'Played' : '')
    state.classList.toggle('is-played', !hint && played)
    const playing = isSel && (s.playing || s.loading)
    const btn = card.querySelector<HTMLButtonElement>('[data-role="play"]')!
    btn.innerHTML = icon(playing ? 'pause' : 'play', 22)
    const when = `${dayLabel(d.createdAt)}, ${clockLabel(d.createdAt)}`
    btn.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} the digest from ${when}`)
  }
}

function paintTimes(s: PlayerState): void {
  const dur = s.dur
  const pos = scrubFraction !== null ? scrubFraction * dur : s.pos
  const tilde = s.durApprox ? '~' : ''
  $('t-elapsed').textContent = formatClock(pos)
  $('t-remaining').textContent = `-${tilde}${formatClock(Math.max(0, dur - pos))}`
}

function paint(s: PlayerState): void {
  const d = selected()
  if (!d) {
    paintEntries(s)
    return
  }
  // Title line two and the sub line change when the real duration arrives or the selection moves.
  const shell = `${d.id}|${Math.round(s.dur)}|${s.durApprox}|${s.mode}|${madeAudio.has(d.id)}|${notesOpen}|${d.notes?.length ?? -1}`
  if (shell !== lastShell) {
    lastShell = shell
    $('hero-line2').textContent = formatLength(s.dur, s.durApprox || (s.mode === 'audio' && !s.played && !exactSeconds(d)))
    $('hero-sub').textContent = `${dayLabel(d.createdAt)}, ${clockLabel(d.createdAt)}${s.mode === 'speech' ? ' · read aloud by your browser' : ''}`
    const count = d.notes?.length
    const btn = $('btn-shownotes')
    btn.innerHTML = `${icon('notes', 20)}<span>${count === undefined ? 'Show notes' : `Show notes · ${count}`}</span>`
    btn.setAttribute('aria-expanded', String(notesOpen))
    const audioBtn = $<HTMLButtonElement>('btn-audio')
    const made = madeAudio.get(d.id)
    const offer = Boolean(made) || (backend.canMakeAudio?.() === true && !d.audioUrl)
    audioBtn.classList.toggle('hidden', !offer)
    audioBtn.textContent = made ? 'Save MP3' : 'Make audio'
  }

  const busy = s.playing || s.loading
  const play = $<HTMLButtonElement>('btn-play')
  play.innerHTML = icon(busy ? 'pause' : 'play', 40)
  play.setAttribute('aria-label', busy ? 'Pause digest' : 'Play digest')
  play.classList.toggle('is-playing', s.playing)
  play.setAttribute('aria-busy', String(s.loading))
  play.disabled = s.mode === 'none'

  const fraction = s.dur > 0 ? s.pos / s.dur : 0
  wave.setEnabled(s.mode !== 'none')
  wave.setProgress(fraction)
  const waveEl = $('wave')
  waveEl.setAttribute('aria-valuenow', String(Math.round(fraction * 100)))
  waveEl.setAttribute('aria-valuetext', `${formatClock(s.pos)} of ${formatClock(s.dur)}`)
  if (!wave.isScrubbing) paintTimes(s)

  $('btn-speed').textContent = formatSpeed(s.speed)
  for (const item of document.querySelectorAll<HTMLElement>('#speed-menu [role="menuitemradio"]')) {
    item.setAttribute('aria-checked', String(Number(item.dataset.speed) === s.speed))
  }

  const hint = $('player-hint')
  const text = s.error || (s.resumeAt > 0 && !s.playing ? (resumeHint(s.resumeAt) ?? '') : s.played && !s.playing ? 'Played' : '')
  hint.textContent = text
  hint.classList.toggle('is-error', Boolean(s.error))
  hint.setAttribute('role', s.error ? 'alert' : 'status')

  paintEntries(s)
  paintMini()
}

// ─── mini player (Feed tab) ──────────────────────────────────────────────────

/** Start or stop the running clock, and the once-a-second repaint that draws it. */
function syncRunClock(startedAtSec?: number): void {
  const running = jobRunning || makeBusy
  if (!running) runStartedAt = null
  else if (startedAtSec !== undefined) runStartedAt = startedAtSec
  else if (runStartedAt === null) runStartedAt = Math.floor(Date.now() / 1000)
  if (running && miniTick === undefined) {
    miniTick = window.setInterval(() => {
      if (document.visibilityState === 'visible') paintMini()
    }, 1000)
  } else if (!running && miniTick !== undefined) {
    clearInterval(miniTick)
    miniTick = undefined
  }
}

/** The latest digest, and the parts of the player state the mini bar shows for it. */
function miniLatest(s: PlayerState) {
  const d = digests[0]
  if (!d) return null
  const key = keyOf(d)
  const isSel = d.id === selectedId
  const playing = isSel && (s.playing || s.loading)
  const resumeAt = isSel ? s.resumeAt : resume.resumeAt(key)
  return {
    when: `${dayLabel(d.createdAt)}, ${clockLabel(d.createdAt)}`,
    length: entryLength(d),
    playing,
    pos: playing ? s.pos : resumeAt,
    dur: isSel ? s.dur : resume.durationOf(key) || exactSeconds(d) || 0,
    resumeHint: resumeHint(resumeAt),
  }
}

/** Go to the Digests tab with the latest digest in the main player; optionally start it (from a press only). */
function openLatest(play: boolean): void {
  const d = digests[0]
  if (d && d.id !== selectedId) {
    selectInternal(d.id, false)
    renderAll()
  }
  showTab('digest')
  window.scrollTo({ top: 0 })
  // Called inside the click handler, so the browser counts it as the reader's press.
  if (play && d) player.play()
}

function initMini(): void {
  $('mini-play').addEventListener('click', () => {
    const d = digests[0]
    if (d && d.id === selectedId && (player.current.playing || player.current.loading)) player.pause()
    else openLatest(true)
  })
  $('mini-open').addEventListener('click', () => openLatest(false))
}

function setText(id: string, text: string): void {
  const el = $(id)
  if (el.textContent !== text) el.textContent = text
}

function paintMini(): void {
  const box = document.getElementById('mini')
  if (!box || !player) return
  const nowSec = Math.floor(Date.now() / 1000)
  const v = miniView({
    running: jobRunning || makeBusy,
    elapsedSeconds: runStartedAt === null ? 0 : nowSec - runStartedAt,
    latest: miniLatest(player.current),
  })
  const show = v.kind !== 'none'
  if (show !== miniShown) {
    // Keep a scrolled reader where they are: the bar is part of the flow above the notes.
    const visible = box.offsetParent !== null
    const y = window.scrollY
    const height = (): number => box.offsetHeight + (parseFloat(getComputedStyle(box).marginTop) || 0)
    if (show) {
      box.classList.remove('hidden')
      if (visible) window.scrollTo({ top: scrollAfterInsert(y, height()) })
    } else {
      const h0 = visible ? height() : 0
      box.classList.add('hidden')
      if (visible && y > 4) window.scrollTo({ top: Math.max(0, y - h0) })
    }
    miniShown = show
  }
  if (v.kind === 'none') return
  const play = $<HTMLButtonElement>('mini-play')
  const line = $('mini-line')
  box.classList.toggle('is-running', v.kind === 'running')
  play.classList.toggle('hidden', v.kind === 'running')
  line.classList.toggle('is-indet', v.kind === 'running')
  if (v.kind === 'running') {
    setText('mini-title', v.title)
    setText('mini-meta', 'It will appear here when it is ready.')
    setText('mini-hint', '')
    box.setAttribute('aria-label', 'Digest being written')
    $('mini-open').setAttribute('aria-label', 'Open your digests')
    line.classList.remove('hidden')
    $('mini-fill').style.transform = ''
    return
  }
  box.setAttribute('aria-label', 'Latest digest')
  setText('mini-title', v.title)
  setText('mini-meta', v.meta)
  setText('mini-hint', v.hint ?? '')
  $('mini-open').setAttribute('aria-label', `${v.openLabel}. ${v.title}, ${v.meta}${v.hint ? `, ${v.hint}` : ''}`)
  const glyph = v.playing ? 'pause' : 'play'
  if (play.dataset.glyph !== glyph) {
    play.dataset.glyph = glyph
    play.innerHTML = icon(glyph, 22)
  }
  play.setAttribute('aria-label', v.buttonLabel)
  line.classList.toggle('hidden', v.progress === null)
  $('mini-fill').style.transform = `scaleX(${v.progress ?? 0})`
}

// ─── speed menu ──────────────────────────────────────────────────────────────

function initSpeedMenu(): void {
  const btn = $('btn-speed')
  const menu = $('speed-menu')
  for (const speed of SPEEDS) {
    const item = h('button', 'speed-item', formatSpeed(speed))
    item.type = 'button'
    item.setAttribute('role', 'menuitemradio')
    item.dataset.speed = String(speed)
    item.addEventListener('click', () => {
      player.setSpeed(speed)
      close()
      btn.focus()
    })
    menu.append(item)
  }
  const close = (): void => {
    menu.classList.add('hidden')
    btn.setAttribute('aria-expanded', 'false')
  }
  const open = (): void => {
    menu.classList.remove('hidden')
    btn.setAttribute('aria-expanded', 'true')
    const current = menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLElement>('button')
    current?.focus()
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu.classList.contains('hidden')) open()
    else close()
  })
  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('#speed-menu')) close()
  })
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll<HTMLElement>('button')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      close()
      btn.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      items[(at + 1) % items.length].focus()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      items[(at - 1 + items.length) % items.length].focus()
    } else if (e.key === 'Tab') {
      close()
    }
  })
}

// ─── show notes ──────────────────────────────────────────────────────────────

function initNotesTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#shownotes [role="tab"]')]
  tabs.forEach((tab, i) => {
    tab.id = `shownotes-tab-${tab.dataset.tab}`
    tab.setAttribute('aria-controls', `shownotes-${tab.dataset.tab}`)
    document.getElementById(`shownotes-${tab.dataset.tab}`)?.setAttribute('aria-labelledby', tab.id)
    tab.addEventListener('keydown', (e) => {
      const target = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1
      if (target < 0) return
      e.preventDefault(); tabs[target].click(); tabs[target].focus()
    })
  })
  for (const tab of document.querySelectorAll<HTMLButtonElement>('#shownotes [role="tab"]')) {
    tab.addEventListener('click', () => {
      notesTab = tab.dataset.tab === 'text' ? 'text' : 'notes'
      renderShowNotes()
    })
  }
}

function toggleNotes(): void {
  notesOpen = !notesOpen
  lastShell = ''
  renderShowNotes()
  paint(player.current)
  if (notesOpen) $('shownotes').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
}

function renderShowNotes(): void {
  const box = $('shownotes')
  const d = selected()
  box.classList.toggle('hidden', !d || !notesOpen)
  if (!d || !notesOpen) return

  for (const tab of box.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const on = tab.dataset.tab === notesTab
    tab.setAttribute('aria-selected', String(on))
    tab.tabIndex = on ? 0 : -1
  }
  $('shownotes-sub').textContent =
    d.notes === undefined
      ? `${dayLabel(d.createdAt)}, ${clockLabel(d.createdAt)}`
      : `${d.notes.length === 1 ? '1 note' : `${d.notes.length} notes`} it was written from, best first`
  $('shownotes-notes').classList.toggle('hidden', notesTab !== 'notes')
  $('shownotes-text').classList.toggle('hidden', notesTab !== 'text')

  // Text
  const textEl = $('shownotes-text')
  textEl.replaceChildren()
  for (const para of d.text.split(/\n{2,}/)) {
    if (para.trim()) textEl.append(h('p', undefined, para.trim()))
  }
  if (!textEl.firstChild) textEl.append(h('p', 'muted', 'This digest has no text.'))

  // Notes
  const list = $('shownotes-notes')
  if (d.notes === undefined) {
    list.replaceChildren(h('p', 'state-note', 'Loading the show notes…'))
    void fetchFull(d)
    return
  }
  if (d.notes.length === 0) {
    list.replaceChildren(h('p', 'state-note', 'This digest did not record the notes it was written from.'))
    return
  }
  drawNotes(d)
  const pubkeys = notePubkeys(d.notes)
  void loadProfiles(pubkeys, backend.relays()).then((map) => {
    // Still looking at the same digest? Then names and pictures can appear.
    if (selectedId === d.id && notesOpen && map.size > 0) drawNotes(d)
  })
}

function drawNotes(d: DigestRecord): void {
  const notes = d.notes ?? []
  const profiles = knownProfiles(notePubkeys(notes))
  const options = backend.renderOptions(profiles)
  const list = $('shownotes-notes')
  const y = window.scrollY
  renderFeed(notes.map(toScoredPost) as never, list, options)
  if (window.scrollY !== y) window.scrollTo({ top: y })
}

const fetching = new Set<string>()

async function fetchFull(d: DigestRecord): Promise<void> {
  if (fetching.has(d.id)) return
  fetching.add(d.id)
  try {
    const full = backend.loadFull ? await backend.loadFull(d) : null
    const next = full ?? { ...d, notes: d.notes ?? [] }
    digests = digests.map((x) => (x.id === d.id ? { ...x, notes: next.notes ?? [] } : x))
    rememberSnapshots(next.profiles)
  } catch {
    const list = $('shownotes-notes')
    if (selectedId === d.id) {
      list.replaceChildren(h('p', 'state-note is-error', 'The show notes could not be loaded. Check your connection and open this digest again.'))
    }
    return
  } finally {
    fetching.delete(d.id)
  }
  if (selectedId === d.id) {
    lastShell = ''
    renderList()
    renderShowNotes()
    paint(player.current)
  }
}

// ─── actions ─────────────────────────────────────────────────────────────────

async function runMake(): Promise<void> {
  if (makeBusy) return
  const finishActivity = beginActivity('digest generation')
  setMakeBusy(true)
  setMakeStatus('')
  try {
    await backend.make()
  } catch (err) {
    setMakeStatus((err as Error).message, true)
  } finally {
    finishActivity()
    setMakeBusy(false)
  }
}

async function onAudioButton(): Promise<void> {
  const d = selected()
  if (!d) return
  const made = madeAudio.get(d.id)
  const btn = $<HTMLButtonElement>('btn-audio')
  if (made) {
    const a = document.createElement('a')
    a.href = made.url
    a.download = made.filename
    a.click()
    return
  }
  if (!backend.makeAudio) return
  const finishActivity = beginActivity('audio generation')
  btn.disabled = true
  const label = btn.textContent
  btn.textContent = 'Making audio…'
  try {
    madeAudio.set(d.id, await backend.makeAudio(d))
    // Same digest, now with a real audio file: swap the source under the player.
    player.load(null)
    selectInternal(d.id, notesOpen)
    lastShell = ''
    renderAll()
  } catch (err) {
    $('player-hint').textContent = `Audio failed: ${(err as Error).message}`
    $('player-hint').classList.add('is-error')
    btn.textContent = label
  } finally {
    finishActivity()
    btn.disabled = false
  }
}
