package io.yaver.tv.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.yaver.tv.BoxPhase

/**
 * WakeProgress — the big animated wake bar + step ladder, mirroring
 * tvos/YaverTV/Views/WakeProgressView.swift. Tint: cyan/cold → green when the
 * phase is on the network, red on error.
 */
@Composable
fun WakeProgress(phase: BoxPhase, percent: Int) {
    val barColor by animateColorAsState(
        when {
            phase == BoxPhase.NeedsAuth -> TvColors.Orange
            phase.isNetwork -> TvColors.Green
            else -> TvColors.Accent
        },
        tween(450),
    )
    val animated by animateFloatAsState(percent / 100f, tween(550))

    Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Text(phase.label, color = TvColors.TextPrimary, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        // Bar.
        Box(
            modifier = Modifier.fillMaxWidth().height(18.dp)
                .background(TvColors.Card, RoundedCornerShape(10.dp)),
        ) {
            Box(
                modifier = Modifier.fillMaxWidth(animated.coerceIn(0.02f, 1f)).height(18.dp)
                    .background(barColor, RoundedCornerShape(10.dp)),
            )
        }
        Text("$percent%", color = TvColors.TextSecondary, fontSize = 20.sp, fontFamily = FontFamily.Monospace)
        // Step ladder: Restoring → Booting → Connecting → Online → Ready.
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            BoxPhase.WAKE_STEPS.forEach { step ->
                val reached = step.percent <= percent
                val active = step == phase
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(
                        modifier = Modifier.size(18.dp)
                            .background(
                                when {
                                    reached -> barColor
                                    else -> TvColors.Border
                                },
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (reached) {
                            Text("✓", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    Text(
                        step.short,
                        color = if (active) TvColors.TextPrimary else TvColors.TextSecondary,
                        fontSize = 16.sp,
                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    )
                }
            }
        }
        Text("Coming up over the free relay — no re-auth needed.", color = TvColors.TextMuted, fontSize = 15.sp)
    }
}
