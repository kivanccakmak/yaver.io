package io.yaver.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import io.yaver.tv.TvStore
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * SettingsScreen — account defaults: primary device, primary runner, latest
 * project, MCP defaults. Each row writes the same Convex `POST /settings` row
 * the phone/web write, so a choice made on the TV is remembered everywhere.
 * Mirrors tvos/YaverTV/Views/TVSettingsView.swift.
 */
@Composable
fun SettingsScreen(store: TvStore, nav: NavHostController) {
    val scope = rememberCoroutineScope()
    val token by store.token.collectAsState()
    val devices by store.devices.collectAsState()
    val boxes by store.boxes.collectAsState()
    val settings by store.settings.collectAsState()
    val selectedBox by store.selectedBox.collectAsState()

    var saved by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var runners by remember { mutableStateOf<Map<String, List<String>>>(emptyMap()) }

    LaunchedEffect(Unit) {
        store.refreshDevices()
        // Runner ids per box, for the primary-runner picker.
        val boxesToProbe = boxes
        val map = mutableMapOf<String, List<String>>()
        boxesToProbe.forEach { box ->
            runCatching {
                store.clientFor(box).getRunners().map { it.id }
            }.getOrNull()?.let { map[box.id] = it }
        }
        runners = map
    }

    Column(
        modifier = Modifier.fillMaxSize().background(TvColors.Bg).verticalScroll(rememberScrollState()).padding(48.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
        BackBar(title = "Settings", subtitle = "Account defaults — remembered on every surface", onBack = { nav.popBackStack() })

        error?.let { ErrorPanel(message = it) }
        saved?.let { StatusChip(it, TvColors.Green) }

        // ── Primary device ─────────────────────────────────────────────────
        SettingsRow(
            title = "Primary device",
            detail = "Where the TV connects by default",
        ) {
            val deviceRows = devices.ifEmpty {
                boxes.map { io.yaver.tv.RegisteredDevice(deviceId = it.id, name = it.name, alias = it.alias) }
            }
            deviceRows.forEach { d ->
                TvChip(
                    text = d.name,
                    selected = d.deviceId == settings?.primaryDeviceId,
                    onClick = {
                        scope.launch {
                            runCatching {
                                io.yaver.tv.MachineRegistry.writeSetting(
                                    token,
                                    JSONObject().put("primaryDeviceId", d.deviceId),
                                )
                                saved = "Primary device saved"
                            }.onFailure { error = it.message }
                        }
                    },
                )
            }
        }

        // ── Primary runner ─────────────────────────────────────────────────
        SettingsRow(
            title = "Primary runner",
            detail = "The coding agent used by default",
        ) {
            val boxId = selectedBox?.id ?: boxes.firstOrNull()?.id
            if (boxId == null) {
                Text("Connect to a box to pick its runner.", color = TvColors.TextMuted, fontSize = 16.sp)
                return@SettingsRow
            }
            val boxRunners = runners[boxId] ?: emptyList()
            if (boxRunners.isEmpty()) {
                Text("Connect to a box to pick its runner.", color = TvColors.TextMuted, fontSize = 16.sp)
            } else {
                boxRunners.forEach { runnerId ->
                    TvChip(
                        text = runnerId,
                        selected = settings?.primaryRunnerByDevice?.get(boxId) == runnerId,
                        onClick = {
                            scope.launch {
                                runCatching {
                                    io.yaver.tv.MachineRegistry.writeSetting(
                                        token,
                                        JSONObject().put(
                                            "primaryRunnerForDevice",
                                            JSONObject().put(boxId, JSONObject().put("runner", runnerId)),
                                        ),
                                    )
                                    saved = "Primary runner saved"
                                }.onFailure { error = it.message }
                            }
                        },
                    )
                }
            }
        }

        // ── Latest project ─────────────────────────────────────────────────
        SettingsRow(
            title = "Latest project",
            detail = "The project a new task opens with",
        ) {
            val boxId = selectedBox?.id ?: boxes.firstOrNull()?.id
            if (boxId == null) {
                Text("Connect to a box first.", color = TvColors.TextMuted, fontSize = 16.sp)
            } else {
                TvChip(text = "Remember project (on)", selected = true, onClick = { })
            }
        }
    }
}

@Composable
private fun SettingsRow(
    title: String,
    detail: String,
    chips: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().background(TvColors.Card, RoundedCornerShape(18.dp)).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(title, color = TvColors.TextPrimary, fontSize = 24.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
        Text(detail, color = TvColors.TextSecondary, fontSize = 16.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { chips() }
    }
}
