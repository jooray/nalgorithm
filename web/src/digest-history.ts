/**
 * Nalgorithm Web — digest history list
 *
 * Newest first, at most `HISTORY_CAP`, each with the notes it was composed
 * from. Where the list is kept is local-data.ts; this is the pure list policy.
 */

import type { DigestRecord } from './digest-model.js'

export const HISTORY_CAP = 30

/** Insert (or replace by id), sort newest first, cap. Returns the new list. */
export function withDigest(list: DigestRecord[], digest: DigestRecord, cap = HISTORY_CAP): DigestRecord[] {
  const rest = list.filter((d) => d.id !== digest.id)
  return [digest, ...rest].sort((a, b) => b.createdAt - a.createdAt).slice(0, cap)
}
