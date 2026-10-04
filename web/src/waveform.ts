/**
 * Nalgorithm Web — waveform progress bar
 *
 * A row of bars drawn on a canvas from a fixed pseudo-random pattern. The part
 * already played is full strength, the rest 30%. It is also the seek control:
 * tap or drag, or use the arrow keys, Home and End when focused.
 *
 * Colours come from the `--wave-on` and `--wave-off` custom properties, so the
 * theme owns them.
 */

import { fractionFromPointer, waveformBars } from './audio-logic.js'

const PATTERN = waveformBars(180)
const BAR_W = 3
const GAP = 3

export interface WaveformHandlers {
  /** Live while dragging, for the elapsed label. */
  onScrub: (fraction: number) => void
  /** Pointer released, or a key pressed: seek here. */
  onCommit: (fraction: number) => void
  /** Keyboard step request in seconds (negative back). */
  onStep: (seconds: number) => void
}

export class Waveform {
  private readonly canvas: HTMLCanvasElement
  private fraction = 0
  private scrubbing = false
  private enabled = true
  private bounds: { w: number; h: number } | null = null
  private colors: { on: string; off: string } | null = null

  constructor(private readonly host: HTMLElement, private readonly handlers: WaveformHandlers) {
    this.canvas = host.querySelector('canvas') as HTMLCanvasElement

    host.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return
      this.scrubbing = true
      host.setPointerCapture(e.pointerId)
      this.scrubTo(e)
    })
    host.addEventListener('pointermove', (e) => {
      if (this.scrubbing) this.scrubTo(e)
    })
    const end = (e: PointerEvent): void => {
      if (!this.scrubbing) return
      this.scrubbing = false
      handlers.onCommit(this.fractionAt(e))
    }
    host.addEventListener('pointerup', end)
    host.addEventListener('pointercancel', () => {
      this.scrubbing = false
    })

    host.addEventListener('keydown', (e) => {
      if (!this.enabled) return
      const step: Record<string, number> = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 }
      if (e.key in step) {
        e.preventDefault()
        handlers.onStep(step[e.key])
      } else if (e.key === 'Home') {
        e.preventDefault()
        handlers.onCommit(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        handlers.onCommit(1)
      }
    })

    new ResizeObserver(() => { this.bounds = null; this.draw() }).observe(host)
    // The theme can change under us.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.colors = null; this.draw() })
  }

  get isScrubbing(): boolean {
    return this.scrubbing
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.host.classList.toggle('is-disabled', !on)
    this.host.tabIndex = on ? 0 : -1
  }

  /** Progress in 0..1. Ignored while the finger is on the bar. */
  setProgress(fraction: number): void {
    if (this.scrubbing) return
    const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
    if (f === this.fraction) return
    this.fraction = f
    this.draw()
  }

  private fractionAt(e: PointerEvent): number {
    const r = this.host.getBoundingClientRect()
    return fractionFromPointer(e.clientX, r.left, r.width)
  }

  private scrubTo(e: PointerEvent): void {
    this.fraction = this.fractionAt(e)
    this.draw()
    this.handlers.onScrub(this.fraction)
  }

  draw(): void {
    const { w, h } = this.bounds ??= { w: this.host.clientWidth, h: this.host.clientHeight }
    if (w === 0 || h === 0) return
    const dpr = window.devicePixelRatio || 1
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr)
      this.canvas.height = Math.round(h * dpr)
    }
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    if (!this.colors) {
      const style = getComputedStyle(this.host)
      this.colors = { on: style.getPropertyValue('--wave-on').trim() || '#fff', off: style.getPropertyValue('--wave-off').trim() || 'rgba(255,255,255,0.3)' }
    }
    const { on, off } = this.colors

    const count = Math.max(1, Math.floor((w + GAP) / (BAR_W + GAP)))
    const span = count * BAR_W + (count - 1) * GAP
    const x0 = (w - span) / 2
    const mid = h / 2
    for (let i = 0; i < count; i++) {
      const bar = PATTERN[Math.floor((i / count) * PATTERN.length)]
      const bh = Math.max(4, bar * h)
      const x = x0 + i * (BAR_W + GAP)
      ctx.fillStyle = (i + 0.5) / count <= this.fraction ? on : off
      ctx.beginPath()
      ctx.roundRect(x, mid - bh / 2, BAR_W, bh, BAR_W / 2)
      ctx.fill()
    }
  }
}
