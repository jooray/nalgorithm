/**
 * The line for model scoring. A few runs score at once and the rest wait their
 * turn in order, so each reader's ranking finishes as soon as possible instead
 * of every run crawling through one shared model queue. Runs whose scores are
 * all cached never join it. What each reader's run is doing is kept here too,
 * so the app can say "2 rankings ahead of yours" rather than show a bare spinner.
 */

export type FeedProgress =
  | { state: 'fetching'; startedAt: number }
  | { state: 'queued'; ahead: number; startedAt: number }
  | { state: 'ranking'; scored: number; total: number; startedAt: number }

interface Waiter { npub: string; admit: () => void }

export interface ScoringLine {
  /** Waits for a turn; resolves to the function that gives it back. Rejects if `signal` aborts first. */
  enter(npub: string, signal?: AbortSignal): Promise<() => void>
  /** Marks what a reader's run is doing; null when it ends. */
  report(npub: string, progress: FeedProgress | null): void
  /** What the reader's run is doing now, with a live place in the line. */
  progress(npub: string): FeedProgress | null
}

export function createScoringLine(width: number): ScoringLine {
  let scoring = 0
  const waiting: Waiter[] = []
  const runs = new Map<string, FeedProgress>()

  const leave = (): void => {
    const next = waiting.shift()
    if (next) next.admit()
    else scoring--
  }
  /** Gives back a turn exactly once, however often it is called. */
  const turn = (): (() => void) => {
    let given = false
    return () => {
      if (given) return
      given = true
      leave()
    }
  }

  return {
    enter(npub, signal) {
      signal?.throwIfAborted()
      if (scoring < width) {
        scoring++
        return Promise.resolve(turn())
      }
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          const at = waiting.indexOf(waiter)
          if (at >= 0) waiting.splice(at, 1)
          reject(signal!.reason)
        }
        const waiter: Waiter = {
          npub,
          admit: () => {
            signal?.removeEventListener('abort', onAbort)
            resolve(turn())
          },
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiting.push(waiter)
      })
    },
    report(npub, progress) {
      if (progress) runs.set(npub, progress)
      else runs.delete(npub)
    },
    progress(npub) {
      const run = runs.get(npub)
      if (run?.state !== 'queued') return run ?? null
      const at = waiting.findIndex((w) => w.npub === npub)
      return { ...run, ahead: Math.max(0, at) }
    },
  }
}
