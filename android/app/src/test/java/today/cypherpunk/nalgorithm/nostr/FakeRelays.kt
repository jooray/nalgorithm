package today.cypherpunk.nalgorithm.nostr

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.longOrNull
import today.cypherpunk.nalgorithm.model.NostrEvent
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * In-memory relays behind the [RelayTransport] seam. Each URL is one relay with
 * stored events; a relay can be made silent (never answers), broken (fails to
 * connect) or picky (refuses events). Frames are delivered on a background
 * thread, like OkHttp's reader thread.
 */
internal class FakeRelays : RelayTransport {
    inner class Relay(val url: String) {
        val stored = CopyOnWriteArrayList<String>()
        @Volatile var silent = false
        @Volatile var broken = false
        @Volatile var refuse: String? = null
        @Volatile var sendEose = true
        val received = CopyOnWriteArrayList<String>()
        val conns = CopyOnWriteArrayList<Conn>()
        /** Called with every event published to this relay (after OK). */
        @Volatile var onPublish: ((NostrEvent) -> Unit)? = null

        fun store(vararg events: String) = stored.addAll(events)

        /** Drop every connection, as a relay restart would. */
        fun dropAll() = conns.toList().forEach { it.gone("dropped") }

        fun broadcast(eventJson: String) {
            val event = parseEvent(relayJson.parseToJsonElement(eventJson)) ?: return
            for (c in conns) for ((subId, filters) in c.subs) if (filters.any { it.matches(event) }) c.deliver("[\"EVENT\",\"$subId\",$eventJson]")
        }
    }

    inner class Conn(val relay: Relay, val listener: RelaySocketListener) : RelaySocket {
        val subs = ConcurrentHashMap<String, List<Filter>>()
        @Volatile var open = true

        fun deliver(text: String) {
            if (open) executor.execute { if (open) listener.onMessage(text) }
        }

        fun gone(reason: String) {
            if (!open) return
            open = false
            relay.conns.remove(this)
            executor.execute { listener.onGone(reason) }
        }

        override fun send(text: String): Boolean {
            if (!open) return false
            relay.received.add(text)
            if (relay.silent) return true
            val arr = relayJson.parseToJsonElement(text).jsonArray
            when ((arr[0] as JsonPrimitive).content) {
                "REQ" -> {
                    val subId = (arr[1] as JsonPrimitive).content
                    val filters = arr.drop(2).map { parseFilter(it as JsonObject) }
                    subs[subId] = filters
                    for (raw in relay.stored) {
                        val e = parseEvent(relayJson.parseToJsonElement(raw)) ?: continue
                        if (filters.any { it.matches(e) && it.limit != 0 }) deliver("[\"EVENT\",\"$subId\",$raw]")
                    }
                    if (relay.sendEose) deliver("[\"EOSE\",\"$subId\"]")
                }
                "CLOSE" -> subs.remove((arr[1] as JsonPrimitive).content)
                "EVENT" -> {
                    val raw = arr[1].toString()
                    val event = parseEvent(arr[1])!!
                    val refusal = relay.refuse
                    if (refusal != null) {
                        deliver("[\"OK\",\"${event.id}\",false,\"$refusal\"]")
                    } else {
                        relay.stored.add(raw)
                        deliver("[\"OK\",\"${event.id}\",true,\"\"]")
                        relay.broadcast(raw)
                        relay.onPublish?.let { cb -> executor.execute { cb(event) } }
                    }
                }
            }
            return true
        }

        override fun close() = gone("closed")
    }

    val executor = Executors.newSingleThreadExecutor()
    val relays = ConcurrentHashMap<String, Relay>()
    val opened = CopyOnWriteArrayList<String>()

    fun relay(url: String): Relay = relays.getOrPut(relayKey(url)!!) { Relay(relayKey(url)!!) }

    override fun open(url: String, listener: RelaySocketListener): RelaySocket {
        opened.add(url)
        val relay = relay(url)
        val conn = Conn(relay, listener)
        if (relay.broken) {
            conn.open = false
            executor.execute { listener.onGone("TLS handshake failed") }
            return conn
        }
        relay.conns.add(conn)
        executor.execute { listener.onOpen() }
        return conn
    }

    companion object {
        fun parseFilter(o: JsonObject): Filter {
            fun strs(k: String) = (o[k] as? JsonArray)?.map { (it as JsonPrimitive).content }
            val tags = o.keys.filter { it.startsWith("#") && it != "#e" && it != "#p" }.associate { it.drop(1) to strs(it)!! }
            return Filter(
                ids = strs("ids"),
                authors = strs("authors"),
                kinds = (o["kinds"] as? JsonArray)?.map { (it as JsonPrimitive).intOrNull!! },
                e = strs("#e"),
                p = strs("#p"),
                since = (o["since"] as? JsonPrimitive)?.longOrNull,
                until = (o["until"] as? JsonPrimitive)?.longOrNull,
                limit = (o["limit"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull(),
                tags = tags,
            )
        }
    }
}

/** Signed events for tests. */
internal object TestEvents {
    val alice = Keys.generateSecret()
    val bob = Keys.generateSecret()

    fun note(secret: ByteArray, content: String, createdAt: Long = 1_700_000_000, kind: Int = 1, tags: List<List<String>> = emptyList()): NostrEvent =
        signLocal(today.cypherpunk.nostrsignin.UnsignedEvent(Keys.publicHex(secret), createdAt, kind, tags, content), secret)

    fun json(e: NostrEvent) = e.toWireJson()
}
