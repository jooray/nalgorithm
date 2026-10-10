package today.cypherpunk.nalgorithm.ui.notes

/**
 * Port of web/src/client-url.ts: "open this in a Nostr client" links.
 *
 * Which client someone prefers is personal, so the presets are just starting
 * points and a custom template is a first-class option. Every URL that leaves
 * this file has passed the scheme allowlist below.
 */
object ClientPreset {
    data class Info(val label: String, val url: String, val profileUrl: String)

    const val CUSTOM = "custom"
    const val APP = "app"

    val PRESETS: Map<String, Info> = linkedMapOf(
        "njump" to Info("njump", "https://njump.me/{e}", "https://njump.me/{npub}"),
        "primal" to Info("Primal", "https://primal.net/e/{e}", "https://primal.net/p/{npub}"),
        "yakihonne" to Info("Yakihonne", "https://yakihonne.com/event/{e}", "https://yakihonne.com/profile/{npub}"),
        // NIP-21: hands the identifier to whichever app registered the nostr: scheme.
        APP to Info("my Nostr app", "nostr:{e}", "nostr:{npub}"),
    )

    /** The picker's options, in the web's order and wording. */
    val OPTIONS: List<Pair<String, String>> = listOf(
        "njump" to "njump",
        "primal" to "Primal",
        "yakihonne" to "Yakihonne",
        APP to "My Nostr app (nostr: link)",
        CUSTOM to "Custom",
    )

    fun isPreset(value: String?): Boolean = value == CUSTOM || (value != null && value in PRESETS)

    /** Human-readable name for the current choice, for menu labels. */
    fun label(preset: String): String = if (preset == CUSTOM) "client" else PRESETS[preset]?.label ?: "njump"
}

object ClientUrl {
    /**
     * Schemes a link template may use: web links, and the NIP-21 `nostr:` scheme
     * (`web+nostr` is the spelling browsers require for registered handlers).
     * Everything else (javascript:, data:, file: and so on) is refused.
     */
    private val ALLOWED_SCHEMES = setOf("http", "https", "nostr", "web+nostr")
    private val SCHEME = Regex("^([a-z][a-z0-9+.-]*):", RegexOption.IGNORE_CASE)
    private val CONTROL = Regex("[\\u0000- \\u007f-\\u009f]")
    private val PLACEHOLDER = Regex("\\{([a-z]+)\\}", RegexOption.IGNORE_CASE)
    private val BARE_SCHEME = Regex("^[a-z][a-z0-9+.-]*:[^/]*$", RegexOption.IGNORE_CASE)

    private fun schemeOf(url: String): String? = SCHEME.find(url)?.groupValues?.get(1)?.lowercase()

    /** True when the URL starts with an allowed scheme. Whitespace and control characters are refused outright. */
    fun isAllowedLink(url: String): Boolean {
        if (url.trim() != url || CONTROL.containsMatchIn(url.trim())) return false
        val scheme = schemeOf(url) ?: return false
        return scheme in ALLOWED_SCHEMES
    }

    /** The URL if it is safe to open, otherwise null. */
    fun safeLink(url: String): String? = if (isAllowedLink(url)) url else null

    /** Why a custom template was refused, or null if it is fine (or empty). */
    fun validateTemplate(template: String): String? {
        val t = template.trim()
        if (t.isEmpty()) return null
        if (!isAllowedLink(t.replace(PLACEHOLDER, "x"))) return "Use an http://, https:// or nostr: link."
        return null
    }

    /** Fill a template, or append to it when it has no placeholder; "" when the result is not an allowed link. */
    private fun expand(template: String, values: Map<String, String>, primary: String): String {
        val t = template.trim()
        val out = when {
            PLACEHOLDER.containsMatchIn(t) -> PLACEHOLDER.replace(t) { m -> values[m.groupValues[1]] ?: m.value }
            t.endsWith(":") || BARE_SCHEME.matches(t) -> t + values.getValue(primary)
            else -> (if (t.endsWith("/")) t else "$t/") + values.getValue(primary)
        }
        return if (isAllowedLink(out)) out else ""
    }

    /** A URL for an event. Falls back to njump for an empty or unsafe template. */
    fun buildEventUrl(template: String, nevent: String): String {
        val url = if (template.isNotBlank()) expand(template, mapOf("e" to nevent, "nevent" to nevent, "note" to nevent), "e") else ""
        return url.ifEmpty { ClientPreset.PRESETS.getValue("njump").url.replace("{e}", nevent) }
    }

    /** A URL for a profile. Placeholders: {npub}, {nprofile}, {pubkey}. */
    fun buildProfileUrl(template: String, npub: String, nprofile: String, pubkey: String): String {
        val url = if (template.isNotBlank()) expand(template, mapOf("npub" to npub, "nprofile" to nprofile, "pubkey" to pubkey), "npub") else ""
        return url.ifEmpty { ClientPreset.PRESETS.getValue("njump").profileUrl.replace("{npub}", npub) }
    }

    /** NIP-21 URI for any bech32 identifier (npub, nprofile, nevent, note). */
    fun nostrUri(bech32: String): String = "nostr:$bech32"

    /** The event template for a preset, or the custom one (blank if it is not allowed). */
    fun resolveTemplate(preset: String, customUrl: String): String {
        if (preset == ClientPreset.CUSTOM) return if (validateTemplate(customUrl) != null) "" else customUrl
        return (ClientPreset.PRESETS[preset] ?: ClientPreset.PRESETS.getValue("njump")).url
    }

    /** The profile template for a preset, or the custom one (blank if it is not allowed). */
    fun resolveProfileTemplate(preset: String, customProfileUrl: String): String {
        if (preset == ClientPreset.CUSTOM) return if (validateTemplate(customProfileUrl) != null) "" else customProfileUrl
        return (ClientPreset.PRESETS[preset] ?: ClientPreset.PRESETS.getValue("njump")).profileUrl
    }

    /** Which preset a stored URL corresponds to (migrating an imported `njumpBaseUrl`). */
    fun presetFromUrl(url: String): String {
        val trimmed = url.trim()
        val normalized = (if (trimmed.endsWith("/")) trimmed else "$trimmed/").replace("{e}/", "")
        for ((key, preset) in ClientPreset.PRESETS) {
            if (key == ClientPreset.APP) continue
            if (normalized == preset.url.replace("{e}", "")) return key
        }
        return ClientPreset.CUSTOM
    }
}
