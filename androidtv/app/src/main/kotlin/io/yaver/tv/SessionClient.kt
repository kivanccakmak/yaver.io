package io.yaver.tv

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** The full session-turn result (pane + options + awaitingChoice) so the TV can
 *  render more than a watch — mirrors tvOS SessionTurnResult. */
data class SessionTurnResult(
    val ok: Boolean? = null,
    val session: String? = null,
    val runner: String? = null,
    val sent: String? = null, // "prompt" or "choice"
    val awaitingChoice: Boolean? = null,
    val options: List<String> = emptyList(),
    val pane: String? = null,
    val error: String? = null,
)

/**
 * SessionClient — drives a LIVE coding session via POST /runner/session/turn,
 * with runtime_turn (the ops verb) as the primary path and the direct endpoint
 * as a rollout fallback for older agents. The four server-side guards are
 * honored by the endpoint — 409s carry the same body as 200.
 *
 * Mirrors tvos/YaverTV/SessionClient.swift.
 */
class SessionClient(
    initialBox: BoxTarget,
    private val token: String,
    private val relayRepair: suspend () -> BoxTarget? = { null },
) {
    @Volatile
    private var box: BoxTarget = initialBox

    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    /** Send a prompt to a named session. `session` is not optional-by-accident:
     *  omitting it makes the agent guess, and the guess can drive the WRONG
     *  tmux window (a personal Claude session whose scrollback renders back
     *  onto a television). Name the session. */
    suspend fun sendText(
        text: String,
        session: String?,
        workDir: String? = null,
        mcpServers: List<String> = emptyList(),
        includeYaverMcp: Boolean = false,
    ): SessionTurnResult = turn(text, null, session, workDir, mcpServers, includeYaverMcp)

    /** Answer a menu the pane is showing. */
    suspend fun sendChoice(choice: String, session: String?): SessionTurnResult =
        turn(null, choice, session, null, emptyList(), false)

    /** List recent runtime turns for a TV dashboard. Returns [] rather than
     *  throwing when the agent is too old to know the verb. */
    suspend fun runtimeTurns(limit: Int = 25): JSONArray = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject()
                .put("verb", "runtime_turns")
                .put("payload", JSONObject().put("limit", limit))
                .put("machine", "local")
            val data = request("POST", "/ops", body, emptySet()).body
            val obj = runCatching { JSONObject(String(data)) }.getOrNull() ?: return@runCatching JSONArray()
            obj.optJSONObject("initial")?.optJSONArray("items") ?: obj.optJSONArray("items") ?: JSONArray()
        }.getOrDefault(JSONArray())
    }

    private suspend fun turn(
        text: String?,
        choice: String?,
        session: String?,
        workDir: String?,
        mcpServers: List<String>,
        includeYaverMcp: Boolean,
    ): SessionTurnResult {
        return runCatching {
            runtimeTurn(text, choice, session, workDir, mcpServers, includeYaverMcp)
        }.getOrElse { e ->
            // Older agents do not have runtime_turn yet — direct endpoint.
            if (e is CancellationException) throw e
            directTurn(text, choice, session)
        }
    }

    private suspend fun runtimeTurn(
        text: String?,
        choice: String?,
        session: String?,
        workDir: String?,
        mcpServers: List<String>,
        includeYaverMcp: Boolean,
    ): SessionTurnResult = withContext(Dispatchers.IO) {
        val target = JSONObject()
        if (!session.isNullOrEmpty()) target.put("session", session)
        val payload = JSONObject()
            .put("utterance", text ?: "")
            .put("target", target)
            .put(
                "surface",
                JSONObject()
                    .put("id", "tv-android")
                    .put("class", "tv-android")
                    .put("interaction", "dpad")
                    .put("visualBudget", "panel")
                    .put("riskPolicy", "shared-tv")
                    .put("ttsBudget", 240)
                    .put("replyTo", "androidtv"),
            )
            .put(
                "development",
                JSONObject()
                    .put(
                        "queue",
                        JSONObject()
                            .put("mode", "run")
                            .put("priority", "normal")
                            .put("afterFinish", JSONArray(listOf("load-mobile-container", "ask-deploy"))),
                    )
                    .put("meta", JSONObject().put("source", "androidtv-session")),
            )
            .put("mode", "run")
        if (!choice.isNullOrEmpty()) payload.put("choice", choice)
        if (!workDir.isNullOrEmpty()) payload.put("workDir", workDir)
        if (mcpServers.isNotEmpty()) payload.put("mcpServers", JSONArray(mcpServers))
        payload.put("includeYaverMcp", includeYaverMcp)

        val body = JSONObject()
            .put("verb", "runtime_turn")
            .put("payload", payload)
            .put("machine", "local")
        val data = request("POST", "/ops", body, emptySet()).body
        val env = runCatching { JSONObject(String(data)) }.getOrNull() ?: throw AgentError("runtime turn returned no result")
        if (env.optBoolean("ok", true) == false) throw AgentError(env.optString("error").ifEmpty { "runtime turn failed" })
        val result = env.optJSONObject("initial") ?: throw AgentError("runtime turn returned no result")
        if (result.optBoolean("ok", true) == false) {
            val err = result.optString("error")
            if (err.isNotEmpty()) throw AgentError(err)
        }
        val queue = result.optJSONObject("queue")
        SessionTurnResult(
            ok = if (result.has("ok")) result.optBoolean("ok") else null,
            session = queue?.optString("session")?.ifEmpty { null },
            runner = queue?.optString("runner")?.ifEmpty { null },
            sent = if (choice == null) "prompt" else "choice",
            awaitingChoice = if (result.has("awaitingChoice")) result.optBoolean("awaitingChoice") else null,
            options = result.optJSONArray("options")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList(),
            pane = result.optJSONObject("panel")?.optString("text")?.ifEmpty { null }
                ?: result.optString("spoken").ifEmpty { null },
            error = result.optString("error").ifEmpty { null },
        )
    }

    private suspend fun directTurn(text: String?, choice: String?, session: String?): SessionTurnResult =
        withContext(Dispatchers.IO) {
            val body = JSONObject().put("waitMs", 6000)
            if (!text.isNullOrEmpty()) body.put("text", text)
            if (!choice.isNullOrEmpty()) body.put("choice", choice)
            if (!session.isNullOrEmpty()) body.put("session", session)
            val data = request("POST", "/runner/session/turn", body, setOf(409)).body
            val o = runCatching { JSONObject(String(data)) }.getOrNull() ?: throw AgentError("session turn returned no result")
            SessionTurnResult(
                ok = if (o.has("ok")) o.optBoolean("ok") else null,
                session = o.optString("session").ifEmpty { null },
                runner = o.optString("runner").ifEmpty { null },
                sent = if (o.has("sent")) o.optString("sent") else (if (choice == null) "prompt" else "choice"),
                awaitingChoice = if (o.has("awaitingChoice")) o.optBoolean("awaitingChoice") else null,
                options = o.optJSONArray("options")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList(),
                pane = o.optString("pane").ifEmpty { null },
                error = o.optString("error").ifEmpty { null },
            )
        }

    /** Same LAN-first/relay-second two-pass request core as OpsClient. */
    private suspend fun request(method: String, path: String, body: JSONObject?, extraOK: Set<Int>): HttpResult {
        var repairedOnce = false
        var lastError: Throwable = AgentError("request failed: $method $path")
        repeat(2) {
            val endpoints = box.requestEndpoints(path)
            if (endpoints.isEmpty()) throw AgentError("bad box host")
            var innerError: Throwable? = null
            var repairThisPass = false
            for (endpoint in endpoints) {
                val rb = Request.Builder()
                    .url(endpoint.url)
                    .header("Authorization", "Bearer $token")
                    .header("X-Yaver-Surface", TV_SURFACE_ID)
                if (endpoint.relay) {
                    box.relayPassword?.takeIf { it.isNotEmpty() }?.let { pw -> rb.header("X-Relay-Password", pw) }
                }
                val req = when (method) {
                    "GET" -> rb.get().build()
                    else -> rb.method(method, body?.toString()?.toRequestBody(JSON)).build()
                }
                var resp: okhttp3.Response? = null
                try {
                    resp = http.newCall(req).execute()
                    val bytes = resp.body?.bytes() ?: ByteArray(0)
                    if (resp.isSuccessful || extraOK.contains(resp.code)) return HttpResult(bytes, resp.code)
                    val errMessage = runCatching {
                        JSONObject(String(bytes)).optString("error").ifEmpty { null }
                    }.getOrNull()
                    if (errMessage != null) {
                        if (endpoint.relay && FailureSignals.isRelayCredentialDeny(errMessage) && !repairedOnce) {
                            val repaired = relayRepair()
                            if (repaired != null) {
                                box = repaired
                                repairedOnce = true
                                innerError = AgentError(errMessage, relayDeny = true)
                                repairThisPass = true
                                break
                            }
                        }
                        throw AgentError(errMessage, relayDeny = endpoint.relay && FailureSignals.isRelayCredentialDeny(errMessage))
                    }
                    innerError = AgentError("$path (${resp.code})")
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    innerError = e
                } finally {
                    resp?.close()
                }
            }
            lastError = innerError ?: lastError
            if (!repairThisPass) throw lastError
        }
        throw lastError
    }
}
