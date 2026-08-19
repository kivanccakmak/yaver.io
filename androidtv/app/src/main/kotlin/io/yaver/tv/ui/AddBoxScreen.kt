package io.yaver.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import io.yaver.tv.TvStore

/**
 * AddBoxScreen — manual "type an address" box entry. Three fields (Name, LAN
 * host/IP, optional Machine ID enabling Wake) + Save (disabled on empty host).
 * Manual boxes get id = host, so they can never be addressed by
 * /devices/request-update. Mirrors tvos/YaverTV/AddBoxView.swift.
 */
@Composable
fun AddBoxScreen(store: TvStore, nav: NavHostController) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var machineId by remember { mutableStateOf("") }

    Column(
        modifier = Modifier.fillMaxSize().background(TvColors.Bg).padding(48.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
        BackBar(title = "Type an address", subtitle = "Connect directly over the LAN", onBack = { nav.popBackStack() })
        Text(
            "A machine appears here once it's running `yaver serve` signed in as you. Type its LAN host or IP.",
            color = TvColors.TextSecondary,
            fontSize = 18.sp,
        )

        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Name") },
                singleLine = true,
                colors = fieldColors(),
            )
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text("LAN host or IP") },
                singleLine = true,
                colors = fieldColors(),
            )
            OutlinedTextField(
                value = machineId,
                onValueChange = { machineId = it },
                label = { Text("Machine ID (optional — enables Wake)") },
                singleLine = true,
                colors = fieldColors(),
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            TvTextButton(
                label = "Save",
                onClick = {
                    if (host.isNotBlank()) {
                        store.addBox(name, host, machineId.ifBlank { null })
                        nav.popBackStack()
                    }
                },
            )
            TvTextButton(label = "Cancel", onClick = { nav.popBackStack() })
        }
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = TvColors.TextPrimary,
    unfocusedTextColor = TvColors.TextPrimary,
    focusedBorderColor = TvColors.Accent,
    unfocusedBorderColor = TvColors.Border,
)
