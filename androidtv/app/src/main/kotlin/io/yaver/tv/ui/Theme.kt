package io.yaver.tv.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * TV theme — the lean-back design language shared by every screen.
 *
 * Mirrors the tvOS visual vocabulary (FrameworkStyle + DashboardView patterns):
 * near-black surfaces, large heavy type, one accent (brand purple), status
 * rendered as capsule chips (never grids), and focus states that read at
 * 10 feet (scale + accent border).
 */
object TvColors {
    private var theme by mutableStateOf("dark")
    fun applyTheme(value: String) { theme = if (value == "light") "light" else "dark" }
    private val light: Boolean get() = theme == "light"

    val Bg: Color get() = if (light) Color(0xFFF7F7F9) else Color(0xFF0B0B10)
    val Card: Color get() = if (light) Color(0xFFFFFFFF) else Color(0xFF16161E)
    val CardElevated: Color get() = if (light) Color(0xFFEFEFF3) else Color(0xFF1E1E29)
    val Border: Color get() = if (light) Color(0xFFD4D4D8) else Color(0xFF2A2A38)
    val TextPrimary: Color get() = if (light) Color(0xFF0A0A0F) else Color(0xFFF2F2F7)
    val TextSecondary: Color get() = if (light) Color(0xFF52525B) else Color(0xFFA6A6B8)
    val TextMuted: Color get() = if (light) Color(0xFF71717A) else Color(0xFF6E6E80)

    val Accent: Color get() = if (light) Color(0xFF6E56F6) else Color(0xFF7C6CF0)
    val AccentSoft: Color get() = if (light) Color(0x1F6E56F6) else Color(0x337C6CF0)

    val Green: Color get() = if (light) Color(0xFF16803A) else Color(0xFF34C759)
    val Orange: Color get() = if (light) Color(0xFFC76A00) else Color(0xFFFF9F0A)
    val Yellow: Color get() = if (light) Color(0xFFA16207) else Color(0xFFFFD60A)
    val Red: Color get() = if (light) Color(0xFFDC2626) else Color(0xFFFF453A)
    val Blue: Color get() = if (light) Color(0xFF2563EB) else Color(0xFF0A84FF)
    val Purple: Color get() = if (light) Color(0xFF9333EA) else Color(0xFFBF5AF2)

    val White = Color(0xFFFFFFFF)
}
