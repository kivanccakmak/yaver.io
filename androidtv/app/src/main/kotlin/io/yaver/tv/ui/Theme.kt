package io.yaver.tv.ui

import androidx.compose.ui.graphics.Color

/**
 * TV theme — the lean-back design language shared by every screen.
 *
 * Mirrors the tvOS visual vocabulary (FrameworkStyle + DashboardView patterns):
 * near-black surfaces, large heavy type, one accent (brand purple), status
 * rendered as capsule chips (never grids), and focus states that read at
 * 10 feet (scale + accent border).
 */
object TvColors {
    val Bg = Color(0xFF0B0B10)
    val Card = Color(0xFF16161E)
    val CardElevated = Color(0xFF1E1E29)
    val Border = Color(0xFF2A2A38)
    val TextPrimary = Color(0xFFF2F2F7)
    val TextSecondary = Color(0xFFA6A6B8)
    val TextMuted = Color(0xFF6E6E80)

    val Accent = Color(0xFF7C6CF0)
    val AccentSoft = Color(0x337C6CF0)

    val Green = Color(0xFF34C759)
    val Orange = Color(0xFFFF9F0A)
    val Yellow = Color(0xFFFFD60A)
    val Red = Color(0xFFFF453A)
    val Blue = Color(0xFF0A84FF)
    val Purple = Color(0xFFBF5AF2)

    val White = Color(0xFFFFFFFF)
}
