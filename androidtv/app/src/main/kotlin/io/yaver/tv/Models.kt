package io.yaver.tv

/**
 * Models — mirrors of the agent's JSON shapes, plus the BoxTarget transport
 * model. Field names match the Go agent and mobile/src/lib twins. Mirrors
 * tvos/YaverTV/Models.swift (BoxTarget + task/device shapes).
 */

const val AGENT_PORT = 18080
const val CONVEX_ORIGIN = "https://perceptive-minnow-557.eu-west-1.convex.site"
const val WEB_BASE = "https://yaver.io"

/** A box (device) the TV can drive — the same model as tvOS `BoxTarget`. */
data class BoxTarget(
    /** deviceId (or a stable local id; a manual Add-Box gets id = host). */
    val id: String,
    val name: String,
    /** Account-local alias. Optional/additive so old persisted boxes decode. */
    val alias: String? = null,
    /** LAN IP / hostname running `yaver serve`. */
    val host: String,
    val port: Int = AGENT_PORT,
    /** Set for a managed cloud box that can be woken from the control plane. */
    val managed: Boolean? = null,
    val machineId: String? = null,
    /** Relay reachability. `relayBaseUrl` is the relay's HTTPS origin; the
     *  proxy path `/d/<deviceId>/ops` is built from [id]. */
    val relayBaseUrl: String? = null,
    val relayPassword: String? = null,
) {
    val aliasLabel: String?
        get() {
            val a = alias ?: return null
            if (a.isEmpty() || a == name) return null
            return if (a.startsWith("@")) a else "@$a"
        }

    /** True when this box can be resumed from the TV (managed + has a machineId). */
    val wakeable: Boolean get() = (managed == true) && !machineId.isNullOrEmpty()

    data class Endpoint(val url: String, val relay: Boolean)

    /** Ordered /ops endpoints to try: direct first, relay second.
     *  Direct-first / relay-fallback is Yaver's documented connection strategy. */
    val opsEndpoints: List<Endpoint>
        get() = requestEndpoints("/ops")

    fun requestEndpoints(rawPath: String): List<Endpoint> {
        val path = if (rawPath.startsWith("/")) rawPath else "/$rawPath"
        val out = mutableListOf<Endpoint>()
        if (host.isNotEmpty()) {
            out.add(Endpoint("http://$host:$port$path", false))
        }
        val base = relayBaseUrl?.trim() ?: ""
        if (base.isNotEmpty() && id.isNotEmpty()) {
            val trimmed = if (base.endsWith("/")) base.dropLast(1) else base
            // Credentials never belong in a URL; OpsClient sets X-Relay-Password
            // on the relay leg only.
            out.add(Endpoint("$trimmed/d/$id$path", true))
        }
        return out
    }
}

/** One row of the account machine registry (GET /devices/list). */
data class RegisteredDevice(
    val deviceId: String,
    val name: String,
    val alias: String? = null,
    val platform: String? = null,
    val agentVersion: String? = null,
    val hosting: String? = null,
    val machineId: String? = null,
    val localIps: List<String> = emptyList(),
    val quicHost: String? = null,
    val lastSeenAt: Double? = null,
    val runnerIds: List<String> = emptyList(),
) {
    val isManaged: Boolean get() = hosting == "yaver-hosted" || !machineId.isNullOrEmpty()

    fun toBox(relayBaseUrl: String?, relayPassword: String?): BoxTarget {
        val host = (localIps.firstOrNull()?.takeIf { it.isNotBlank() } ?: quicHost) ?: ""
        return BoxTarget(
            id = deviceId,
            name = name,
            alias = alias,
            host = host,
            managed = if (isManaged) true else null,
            machineId = machineId,
            relayBaseUrl = relayBaseUrl,
            relayPassword = relayPassword,
        )
    }
}

data class DeviceList(val devices: List<RegisteredDevice>)

data class UserSettings(
    val relayUrl: String? = null,
    val relayPassword: String? = null,
    val primaryDeviceId: String? = null,
    val secondaryDeviceId: String? = null,
    val primaryRunnerByDevice: Map<String, String>? = null,
    val defaultRuntimeProjectByDevice: Map<String, Map<String, String>>? = null,
    val mcpServersByDevice: Map<String, Map<String, Any>>? = null,
)

data class AgentInfo(
    val hostname: String? = null,
    val platform: String? = null,
    val arch: String? = null,
    val agentVersion: String? = null,
    val deviceId: String? = null,
    val cpuPercent: Double? = null,
    val localIPs: List<String>? = null,
)

data class TaskCounts(val total: Int? = null, val running: Int? = null)

data class DevServerStatus(
    val running: Boolean? = null,
    val framework: String? = null,
    val port: Int? = null,
    val tasksTotal: Int? = null,
    val tasksRunning: Int? = null,
)

data class AgentStatus(
    val agentVersion: String? = null,
    val authExpired: Boolean? = null,
    val tasks: TaskCounts? = null,
    val devServer: DevServerStatus? = null,
)

/** A coding task (GET /tasks). */
data class TaskRow(
    val id: String,
    val title: String? = null,
    val status: String? = null,
    val runner: String? = null,
    val model: String? = null,
    val projectName: String? = null,
    val createdAt: Double? = null,
) {
    val safeTitle: String get() = redactHomePaths(title ?: "Untitled task")
}

data class TaskListEnvelope(val tasks: List<TaskRow>? = null)

/** A live tmux runner session (runner_sessions verb). */
data class RunnerSession(
    val name: String,
    val runner: String? = null,
    val attached: Boolean? = null,
) {
    val id: String get() = name
}

data class RunnerSessionList(val sessions: List<RunnerSession>? = null)

data class RunnerInfo(
    val id: String,
    val installed: Boolean = false,
    val ready: Boolean? = null,
    val models: List<ModelInfo> = emptyList(),
)

data class ModelInfo(val id: String, val name: String? = null, val isDefault: Boolean = false)

data class ProjectRow(
    val name: String,
    val path: String,
    val branch: String? = null,
    val framework: String? = null,
    val gitRemote: String? = null,
)

data class McpServer(val name: String, val enabled: Boolean = false)

/** Parse a project row, tolerating both `{task:…}` and bare shapes. */
fun parseTaskRow(obj: org.json.JSONObject): TaskRow? {
    val id = obj.optString("id").ifEmpty { obj.optString("taskId") }
    if (id.isEmpty()) return null
    return TaskRow(
        id = id,
        title = obj.optString("title").ifEmpty { null },
        status = obj.optString("status").ifEmpty { null },
        runner = obj.optString("runner").ifEmpty { null },
        model = obj.optString("model").ifEmpty { null },
        projectName = obj.optString("projectName").ifEmpty { null },
        createdAt = if (obj.has("createdAt")) obj.optDouble("createdAt") else null,
    )
}
