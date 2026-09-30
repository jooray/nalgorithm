/**
 * Nalgorithm Web — profile metadata for show notes
 *
 * The Feed gets profiles with its posts. Show notes are stored without them
 * (hosted) or with a small snapshot (bring your own key), so the names and
 * pictures are looked up here the same way the Feed does it: kind 0 events
 * from the reader's relays, through the library's fetcher. Profiles are public
 * Nostr data. Everything found is remembered for the session.
 */

import { createFetcher, type ProfileData } from 'nalgorithm'
import type { ProfileSnapshot } from './digest-model.js'

const cache = new Map<string, ProfileData>()
const tried = new Set<string>()

/** Remember profiles the Feed already has, so show notes do not look them up again. */
export function rememberProfiles(profiles: Map<string, ProfileData>): void {
  for (const [pk, p] of profiles) cache.set(pk, p)
}

/** Remember a stored snapshot without overriding a fresher profile. */
export function rememberSnapshots(snapshots: Record<string, ProfileSnapshot> | undefined): void {
  if (!snapshots) return
  for (const [pubkey, s] of Object.entries(snapshots)) {
    if (!cache.has(pubkey)) cache.set(pubkey, { pubkey, ...s })
  }
}

/** What is known right now for these people. */
export function knownProfiles(pubkeys: string[]): Map<string, ProfileData> {
  const out = new Map<string, ProfileData>()
  for (const pk of pubkeys) {
    const p = cache.get(pk)
    if (p) out.set(pk, p)
  }
  return out
}

/**
 * Look up the people not yet known. Resolves with everything known afterwards.
 * Each person is tried once per session; a failed relay leaves them unresolved.
 */
export async function loadProfiles(pubkeys: string[], relays: string[]): Promise<Map<string, ProfileData>> {
  const missing = pubkeys.filter((pk) => !cache.has(pk) && !tried.has(pk))
  if (missing.length > 0 && relays.length > 0) {
    for (const pk of missing) tried.add(pk)
    const fetcher = createFetcher({ relays })
    try {
      rememberProfiles(await fetcher.getProfiles(missing))
    } catch {
      // Names stay as npubs; the notes themselves come from the stored snapshot.
    } finally {
      fetcher.destroy()
    }
  }
  return knownProfiles(pubkeys)
}

/** The snapshot to store alongside a local digest. */
export function snapshotOf(profiles: Map<string, ProfileData>): Map<string, ProfileSnapshot> {
  return new Map([...profiles].map(([pk, p]) => [pk, { name: p.name, picture: p.picture, nip05: p.nip05 }]))
}
