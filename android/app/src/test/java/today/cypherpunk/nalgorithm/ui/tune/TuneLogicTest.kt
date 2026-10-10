package today.cypherpunk.nalgorithm.ui.tune

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nalgorithm.data.DeviceSettings
import today.cypherpunk.nalgorithm.data.FeedbackState
import today.cypherpunk.nalgorithm.data.StoredRule
import today.cypherpunk.nalgorithm.model.AppMode

class TuneLogicTest {
    @Test
    fun `starters add a sentence, never twice, never past the cap`() {
        assertEquals("Privacy and security tools.", PromptStarters.add("", "Privacy and security tools", 0))
        assertEquals("I like relays. Privacy and security tools.", PromptStarters.add("I like relays", "Privacy and security tools", 0))
        assertEquals("I like relays. Privacy and security tools.", PromptStarters.add("I like relays,", "Privacy and security tools", 0))
        assertNull(PromptStarters.add("privacy and security tools matter", "Privacy and security tools", 0))
        assertNull(PromptStarters.add("x".repeat(1990), "Privacy and security tools", 2000))
    }

    @Test
    fun `device defaults follow the web's settings`() {
        val d = DeviceSettings()
        assertEquals("new", d.feedOrder)
        assertFalse(d.dataSaver)
        assertEquals(6, d.digestMinutes)
        assertTrue(d.cacheAudio)
        assertEquals("njump", d.clientPreset)
        assertEquals(DeviceSettings(), DeviceSettings(feedOrder = "weird", digestMinutes = 7, clientPreset = "toString", playbackSpeed = Float.NaN).normalized())
    }

    @Test
    fun `export - hosted keeps only this device's preferences, BYOK adds the mode's settings`() {
        val feedback = FeedbackState(rules = listOf(StoredRule("more", "relays", "n1", 5)), hidden = listOf("h"), muted = listOf("m"))
        val byokSettings = buildJsonObject { put("model", "m1"); put("feedOrder", "best") }
        val hosted = Json.parseToJsonElement(DeviceData.build(AppMode.Hosted, DeviceSettings(), feedback, byokSettings, "T")).jsonObject
        assertEquals("nalgorithm", hosted["app"]!!.jsonPrimitive.content)
        assertEquals("hosted", hosted["mode"]!!.jsonPrimitive.content)
        assertNull(hosted["settings"]!!.jsonObject["model"])
        assertEquals(JsonPrimitive("new"), hosted["settings"]!!.jsonObject["feedOrder"])
        val fb = hosted["feedback"]!!.jsonObject
        assertEquals(1, fb["rules"]!!.jsonArray.size)
        assertEquals(1, fb["muted"]!!.jsonArray.size)
        assertNull("hidden notes are not exported, as on the web", fb["hidden"])

        val byok = Json.parseToJsonElement(DeviceData.build(AppMode.Byok, DeviceSettings(), feedback, byokSettings, "T")).jsonObject
        assertEquals("m1", byok["settings"]!!.jsonObject["model"]!!.jsonPrimitive.content)
        assertEquals("the mode's own value wins", "best", byok["settings"]!!.jsonObject["feedOrder"]!!.jsonPrimitive.content)
        assertTrue(byok["settings"]!!.jsonObject.containsKey("clientPreset"))
    }
}
