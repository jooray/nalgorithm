package today.cypherpunk.nalgorithm.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * The web app's design tokens (web/src/style.css `:root`), dark by default and
 * the warm light palette when the system is light. Use [Nal.colors] for tokens
 * Material has no slot for (hero, accent ink, warn…); everything else goes
 * through MaterialTheme.colorScheme, which is mapped from the same tokens.
 */
@Immutable
data class NalColors(
    val bg: Color,
    val surface: Color,
    val surface2: Color,
    val surface3: Color,
    val line: Color,
    val text: Color,
    val text2: Color,
    val text3: Color,
    val accent: Color,
    val onAccent: Color,
    val accentInk: Color,
    val hero: Color,
    val onHero: Color,
    val onHero2: Color,
    val heroPill: Color,
    val waveOn: Color,
    val waveOff: Color,
    val danger: Color,
    val dangerBg: Color,
    val warn: Color,
    val warnBg: Color,
    val tabbar: Color,
    val scrim: Color,
)

val DarkNal = NalColors(
    bg = Color(0xFF0B0B10), surface = Color(0xFF14141B), surface2 = Color(0xFF1D1D27), surface3 = Color(0xFF2A2A37),
    line = Color(0xFF2A2A37), text = Color.White, text2 = Color(0xFFB4B4C6), text3 = Color(0xFF9393AA),
    accent = Color(0xFFC6F135), onAccent = Color(0xFF0B0B10), accentInk = Color(0xFFC6F135),
    hero = Color(0xFF6B3DF5), onHero = Color.White, onHero2 = Color(0xE0FFFFFF), heroPill = Color(0x4D0B0B10),
    waveOn = Color.White, waveOff = Color(0x4DFFFFFF),
    danger = Color(0xFFFF8A98), dangerBg = Color(0x1FFF5A6E), warn = Color(0xFFFFC857), warnBg = Color(0x1FFFC857),
    tabbar = Color(0xFF0F0F15), scrim = Color(0x9E000000),
)

val LightNal = DarkNal.copy(
    bg = Color(0xFFFAF7F2), surface = Color.White, surface2 = Color(0xFFF2EDE4), surface3 = Color(0xFFE7E0D3),
    line = Color(0xFFE3DCCF), text = Color(0xFF17151F), text2 = Color(0xFF4F4C63), text3 = Color(0xFF605D73),
    accent = Color(0xFF3F6B00), onAccent = Color.White, accentInk = Color(0xFF3F6B00),
    danger = Color(0xFFB3261E), dangerBg = Color(0x14B3261E), warn = Color(0xFF8A5A00), warnBg = Color(0x1A8A5A00),
    tabbar = Color.White, scrim = Color(0x8017151F),
)

val LocalNalColors = staticCompositionLocalOf { DarkNal }

object Nal {
    val colors: NalColors @Composable get() = LocalNalColors.current
    /** --radius / --radius-sm / --gutter */
    val radius = 18.dp
    val radiusSmall = 12.dp
    val gutter = 16.dp
    /** --column: content never grows wider than this on a tablet or unfolded phone. */
    val column = 680.dp
    /** --tabbar-h */
    val tabbarHeight = 64.dp
    /** Wider than this, the tab bar becomes a navigation rail (an unfolded phone, a tablet). */
    val railFrom = 720.dp
    /** Sheets rise with a larger radius than cards (dialog.sheet). */
    val sheetRadius = 28.dp
}

/** style.css type scale: Inter on the web; the platform sans here, with the same weights and tracking. */
private val NalTypography = Typography().let { t ->
    t.copy(
        // .gate-title
        displaySmall = t.displaySmall.copy(fontSize = 40.sp, lineHeight = 42.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.035).em),
        // .view-head h1
        headlineLarge = t.headlineLarge.copy(fontSize = 32.sp, lineHeight = 38.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.03).em),
        // .section-head h2, .tune-section h2, .state-card h2
        titleLarge = t.titleLarge.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.02).em),
        titleMedium = t.titleMedium.copy(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.Bold),
        titleSmall = t.titleSmall.copy(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Bold),
        bodyLarge = t.bodyLarge.copy(fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = 0.sp),
        bodyMedium = t.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp, letterSpacing = 0.sp),
        bodySmall = t.bodySmall.copy(fontSize = 13.sp, lineHeight = 19.sp, letterSpacing = 0.sp),
        labelLarge = t.labelLarge.copy(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.sp),
        labelMedium = t.labelMedium.copy(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.01.em),
        labelSmall = t.labelSmall.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.01.em),
    )
}

/** Small text styles the Material scale has no name for. */
object NalText {
    /** .field-hint */
    val hint = TextStyle(fontSize = 13.sp, lineHeight = 19.5.sp)
    /** label (form field captions) */
    val fieldLabel = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold)
    /** .status, .form-status */
    val status = TextStyle(fontSize = 14.sp, lineHeight = 20.sp)
}

@Composable
fun NalgorithmTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val c = if (dark) DarkNal else LightNal
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = c.accent, onPrimary = c.onAccent,
        primaryContainer = c.surface3, onPrimaryContainer = c.text,
        secondary = c.hero, onSecondary = c.onHero,
        secondaryContainer = c.surface3, onSecondaryContainer = c.accentInk,
        tertiary = c.accentInk,
        background = c.bg, onBackground = c.text,
        surface = c.bg, onSurface = c.text,
        surfaceVariant = c.surface2, onSurfaceVariant = c.text2,
        surfaceContainerLowest = c.bg, surfaceContainerLow = c.surface, surfaceContainer = c.surface,
        surfaceContainerHigh = c.surface2, surfaceContainerHighest = c.surface3,
        inverseSurface = c.surface3, inverseOnSurface = c.text, inversePrimary = c.accentInk,
        outline = c.line, outlineVariant = c.line,
        error = c.danger, onError = c.bg, errorContainer = c.dangerBg, onErrorContainer = c.danger,
        scrim = c.scrim,
    )
    CompositionLocalProvider(LocalNalColors provides c) {
        MaterialTheme(
            colorScheme = scheme,
            typography = NalTypography,
            shapes = Shapes(
                extraSmall = RoundedCornerShape(8.dp),
                small = RoundedCornerShape(Nal.radiusSmall),
                medium = RoundedCornerShape(Nal.radiusSmall),
                large = RoundedCornerShape(Nal.radius),
                extraLarge = RoundedCornerShape(Nal.sheetRadius),
            ),
        ) {
            // Text outside a Surface would otherwise fall back to black, invisible on the dark ground.
            CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides c.text, content = content)
        }
    }
}
