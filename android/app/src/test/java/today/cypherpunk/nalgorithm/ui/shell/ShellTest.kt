package today.cypherpunk.nalgorithm.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.ui.notes.NoteIds

class ShellTest {
    private val id = "c".repeat(64)

    @Test
    fun `app links name a tab or a note, anything else only brings the app forward`() {
        assertEquals(AppLink(tab = Tab.Digest), parseAppLinkParts(listOf("digest")))
        assertEquals(AppLink(tab = Tab.Tune), parseAppLinkParts(listOf("tune")))
        assertEquals(AppLink(Tab.Feed, id), parseAppLinkParts(listOf("note", id)))
        assertEquals(AppLink(Tab.Feed, id), parseAppLinkParts(listOf("feed", "note", id)))
        assertEquals(AppLink(Tab.Feed, id), parseAppLinkParts(listOf("note", NoteIds.nevent(id))))
        assertEquals("a bad id falls back to the tab", AppLink(tab = Tab.Feed), parseAppLinkParts(listOf("feed", "note", "zz")))
        assertNull(parseAppLinkParts(listOf("signer", "callback")))
        assertNull(parseAppLinkParts(emptyList()))
    }

    @Test
    fun `undo toasts close at the next action and run on Ctrl+Z, others do not`() {
        val t = Toaster()
        var undone = 0
        t.show("Saved")
        t.onNextAction()
        assertEquals("a plain toast is left to its timer", "Saved", t.current.value?.text)
        assertFalse(t.runUndo())
        t.undo("Note hidden on this device.") { undone++ }
        t.onNextAction()
        assertNull(t.current.value)
        assertEquals(0, undone)
        t.undo("Note hidden on this device.") { undone++ }
        assertTrue(t.runUndo())
        assertEquals(1, undone)
        assertNull(t.current.value)
        t.show("")
        assertNull("an empty message is not shown", t.current.value)
    }
}
