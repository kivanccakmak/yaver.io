package io.yaver.tv

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

/** One SSE event: the `event:` type plus the raw `data:` payload. */
data class SseEvent(val type: String?, val data: String)

/**
 * Sse — a minimal server-sent-events reader over OkHttp, driven as a cold
 * [Flow]. Reads blocking from the response body on [Dispatchers.IO] and emits
 * every `event:` + `data:` pair. The flow completes when the server closes the
 * stream or the collector cancels.
 *
 * Mirrors the SSE parsing in tvOS AgentClient.subscribeTaskOutput / the mobile
 * eventSource usage: `connected` is signalled the moment bytes start flowing so
 * a caller never walks on to a second endpoint after a successful connect.
 */
object Sse {

    @OptIn(ExperimentalCoroutinesApi::class)
    fun stream(
        client: OkHttpClient,
        request: Request,
        ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    ): Flow<SseEvent> = callbackFlow {
        val job = CoroutineScope(ioDispatcher).launch {
            var response: Response? = null
            try {
                response = client.newCall(request).execute()
                val body = response.body ?: throw IllegalStateException("no response body")
                val reader = BufferedReader(InputStreamReader(body.byteStream(), Charsets.UTF_8))
                var eventType: String? = null
                val dataLines = StringBuilder()
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) {
                        // Blank line ends the event.
                        if (dataLines.isNotEmpty()) {
                            val data = dataLines.toString()
                            if (!trySendBlocking(SseEvent(eventType, data)).isSuccess) break
                            eventType = null
                            dataLines.setLength(0)
                        }
                        continue
                    }
                    when {
                        line.startsWith("event:") -> eventType = line.removePrefix("event:").trim()
                        line.startsWith("data:") -> {
                            if (dataLines.isNotEmpty()) dataLines.append('\n')
                            dataLines.append(line.removePrefix("data:").trimStart())
                        }
                        line.startsWith(":") -> { /* comment — keep-alive */ }
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Swallow into flow completion — callers classify via
                // FailureSignals.classifyStreamEnd rather than an exception.
            } finally {
                response?.close()
            }
        }
        awaitClose { job.cancel() }
    }

    /** Parse a `data:` payload as JSON. */
    fun dataToJson(event: SseEvent): JSONObject? =
        runCatching { JSONObject(event.data) }.getOrNull()
}
