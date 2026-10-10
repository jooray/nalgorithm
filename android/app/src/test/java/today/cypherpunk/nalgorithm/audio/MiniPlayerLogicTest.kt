package today.cypherpunk.nalgorithm.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MiniPlayerLogicTest {
    private fun latest(playing: Boolean = false, pos: Double = 0.0, dur: Double = 232.0, resumeHint: String? = null, length: String = "3 min 52 s") =
        MiniLatest("Today, 07:30", length, playing, pos, dur, resumeHint)

    private fun view(l: MiniLatest = latest(), running: Boolean = false) = miniView(running, 3.0, l)

    @Test fun `no digest and nothing running - no bar`() {
        assertEquals(MiniView.None, miniView(false, 0.0, null))
    }

    @Test fun `running with no digest yet - a writing bar with the elapsed time`() {
        assertEquals(MiniView.Running("Writing your digest… 1:15"), miniView(true, 75.0, null))
    }

    @Test fun `running beside an older digest shows the writing bar`() {
        assertTrue(view(running = true) is MiniView.Running)
    }

    @Test fun `running while the latest digest is playing keeps the controls`() {
        val v = view(latest(playing = true, pos = 10.0), running = true) as MiniView.Ready
        assertTrue(v.playing)
    }

    @Test fun `ready - title, date and exact length, no progress, no hint`() {
        val v = view() as MiniView.Ready
        assertEquals("Your morning", v.title)
        assertEquals("Today, 07:30 · 3 min 52 s", v.meta)
        assertNull(v.progress)
        assertNull(v.hint)
        assertTrue(v.buttonLabel.startsWith("Play "))
    }

    @Test fun `the length label is used as given`() {
        assertEquals("Today, 07:30 · about 4 min", (view(latest(length = "about 4 min")) as MiniView.Ready).meta)
    }

    @Test fun `resume - hint and progress at the saved place`() {
        val v = view(latest(pos = 58.0, resumeHint = "Resume at 0:58")) as MiniView.Ready
        assertEquals("Resume at 0:58", v.hint)
        assertEquals(58.0 / 232.0, v.progress!!, 1e-9)
    }

    @Test fun `playing - pause button, live progress, no resume hint`() {
        val v = view(latest(playing = true, pos = 116.0, resumeHint = "Resume at 0:58")) as MiniView.Ready
        assertTrue(v.playing)
        assertNull(v.hint)
        assertEquals(0.5, v.progress!!, 0.0)
        assertTrue(v.buttonLabel.startsWith("Pause "))
    }

    @Test fun `playing at the very start shows an empty progress line`() {
        assertEquals(0.0, (view(latest(playing = true, pos = 0.0)) as MiniView.Ready).progress!!, 0.0)
    }

    @Test fun `progress is clamped and needs a known length`() {
        assertEquals(1.0, (view(latest(playing = true, pos = 999.0)) as MiniView.Ready).progress!!, 0.0)
        assertNull((view(latest(playing = true, pos = 5.0, dur = 0.0)) as MiniView.Ready).progress)
    }

    @Test fun `clock never goes negative or non-finite`() {
        assertEquals("0:00", miniClock(-5.0))
        assertEquals("0:00", miniClock(Double.NaN))
        assertEquals("1:01", miniClock(61.9))
    }

    @Test fun `make buttons`() {
        assertEquals(MakeButtonView("Writing your digest…", true, true), makeButtonView(true, true, "First", "Another"))
        assertEquals(MakeButtonView("First", false, false), makeButtonView(false, false, "First", "Another"))
        assertEquals(MakeButtonView("Another", false, false), makeButtonView(false, true, "First", "Another"))
    }
}
