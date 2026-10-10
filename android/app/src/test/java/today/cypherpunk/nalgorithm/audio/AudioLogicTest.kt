package today.cypherpunk.nalgorithm.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioLogicTest {
    private class Memory : KeyValueStore {
        val raw = HashMap<String, String>()
        override fun getItem(key: String) = raw[key]
        override fun setItem(key: String, value: String) { raw[key] = value }
        override fun removeItem(key: String) { raw.remove(key) }
    }

    @Test fun `speeds are the six the brief asks for`() {
        assertEquals(listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f), SPEEDS)
    }

    @Test fun `nextSpeed cycles and wraps`() {
        assertEquals(1.25f, nextSpeed(1f))
        assertEquals(0.75f, nextSpeed(2f))
        assertEquals(1f, nextSpeed(3f))
    }

    @Test fun `formatSpeed prints a trailing multiplication sign`() {
        assertEquals("1.25×", formatSpeed(1.25f))
        assertEquals("1×", formatSpeed(1f))
        assertEquals("0.75×", formatSpeed(0.75f))
        assertEquals("2×", formatSpeed(2f))
    }

    @Test fun `normalizeSpeed accepts known values only`() {
        assertEquals(1.5f, normalizeSpeed(1.5f))
        assertEquals(DEFAULT_SPEED, normalizeSpeed(3f))
        assertEquals(DEFAULT_SPEED, normalizeSpeed(null))
    }

    @Test fun `resume position is remembered per key`() {
        val r = ResumeStore(Memory())
        r.save("a", 83.0, 240.0, 1000)
        r.save("b", 12.0, 300.0, 1000)
        assertEquals(83.0, r.resumeAt("a"), 0.0)
        assertEquals(12.0, r.resumeAt("b"), 0.0)
        assertEquals(0.0, r.resumeAt("c"), 0.0)
        assertEquals(240.0, r.durationOf("a"), 0.0)
    }

    @Test fun `nothing to resume in the first seconds`() {
        val r = ResumeStore(Memory())
        r.save("a", 2.0, 240.0)
        assertEquals(0.0, r.resumeAt("a"), 0.0)
        assertEquals(null, resumeHint(2.0))
        assertEquals(null, resumeHint(null))
    }

    @Test fun `clears near the end and marks the digest played`() {
        val r = ResumeStore(Memory())
        r.save("a", 100.0, 240.0)
        assertFalse(r.isPlayed("a"))
        r.save("a", 235.0, 240.0)
        assertEquals(0.0, r.resumeAt("a"), 0.0)
        assertTrue(r.isPlayed("a"))
        assertTrue(isNearEnd(235.0, 240.0))
        assertFalse(isNearEnd(200.0, 240.0))
        assertFalse(isNearEnd(50.0, 0.0))
    }

    @Test fun `a played mark survives later position saves`() {
        val r = ResumeStore(Memory())
        r.markPlayed("a", 240.0)
        r.save("a", 60.0, 240.0)
        assertTrue(r.isPlayed("a"))
        assertEquals(60.0, r.resumeAt("a"), 0.0)
    }

    @Test fun `saveDuration keeps the position`() {
        val r = ResumeStore(Memory())
        r.save("a", 30.0, 0.0)
        r.saveDuration("a", 200.0)
        assertEquals(30.0, r.resumeAt("a"), 0.0)
        assertEquals(200.0, r.durationOf("a"), 0.0)
    }

    @Test fun `resume hint text`() {
        assertEquals("Resume at 1:23", resumeHint(83.0))
        assertEquals("Resume at 1:02:03", resumeHint(3723.0))
    }

    @Test fun `old entries are dropped past the cap, newest kept`() {
        val s = Memory()
        val r = ResumeStore(s)
        for (i in 0 until 120) r.save("k$i", 30.0, 600.0, i.toLong())
        val stored = kotlinx.serialization.json.Json.parseToJsonElement(s.raw["nalgorithm_resume_v1"]!!) as kotlinx.serialization.json.JsonObject
        assertEquals(100, stored.size)
        assertEquals(30.0, r.resumeAt("k119"), 0.0)
        assertEquals(0.0, r.resumeAt("k0"), 0.0)
        // A fresh reader of the same storage sees the same marks.
        assertEquals(30.0, ResumeStore(s).resumeAt("k119"), 0.0)
    }

    @Test fun `garbage in storage reads as empty`() {
        val s = Memory()
        s.setItem("nalgorithm_resume_v1", """{"a":{"pos":"x"},"b":5}""")
        assertEquals(0.0, ResumeStore(s).resumeAt("a"), 0.0)
        s.setItem("nalgorithm_resume_v1", "not json")
        assertEquals(0.0, ResumeStore(s).resumeAt("a"), 0.0)
    }

    @Test fun `clock formatting`() {
        assertEquals("0:00", formatClock(0.0))
        assertEquals("1:05", formatClock(65.9))
        assertEquals("1:00:00", formatClock(3600.0))
        assertEquals("0:00", formatClock(Double.NaN))
    }

    @Test fun `waveform is fixed, bounded and the requested length`() {
        val a = waveformBars(64)
        assertEquals(a, waveformBars(64))
        assertEquals(64, a.size)
        assertTrue(a.all { it in 0.12..1.0 })
        assertTrue(a.map { "%.2f".format(it) }.toSet().size > 10)
        // The same picture the web draws.
        assertEquals("0.486471,0.422474,0.452863,0.390389,0.682646", waveformBars(5).joinToString(",") { "%.6f".format(java.util.Locale.ROOT, it) })
    }

    @Test fun `seek maths`() {
        assertEquals(0.25f, fractionFromPointer(150f, 100f, 200f))
        assertEquals(0f, fractionFromPointer(50f, 100f, 200f))
        assertEquals(1f, fractionFromPointer(900f, 100f, 200f))
        assertEquals(0f, fractionFromPointer(10f, 0f, 0f))
        assertEquals(0.0, clampSeek(10.0, -15.0, 100.0), 0.0)
        assertEquals(100.0, clampSeek(95.0, 15.0, 100.0), 0.0)
        assertEquals(65.0, clampSeek(50.0, 15.0, 100.0), 0.0)
    }
}
