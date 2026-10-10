package today.cypherpunk.nalgorithm.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechTextTest {
    @Test fun `short sentences join into one chunk per paragraph`() {
        assertEquals(listOf("Good morning. Here is the news!", "Second paragraph?"), splitForSpeech("Good morning. Here is the news!\n\nSecond paragraph?"))
    }

    @Test fun `chunks never exceed the limit and keep every word`() {
        val text = (1..60).joinToString(" ") { "Sentence number $it is here." }
        val chunks = splitForSpeech(text, 80)
        assertTrue(chunks.all { it.length <= 80 })
        assertEquals(text.split(" ").filter { it.isNotEmpty() }, chunks.joinToString(" ").split(" "))
    }

    @Test fun `terminators and closing quotes stay with their sentence`() {
        val chunks = splitForSpeech("He said \"hi.\" Then left. " + "x".repeat(10), 20)
        assertEquals("He said \"hi.\"", chunks[0])
    }

    @Test fun `an overlong sentence breaks on commas, then words`() {
        val long = "alpha beta gamma, delta epsilon zeta, eta theta iota kappa lambda mu nu xi omicron pi rho"
        val chunks = splitForSpeech(long, 30)
        assertTrue(chunks.all { it.length <= 30 })
        assertEquals("alpha beta gamma,", chunks[0])
        assertEquals(long, chunks.joinToString(" "))
    }

    @Test fun `an unbreakable token is cut hard`() {
        val url = "https://" + "a".repeat(50)
        val chunks = splitForSpeech(url, 20)
        assertTrue(chunks.all { it.length <= 20 })
        assertEquals(url, chunks.joinToString(""))
    }

    @Test fun `empty text has no chunks`() {
        assertEquals(emptyList<String>(), splitForSpeech("  \n\n  "))
    }
}
