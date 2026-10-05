/**
 * Nalgorithm Web — personal records on this device
 *
 * Feed snapshots and digest histories live in IndexedDB, one record per mode
 * and canonical identity, so a large history never blocks the main thread and
 * one account never reads another's. Small preferences stay in storage.ts.
 *
 * Older builds kept these in localStorage under mode-global keys. They move
 * here the first time they are read, and the old key goes only after the new
 * record is safely written.
 */

import { pubkeyToHex } from 'nalgorithm'
import type { DigestRecord } from './digest-model.js'
import { withDigest } from './digest-history.js'
import { trimLocalSnapshot, validSnapshot, type LocalSnapshot, type StoredPost } from './snapshot-logic.js'
import { deleteRecord, getRecord, listRecords, putRecord } from './records.js'
import { deviceStorage } from './storage.js'

export type DataMode = 'byok' | 'hosted'

/** Feed snapshots kept per mode: the current identity plus a couple of recent ones. */
const FEED_IDENTITIES = 3

const LEGACY_HISTORY: Record<DataMode, string> = {
  byok: 'nalgorithm_digest_history_v1',
  hosted: 'nalgorithm_hosted_digests_v1',
}
const LEGACY_FEED: Record<DataMode, string> = {
  byok: 'nalgorithm_byok_feed_',
  hosted: 'nalgorithm_hosted_feed_',
}

/** The hex key, or null for something that is not an identity (nothing is stored for it). */
export function identityKey(identity: string): string | null {
  try {
    return pubkeyToHex(identity.trim())
  } catch {
    return null
  }
}

/** Strictly increasing write times, so "newest identity" is well defined within a millisecond. */
let lastAt = 0
const stamp = (): number => (lastAt = Math.max(Date.now(), lastAt + 1))

const historyKey = (mode: DataMode, hex: string): string => `history:${mode}:${hex}`
const feedKey = (mode: DataMode, hex: string): string => `feed:${mode}:${hex}`

function takeLegacy(key: string): unknown {
  try {
    const raw = deviceStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function dropLegacy(key: string): void {
  try {
    deviceStorage.removeItem(key)
  } catch {
    // Nothing more to do; the record is already in IndexedDB.
  }
}

/** Whether a mode-global legacy history may be adopted by this identity. */
export type LegacyOwner = (mode: DataMode) => string | null

/** By default, a legacy BYOK history belongs to the identity it was written for: the configured one. */
let legacyOwner: LegacyOwner = () => null
export function setLegacyOwner(owner: LegacyOwner): void {
  legacyOwner = owner
}

// ─── digest history ──────────────────────────────────────────────────────────

export async function loadDigestHistory(
  mode: DataMode,
  identity: string,
  read: (value: unknown) => DigestRecord | null
): Promise<DigestRecord[]> {
  const hex = identityKey(identity)
  if (!hex) return []
  const stored = await getRecord<unknown[]>(historyKey(mode, hex))
  if (Array.isArray(stored)) return stored.map(read).filter((d): d is DigestRecord => d !== null)
  const owner = legacyOwner(mode)
  if (!owner || identityKey(owner) !== hex) return []
  const legacy = takeLegacy(LEGACY_HISTORY[mode])
  if (!Array.isArray(legacy)) return []
  const list = legacy.map(read).filter((d): d is DigestRecord => d !== null)
  if (await putRecord(historyKey(mode, hex), list)) dropLegacy(LEGACY_HISTORY[mode])
  return list
}

/** False when the device could not keep it durably (it is still held for this session). */
export async function saveDigestHistory(mode: DataMode, identity: string, list: DigestRecord[]): Promise<boolean> {
  const hex = identityKey(identity)
  if (!hex) return false
  return putRecord(historyKey(mode, hex), list)
}

/** Writes are serialised per identity, so two digests finishing together both survive. */
const historyWrites = new Map<string, Promise<unknown>>()
export function addDigestToHistory(
  mode: DataMode,
  identity: string,
  read: (value: unknown) => DigestRecord | null,
  digest: DigestRecord
): Promise<boolean> {
  const key = `${mode}:${identityKey(identity)}`
  const run = (historyWrites.get(key) ?? Promise.resolve()).then(async () =>
    saveDigestHistory(mode, identity, withDigest(await loadDigestHistory(mode, identity, read), digest))
  )
  historyWrites.set(key, run.catch(() => undefined))
  return run
}

// ─── feed snapshot ───────────────────────────────────────────────────────────

export async function loadFeedSnapshot(mode: DataMode, identity: string): Promise<LocalSnapshot | null> {
  const hex = identityKey(identity)
  if (!hex) return null
  const stored = await getRecord<unknown>(feedKey(mode, hex))
  if (validSnapshot(stored)) return stored
  // Legacy keys were written with whatever spelling the reader typed.
  for (const spelling of new Set([identity.trim(), hex])) {
    const legacy = takeLegacy(LEGACY_FEED[mode] + spelling)
    if (!validSnapshot(legacy)) continue
    if (await putRecord(feedKey(mode, hex), legacy, stamp())) dropLegacy(LEGACY_FEED[mode] + spelling)
    return legacy
  }
  return null
}

export async function saveFeedSnapshot(
  mode: DataMode,
  identity: string,
  snap: LocalSnapshot,
  collectKeep?: (posts: StoredPost[]) => Set<string>
): Promise<boolean> {
  const hex = identityKey(identity)
  if (!hex) return false
  const saved = await putRecord(feedKey(mode, hex), trimLocalSnapshot(snap, undefined, undefined, collectKeep), stamp())
  // Keep only a few identities' feeds, newest first.
  const all = (await listRecords<LocalSnapshot>(`feed:${mode}:`)).sort((a, b) => b.at - a.at)
  for (const old of all.slice(FEED_IDENTITIES)) await deleteRecord(old.key)
  return saved
}

// ─── wiping ──────────────────────────────────────────────────────────────────

/** Everything personal this device keeps for one identity in one mode. */
export async function clearIdentityData(mode: DataMode, identity: string): Promise<void> {
  const hex = identityKey(identity)
  if (!hex) return
  await deleteRecord(historyKey(mode, hex))
  await deleteRecord(feedKey(mode, hex))
  dropLegacy(LEGACY_FEED[mode] + identity.trim())
  dropLegacy(LEGACY_FEED[mode] + hex)
}

/** Legacy mode-global copies, which no longer belong to a known identity. */
export function clearLegacyHistory(mode: DataMode): void {
  dropLegacy(LEGACY_HISTORY[mode])
}
