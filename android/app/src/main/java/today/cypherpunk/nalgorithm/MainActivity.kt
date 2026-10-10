package today.cypherpunk.nalgorithm

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import today.cypherpunk.nalgorithm.ui.shell.AppRoot
import today.cypherpunk.nalgorithm.ui.theme.NalgorithmTheme

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        graph.audio.onLaunch()
        setContent {
            NalgorithmTheme {
                AppRoot(graph)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }
}
