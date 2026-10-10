package today.cypherpunk.nalgorithm.byok

import today.cypherpunk.nalgorithm.engine.pubkeyToHexOrNull
import java.net.URI

/** The Tune fields a setup problem can point at (web settings-validation.ts field ids). */
enum class SetupField { Npub, ApiBase, ApiKey, Model, UserPrompt, Relays, HoursBack, DigestTopN, BatchSize, Concurrency, Scorer }

data class FieldProblem(val field: SetupField, val message: String) {
    /** Fields that sit behind "Show all settings" during the first setup. */
    val isExtra: Boolean get() = this.field in setOf(SetupField.HoursBack, SetupField.DigestTopN, SetupField.BatchSize, SetupField.Concurrency, SetupField.Scorer, SetupField.Relays)
}

object SettingsValidation {
    private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1")

    private fun parseUrl(text: String): URI? = try {
        URI(text).takeIf { it.scheme != null && it.host != null }
    } catch (_: Exception) {
        null
    }

    /** The first thing that keeps these settings from running, or null. */
    fun setupProblem(s: ByokSettings): FieldProblem? {
        fun bad(field: SetupField, message: String) = FieldProblem(field, message)
        if (pubkeyToHexOrNull(s.npub.trim()) == null) {
            return bad(SetupField.Npub, "Enter a valid public npub, nprofile or 64-character public key. Never paste a private key.")
        }
        val url = parseUrl(s.apiBaseUrl)
        val urlOk = url != null &&
            url.scheme.lowercase() in setOf("http", "https") &&
            url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null &&
            !(url.scheme.lowercase() == "http" && url.host.lowercase() !in LOCAL_HOSTS)
        if (!urlOk) return bad(SetupField.ApiBase, "Use an HTTPS model API URL, or http://localhost (or 127.0.0.1) for a local model.")
        val host = url.host.lowercase()
        if (host !in LOCAL_HOSTS && s.apiKey.trim().isEmpty()) return bad(SetupField.ApiKey, "Add the API key for this provider. Local models need no key.")
        if (s.model.trim().isEmpty()) return bad(SetupField.Model, "Choose a chat model for scoring, digest writing and learning.")
        if (s.userPrompt.trim().isEmpty() || s.userPrompt.length > 2000) return bad(SetupField.UserPrompt, "Describe your interests in 1–2,000 characters.")
        val relaysOk = s.relays.isNotEmpty() && s.relays.all { r ->
            val u = parseUrl(r) ?: return@all false
            val scheme = u.scheme.lowercase()
            scheme == "wss" || (scheme == "ws" && u.host.lowercase() in LOCAL_HOSTS)
        }
        if (!relaysOk) return bad(SetupField.Relays, "Enter at least one valid wss:// relay address.")
        for ((field, value, range) in listOf(
            Triple(SetupField.HoursBack, s.hoursBack, 1..168),
            Triple(SetupField.DigestTopN, s.digestTopN, 3..50),
            Triple(SetupField.BatchSize, s.batchSize, 5..50),
            Triple(SetupField.Concurrency, s.concurrency, 1..10),
        )) {
            if (value !in range) return bad(field, "Use a whole number from ${range.first} to ${range.last}.")
        }
        if (s.scorer == "decision" && (s.decisionModel.trim().isEmpty() || host != "api.venice.ai")) {
            return bad(SetupField.Scorer, "Decision scoring requires Venice and a decision model. Choose Chat for other providers.")
        }
        return null
    }

    fun validate(s: ByokSettings): String? = setupProblem(s)?.message

    enum class StepState { Done, Next, Todo }
    data class Step(val label: String, val field: SetupField, val state: StepState)

    /** The essentials of a first run, in order, and which one is next (web ui.ts setupSteps). */
    fun setupSteps(s: ByokSettings): List<Step> {
        // Each essential judged on its own: the other two filled with placeholders that pass.
        fun fieldOf(patch: ByokSettings) = setupProblem(patch)?.field
        val npubOk = fieldOf(s) != SetupField.Npub
        val connectionProblem = fieldOf(s.copy(npub = "0".repeat(64), userPrompt = "x"))
        val connectionFields = setOf(SetupField.ApiBase, SetupField.ApiKey, SetupField.Model, SetupField.Scorer)
        val groups = listOf(
            Triple("Your public key (npub)", SetupField.Npub, npubOk),
            Triple("What you care about, in your own words", SetupField.UserPrompt, s.userPrompt.trim().isNotEmpty()),
            Triple(
                "A model connection",
                if (connectionProblem != null && connectionProblem in setOf(SetupField.ApiKey, SetupField.Model, SetupField.Scorer)) connectionProblem else SetupField.ApiBase,
                connectionProblem == null || connectionProblem !in connectionFields,
            ),
        )
        var nextGiven = false
        return groups.map { (label, field, done) ->
            if (done) {
                Step(label, field, StepState.Done)
            } else {
                val state = if (nextGiven) StepState.Todo else StepState.Next
                nextGiven = true
                Step(label, field, state)
            }
        }
    }
}
