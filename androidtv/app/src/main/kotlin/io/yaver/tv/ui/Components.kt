package io.yaver.tv.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.RowScope

/**
 * Shared TV components — the lean-back building blocks. Focus styling is the
 * same everywhere: a focusable element lifts (scale 1.04) and lights its
 * border with the accent color so a D-pad lands somewhere readable at 10 feet.
 */

@Composable
fun StatusChip(text: String, color: Color, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .background(color.copy(alpha = 0.14f), CircleShape)
            .padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Text(
            text,
            color = color,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/** A rounded material surface used by every card. */
@Composable
fun TvCard(
    modifier: Modifier = Modifier,
    shape: RoundedCornerShape = RoundedCornerShape(18.dp),
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = modifier
            .background(TvColors.Card, shape)
            .padding(24.dp),
        content = content,
    )
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier,
        color = TvColors.TextMuted,
        fontSize = 14.sp,
        fontWeight = FontWeight.Black,
        letterSpacing = 1.sp,
    )
}

/** A focusable pill used for config options (Remote Box / Project / Agent). */
@Composable
fun TvChip(
    text: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    val borderColor = when {
        !enabled -> TvColors.Border
        focused -> TvColors.Accent
        selected -> TvColors.Accent
        else -> TvColors.Border
    }
    val bg = when {
        !enabled -> TvColors.Card.copy(alpha = 0.4f)
        focused -> TvColors.Accent
        selected -> TvColors.AccentSoft
        else -> TvColors.Card
    }
    val textColor = when {
        !enabled -> TvColors.TextMuted
        focused -> TvColors.White
        selected -> TvColors.Accent
        else -> TvColors.TextPrimary
    }
    Box(
        modifier = modifier
            .border(1.dp, borderColor, RoundedCornerShape(10.dp))
            .background(bg, RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .focusable(enabled)
            .onFocusChanged { focused = it.hasFocus }
            .padding(horizontal = 22.dp, vertical = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            color = textColor,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

/** The big dashboard tile — icon + title, one predictable rail. */
@Composable
fun TvTile(
    icon: String,
    title: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    Column(
        modifier = modifier
            .size(width = 216.dp, height = 82.dp)
            .border(
                BorderStroke(if (focused) 2.dp else 1.dp, if (focused) TvColors.Accent else TvColors.Border),
                RoundedCornerShape(16.dp),
            )
            .background(if (focused) TvColors.Accent else TvColors.Card, RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .focusable()
            .onFocusChanged { focused = it.hasFocus }
            .padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(icon, fontSize = 28.sp, color = if (focused) TvColors.White else TvColors.Accent)
            Text(
                title,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (focused) TvColors.White else TvColors.TextPrimary,
                maxLines = 1,
            )
        }
    }
}

/** A focusable text button (secondary action / back / try-again). */
@Composable
fun TvTextButton(
    label: String,
    modifier: Modifier = Modifier,
    danger: Boolean = false,
    onClick: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    val borderColor = if (focused) TvColors.Accent else TvColors.Border
    Row(
        modifier = modifier
            .border(2.dp, borderColor, RoundedCornerShape(14.dp))
            .background(if (focused) TvColors.Accent else TvColors.Card, RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .focusable()
            .onFocusChanged { focused = it.hasFocus }
            .padding(horizontal = 24.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            label,
            color = when {
                danger -> TvColors.Red
                focused -> TvColors.White
                else -> TvColors.TextSecondary
            },
            fontSize = 18.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/** Error panel with a Try-again route — a named cause is never a bare line. */
@Composable
fun ErrorPanel(
    message: String,
    modifier: Modifier = Modifier,
    retryLabel: String? = "Try again",
    onRetry: (() -> Unit)? = null,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(TvColors.Card, RoundedCornerShape(18.dp))
            .padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(message, color = TvColors.Red, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        if (retryLabel != null && onRetry != null) {
            TvTextButton(label = retryLabel, onClick = onRetry)
        }
    }
}

/** The back bar used at the top of pushed screens. */
@Composable
fun BackBar(
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
    onBack: () -> Unit,
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TvTextButton(label = "← Back", onClick = onBack)
        Text(title, color = TvColors.TextPrimary, fontSize = 44.sp, fontWeight = FontWeight.Black)
        if (subtitle != null) {
            Text(subtitle, color = TvColors.TextSecondary, fontSize = 18.sp)
        }
    }
}
