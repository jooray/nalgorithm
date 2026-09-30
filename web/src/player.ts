/**
 * Nalgorithm Web — digest player engine
 *
 * One player for the whole app. Two sources behind one interface:
 *
 *  - audio: the digest's audio link, through an <audio> element (background
 *    play, lock-screen controls and exact seeking all come from the platform);
 *  - speech: the browser's own speech engine reading the digest text. There
 *    is no audio to seek in, so position is tracked per spoken chunk and a
 *    seek restarts from the chunk that contains the target. Speed is the
 *    speech rate. Its duration is an estimate from the word count.
 *
 * Nothing ever plays by itself: no autoplay, no sound cues. `play()` is only
 * called from a press on the play button or a media key.
 */

import {
  ResumeStore,
  clampSeek,
  loadSpeed,
  loadVoiceName,
  normalizeSpeed,
  saveSpeed,
  type KeyValueStore,
} from './audio-logic.js'
import { estimateSeconds } from './digest-model.js'
import { isSpeechSupported, speak, splitForSpeech, type SpeechSession } from './speech.js'

export interface PlayerSource {
  /** Stable key for resume and played marks: the audio URL, else the digest id. */
  key: string
  title: string
  /** Shown as album / subtitle, e.g. the date. */
  subtitle: string
  audioUrl: string | null
  text: string
}

export interface PlayerState {
  source: PlayerSource | null
  mode: 'audio' | 'speech' | 'none'
  playing: boolean
  /** Seconds. */
  pos: number
  /** Seconds; an estimate when `durApprox`. */
  dur: number
  durApprox: boolean
  speed: number
  /** Audio is being fetched (metadata or after a seek). */
  loading: boolean
  error: string
  /** Where playback would resume from (0 when nothing to resume). */
  resumeAt: number
  played: boolean
}

const SAVE_EVERY_MS = 5000
const BACK_SECONDS = 15
const FORWARD_SECONDS = 30

export function safeStorage(): KeyValueStore | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export class DigestPlayer {
  private readonly audio = new Audio()
  private readonly resume: ResumeStore
  private readonly store: KeyValueStore | null
  private session: SpeechSession | null = null
  private saveTimer: number | undefined
  private listener: (s: PlayerState) => void = () => {}
  private speechChunks: string[] = []
  private speechStart = 0
  private pendingSeek: number | null = null
  private state: PlayerState

  constructor(store: KeyValueStore | null = safeStorage()) {
    this.store = store
    this.resume = new ResumeStore(store)
    this.state = this.blank()

    // Metadata only: no bytes of the digest are fetched until play is pressed.
    this.audio.preload = 'none'
    const a = this.audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }
    a.preservesPitch = true
    a.webkitPreservesPitch = true

    this.audio.addEventListener('loadedmetadata', () => {
      const dur = Number.isFinite(this.audio.duration) ? this.audio.duration : 0
      if (this.state.source && dur > 0) this.resume.saveDuration(this.state.source.key, dur)
      if (this.pendingSeek !== null) {
        this.audio.currentTime = Math.min(this.pendingSeek, dur || this.pendingSeek)
        this.pendingSeek = null
      }
      this.set({ dur, durApprox: false, loading: false, pos: this.audio.currentTime })
      this.updatePositionState()
    })
    // A streamed MP3 without a length header reports a first guess from its bitrate and
    // corrects it while it plays (a 3 min 25 s guess for a 3 min 47 s digest). Follow it.
    this.audio.addEventListener('durationchange', () => {
      const dur = this.audio.duration
      if (!Number.isFinite(dur) || dur <= 0 || this.state.mode !== 'audio') return
      if (this.state.source) this.resume.saveDuration(this.state.source.key, dur)
      this.set({ dur, durApprox: false })
      this.updatePositionState()
    })
    this.audio.addEventListener('timeupdate', () => {
      // Never let the position run past the length we are showing.
      const pos = this.audio.currentTime
      if (this.state.mode === 'audio' && this.state.dur > 0 && pos > this.state.dur) this.set({ dur: pos })
      this.set({ pos })
    })
    this.audio.addEventListener('playing', () => this.set({ playing: true, loading: false, error: '' }))
    this.audio.addEventListener('pause', () => {
      if (!this.audio.ended) this.set({ playing: false })
      this.persist()
    })
    this.audio.addEventListener('waiting', () => this.set({ loading: true }))
    this.audio.addEventListener('canplay', () => this.set({ loading: false }))
    this.audio.addEventListener('ended', () => this.finish())
    this.audio.addEventListener('error', () => {
      this.set({
        playing: false,
        loading: false,
        error: 'This audio could not be loaded. Check your connection, then press play to try again.',
      })
    })

    // Backgrounded or closed: keep the place.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.persist()
    })
    window.addEventListener('pagehide', () => this.persist())

    this.installMediaSession()
  }

  onChange(fn: (s: PlayerState) => void): void {
    this.listener = fn
    fn(this.state)
  }

  get current(): PlayerState {
    return this.state
  }

  /** Select a digest. Stops whatever was playing; never starts playback. */
  load(source: PlayerSource | null): void {
    if (this.state.source?.key === source?.key) {
      // Same digest: only the text may have changed (streaming finished).
      if (source) this.state.source = source
      return
    }
    this.persist()
    this.stopOutput()
    this.pendingSeek = null
    if (!source) {
      this.state = this.blank()
      this.emit()
      return
    }

    const speed = loadSpeed(this.store)
    const resumeAt = this.resume.resumeAt(source.key)
    const knownDur = this.resume.durationOf(source.key)
    const usesAudio = Boolean(source.audioUrl)
    const speechOk = isSpeechSupported() && source.text.trim().length > 0

    this.state = {
      source,
      mode: usesAudio ? 'audio' : speechOk ? 'speech' : 'none',
      playing: false,
      pos: resumeAt,
      dur: knownDur || estimateSeconds(source.text),
      durApprox: !knownDur,
      speed,
      loading: false,
      error: usesAudio || speechOk ? '' : 'This digest has no audio, and this browser cannot read it aloud.',
      resumeAt,
      played: this.resume.isPlayed(source.key),
    }

    if (usesAudio) {
      this.audio.src = source.audioUrl!
      this.audio.preload = 'metadata'
      this.audio.playbackRate = speed
      this.audio.load()
      if (resumeAt > 0) this.pendingSeek = resumeAt
    } else {
      this.speechChunks = speechOk ? splitForSpeech(source.text) : []
    }
    this.emit()
    this.updateMetadata()
  }

  play(): void {
    const s = this.state
    if (!s.source || s.mode === 'none') return
    if (s.mode === 'audio') {
      this.audio.playbackRate = s.speed
      if (this.pendingSeek !== null && this.audio.readyState >= 1) {
        this.audio.currentTime = this.pendingSeek
        this.pendingSeek = null
      }
      this.set({ loading: true, error: '' })
      void this.audio.play().catch(() => {
        this.set({
          playing: false,
          loading: false,
          error: 'Playback was blocked or the audio could not be loaded. Press play to try again.',
        })
      })
    } else {
      this.startSpeech(this.state.pos >= this.state.dur - 1 ? 0 : this.state.pos)
    }
    this.startSaving()
    this.setPlaybackState('playing')
  }

  pause(): void {
    if (this.state.mode === 'audio') this.audio.pause()
    else {
      this.session?.stop()
      this.session = null
      this.set({ playing: false })
      this.persist()
    }
    this.stopSaving()
    this.setPlaybackState('paused')
  }

  toggle(): void {
    if (this.state.playing || this.state.loading) this.pause()
    else this.play()
  }

  seek(seconds: number): void {
    const s = this.state
    if (!s.source || s.mode === 'none') return
    const target = Math.min(Math.max(0, seconds), s.dur > 0 ? s.dur : Math.max(0, seconds))
    if (s.mode === 'audio') {
      if (this.audio.readyState >= 1) this.audio.currentTime = target
      else this.pendingSeek = target
      this.set({ pos: target })
    } else {
      this.set({ pos: target })
      if (s.playing) this.startSpeech(target)
    }
    this.persist()
    this.updatePositionState()
  }

  skip(delta: number): void {
    this.seek(clampSeek(this.state.pos, delta, this.state.dur))
  }

  setSpeed(speed: number): void {
    const v = normalizeSpeed(speed)
    saveSpeed(this.store, v)
    this.audio.playbackRate = v
    this.set({ speed: v })
    // The speech engine takes a rate per utterance: restart this chunk at the new one.
    if (this.state.mode === 'speech' && this.state.playing) this.startSpeech(this.state.pos)
    this.updatePositionState()
  }

  // ─── speech source ─────────────────────────────────────────────────────────

  private startSpeech(fromSeconds: number): void {
    const s = this.state
    if (!s.source) return
    this.session?.stop()
    const total = this.speechChunks.length
    if (total === 0) return
    const fraction = s.dur > 0 ? Math.min(0.999, Math.max(0, fromSeconds / s.dur)) : 0
    const start = Math.floor(fraction * total)
    this.speechStart = start
    this.set({ playing: true, error: '', pos: (start / total) * s.dur })
    this.session = speak(this.speechChunks.slice(start).join('\n\n'), {
      rate: s.speed,
      voiceName: loadVoiceName(this.store) || undefined,
      onProgress: (chunk) => {
        const index = Math.min(total - 1, this.speechStart + chunk - 1)
        this.set({ pos: (index / total) * this.state.dur })
      },
      onEnd: () => {
        this.session = null
        this.finish()
      },
      onError: (message) => {
        this.session = null
        this.set({ playing: false, error: message })
      },
    })
  }

  // ─── bookkeeping ───────────────────────────────────────────────────────────

  private finish(): void {
    const key = this.state.source?.key
    // The true length is known once the audio has played to its end.
    if (this.state.mode === 'audio' && Number.isFinite(this.audio.duration) && this.audio.duration > 0) this.set({ dur: this.audio.duration })
    if (key) this.resume.markPlayed(key, this.state.dur)
    this.stopSaving()
    this.set({ playing: false, pos: 0, resumeAt: 0, played: true })
    if (this.state.mode === 'audio') this.audio.currentTime = 0
    this.setPlaybackState('none')
  }

  private stopOutput(): void {
    this.stopSaving()
    this.session?.stop()
    this.session = null
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  /** Write the position to the resume store (clears it near the end). */
  private persist(): void {
    const s = this.state
    if (!s.source || s.mode === 'none') return
    this.resume.save(s.source.key, s.pos, s.durApprox ? 0 : s.dur)
    const resumeAt = this.resume.resumeAt(s.source.key)
    this.state = { ...this.state, resumeAt, played: this.resume.isPlayed(s.source.key) }
    this.emit()
  }

  private startSaving(): void {
    this.stopSaving()
    this.saveTimer = window.setInterval(() => this.persist(), SAVE_EVERY_MS)
  }

  private stopSaving(): void {
    if (this.saveTimer !== undefined) clearInterval(this.saveTimer)
    this.saveTimer = undefined
  }

  private blank(): PlayerState {
    return {
      source: null,
      mode: 'none',
      playing: false,
      pos: 0,
      dur: 0,
      durApprox: true,
      speed: loadSpeed(this.store),
      loading: false,
      error: '',
      resumeAt: 0,
      played: false,
    }
  }

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  private emit(): void {
    this.listener(this.state)
  }

  // ─── media session (lock screen and media keys) ────────────────────────────

  private installMediaSession(): void {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    const trySet = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
      try {
        ms.setActionHandler(action, handler)
      } catch {
        // This browser does not support that action.
      }
    }
    trySet('play', () => this.play())
    trySet('pause', () => this.pause())
    trySet('seekbackward', (d) => this.skip(-(d.seekOffset ?? BACK_SECONDS)))
    trySet('seekforward', (d) => this.skip(d.seekOffset ?? FORWARD_SECONDS))
    trySet('seekto', (d) => {
      if (typeof d.seekTime === 'number') this.seek(d.seekTime)
    })
  }

  private updateMetadata(): void {
    if (!('mediaSession' in navigator) || !this.state.source) return
    const icon = new URL('icon-512.png', document.baseURI).toString()
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.state.source.title,
      artist: 'nalgorithm',
      album: this.state.source.subtitle,
      artwork: [{ src: icon, sizes: '512x512', type: 'image/png' }],
    })
  }

  private setPlaybackState(state: MediaSessionPlaybackState): void {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state
  }

  private updatePositionState(): void {
    if (!('mediaSession' in navigator) || this.state.mode !== 'audio') return
    const dur = this.audio.duration
    if (!Number.isFinite(dur) || dur <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: this.state.speed,
        position: Math.min(this.audio.currentTime, dur),
      })
    } catch {
      // Not supported, or momentarily inconsistent: the next update fixes it.
    }
  }
}
