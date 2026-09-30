import { createHash, randomBytes } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import { insertIgnore } from './database.js'
import type { Db } from './db.js'

/** NIP-98 HTTP auth kind, reused for the login challenge. */
export const AUTH_KIND = 27235
export const CHALLENGE_TTL_SECONDS = 300
/** How far a login event's own timestamp may be from the server clock. */
export const EVENT_SKEW_SECONDS = 60
export const SESSION_TTL_SECONDS = 30 * 86_400

export class AuthError extends Error {}

const nowSec = (): number => Math.floor(Date.now() / 1000)
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Issue a single-use nonce the client must sign into its login event. */
export async function issueChallenge(db: Db, now = nowSec()): Promise<{ nonce: string; expires_at: number }> {
  await db.run('DELETE FROM nonces WHERE expires_at < ?', [now])
  const nonce = randomBytes(16).toString('hex')
  const expiresAt = now + CHALLENGE_TTL_SECONDS
  await db.run('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)', [nonce, expiresAt])
  return { nonce, expires_at: expiresAt }
}

const tagValue = (event: Event, name: string): string | undefined => event.tags.find((t) => t[0] === name)?.[1]

/**
 * Check a signed login event and return the npub (hex) that signed it.
 *
 * The event must be kind 27235, correctly signed, fresh, bound to this server's
 * login URL and to POST, and carry a nonce we issued that has not been used.
 * The nonce is consumed here whether or not later steps succeed.
 */
export async function verifyLogin(db: Db, event: unknown, expectedUrl: string, now = nowSec()): Promise<string> {
  if (!event || typeof event !== 'object') throw new AuthError('missing event')
  const raw = event as Record<string, unknown>
  if (
    typeof raw.id !== 'string' || typeof raw.pubkey !== 'string' || typeof raw.sig !== 'string' ||
    typeof raw.content !== 'string' || typeof raw.kind !== 'number' || typeof raw.created_at !== 'number' ||
    !Array.isArray(raw.tags) || !raw.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  ) {
    throw new AuthError('malformed event')
  }
  // Rebuilt from plain fields: nostr-tools remembers "already verified" on the
  // object itself, so verification must run on a fresh copy, never on whatever
  // object the caller handed in.
  const ev: Event = {
    id: raw.id,
    pubkey: raw.pubkey,
    created_at: raw.created_at,
    kind: raw.kind,
    tags: raw.tags as string[][],
    content: raw.content,
    sig: raw.sig,
  }
  if (ev.kind !== AUTH_KIND) throw new AuthError('wrong event kind')
  // verifyEvent recomputes the id and checks the Schnorr signature.
  if (!verifyEvent(ev)) throw new AuthError('bad signature')
  if (Math.abs(ev.created_at - now) > EVENT_SKEW_SECONDS) throw new AuthError('event is not fresh')
  if (tagValue(ev, 'u') !== expectedUrl) throw new AuthError('event is for a different URL')
  if (tagValue(ev, 'method')?.toUpperCase() !== 'POST') throw new AuthError('event is for a different method')

  const nonce = tagValue(ev, 'nonce')
  if (!nonce) throw new AuthError('missing nonce')
  // Consuming the nonce is a single DELETE: under concurrency only one caller
  // can see it delete a row, so a nonce can never be used twice.
  const row = await db.get<{ expires_at: number }>('SELECT expires_at FROM nonces WHERE nonce = ?', [nonce])
  const removed = await db.run('DELETE FROM nonces WHERE nonce = ?', [nonce])
  if (!row || removed.changes === 0 || Number(row.expires_at) < now) throw new AuthError('unknown or expired nonce')

  return ev.pubkey
}

/** Create the account if new and return a session token (shown once; only its hash is stored). */
export async function createSession(db: Db, npub: string, now = nowSec()): Promise<{ token: string; expires_at: number }> {
  await db.run(insertIgnore(db, 'accounts', ['npub', 'created_at']), [npub, now])
  const token = randomBytes(32).toString('hex')
  const expiresAt = now + SESSION_TTL_SECONDS
  await db.run('INSERT INTO sessions (token_hash, npub, created_at, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), npub, now, expiresAt])
  return { token, expires_at: expiresAt }
}

/** The npub for a session token, or null if unknown or expired. */
export async function getSession(db: Db, token: string, now = nowSec()): Promise<string | null> {
  const row = await db.get<{ npub: string; expires_at: number }>('SELECT npub, expires_at FROM sessions WHERE token_hash = ?', [sha256(token)])
  if (!row || Number(row.expires_at) < now) return null
  return row.npub
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)])
}
