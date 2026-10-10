package today.cypherpunk.nalgorithm.nostr

import kotlinx.coroutines.flow.Flow
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nostrsignin.UnsignedEvent

/**
 * Something that signs as the reader: a NIP-55 app on this phone (Amber), a
 * NIP-46 remote signer, or (tests) a local key. Read-only identities have none.
 */
interface NostrSigner {
    /** Hex pubkey this signer signs as. */
    val pubkey: String
    /** "Amber", "Remote signer"… for the UI. */
    val label: String
    suspend fun sign(event: UnsignedEvent): NostrEvent
    fun close() {}
}

/** A NIP-01 REQ filter. Null fields are omitted on the wire. */
data class Filter(
    val ids: List<String>? = null,
    val authors: List<String>? = null,
    val kinds: List<Int>? = null,
    val e: List<String>? = null,
    val p: List<String>? = null,
    val since: Long? = null,
    val until: Long? = null,
    val limit: Int? = null,
    /** Other single-letter tag filters, keyed without '#'. */
    val tags: Map<String, List<String>> = emptyMap(),
)

/** Why a signer is being asked for: changes what the sign-in panel offers and which kinds it pre-approves. */
enum class SignInPurpose {
    /** Hosted sign-in / sign-up: must sign the kind-27235 login event; npub paste is not offered. */
    HostedLogin,
    /** BYOK identity: a pubkey is enough; npub paste and read-only are offered. */
    ByokIdentity,
    /** A note action needs a signer for the identity already known. */
    Actions,
}

data class SignInResult(val pubkey: String, val signer: NostrSigner?)

interface RelayPoolApi {
    /** EOSE-or-timeout query across [relays]; duplicate events are merged. */
    suspend fun query(relays: List<String>, filters: List<Filter>, timeoutMs: Long = 8_000): List<NostrEvent>
    suspend fun get(relays: List<String>, filter: Filter, timeoutMs: Long = 6_000): NostrEvent?
    /** Publish to every relay; returns relay → accepted (OK true). */
    suspend fun publish(relays: List<String>, event: NostrEvent, timeoutMs: Long = 8_000): Map<String, Boolean>
    /** Live subscription until the flow's collector is cancelled. */
    fun subscribe(relays: List<String>, filters: List<Filter>): Flow<NostrEvent>
}
