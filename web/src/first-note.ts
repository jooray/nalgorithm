/**
 * Nalgorithm Web — the one-time note under the first ranking
 *
 * Shown once per identity, the first time a ranked feed is on screen: what the
 * ranking is measured against and where to see or steer it. BYOK adds a way to
 * try a digest; hosted writes the first one by itself.
 */

import { deviceStorage } from './storage.js'
import { identityKey } from './local-data.js'
import { showTab } from './shell.js'

const keyOf = (identity: string): string => `nalgorithm_first_rank_note_${identityKey(identity) ?? 'setup'}`
let wired = false

export function maybeShowFirstRankNote(identity: string, rankedCount: number): void {
  const box = document.getElementById('first-rank-note')
  if (!box || !identity || rankedCount === 0) return
  if (!wired) {
    wired = true
    const done = (): void => {
      box.classList.add('hidden')
      deviceStorage.setItem(box.dataset.key ?? '', 'seen')
    }
    document.getElementById('btn-first-note-ok')?.addEventListener('click', done)
    document.getElementById('btn-first-digest')?.addEventListener('click', () => {
      done()
      showTab('digest')
    })
  }
  const key = keyOf(identity)
  if (deviceStorage.getItem(key)) {
    box.classList.add('hidden')
    return
  }
  box.dataset.key = key
  box.classList.remove('hidden')
}
