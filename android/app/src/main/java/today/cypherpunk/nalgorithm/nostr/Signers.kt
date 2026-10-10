package today.cypherpunk.nalgorithm.nostr

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import today.cypherpunk.nalgorithm.model.NostrEvent
import today.cypherpunk.nostrsignin.AndroidSignerGateway
import today.cypherpunk.nostrsignin.Nip55
import today.cypherpunk.nostrsignin.UnsignedEvent
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** A NIP-55 signer app on this phone (Amber…): content provider first, intent through the bridge otherwise. */
class Nip55Signer(
    override val pubkey: String,
    val packageName: String,
    override val label: String,
    private val gateway: AndroidSignerGateway,
) : NostrSigner {
    override suspend fun sign(event: UnsignedEvent): NostrEvent {
        require(event.pubkey == pubkey) { "This signer signs for another key." }
        return when (val reply = gateway.signEvent(packageName, event)) {
            is Nip55.Reply.Signed -> parseEvent(relayJson.parseToJsonElement(reply.eventJson))
                ?: throw IllegalStateException("The signer did not return a signature.")
            Nip55.Reply.Rejected -> throw SignerRpcException("The signer rejected the request.")
            else -> throw IllegalStateException("The signer did not return a signature.")
        }
    }
}

/**
 * A NIP-46 remote signer connection. [onError] decides what a failure means
 * for the saved connection (a refusal keeps it; a timeout or revocation drops it).
 */
class RemoteSigner(
    override val pubkey: String,
    val session: RemoteSignerSession,
    private val onError: (String) -> Unit = {},
) : NostrSigner {
    override val label: String = "Remote signer"

    override suspend fun sign(event: UnsignedEvent): NostrEvent {
        require(event.pubkey == pubkey) { "This signer signs for another key." }
        return try {
            session.signEvent(event)
        } catch (e: Exception) {
            onError(e.message ?: e.toString())
            throw e
        }
    }

    fun saved(): SavedRemoteSigner = session.saved(pubkey)

    override fun close() = session.close()
}

/** A signer holding the key itself. Only for tests and tooling; the app never holds a reader's key. */
class LocalSigner(private val secret: ByteArray, override val label: String = "Local key") : NostrSigner {
    override val pubkey: String = Keys.publicHex(secret)
    override suspend fun sign(event: UnsignedEvent): NostrEvent = signLocal(event, secret)
}

/** A signing failure worded for the reader (web: signer.ts signChecked). */
class SignFailure(message: String) : Exception(message)

/**
 * Sign [template] as [signer] and check the result before it goes anywhere: a
 * valid signature by the signer's key. Throws [SignFailure] with a readable message otherwise.
 */
suspend fun signChecked(signer: NostrSigner, template: NoteLogic.Template): NostrEvent {
    val event = try {
        signer.sign(template.withAuthor(signer.pubkey))
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        val text = e.message ?: e.toString()
        throw SignFailure(
            if (Regex("reject|denied|declin|cancel", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
                "Your signer declined the request."
            } else {
                "Your signer could not sign: $text"
            },
        )
    }
    if (event.pubkey != signer.pubkey) throw SignFailure("Your signer signed with a different key than the one you are signed in as.")
    if (!event.verify()) throw SignFailure("Your signer returned an event with an invalid signature.")
    return event
}

/**
 * Seals the saved NIP-46 client key at rest with an AES key that never leaves
 * the Android Keystore. Without a working keystore nothing is saved: the
 * connection then lasts until the app closes, rather than sitting in plain text.
 */
internal object SecretBox {
    private const val ALIAS = "nalgorithm-signer-store"

    private fun key(): SecretKey? = runCatching {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }.getOrNull()

    fun seal(plain: String): String? = runCatching {
        val k = key() ?: return null
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, k)
        val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
        Base64.getEncoder().encodeToString(byteArrayOf(c.iv.size.toByte()) + out)
    }.getOrNull()

    fun open(sealed: String): String? = runCatching {
        val k = key() ?: return null
        val all = Base64.getDecoder().decode(sealed)
        val ivLen = all[0].toInt()
        val iv = all.copyOfRange(1, 1 + ivLen)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, iv))
        String(c.doFinal(all.copyOfRange(1 + ivLen, all.size)), Charsets.UTF_8)
    }.getOrNull()
}
