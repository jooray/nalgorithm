package today.cypherpunk.nalgorithm.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of web/test/client-url.test.mjs. */
class ClientUrlTest {
    private fun profile(t: String) = ClientUrl.buildProfileUrl(t, "npub1abc", "nprofile1xyz", "deadbeef")
    private fun preset(id: String) = ClientPreset.PRESETS.getValue(id)

    @Test
    fun `event templates - placeholder, prefix and empty fallback`() {
        assertEquals("https://x.test/e/nevent1q", ClientUrl.buildEventUrl("https://x.test/e/{e}", "nevent1q"))
        assertEquals("https://x.test/e/nevent1q", ClientUrl.buildEventUrl("https://x.test/e", "nevent1q"))
        assertEquals("https://x.test/e/nevent1q", ClientUrl.buildEventUrl("https://x.test/e/", "nevent1q"))
        assertEquals("https://njump.me/nevent1q", ClientUrl.buildEventUrl("", "nevent1q"))
        assertEquals("nostr:nevent1q", ClientUrl.buildEventUrl(preset("app").url, "nevent1q"))
    }

    @Test
    fun `profile templates - every preset and every placeholder`() {
        assertEquals("https://njump.me/npub1abc", profile(preset("njump").profileUrl))
        assertEquals("https://primal.net/p/npub1abc", profile(preset("primal").profileUrl))
        assertEquals("https://yakihonne.com/profile/npub1abc", profile(preset("yakihonne").profileUrl))
        assertEquals("nostr:npub1abc", profile(preset("app").profileUrl))
        assertEquals("https://x.test/u/nprofile1xyz?k=deadbeef&n=npub1abc", profile("https://x.test/u/{nprofile}?k={pubkey}&n={npub}"))
        assertEquals("https://x.test/u/npub1abc", profile("https://x.test/u"))
        assertEquals("web+nostr:nprofile1xyz", profile("web+nostr:{nprofile}"))
        assertEquals("https://njump.me/npub1abc", profile(""))
    }

    @Test
    fun `scheme allowlist - http, https and nostr only`() {
        for (ok in listOf("https://a.test/x", "http://a.test", "HTTPS://a.test", "nostr:npub1x", "web+nostr:npub1x")) {
            assertTrue(ok, ClientUrl.isAllowedLink(ok))
        }
        for (bad in listOf(
            "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd",
            "java\tscript:alert(1)", " javascript:alert(1)", "https ://x", "//evil.test", "evil.test/x", "ftp://x", "blob:https://x", "",
        )) {
            assertFalse(bad, ClientUrl.isAllowedLink(bad))
        }
    }

    @Test
    fun `unsafe templates are refused and never produce a link`() {
        assertNotNull(ClientUrl.validateTemplate("javascript:alert({npub})"))
        assertNotNull(ClientUrl.validateTemplate("data:text/html,{e}"))
        assertNull(ClientUrl.validateTemplate("https://x.test/{npub}"))
        assertNull(ClientUrl.validateTemplate("nostr:{e}"))
        assertNull(ClientUrl.validateTemplate(""))
        assertEquals("https://njump.me/npub1abc", profile("javascript:alert({npub})"))
        assertEquals("https://njump.me/nevent1q", ClientUrl.buildEventUrl("data:text/html,{e}", "nevent1q"))
        assertEquals("", ClientUrl.resolveTemplate("custom", "javascript:{e}"))
        assertEquals("", ClientUrl.resolveProfileTemplate("custom", "vbscript:{npub}"))
        assertEquals("https://a.test/{npub}", ClientUrl.resolveProfileTemplate("custom", "https://a.test/{npub}"))
    }

    @Test
    fun `presets - resolve, migrate, recognise`() {
        assertEquals("https://primal.net/e/{e}", ClientUrl.resolveTemplate("primal", ""))
        assertEquals("nostr:{npub}", ClientUrl.resolveProfileTemplate("app", ""))
        assertEquals("primal", ClientUrl.presetFromUrl("https://primal.net/e/"))
        assertEquals("custom", ClientUrl.presetFromUrl("https://elsewhere.test/"))
        assertTrue(ClientPreset.isPreset("app"))
        assertFalse(ClientPreset.isPreset("toString"))
        assertEquals("nostr:npub1x", ClientUrl.nostrUri("npub1x"))
        assertEquals("client", ClientPreset.label("custom"))
        assertEquals("Primal", ClientPreset.label("primal"))
    }
}
