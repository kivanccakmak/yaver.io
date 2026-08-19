package io.yaver.tv

import androidx.compose.ui.graphics.Color

/**
 * FrameworkStyle — framework icon + brand color, matched to mobile and tvOS.
 *
 * Mirrors mobile/src/components/FrameworkIcon.tsx (source of truth for the
 * brand colors) and tvos/YaverTV/FrameworkStyle.swift (the SF Symbol mapping).
 * The TV app uses a Unicode glyph per framework since Material icon sets are
 * not loaded here.
 */
data class FrameworkStyle(val glyph: String, val color: Color) {
    companion object {
        private fun hex(v: Long): Color = Color(0xFF000000 or v)

        fun of(framework: String?): FrameworkStyle {
            return when ((framework ?: "").lowercase()) {
                "expo" -> FrameworkStyle("◈", hex(0xA78BFA))
                "react-native", "reactnative", "rn", "react" -> FrameworkStyle("◈", hex(0x61DAFB))
                "flutter" -> FrameworkStyle("⬥", hex(0x42A5F5))
                "swift" -> FrameworkStyle("S", hex(0xFA7343))
                "kotlin" -> FrameworkStyle("K", hex(0x7F52FF))
                "nextjs", "next" -> FrameworkStyle("▲", hex(0xFAFAFA))
                "vite" -> FrameworkStyle("⚡", hex(0xFFC107))
                "remix", "astro", "svelte", "web" -> FrameworkStyle("◍", hex(0x94A3B8))
                else -> FrameworkStyle("▣", hex(0x94A3B8))
            }
        }
    }
}
