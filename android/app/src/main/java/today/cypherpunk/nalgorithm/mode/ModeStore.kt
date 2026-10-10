package today.cypherpunk.nalgorithm.mode

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import today.cypherpunk.nalgorithm.model.AppMode

/** Which mode the app runs in. Null until the reader chooses (the choice screen). */
class ModeStore(context: Context) {
    private val prefs = context.getSharedPreferences("mode", Context.MODE_PRIVATE)
    private val _mode = MutableStateFlow(read())
    val mode: StateFlow<AppMode?> = _mode.asStateFlow()

    private fun read(): AppMode? = when (prefs.getString("mode", null)) {
        "hosted" -> AppMode.Hosted
        "byok" -> AppMode.Byok
        else -> null
    }

    fun set(mode: AppMode?) {
        prefs.edit().apply {
            if (mode == null) remove("mode") else putString("mode", if (mode == AppMode.Hosted) "hosted" else "byok")
        }.apply()
        _mode.value = mode
    }
}
