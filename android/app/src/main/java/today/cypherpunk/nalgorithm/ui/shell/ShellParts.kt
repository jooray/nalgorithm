package today.cypherpunk.nalgorithm.ui.shell

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import androidx.compose.material.icons.automirrored.rounded.FormatListBulleted
import androidx.compose.material.icons.outlined.SmartDisplay
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.rounded.SmartDisplay
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.WifiOff
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import today.cypherpunk.nalgorithm.ui.theme.Nal

/** The three tabs, in the web's order (#tabbar). */
enum class Tab(val label: String, val id: String, val icon: ImageVector, val selectedIcon: ImageVector) {
    Feed("Feed", "feed", Icons.AutoMirrored.Outlined.FormatListBulleted, Icons.AutoMirrored.Rounded.FormatListBulleted),
    Digest("Digests", "digest", Icons.Outlined.SmartDisplay, Icons.Rounded.SmartDisplay),
    Tune("Tune", "tune", Icons.Outlined.Tune, Icons.Rounded.Tune);

    companion object {
        fun of(id: String?): Tab? = entries.firstOrNull { it.id == id }
    }
}

/**
 * Which tab is shown, remembered across launches (shell.ts `nalgorithm_last_tab`),
 * with a history so Back returns to the tab before, as the browser's back does.
 */
class TabNavigator(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    var current by mutableStateOf(Tab.of(prefs.getString(KEY, null)) ?: Tab.Feed)
        private set
    private val history = mutableStateListOf<Tab>()
    val canGoBack: Boolean get() = history.isNotEmpty()

    fun show(tab: Tab, remember: Boolean = true) {
        if (tab == current) return
        if (remember) {
            history.add(current)
            while (history.size > MAX_HISTORY) history.removeAt(0)
        }
        current = tab
        prefs.edit().putString(KEY, tab.id).apply()
    }

    fun back(): Boolean {
        val previous = history.removeLastOrNull() ?: return false
        current = previous
        prefs.edit().putString(KEY, previous.id).apply()
        return true
    }

    companion object {
        const val PREFS = "shell"
        private const val KEY = "last_tab"
        private const val MAX_HISTORY = 20
    }
}

/** The bottom tab bar: the accent marks the current tab, with a short bar along its top edge. */
@Composable
fun NalTabBar(current: Tab, onSelect: (Tab) -> Unit, modifier: Modifier = Modifier) {
    val c = Nal.colors
    Column(modifier.fillMaxWidth().background(c.tabbar)) {
        HorizontalDivider(color = c.line)
        Box(Modifier.fillMaxWidth().navigationBarsPadding(), contentAlignment = Alignment.TopCenter) {
            Row(Modifier.widthIn(max = Nal.column).fillMaxWidth().height(Nal.tabbarHeight).selectableGroup()) {
                for (tab in Tab.entries) {
                    val selected = tab == current
                    val tint = if (selected) c.accentInk else c.text2
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .selectable(selected = selected, role = Role.Tab, onClick = { onSelect(tab) }),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (selected) {
                            Box(
                                Modifier.align(Alignment.TopCenter).fillMaxWidth(0.44f).height(3.dp)
                                    .clip(RoundedCornerShape(bottomStart = 3.dp, bottomEnd = 3.dp)).background(c.accent),
                            )
                        }
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Icon(if (selected) tab.selectedIcon else tab.icon, contentDescription = null, tint = tint, modifier = Modifier.size(26.dp))
                            Text(tab.label, color = tint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}

/** On a wide window (an unfolded phone, a tablet) the tabs stand in a rail at the side. */
@Composable
fun NalTabRail(current: Tab, onSelect: (Tab) -> Unit, modifier: Modifier = Modifier) {
    val c = Nal.colors
    Row(modifier.fillMaxHeight()) {
        Column(
            Modifier.width(88.dp).fillMaxHeight().background(c.tabbar).statusBarsPadding().navigationBarsPadding().padding(top = 24.dp).selectableGroup(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for (tab in Tab.entries) {
                val selected = tab == current
                val tint = if (selected) c.accentInk else c.text2
                Column(
                    Modifier
                        .width(80.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .selectable(selected = selected, role = Role.Tab, onClick = { onSelect(tab) })
                        .padding(vertical = 10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(
                        Modifier.width(56.dp).height(32.dp).clip(RoundedCornerShape(16.dp)).background(if (selected) c.surface3 else c.tabbar),
                        contentAlignment = Alignment.Center,
                    ) { Icon(if (selected) tab.selectedIcon else tab.icon, contentDescription = null, tint = tint, modifier = Modifier.size(24.dp)) }
                    Text(tab.label, color = tint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        VerticalDivider(color = c.line)
    }
}

/** "You are offline." under the status bar, in the warning colour. */
@Composable
fun OfflineBanner(modifier: Modifier = Modifier) {
    val c = Nal.colors
    Column(modifier.fillMaxWidth().background(c.surface2)) {
        Row(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = Nal.gutter, vertical = 8.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.WifiOff, contentDescription = null, tint = c.warn, modifier = Modifier.size(20.dp))
            Text(
                "You are offline. Saved text and cached audio are available; uncached audio and new notes need a connection.",
                color = c.text, fontSize = 14.sp, lineHeight = 19.sp,
            )
        }
        HorizontalDivider(color = c.warn)
    }
}

/** Whether the phone has a usable connection, following ConnectivityManager. */
@Composable
fun rememberOnline(): State<Boolean> {
    val context = LocalContext.current
    val state = remember { mutableStateOf(isOnline(context)) }
    DisposableEffect(context) {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { state.value = isOnline(context) }
            override fun onLost(network: Network) { state.value = isOnline(context) }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) { state.value = isOnline(context) }
        }
        val request = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
        runCatching { cm.registerNetworkCallback(request, callback) }
        onDispose { runCatching { cm.unregisterNetworkCallback(callback) } }
    }
    return state
}

private fun isOnline(context: Context): Boolean {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val caps = cm.activeNetwork?.let(cm::getNetworkCapabilities) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
}
