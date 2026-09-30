/**
 * Nalgorithm Web — digest history stores
 *
 * Bring-your-own-key mode has no server, so digests written in the browser are
 * kept here: newest first, at most `HISTORY_CAP`, each with the notes it was
 * composed from. The hosted digest list is cached the same way so the Digest
 * tab opens offline. Pure (storage is passed in) so it runs under plain node.
 */

import type { DigestRecord } from './digest-model.js'
import type { KeyValueStore } from './audio-logic.js'

export const HISTORY_CAP = 30
export const HISTORY_KEY = 'nalgorithm_digest_history_v1'
export const HOSTED_CACHE_KEY = 'nalgorithm_hosted_digests_v1'

type Reader = (value: unknown) => DigestRecord | null

/** Stored digests go through `read`, so a hand-edited or old entry cannot break the list. */
export function loadHistory(store: KeyValueStore | null, read: Reader, key = HISTORY_KEY): DigestRecord[] {
  try {
    const raw = store?.getItem(key)
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (!Array.isArray(data)) return []
    return data.map(read).filter((d): d is DigestRecord => d !== null)
  } catch {
    return []
  }
}

/** Insert (or replace by id), sort newest first, cap. Returns the new list. */
export function withDigest(list: DigestRecord[], digest: DigestRecord, cap = HISTORY_CAP): DigestRecord[] {
  const rest = list.filter((d) => d.id !== digest.id)
  return [digest, ...rest].sort((a, b) => b.createdAt - a.createdAt).slice(0, cap)
}

/**
 * Save the list. If storage is full, drop the oldest entries one at a time
 * until it fits, so the newest digest is the last thing to go.
 */
export function saveHistory(store: KeyValueStore | null, list: DigestRecord[], key = HISTORY_KEY): DigestRecord[] {
  if (!store) return list
  let kept = list
  for (;;) {
    try {
      store.setItem(key, JSON.stringify(kept))
      return kept
    } catch {
      if (kept.length <= 1) return kept
      kept = kept.slice(0, -1)
    }
  }
}

export function addToHistory(store: KeyValueStore | null, read: Reader, digest: DigestRecord, key = HISTORY_KEY): DigestRecord[] {
  return saveHistory(store, withDigest(loadHistory(store, read, key), digest), key)
}
