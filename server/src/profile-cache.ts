import type { ProfileData } from 'nalgorithm'
import { upsert } from './database.js'
import type { Db } from './db.js'

/** A found profile is reused this long before it is asked for again. */
export const PROFILE_TTL_SECONDS = 7 * 86_400
/** A failed lookup is remembered this long, so dead pubkeys do not hit relays every run. */
export const PROFILE_MISSING_TTL_SECONDS = 600

const CHUNK = 500

interface Row {
  pubkey: string
  name: string | null
  picture: string | null
  nip05: string | null
  missing: number
  fetched_at: number
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

function rowToProfile(r: Row): ProfileData {
  return {
    pubkey: r.pubkey,
    name: r.name ?? undefined,
    picture: r.picture ?? undefined,
    nip05: r.nip05 ?? undefined,
  }
}

/**
 * Profiles for `pubkeys`: fresh cache rows first, only the rest go to the
 * fetcher. Results are written back; pubkeys that still do not resolve are
 * remembered as missing for ten minutes. A stale row is returned when the refetch
 * fails, so a flaky relay never makes a known name disappear.
 * `onCached` gets every name the cache knows (stale ones too) before the relays are asked.
 */
export async function loadProfilesCached(
  db: Db,
  fetcher: { getProfiles(pubkeys: string[]): Promise<Map<string, ProfileData>> },
  pubkeys: string[],
  now: number = nowSec(),
  onCached?: (cached: Map<string, ProfileData>) => void
): Promise<Map<string, ProfileData>> {
  const out = new Map<string, ProfileData>()
  const unique = [...new Set(pubkeys)]
  if (unique.length === 0) {
    onCached?.(out)
    return out
  }

  const rows = new Map<string, Row>()
  try {
    for (let i = 0; i < unique.length; i += CHUNK) {
      const part = unique.slice(i, i + CHUNK)
      const found = await db.all<Row>(
        `SELECT pubkey, name, picture, nip05, missing, fetched_at FROM profiles WHERE pubkey IN (${part.map(() => '?').join(',')})`,
        part
      )
      for (const r of found) rows.set(r.pubkey, r)
    }
  } catch {
    // The cache is an optimisation; carry on without it.
  }

  const toFetch: string[] = []
  for (const pk of unique) {
    const row = rows.get(pk)
    if (row && row.missing === 0 && now - row.fetched_at < PROFILE_TTL_SECONDS) out.set(pk, rowToProfile(row))
    else if (row && row.missing === 1 && now - row.fetched_at < PROFILE_MISSING_TTL_SECONDS) continue
    else toFetch.push(pk)
  }
  if (onCached) {
    const known = new Map(out)
    for (const pk of toFetch) {
      const stale = rows.get(pk)
      if (stale && stale.missing === 0) known.set(pk, rowToProfile(stale))
    }
    onCached(known)
  }
  if (toFetch.length === 0) return out

  let fetched = new Map<string, ProfileData>()
  try {
    fetched = await fetcher.getProfiles(toFetch)
  } catch {
    // Keep going with whatever is cached.
  }

  const cols = ['pubkey', 'name', 'picture', 'nip05', 'missing', 'fetched_at']
  const sql = upsert(db, 'profiles', cols, ['pubkey'], cols.slice(1))
  for (const pk of toFetch) {
    const p = fetched.get(pk)
    const stale = rows.get(pk)
    try {
      if (p) {
        out.set(pk, p)
        await db.run(sql, [pk, p.name ?? null, p.picture ?? null, p.nip05 ?? null, 0, now])
      } else if (stale && stale.missing === 0) {
        // Stale but known: serve it, and ask again after the short TTL.
        out.set(pk, rowToProfile(stale))
        await db.run(sql, [pk, stale.name, stale.picture, stale.nip05, 0, now - PROFILE_TTL_SECONDS + PROFILE_MISSING_TTL_SECONDS])
      } else {
        await db.run(sql, [pk, null, null, null, 1, now])
      }
    } catch {
      // Cache write failed; the result above is still good.
    }
  }
  return out
}
