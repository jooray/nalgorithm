package today.cypherpunk.nalgorithm.ui.feed

import today.cypherpunk.nalgorithm.data.FeedbackLogic
import today.cypherpunk.nalgorithm.data.FeedbackState
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.ui.notes.DisplayPost
import today.cypherpunk.nalgorithm.ui.notes.aggregateBoosts

/** The feed as drawn: what render.ts and snapshot-logic.ts decide, without the screen. */
object FeedLogic {
    /** "Updated just now", "Updated 12 min ago", "Updated 3 h ago", "Updated 2 d ago"; "" with no ranking. */
    fun ageLabel(createdAt: Long?, nowSec: Long): String {
        if (createdAt == null) return ""
        val s = maxOf(0L, nowSec - createdAt)
        val min = s / 60
        if (min < 1) return "Updated just now"
        if (min < 60) return "Updated $min min ago"
        val h = min / 60
        if (h < 48) return "Updated $h h ago"
        return "Updated ${h / 24} d ago"
    }

    fun pillLabel(n: Int): String = if (n == 1) "1 new note" else "$n new notes"

    /** Fresh notes first, then the rest, each in rank order. No split when nothing or everything is fresh. */
    fun <T> splitFresh(posts: List<T>, fresh: Set<String>, id: (T) -> String): Pair<List<T>, List<T>> {
        val top = posts.filter { id(it) in fresh }
        if (top.isEmpty() || top.size == posts.size) return emptyList<T>() to posts
        return top to posts.filter { id(it) !in fresh }
    }

    /** One lime edge: the first of the highest-scored ranked notes. */
    fun topId(posts: List<DisplayPost>): String? {
        var best: DisplayPost? = null
        for (p in posts) if (!p.post.defaultScore && (best == null || p.post.score > best.post.score)) best = p
        return best?.id
    }

    data class Layout(
        /** Boosts folded, before the reader's private hides. */
        val source: List<DisplayPost>,
        val fresh: List<DisplayPost>,
        val rest: List<DisplayPost>,
        val topId: String?,
    ) {
        val all: List<DisplayPost> get() = fresh + rest
        /** Every note here is one the reader chose to hide. */
        val allHidden: Boolean get() = source.isNotEmpty() && fresh.isEmpty() && rest.isEmpty()
    }

    /**
     * Fold boosts, drop what the reader hid (the note, or its author's notes), and with
     * "new arrivals first" put the notes that came with the latest run on top.
     */
    fun layout(posts: List<ScoredPost>, fresh: Collection<String>, feedOrder: String, feedback: FeedbackState): Layout {
        val source = aggregateBoosts(posts)
        val visible = source.filter { !FeedbackLogic.isFilteredOut(it.post, feedback) }
        val freshSet = fresh.toHashSet().apply { for (p in source) if (p.post.isNew) add(p.id) }
        val (top, rest) = if (feedOrder == "best") emptyList<DisplayPost>() to visible else splitFresh(visible, freshSet) { it.id }
        return Layout(source, top, rest, topId(visible))
    }
}
