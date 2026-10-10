package today.cypherpunk.nalgorithm.byok

import today.cypherpunk.nalgorithm.engine.Scoring
import today.cypherpunk.nalgorithm.model.ScoredPost

/**
 * The stored feed's decisions (web snapshot-logic.ts): how old it is, when to
 * refresh without being asked, whether a fresh result may replace what is shown.
 */
object SnapshotLogic {
    /** A feed older than this is refreshed on open. */
    const val STALE_AFTER_SECONDS = 10 * 60L
    /** How often an open, visible app looks at whether it is due. */
    const val CHECK_EVERY_MS = 5 * 60_000L
    /** The most recent posts one run ranks (the library's cap). */
    const val RANKED_CAP = 500

    fun ageSeconds(createdAt: Long, nowSec: Long): Long = maxOf(0L, nowSec - createdAt)

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

    data class AutoRunInput(
        val enabled: Boolean,
        val ready: Boolean,
        val running: Boolean,
        val hidden: Boolean,
        val createdAt: Long?,
        val nowSec: Long,
        val settingsChanged: Boolean = false,
        val pausedUntil: Long = 0,
        val attemptFailed: Boolean = false,
    )

    fun shouldAutoRun(i: AutoRunInput): Boolean {
        if (!i.enabled || !i.ready || i.running || i.hidden || i.attemptFailed) return false
        if (i.pausedUntil > i.nowSec) return false
        return isStale(i.createdAt, i.nowSec, i.settingsChanged)
    }

    enum class MergeAction { Render, Merge, Pill, Keep }
    data class MergeDecision(val action: MergeAction, val newCount: Int, val same: Boolean)

    fun countNew(shownIds: List<String>, incomingIds: List<String>): Int {
        val shown = shownIds.toSet()
        return incomingIds.toSet().count { it !in shown }
    }

    /**
     * [readerMidList] stands in for the web's scroll position: true when the feed is on
     * screen and the reader may be part-way down it.
     */
    fun decideMerge(shownIds: List<String>, incomingIds: List<String>, readerMidList: Boolean, manual: Boolean): MergeDecision {
        val newCount = countNew(shownIds, incomingIds)
        if (shownIds.isEmpty()) return MergeDecision(MergeAction.Render, newCount, incomingIds.isEmpty())
        if (shownIds == incomingIds) return MergeDecision(MergeAction.Keep, 0, true)
        if (manual || !readerMidList) return MergeDecision(MergeAction.Merge, newCount, false)
        // A reader mid-list keeps their list. New notes are offered; a pure re-rank waits for the next open.
        return if (newCount > 0) MergeDecision(MergeAction.Pill, newCount, false) else MergeDecision(MergeAction.Keep, 0, false)
    }

    /**
     * The notes to put above the rest: those in [incoming] that were not shown before. A run with
     * nothing new keeps the earlier set; no split on a first draw or when everything is new.
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

    /** Display ids, boosts folded into the note they boost (the order of first appearance). */
    fun foldedIds(posts: List<ScoredPost>): List<String> = posts.map { Scoring.scoreCacheKey(it) }.distinct()

    /** What the status line says about a ranking: how many notes, from what, in which order. */
    fun coverageText(shown: Int, ranked: Int, hoursBack: Int, order: String, unranked: Int = 0): String {
        val notes = if (shown == 1) "1 note" else "$shown notes"
        val window = if (hoursBack % 24 == 0 && hoursBack >= 48) "${hoursBack / 24} days" else "$hoursBack h"
        val orderText = if (order == "best") "best match first" else "new arrivals first, then best match"
        val posts = if (ranked == 1) "1 post" else "$ranked posts"
        var text = "$notes from $posts ranked in the last $window, $orderText."
        if (ranked >= RANKED_CAP) text += " A busy window: only the newest $RANKED_CAP posts were ranked."
        if (unranked > 0) text += " $unranked not ranked yet; check the model connection."
        return text
    }

    fun pillLabel(n: Int): String = if (n == 1) "1 new note" else "$n new notes"
}
