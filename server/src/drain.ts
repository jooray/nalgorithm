/** Thrown by `begin` once shutdown has started: no new feed runs or digests. */
export class ShuttingDown extends Error {
  constructor() {
    super('the server is restarting, try again in a minute')
  }
}

export interface JobTracker {
  /** Register a unit of work. Returns the function that marks it finished. Throws `ShuttingDown` after `stop`. */
  begin(): () => void
  /** Refuse new work from now on. */
  stop(): void
  readonly stopping: boolean
  readonly active: number
  /** Resolves true when nothing is running, false when `timeoutMs` passes first. */
  drain(timeoutMs: number): Promise<boolean>
}

/**
 * Counts in-flight feed runs and digest generations, so a restart can let them
 * finish instead of killing a run that is already paid for.
 */
export function createJobTracker(): JobTracker {
  let stopping = false
  let active = 0
  let waiters: Array<() => void> = []

  const settle = (): void => {
    if (active > 0) return
    const ready = waiters
    waiters = []
    for (const w of ready) w()
  }

  return {
    begin() {
      if (stopping) throw new ShuttingDown()
      active++
      let done = false
      return () => {
        if (done) return
        done = true
        active--
        settle()
      }
    },
    stop() {
      stopping = true
    },
    get stopping() {
      return stopping
    },
    get active() {
      return active
    },
    drain(timeoutMs) {
      if (active === 0) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== onDone)
          resolve(false)
        }, timeoutMs)
        const onDone = (): void => {
          clearTimeout(timer)
          resolve(true)
        }
        waiters.push(onDone)
      })
    },
  }
}
