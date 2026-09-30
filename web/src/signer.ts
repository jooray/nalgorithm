/**
 * Nalgorithm Web — who is signed in, and who can sign for them
 *
 * Two separate facts:
 *
 *  - the actor: whose key this app is for (an npub in bring-your-own-key mode,
 *    the hosted session's key in hosted mode). Read-only readers have one.
 *  - the signer: something that can sign for that key right now. A NIP-07
 *    extension, or a NIP-46 remote signer (Amber) connected in this tab.
 *
 * A reader without a signer still sees every action; tapping one asks them to
 * connect a signer. The signer's key must be the actor's key: a signature from
 * another key is refused rather than published under the wrong name.
 *
 * A remote signer connection is held in memory only. Nothing that could sign
 * is written to storage, so a reload asks again.
 */

import { verifyEvent, type Event as NostrEvent, type EventTemplate } from 'nostr-tools/pure'
import { hasNip07, loginWithExtension, signWithExtension, toNpub, type SignFn } from './nostr-login.js'
import { openActionSignerDialog } from './login-ui.js'
import { loadSettings } from './settings.js'

export interface ActiveSigner {
  pubkey: string
  method: 'extension' | 'remote'
  sign: SignFn
}

let actorProvider: () => string | null = () => null
let remote: { pubkey: string; sign: SignFn; close?: () => void } | null = null

/** Each mode says how to find the signed-in key; called when an action needs it. */
export function setActorProvider(provider: () => string | null): void {
  actorProvider = provider
}

export function getActor(): string | null {
  try {
    const pk = actorProvider()
    return pk && /^[0-9a-f]{64}$/i.test(pk) ? pk.toLowerCase() : null
  } catch {
    return null
  }
}

/** A signer that is already available for `actor`, without asking the reader anything new. */
async function existingSigner(actor: string): Promise<ActiveSigner | null> {
  if (remote && remote.pubkey === actor) return { pubkey: actor, method: 'remote', sign: remote.sign }
  if (hasNip07() && typeof window.nostr?.signEvent === 'function') {
    try {
      // May show the extension's own permission prompt; the reader just tapped an action.
      const pk = await loginWithExtension()
      if (pk === actor) return { pubkey: actor, method: 'extension', sign: signWithExtension }
    } catch {
      // the extension refused to share the key: treat as no signer
    }
  }
  return null
}

export type SignerOutcome =
  | { signer: ActiveSigner }
  | { signer: null; reason: 'none' | 'cancelled' | 'other-key'; otherNpub?: string }

/** A signer for the actor if one is ready. Never opens a dialog. */
export async function findSigner(): Promise<ActiveSigner | null> {
  const actor = getActor()
  return actor ? existingSigner(actor) : null
}

/** Open the connect-a-signer dialog and keep the result if it is the actor's key. */
export async function connectSigner(): Promise<SignerOutcome> {
  const actor = getActor()
  const result = await openActionSignerDialog(loadSettings().signerRelays)
  if (!result?.sign) return { signer: null, reason: 'cancelled' }
  if (actor && result.pubkey !== actor) {
    result.close?.()
    return { signer: null, reason: 'other-key', otherNpub: toNpub(result.pubkey) }
  }
  remote?.close?.()
  remote = { pubkey: result.pubkey, sign: result.sign, close: result.close }
  return { signer: { pubkey: result.pubkey, method: 'remote', sign: result.sign } }
}

/**
 * Sign `template` with `signer` and check the result before it goes anywhere:
 * a valid signature by the actor's key. Throws a readable error otherwise.
 */
export async function signChecked(signer: ActiveSigner, template: EventTemplate): Promise<NostrEvent> {
  let event: NostrEvent
  try {
    event = await signer.sign(template)
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    throw new Error(/reject|denied|declin|cancel/i.test(text) ? 'Your signer declined the request.' : `Your signer could not sign: ${text}`)
  }
  if (event.pubkey !== signer.pubkey) throw new Error('Your signer signed with a different key than the one you are signed in as.')
  if (!verifyEvent(event)) throw new Error('Your signer returned an event with an invalid signature.')
  return event
}
