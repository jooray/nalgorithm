package today.cypherpunk.nostrsignin

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * NIP-55: a signer app on this phone (Amber and others), reached through
 * `nostrsigner:` intents and the signer's content provider.
 *
 * The rules that make it work reliably (each one cost a failed login once):
 * - `get_public_key` must go through an intent. Ask for the permissions you will
 *   need (`sign_event` kind 22242) so the next step can run silently.
 * - Sign through the content provider first. It answers in the background when
 *   the user granted the permission, and never opens a second activity.
 * - Only when the provider declines, use the `sign_event` intent, and launch it
 *   only after our own activity is RESUMED again. Signer activities are
 *   singleTask: an intent that reaches the still-closing `get_public_key` window
 *   is delivered through onNewIntent, and Android immediately reports
 *   RESULT_CANCELED to the caller. No flags on the intent (NIP-55's
 *   SINGLE_TOP|CLEAR_TOP is for batching several requests, which login never does).
 * - Results come back as `result` (signature or pubkey), `event` (the signed
 *   event JSON), the older `signature` extra, or a `results` JSON array when
 *   the signer batched requests. `result` from get_public_key may be npub or hex.
 */
object Nip55 {
    data class SignerApp(val packageName: String, val label: String)

    fun signers(context: Context): List<SignerApp> {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:"))
        val infos = if (Build.VERSION.SDK_INT >= 33) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(intent, 0)
        }
        return infos.map { SignerApp(it.activityInfo.packageName, it.loadLabel(pm).toString()) }
            .distinctBy { it.packageName }
    }

    fun getPublicKeyIntent(signerPackage: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:")).apply {
            setPackage(signerPackage)
            putExtra("type", "get_public_key")
            putExtra("permissions", """[{"type":"sign_event","kind":${UnsignedEvent.KIND_CLIENT_AUTH}}]""")
        }

    fun signEventIntent(event: UnsignedEvent, signerPackage: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:" + event.toJson())).apply {
            setPackage(signerPackage)
            putExtra("type", "sign_event")
            putExtra("id", event.id)
            putExtra("current_user", Bech32.npub(event.pubkey))
        }

    /** What a signer answered. */
    sealed interface Reply {
        data class PublicKey(val pubkeyHex: String, val signerPackage: String?) : Reply
        data class Signed(val eventJson: String) : Reply
        data object Rejected : Reply
        /** The signer answered, but with nothing we can use. */
        data object Empty : Reply
    }

    /** Parse a `get_public_key` answer; [extra] reads one string extra. */
    fun parsePublicKey(extra: (String) -> String?): Reply {
        val pubkey = extra("result")?.let(Bech32::pubkeyHex) ?: return Reply.Empty
        return Reply.PublicKey(pubkey, extra("package")?.takeIf { it.isNotBlank() })
    }

    /**
     * Parse a `sign_event` answer for [expected]. A whole event is accepted only
     * when it is the event we asked for; it is re-serialized from our own fields
     * so the server sees exactly what the id covers.
     */
    fun parseSigned(expected: UnsignedEvent, extra: (String) -> String?): Reply {
        extra("event")?.let { json -> signatureFromEvent(json, expected)?.let { return Reply.Signed(expected.signedJson(it)) } }
        for (key in listOf("result", "signature")) {
            extra(key)?.trim()?.takeIf { Hex.isHex(it, 128) }?.let { return Reply.Signed(expected.signedJson(it.lowercase())) }
        }
        extra("results")?.let { json -> signatureFromResults(json, expected)?.let { return Reply.Signed(expected.signedJson(it)) } }
        return Reply.Empty
    }

    private val json = Json { ignoreUnknownKeys = true }

    private fun signatureFromEvent(raw: String, expected: UnsignedEvent): String? {
        val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
        fun str(key: String) = (obj[key] as? JsonPrimitive)?.contentOrNull
        val sig = str("sig")?.takeIf { Hex.isHex(it, 128) } ?: return null
        if (str("pubkey")?.lowercase() != expected.pubkey) return null
        if ((obj["kind"] as? JsonPrimitive)?.longOrNull != expected.kind.toLong()) return null
        // A signer may restamp created_at; then the id it returns is for its own
        // version, which we cannot re-serialize faithfully. Require ours.
        if ((obj["created_at"] as? JsonPrimitive)?.longOrNull != expected.createdAt) return null
        str("id")?.let { if (it.lowercase() != expected.id) return null }
        return sig.lowercase()
    }

    private fun signatureFromResults(raw: String, expected: UnsignedEvent): String? {
        val array = runCatching { json.parseToJsonElement(raw) as? JsonArray }.getOrNull() ?: return null
        for (item in array) {
            val obj = item as? JsonObject ?: continue
            val id = (obj["id"] as? JsonPrimitive)?.contentOrNull
            if (id != null && id != expected.id) continue
            (obj["event"] as? JsonPrimitive)?.contentOrNull?.let { e -> signatureFromEvent(e, expected)?.let { return it } }
            (obj["result"] as? JsonPrimitive)?.contentOrNull?.takeIf { Hex.isHex(it, 128) }?.let { return it.lowercase() }
        }
        return null
    }

    /**
     * Sign through the signer's content provider, without any UI. Returns null
     * when the provider is missing or declines (no remembered permission): the
     * caller then falls back to the intent. Blocking; call off the main thread.
     */
    fun signViaContentResolver(context: Context, signerPackage: String, event: UnsignedEvent): Reply? {
        val uri = Uri.parse("content://$signerPackage.SIGN_EVENT")
        val cursor: Cursor = try {
            context.contentResolver.query(uri, arrayOf(event.toJson(), "", Bech32.npub(event.pubkey)), null, null, null)
        } catch (e: SecurityException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        } ?: return null
        return cursor.use { c ->
            if (c.getColumnIndex("rejected") >= 0) return@use Reply.Rejected
            if (!c.moveToFirst()) return@use null
            val reply = parseSigned(event) { key ->
                val index = c.getColumnIndex(key)
                if (index >= 0 && !c.isNull(index)) c.getString(index) else null
            }
            reply.takeIf { it is Reply.Signed }
        }
    }
}
