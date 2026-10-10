package today.cypherpunk.nalgorithm.hosted

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import today.cypherpunk.nalgorithm.model.DigestRecord
import today.cypherpunk.nalgorithm.model.DigestSourceNote
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileSnapshot
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nostrsignin.UnsignedEvent
import java.net.URI
import java.text.DateFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

/**
 * Hosted mode, pure logic: web/src/hosted/logic.ts, previews-logic.ts and the
 * parts of digest-job-logic.ts and snapshot-logic.ts that hosted mode uses.
 * Free of Android, network and storage, so the rules (prices, limits, which
 * message for which server error) are unit tested on their own.
 */

// ─── Entitlement and plans ───────────────────────────────────────────────────

@Serializable
data class Entitlement(
    /** active, trial, expired, none or unknown. */
    val state: String,
    /** Unix seconds: end of the trial or of the paid period. */
    val until: Long? = null,
) {
    companion object {
        private val STATES = setOf("active", "trial", "expired", "none", "unknown")

        /** The server's answer, read defensively: an odd state is "unknown". */
        fun read(v: JsonElement?): Entitlement {
            val o = v as? JsonObject ?: return Entitlement("unknown")
            val state = (o["state"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val until = (o["until"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }?.toLong()
            return Entitlement(if (state in STATES) state!! else "unknown", until)
        }
    }
}

enum class Plan(val id: String, val label: String, val sats: Long, val days: Int, val blurb: String) {
    Nalgorithm("nalgorithm", "Nalgorithm", 10_000, 30, "10,000 sats for 30 days"),
    AllAccess("all-access", "All-access", 25_000, 30, "25,000 sats for 30 days, also unlocks two sibling apps"),
}

const val MAX_PROMPT_CHARS = 2000
val HOURS_BACK_RANGE = 1..72
val TOP_N_RANGE = 1..30
const val MIN_SATS = 1000L
const val DAY_SECONDS = 86_400L

/** The page with terms, refunds and support, linked from the paywall (web commit c0828b3). */
const val TERMS_URL = "https://cypherpunk.today/terms/"

// ─── Login ───────────────────────────────────────────────────────────────────

const val LOGIN_EVENT_KIND = 27235

/** The unsigned login event: bound to the challenge URL, method and nonce. */
fun buildLoginTemplate(pubkey: String, url: String, nonce: String, now: Long): UnsignedEvent =
    UnsignedEvent(
        pubkey = pubkey,
        createdAt = now,
        kind = LOGIN_EVENT_KIND,
        tags = listOf(listOf("u", url), listOf("method", "POST"), listOf("nonce", nonce)),
        content = "",
    )

/** Only ever open http(s) URLs the server hands back. */
fun isHttpUrl(value: String?): Boolean {
    if (value == null) return false
    return try {
        val u = URI(value)
        (u.scheme == "https" || u.scheme == "http") && !u.host.isNullOrEmpty()
    } catch (_: Exception) {
        false
    }
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** Whole non-negative number from a text field, or null. `1e3` and `2.5` are not accepted. */
fun parseWholeNumber(text: String): Long? {
    val t = text.trim()
    return if (t.isNotEmpty() && t.all { it in '0'..'9' }) t.toLongOrNull() else null
}

/** The first problem with the settings, or null. Same limits the server enforces. */
fun validateHostedSettings(userPrompt: String, hoursBack: Long?, topN: Long?): String? {
    if (userPrompt.length > MAX_PROMPT_CHARS) {
        return "The prompt is limited to $MAX_PROMPT_CHARS characters (now ${userPrompt.length})."
    }
    if (hoursBack == null || hoursBack < HOURS_BACK_RANGE.first || hoursBack > HOURS_BACK_RANGE.last) {
        return "Time window must be a whole number of hours from ${HOURS_BACK_RANGE.first} to ${HOURS_BACK_RANGE.last}."
    }
    if (topN == null || topN < TOP_N_RANGE.first || topN > TOP_N_RANGE.last) {
        return "Posts to show must be a whole number from ${TOP_N_RANGE.first} to ${TOP_N_RANGE.last}."
    }
    return null
}

// ─── Payment ─────────────────────────────────────────────────────────────────

/** Days a payment buys, pro rata, rounded down to a tenth of a day. */
fun daysForSats(plan: Plan, sats: Long?): Double {
    if (sats == null || sats <= 0) return 0.0
    return floor(sats.toDouble() / plan.sats * plan.days * 10 + 1e-9) / 10
}

/** "30 days", "1 day", "7.5 days". */
fun formatDays(days: Double): String {
    val whole = days == floor(days)
    val text = if (whole) days.toLong().toString() else String.format(Locale.ROOT, "%.1f", days)
    return "$text ${if (days == 1.0) "day" else "days"}"
}

/** Sats with thousands separators, for display. */
fun formatSats(sats: Long): String = "${String.format(Locale.ROOT, "%,d", sats)} sats"

/** The first problem with a custom amount, or null. */
fun validateSats(sats: Long?): String? {
    if (sats == null) return "Enter a whole number of sats."
    if (sats < MIN_SATS) return "The minimum is ${formatSats(MIN_SATS)}."
    return null
}

/** The line under the amount: what it buys, or what is wrong with it. */
fun payDaysText(plan: Plan, satsText: String): String {
    val sats = parseWholeNumber(satsText)
    return validateSats(sats) ?: "${formatSats(sats!!)} buys about ${formatDays(daysForSats(plan, sats))}."
}

/**
 * Has a payment landed? Active where it was not before, or active with a later
 * end date than before (a top-up while already subscribed).
 */
fun paymentConfirmed(before: Entitlement?, now: Entitlement): Boolean {
    if (now.state != "active") return false
    if (before == null || before.state != "active") return true
    return (now.until ?: 0) > (before.until ?: 0)
}

// ─── Entitlement → UI ────────────────────────────────────────────────────────

data class EntitlementView(
    val kind: String,
    val text: String,
    /** Whether asking for a feed can work. `none` can: the first feed starts the trial. */
    val canRank: Boolean,
    val actionLabel: String?,
    /** Whether the banner above the feed shows. Tune always shows the status. */
    val banner: Boolean,
)

/** A subscription further out than this keeps the banner above the feed hidden. */
const val BANNER_BEFORE_EXPIRY_SECONDS = 90 * DAY_SECONDS

/** Whole days left, counting a started day as a day. Never negative. */
fun daysLeft(until: Long?, now: Long): Long {
    if (until == null) return 0
    return max(0L, ceil((until - now).toDouble() / DAY_SECONDS).toLong())
}

/** The viewer's own locale, like the web's toLocaleDateString. */
fun localDate(sec: Long): String = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(sec * 1000))

fun entitlementView(ent: Entitlement, now: Long, formatDate: (Long) -> String = ::localDate): EntitlementView =
    when (ent.state) {
        "trial" -> {
            val n = daysLeft(ent.until, now)
            EntitlementView("trial", "Free trial: $n ${if (n == 1L) "day" else "days"} left", true, "Subscribe", true)
        }
        "active" -> EntitlementView(
            "active",
            if (ent.until != null) "Subscribed until ${formatDate(ent.until)}" else "Subscribed",
            true,
            "Add time",
            ent.until == null || ent.until - now < BANNER_BEFORE_EXPIRY_SECONDS,
        )
        "expired" -> EntitlementView("expired", "Your access has ended. Subscribe to keep ranking your feed.", false, "Subscribe", true)
        "none" -> EntitlementView("none", "Your free 3-day trial starts when you first load your feed.", true, null, true)
        else -> EntitlementView("unknown", "Subscription status is unavailable right now.", true, null, true)
    }

// ─── Feed run progress ───────────────────────────────────────────────────────

sealed interface FeedProgress {
    data object Idle : FeedProgress
    data class Fetching(val startedAt: Long) : FeedProgress
    data class Queued(val ahead: Long, val startedAt: Long) : FeedProgress
    data class Ranking(val scored: Long, val total: Long, val startedAt: Long) : FeedProgress
}

private fun JsonObject.num(key: String): Double? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

fun readFeedProgress(raw: JsonElement?): FeedProgress {
    val r = raw as? JsonObject ?: return FeedProgress.Idle
    fun n(key: String): Long = r.num(key)?.let { max(0.0, floor(it)).toLong() } ?: 0
    return when (r.str("state")) {
        "fetching" -> FeedProgress.Fetching(n("startedAt"))
        "queued" -> FeedProgress.Queued(n("ahead"), n("startedAt"))
        "ranking" -> FeedProgress.Ranking(n("scored"), n("total"), n("startedAt"))
        else -> FeedProgress.Idle
    }
}

/** One line for the reader: where their run is, so a wait reads as a line, not a hang. */
fun describeProgress(p: FeedProgress?, seconds: Long): String {
    val so = "${seconds}s so far"
    return when (p) {
        null, FeedProgress.Idle -> "Ranking your feed. This can take up to a minute ($so)."
        is FeedProgress.Fetching -> "Fetching notes from the people you follow ($so)."
        is FeedProgress.Queued -> {
            val line = if (p.ahead == 0L) "You are next in line"
            else "Waiting in line: ${p.ahead} ${if (p.ahead == 1L) "ranking" else "rankings"} ahead of yours"
            "$line. Others are being ranked right now ($so)."
        }
        is FeedProgress.Ranking ->
            if (p.total == 0L) "Ranking your feed ($so)." else "Ranking ${p.scored} of ${p.total} new notes ($so)."
    }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

enum class ErrorAction { Login, Settings, Pay, Retry }

data class DescribedError(val message: String, val action: ErrorAction)

/** Turn an API failure into something to say to a person, plus what they can do. */
fun describeError(status: Int, code: String? = null, message: String? = null): DescribedError = when {
    status == 401 -> DescribedError("Your session has ended. Sign in again to continue.", ErrorAction.Login)
    status == 400 && code == "no_prompt" ->
        DescribedError("Tell Nalgorithm what you care about first: add a prompt in Settings.", ErrorAction.Settings)
    status == 400 ->
        DescribedError(if (!message.isNullOrEmpty()) "That was not accepted: $message" else "That was not accepted.", ErrorAction.Settings)
    status == 402 ->
        DescribedError("Your free trial or subscription has ended. Choose a plan to keep going.", ErrorAction.Pay)
    status == 429 && code == "in_progress" ->
        DescribedError("A feed run is already in progress. Wait for it to finish, then refresh.", ErrorAction.Retry)
    status == 429 && code == "daily_cap" ->
        DescribedError("You have reached the daily limit for feed runs. Try again tomorrow.", ErrorAction.Retry)
    status == 429 -> DescribedError("Too many requests. Wait a moment and try again.", ErrorAction.Retry)
    status == 503 && code == "billing_unavailable" ->
        DescribedError("Billing is temporarily unavailable, so the feed cannot be loaded. Try again in a minute.", ErrorAction.Retry)
    status == 503 && code == "busy" ->
        DescribedError("Ranking is busy right now. Your last ranking stays; try again in a minute.", ErrorAction.Retry)
    // Only the checkout answers 502 itself; a proxy's 502 during a restart is not about payments.
    status == 502 && (message ?: "").contains("payment", ignoreCase = true) ->
        DescribedError("Payments are unavailable right now. Try again shortly.", ErrorAction.Retry)
    status == 0 -> DescribedError("Could not reach the server. Check your connection and try again.", ErrorAction.Retry)
    status >= 500 -> DescribedError("The server had a problem. Try again shortly.", ErrorAction.Retry)
    else -> DescribedError(if (!message.isNullOrEmpty()) message else "Something went wrong.", ErrorAction.Retry)
}

fun describeError(e: ApiError): DescribedError = describeError(e.status, e.code, e.message)

/** What to say after asking for a digest right now. */
fun describeDigestNowError(e: ApiError): DescribedError {
    if (e.status == 503 && e.code == "digests_unavailable") {
        return DescribedError("Digest delivery is not switched on for this server yet.", ErrorAction.Retry)
    }
    if (e.status == 429 && e.code == "daily_cap") {
        return DescribedError("You have reached the daily limit for digests. Try again tomorrow.", ErrorAction.Retry)
    }
    return describeError(e)
}

// ─── Daily digest schedule ───────────────────────────────────────────────────

@Serializable
data class Schedule(
    val enabled: Boolean = false,
    /** 24-hour "HH:MM" in [tz]. */
    val time: String = "07:30",
    val tz: String = "UTC",
    val voice: String? = null,
    /** nip17, nip04, or null for automatic. */
    val dmFormat: String? = null,
    val nextRunAt: Long? = null,
    val lastRunAt: Long? = null,
    val lastStatus: String? = null,
)

/** The service's public Nostr account, which sends the digests. */
const val DIGEST_BOT_NPUB = "npub1dka50zsfvru0tsv2sqd40ktnwyd3236c3hzx62hhlxw9un408tcqz6wkt0"

data class Voice(val id: String, val label: String)

private val VOICE_GROUPS = listOf(
    Triple("US, female", "af_", listOf("bella", "heart", "nicole", "sarah", "sky", "jessica", "nova", "river", "kore", "aoede", "alloy", "jadzia")),
    Triple("UK, female", "bf_", listOf("emma", "alice", "lily")),
    Triple("US, male", "am_", listOf("adam", "michael", "eric", "liam", "onyx")),
    Triple("UK, male", "bm_", listOf("george", "daniel", "lewis", "fable")),
)

/** Kokoro voices the server accepts, with a label for the picker. */
val DIGEST_VOICES: List<Voice> = VOICE_GROUPS.flatMap { (kind, prefix, names) ->
    names.map { n -> Voice(prefix + n, "${n.replaceFirstChar { it.uppercase() }} ($kind)") }
}

/** Voices with a listenable sample on the server (its SAMPLE_VOICES), offered first. */
val SAMPLE_VOICE_IDS = listOf("af_bella", "af_heart", "af_sky", "bf_emma", "am_michael", "bm_george")

/** What "Play sample" plays for the Default voice. */
const val DEFAULT_SAMPLE_VOICE = "af_sky"

data class DmFormatOption(val value: String?, val label: String)

/**
 * The delivery format, asked as "which app reads your DMs". The server's automatic choice
 * is the format of the reader's last message to the digest account, else legacy.
 */
val DM_FORMATS = listOf(
    DmFormatOption(null, "Not sure: pick automatically"),
    DmFormatOption("nip04", "Primal, Damus or another app with older DMs"),
    DmFormatOption("nip17", "Amethyst, 0xchat, Coracle, Nostur or another app with private DMs"),
)

const val DM_FORMAT_HINT =
    "Automatic uses the format of your last message to the digest account, otherwise the older format that almost every app can read. Both are encrypted, but the older format shows relays that the digest account writes to you; private DMs (NIP-17) hide that, and some apps cannot show them."

const val DIGEST_ON_ITS_WAY = "On its way. It usually arrives in a few minutes by DM."

const val DIGEST_DM_NOTE =
    "Digests arrive as Nostr direct messages from the service account, so your Nostr client must be able to receive DMs."

/** The canonical zone for an IANA name (case-insensitive, like Intl), or null. */
fun zoneOf(tz: String?): ZoneId? {
    val t = tz?.trim().orEmpty()
    if (t.isEmpty() || t.length > 64) return null
    val id = ZONE_IDS[t.lowercase(Locale.ROOT)] ?: return null
    return runCatching { ZoneId.of(id) }.getOrNull()
}

private val ZONE_IDS: Map<String, String> by lazy {
    (ZoneId.getAvailableZoneIds() + "UTC").associateBy { it.lowercase(Locale.ROOT) }
}

/** Every IANA zone name, sorted, for the picker. */
val TIME_ZONES: List<String> by lazy {
    ZoneId.getAvailableZoneIds().filter { it.contains('/') && !it.startsWith("Etc/") && !it.startsWith("SystemV/") }.sorted() + "UTC"
}

fun isValidTimeZone(tz: String?): Boolean = zoneOf(tz) != null

/** "07:30" style 24-hour time. */
fun isValidTime(time: String?): Boolean = time != null && Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(time)

fun isKnownVoice(voice: String?): Boolean = voice != null && DIGEST_VOICES.any { it.id == voice }

/** The first problem with the schedule form, or null. */
fun validateScheduleForm(time: String, tz: String, voice: String?): String? {
    if (!isValidTime(time)) return "Pick a time of day."
    if (!isValidTimeZone(tz)) return "That time zone is not recognised. Use a name such as Europe/Bratislava."
    if (voice != null && !isKnownVoice(voice)) return "Pick a voice from the list."
    return null
}

/** A schedule that was never saved comes back as UTC and off; suggest the device's zone then. */
fun defaultTimeZone(tz: String, enabled: Boolean, deviceTz: String?): String =
    if (tz == "UTC" && !enabled && isValidTimeZone(deviceTz)) deviceTz!! else tz

/** "Thu 1 Oct, 07:30" in the given zone (English, so the text is the same everywhere). */
fun formatInZone(sec: Long, tz: String): String {
    val zone = zoneOf(tz) ?: ZoneId.of("UTC")
    return DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", Locale.UK).withZone(zone).format(Instant.ofEpochSecond(sec))
}

/** One line for the Digests tab: is daily delivery on, and when is the next one. */
fun scheduleLine(s: Schedule?): String {
    if (s == null) return ""
    if (!s.enabled) return "Daily delivery is off. Digests come only when you ask."
    if (s.nextRunAt == null || !isValidTimeZone(s.tz)) return "Daily delivery is on."
    return "Daily delivery is on. Next: ${formatInZone(s.nextRunAt, s.tz)} (${s.tz})."
}

/** "Next digest: Thu 1 Oct, 07:30", or a line saying nothing is planned. */
fun nextRunText(s: Schedule): String {
    if (!s.enabled) return "The daily digest is off."
    if (s.nextRunAt == null || !isValidTimeZone(s.tz)) return ""
    return "Next digest: ${formatInZone(s.nextRunAt, s.tz)}"
}

/** The last run in plain words, or "" when nothing is known. */
fun lastStatusText(status: String?): String = when (status) {
    "sent" -> "Last digest: sent."
    "delivery_pending" -> "Last digest: ready in the app, but its DM has not gone through yet. It will try again."
    "no_prompt" -> "Last digest: not made, because you have not written a prompt yet. Add one in the Prompt section."
    "not_entitled" -> "Last digest: not made, because your subscription has ended."
    "billing_unavailable" -> "Last digest: not made, because billing could not be checked. It will try again."
    "capped" -> "Last digest: not made, because you reached the daily limit."
    "no_posts" -> "Last digest: nothing new to report."
    "failed" -> "Last digest: failed. It will retry."
    else -> ""
}

/** Audio only ever plays from an http(s) address; anything else is dropped. */
fun safeAudioUrl(value: String?): String? = if (isHttpUrl(value)) value else null

/** The time the schedule nudge offers. */
const val NUDGE_TIME = "07:30"

fun nudgeText(zone: String): String =
    "I write it at $NUDGE_TIME $zone and send it by Nostr DM, in a format almost every app can read. " +
        "The DM is encrypted, but the audio link in it is public: anyone with the link can play it. Change the time, voice or app in Tune."

// ─── Digest job (digest-job-logic.ts) ────────────────────────────────────────

data class DigestStatus(
    val running: Boolean = false,
    val startedAt: Long? = null,
    val lastDurationSeconds: Double? = null,
    val lastStatus: String? = null,
    val finishedAt: Long? = null,
) {
    companion object {
        val IDLE = DigestStatus()

        /** Read the server's answer defensively: anything odd means "not running". */
        fun read(v: JsonElement?): DigestStatus {
            val o = v as? JsonObject ?: return IDLE
            return DigestStatus(
                running = (o["running"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true,
                startedAt = o.num("startedAt")?.toLong(),
                lastDurationSeconds = o.num("lastDurationSeconds"),
                lastStatus = o.str("lastStatus"),
                finishedAt = o.num("finishedAt")?.toLong(),
            )
        }
    }
}

fun clock(seconds: Long): String {
    val s = max(0L, seconds)
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}

/** "usually about 2 minutes", or "usually a few minutes" before there is a run to learn from. */
fun estimateText(lastDurationSeconds: Double?): String {
    if (lastDurationSeconds == null || lastDurationSeconds <= 0) return "usually a few minutes"
    if (lastDurationSeconds < 90) return "usually about a minute"
    return "usually about ${Math.round(lastDurationSeconds / 60)} minutes"
}

/** The one status line while a digest is being written. */
fun progressText(status: DigestStatus, nowSec: Long): String {
    val elapsed = if (status.startedAt == null) 0 else nowSec - status.startedAt
    return "Writing your digest… ${clock(elapsed)} so far, ${estimateText(status.lastDurationSeconds)}. It will appear here and arrive by DM."
}

sealed interface JobStep {
    data object None : JobStep
    data class Arrived(val dmPending: Boolean) : JobStep
    data class Failed(val message: String, val action: ErrorAction) : JobStep
}

/** What to say when a digest run ended without a digest. */
fun failureFor(lastStatus: String?): JobStep.Failed = when (lastStatus) {
    "no_prompt" -> JobStep.Failed("Your digest needs a prompt first. Write what you care about in Tune.", ErrorAction.Settings)
    "not_entitled" -> JobStep.Failed("Your free trial or subscription has ended, so no digest was written.", ErrorAction.Pay)
    "capped" -> JobStep.Failed("You have reached the daily limit for digests. Try again tomorrow.", ErrorAction.Retry)
    "no_posts" -> JobStep.Failed(
        "Nothing new from the people you follow in your time window, so no digest was written. Try a longer window in Tune.",
        ErrorAction.Settings,
    )
    "billing_unavailable" -> JobStep.Failed("Billing is unreachable right now, so the digest could not start. Try again in a few minutes.", ErrorAction.Retry)
    "interrupted" -> JobStep.Failed("The digest was interrupted by a server restart. Press the button to start it again.", ErrorAction.Retry)
    else -> JobStep.Failed("The digest could not be written. Try again in a few minutes.", ErrorAction.Retry)
}

/** Compare the previous and the newest status. Only a running-to-finished change is news. */
fun nextJobStep(wasRunning: Boolean, now: DigestStatus): JobStep {
    if (!wasRunning || now.running) return JobStep.None
    if (now.lastStatus == "sent") return JobStep.Arrived(false)
    if (now.lastStatus == "delivery_pending") return JobStep.Arrived(true)
    return failureFor(now.lastStatus)
}

/** Whether the first digest should be requested now. Asked at most once per account, ever. */
fun shouldRequestFirstDigest(
    hasPrompt: Boolean,
    postCount: Int,
    digestCount: Int,
    digestsKnown: Boolean,
    jobRunning: Boolean,
    alreadyRequested: Boolean,
    paywalled: Boolean,
): Boolean = hasPrompt && postCount > 0 && digestsKnown && digestCount == 0 && !jobRunning && !alreadyRequested && !paywalled

/** The newest digest the reader did not have before asking. Works from an empty list. */
fun findArrived(knownIds: Collection<String>, list: List<DigestRecord>): DigestRecord? {
    val known = knownIds.toSet()
    return list.firstOrNull { it.id !in known }
}

/** The digest row is saved before its DM goes out, so the list can show it while the job still runs. */
fun readyDuringRun(status: DigestStatus, list: List<DigestRecord>): Boolean =
    status.running && status.startedAt != null && list.any { it.createdAt >= status.startedAt }

/** What to say once the digest is in the list: ready, sent or dm_pending. */
fun arrivalText(stage: String): String = when (stage) {
    "ready" -> "Your digest is ready here. Sending it to your DMs…"
    "dm_pending" -> "Your digest is ready here. Its DM has not gone through yet; the server will try again."
    else -> "Your digest has arrived."
}

// ─── The stored feed (snapshot-logic.ts) ─────────────────────────────────────

/** A feed older than this is refreshed on open. */
const val STALE_AFTER_SECONDS = 10 * 60L
/** How often an open, visible app looks at whether it is due. */
const val CHECK_EVERY_MS = 5 * 60_000L
const val LOCAL_MAX_POSTS = 200
const val LOCAL_MAX_BYTES = 1_500_000

fun ageSeconds(createdAt: Long, nowSec: Long): Long = max(0L, nowSec - createdAt)

fun isStale(createdAt: Long?, nowSec: Long, settingsChanged: Boolean = false): Boolean {
    if (createdAt == null || settingsChanged) return true
    return ageSeconds(createdAt, nowSec) >= STALE_AFTER_SECONDS
}

/** "Updated just now", "Updated 12 min ago", "Updated 3 h ago", "Updated 2 d ago". */
fun ageLabel(createdAt: Long?, nowSec: Long): String {
    if (createdAt == null) return ""
    val min = ageSeconds(createdAt, nowSec) / 60
    if (min < 1) return "Updated just now"
    if (min < 60) return "Updated $min min ago"
    val h = min / 60
    if (h < 48) return "Updated $h h ago"
    return "Updated ${h / 24} d ago"
}

fun shouldAutoRun(
    ready: Boolean,
    running: Boolean,
    hidden: Boolean,
    createdAt: Long?,
    nowSec: Long,
    settingsChanged: Boolean = false,
    pausedUntil: Long = 0,
    attemptFailed: Boolean = false,
): Boolean {
    if (!ready || running || hidden || attemptFailed) return false
    if (pausedUntil > nowSec) return false
    return isStale(createdAt, nowSec, settingsChanged)
}

enum class MergeAction { Render, Merge, Pill, Keep }

data class MergeDecision(val action: MergeAction, val newCount: Int, val same: Boolean)

fun countNew(shownIds: List<String>, incomingIds: List<String>): Int {
    val shown = shownIds.toSet()
    return incomingIds.toSet().count { it !in shown }
}

/**
 * Whether a fresh result replaces what is on screen. [atTop] is the web's
 * "scrolled less than 80 px": a reader mid-scroll keeps their list.
 */
fun decideMerge(shownIds: List<String>, incomingIds: List<String>, atTop: Boolean, feedVisible: Boolean, manual: Boolean): MergeDecision {
    val newCount = countNew(shownIds, incomingIds)
    if (shownIds.isEmpty()) return MergeDecision(MergeAction.Render, newCount, incomingIds.isEmpty())
    val same = shownIds == incomingIds
    if (same) return MergeDecision(MergeAction.Keep, 0, true)
    if (manual) return MergeDecision(MergeAction.Merge, newCount, false)
    if (!feedVisible || atTop) return MergeDecision(MergeAction.Merge, newCount, false)
    return if (newCount > 0) MergeDecision(MergeAction.Pill, newCount, false) else MergeDecision(MergeAction.Keep, 0, false)
}

/** The display (folded) ids of a ranking: a boost counts as the note it boosts, each note once, in order. */
fun foldedIds(posts: List<ScoredPost>): List<String> =
    posts.map { p -> if (p.type == PostType.Boost && !p.originalPost?.id.isNullOrEmpty()) p.originalPost.id else p.id }.distinct()

/**
 * The notes to put above the rest: those in [incoming] that were not on screen
 * before. A run that brings nothing new keeps the earlier set. No split on a
 * first draw, or when everything is new. All ids are folded ids.
 */
fun freshIds(shown: List<String>, incoming: List<String>, carried: List<String> = emptyList()): List<String> {
    if (shown.isEmpty()) return emptyList()
    val before = shown.toSet()
    val added = incoming.filter { it !in before }
    if (added.size == incoming.size) return emptyList()
    if (added.isNotEmpty()) return added
    val keep = carried.toSet()
    val still = incoming.filter { it in keep }
    return if (still.size == incoming.size) emptyList() else still
}

/** The most recent posts one run ranks (the server's cap). */
const val RANKED_CAP = 500

/** What the status line says about a ranking. */
fun coverageText(shown: Int, ranked: Int, hoursBack: Int, order: String): String {
    val notes = if (shown == 1) "1 note" else "$shown notes"
    val window = if (hoursBack % 24 == 0 && hoursBack >= 48) "${hoursBack / 24} days" else "$hoursBack h"
    val orderText = if (order == "best") "best match first" else "new arrivals first, then best match"
    val posts = if (ranked == 1) "1 post" else "$ranked posts"
    var text = "$notes from $posts ranked in the last $window, $orderText."
    if (ranked >= RANKED_CAP) text += " A busy window: only the newest $RANKED_CAP posts were ranked."
    return text
}

fun pillLabel(n: Int): String = if (n == 1) "1 new note" else "$n new notes"

data class QuietNotice(val text: String, val pauseSeconds: Long)

/** Failures that must not replace a feed the reader can still use with an error card. */
fun quietNotice(status: Int, code: String?): QuietNotice? = when {
    status == 429 && code == "daily_cap" -> QuietNotice("Daily limit for ranking reached. Showing your last ranking.", 3600)
    status == 429 && code == "in_progress" -> QuietNotice("", 60)
    status == 503 && code == "busy" -> QuietNotice("Ranking is busy right now. Showing your last ranking; it tries again in a minute.", 60)
    status == 503 -> QuietNotice("Ranking is unavailable right now. Showing your last ranking.", 300)
    status == 0 -> QuietNotice("Offline. Showing your last ranking.", 60)
    status >= 500 -> QuietNotice("Ranking hit a problem. Showing your last ranking.", 300)
    else -> null
}

// ─── Link previews (previews-logic.ts) ───────────────────────────────────────

const val MAX_CARDS_PER_POST = 2

data class LinkCard(val title: String, val description: String, val siteName: String, val image: String)

private val MEDIA_EXT = Regex("\\.(jpg|jpeg|png|gif|webp|svg|avif|mp4|webm|mov|ogg|mp3|wav|flac|m4a|aac|opus)$", RegexOption.IGNORE_CASE)
private val URL_IN_TEXT = Regex("https?://[^\\s<>\"]+", RegexOption.IGNORE_CASE)
private val TRAILING = Regex("[)\\]>.,;:!?'\"]+$")

/**
 * The first http(s) URLs of [content] that deserve a card: not media, not the
 * app's own host, each page once. [ownHost] is the app's own host (with port, if any).
 */
fun extractPreviewUrls(content: String, ownHost: String = "", max: Int = MAX_CARDS_PER_POST): List<String> {
    val out = mutableListOf<String>()
    val seen = HashSet<String>()
    for (m in URL_IN_TEXT.findAll(content)) {
        val cleaned = m.value.replace(TRAILING, "")
        val url = try {
            URI(cleaned)
        } catch (_: Exception) {
            continue
        }
        val scheme = url.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") continue
        val host = url.host?.lowercase() ?: continue
        if (url.rawUserInfo != null) continue
        val path = url.path.orEmpty()
        if (MEDIA_EXT.containsMatchIn(path) || host == "nostr.build" || host.endsWith(".nostr.build")) continue
        val hostPort = if (url.port != -1) "$host:${url.port}" else host
        if (ownHost.isNotEmpty() && hostPort == ownHost.lowercase()) continue
        val key = normalizeUrl(url, scheme, host)
        if (!seen.add(key)) continue
        out += key
        if (out.size >= max) break
    }
    return out
}

/** Like the WHATWG URL serializer for the parts that matter here: lower-case scheme and host, "/" for an empty path, no fragment. */
private fun normalizeUrl(url: URI, scheme: String, host: String): String = buildString {
    append(scheme).append("://").append(host)
    val defaultPort = if (scheme == "https") 443 else 80
    if (url.port != -1 && url.port != defaultPort) append(':').append(url.port)
    append(url.rawPath.takeUnless { it.isNullOrEmpty() } ?: "/")
    if (url.rawQuery != null) append('?').append(url.rawQuery)
}

private val IMAGE_PATH = Regex("^preview/image\\?u=[\\w-]{1,4096}&s=[\\w-]{1,128}$")

/** The one shape an image path may have: what the server's `/preview/image` hands out. */
fun safeImagePath(value: String?): String = if (value != null && IMAGE_PATH.matches(value)) value else ""

/** A card from a server answer, or null when there is nothing to show. */
fun readLinkCard(data: JsonElement?): LinkCard? {
    val d = data as? JsonObject ?: return null
    if ((d["unavailable"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true) return null
    fun text(key: String, max: Int): String = d.str(key)?.take(max) ?: ""
    val title = text("title", 200)
    val description = text("description", 400)
    if (title.isEmpty() && description.isEmpty()) return null
    return LinkCard(title, description, text("siteName", 100), safeImagePath(d.str("image")))
}

/** Off only when the person turned it off; a server that predates the setting means on. */
fun previewsEnabled(linkPreviews: Boolean?): Boolean = linkPreviews != false

// ─── Digest records (digest-model.ts readDigest) ─────────────────────────────

private val HEX_64 = Regex("^[0-9a-fA-F]{64}$")
private val RELAY_URL = Regex("^wss?://\\S+$", RegexOption.IGNORE_CASE)
private const val MAX_NOTE_CHARS = 4000
private const val MAX_TEXT_CHARS = 60_000

/** Validate one untrusted source note (from the server or from storage). */
fun readSourceNote(value: JsonElement?): DigestSourceNote? {
    val v = value as? JsonObject ?: return null
    val id = v.str("id")?.takeIf { HEX_64.matches(it) } ?: return null
    val pubkey = v.str("pubkey")?.takeIf { HEX_64.matches(it) } ?: return null
    val createdAt = v.num("createdAt") ?: return null
    val content = v.str("content") ?: return null
    val score = v.num("score") ?: return null
    val kind = v.num("kind")?.takeIf { it >= 0 && it == floor(it) }?.toInt()
    return DigestSourceNote(
        id = id.lowercase(),
        pubkey = pubkey.lowercase(),
        createdAt = createdAt.toLong(),
        content = content.take(MAX_NOTE_CHARS),
        score = score.coerceIn(0.0, 10.0),
        reason = v.str("reason")?.trim()?.takeIf { it.isNotEmpty() },
        kind = kind,
        relay = v.str("relay")?.takeIf { RELAY_URL.matches(it) },
    )
}

private fun readDigestProfiles(value: JsonElement?): Map<String, ProfileSnapshot>? {
    val o = value as? JsonObject ?: return null
    val out = LinkedHashMap<String, ProfileSnapshot>()
    for ((pk, p) in o) {
        if (!HEX_64.matches(pk) || p !is JsonObject) continue
        out[pk.lowercase()] = ProfileSnapshot(p.str("name")?.take(200), p.str("picture")?.take(1000), p.str("nip05")?.take(200))
    }
    return out.ifEmpty { null }
}

/** Validate one untrusted digest. Notes stay null when the source had none. */
fun readDigest(value: JsonElement?): DigestRecord? {
    val v = value as? JsonObject ?: return null
    val rawId = v["id"] as? JsonPrimitive ?: return null
    val id = if (rawId.isString) rawId.content else rawId.longOrNull?.toString() ?: rawId.doubleOrNull?.let { if (it == floor(it)) it.toLong().toString() else it.toString() }
    if (id.isNullOrEmpty()) return null
    val createdAt = v.num("createdAt") ?: return null
    return DigestRecord(
        id = id,
        createdAt = createdAt.toLong(),
        text = v.str("text")?.take(MAX_TEXT_CHARS) ?: "",
        audioUrl = v.str("audioUrl"),
        durationSeconds = v.num("durationSeconds")?.takeIf { it > 0 },
        notes = (v["notes"] as? JsonArray)?.mapNotNull(::readSourceNote),
        profiles = readDigestProfiles(v["profiles"]),
    )
}
