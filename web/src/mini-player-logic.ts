/**
 * Nalgorithm Web — what the mini player on the Feed tab shows (pure)
 *
 * The mini player is not an audio player. It shows the latest digest (or the one being
 * written) and sends the reader to the Digests tab, where the one real player lives.
 * No imports, so it can be tested on its own: the caller passes the formatted bits.
 */

export interface MiniLatest {
  /** "Today, 7:30", already formatted for the reader. */
  when: string
  /** The same length label the hero and the list show, "about" rule included. */
  length: string
  /** This digest is the one in the main player and it is playing or loading. */
  playing: boolean
  /** Where playback is now (playing) or would resume from (not playing); 0 for none. */
  pos: number
  dur: number
  /** "Resume at 1:23", or null when there is nothing to resume. */
  resumeHint: string | null
}

export interface MiniInput {
  running: boolean
  elapsedSeconds: number
  latest: MiniLatest | null
}

export type MiniView =
  | { kind: 'none' }
  | { kind: 'running'; title: string }
  | {
      kind: 'ready'
      title: string
      meta: string
      hint: string | null
      /** 0 to 1, or null when there is neither playback nor a resume position. */
      progress: number | null
      playing: boolean
      buttonLabel: string
      openLabel: string
    }

export function miniClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function miniView(i: MiniInput): MiniView {
  const l = i.latest
  // A digest that is playing keeps its controls even while the next one is written.
  if (i.running && !l?.playing) return { kind: 'running', title: `Writing your digest… ${miniClock(i.elapsedSeconds)}` }
  if (!l) return { kind: 'none' }
  const progress = l.dur > 0 && (l.playing || l.pos > 0) ? Math.min(1, Math.max(0, l.pos / l.dur)) : null
  return {
    kind: 'ready',
    title: 'Your morning',
    meta: `${l.when} · ${l.length}`,
    hint: l.playing ? null : l.resumeHint,
    progress,
    playing: l.playing,
    buttonLabel: l.playing ? 'Pause your morning digest' : `Play your morning digest from ${l.when}`,
    openLabel: 'Open your digests',
  }
}

/** Scroll position after a bar of `barHeight` is inserted above content that a reader has scrolled. */
export function scrollAfterInsert(scrollY: number, barHeight: number, threshold = 4): number {
  return scrollY > threshold ? scrollY + barHeight : scrollY
}
