package io.yaver.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import io.yaver.tv.AgentError
import io.yaver.tv.TaskRow
import io.yaver.tv.TvStore
import kotlinx.coroutines.launch

/**
 * PLACEHOLDER screens for the Phase 2/3 routes — replaced by the real
 * implementations in TasksScreen.kt / TaskComposerScreen.kt / TaskDetailScreen.kt /
 * SessionScreen.kt / VibingScreen.kt / PreviewStreamScreen.kt /
 * DroidStreamScreen.kt. Kept in one file so the navigation host compiles while
 * the surface is built out incrementally.
 */
@Composable
private fun placeholder(modifier: Modifier, title: String) {
    Column(
        modifier = modifier.fillMaxSize().background(TvColors.Bg).padding(56.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(title, color = TvColors.TextPrimary, fontSize = 40.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Black)
        Text("Under construction — the Phase 2/3 surface lands next.", color = TvColors.TextSecondary, fontSize = 18.sp)
    }
}

@Composable
fun TasksScreen(store: TvStore, nav: NavHostController) {
    val box by store.selectedBox.collectAsState()
    val scope = rememberCoroutineScope()
    var tasks by remember { mutableStateOf<List<TaskRow>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    fun reload() {
        scope.launch {
            loading = true
            error = null
            try {
                tasks = box?.let { store.clientFor(it).getTasks() }.orEmpty()
            } catch (e: Throwable) {
                error = (e as? AgentError)?.message ?: e.message ?: "Couldn't load tasks."
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(box?.id) { reload() }

    Column(
        modifier = Modifier.fillMaxSize().background(TvColors.Bg).padding(56.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        BackBar("Tasks", box?.name?.let { "Coding work on $it" }, onBack = { nav.popBackStack() })
        TvTextButton("Refresh", onClick = ::reload)
        when {
            box == null -> {
                Text("remoteless.code-edit.unavailable", color = TvColors.Orange, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Text("Android TV has no phone-local repository or safe background coding runtime. Choose your primary/secondary machine; use Cloud Workspace when neither can provide the required capability.", color = TvColors.TextSecondary, fontSize = 20.sp)
                TvTextButton("Choose a capable device", onClick = { nav.navigate(Routes.MACHINES) })
            }
            loading -> Text("Loading tasks…", color = TvColors.TextSecondary, fontSize = 22.sp)
            error != null -> ErrorPanel(error!!, onRetry = ::reload)
            tasks.isEmpty() -> Text("No tasks on this machine yet.", color = TvColors.TextSecondary, fontSize = 22.sp)
            else -> LazyColumn(
                verticalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                items(tasks, key = { it.id }) { task ->
                    TaskCard(task) { nav.navigate(Routes.taskDetail(task.id)) }
                }
            }
        }
    }
}

@Composable
fun TaskComposerScreen(store: TvStore, nav: NavHostController) {
    placeholder(Modifier, "New task")
}

@Composable
fun TaskDetailScreen(store: TvStore, nav: NavHostController, taskId: String) {
    val box by store.selectedBox.collectAsState()
    val scope = rememberCoroutineScope()
    var task by remember { mutableStateOf<org.json.JSONObject?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    fun reload() {
        scope.launch {
            loading = true
            error = null
            try { task = box?.let { store.clientFor(it).getTask(taskId) } }
            catch (e: Throwable) { error = (e as? AgentError)?.message ?: e.message ?: "Couldn't load this task." }
            finally { loading = false }
        }
    }
    LaunchedEffect(box?.id, taskId) { reload() }
    Column(
        modifier = Modifier.fillMaxSize().background(TvColors.Bg).padding(56.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        BackBar("Task", taskId, onBack = { nav.popBackStack() })
        when {
            loading -> Text("Loading task…", color = TvColors.TextSecondary, fontSize = 22.sp)
            error != null -> ErrorPanel(error!!, onRetry = ::reload)
            task != null -> {
                Text(task!!.optString("title").ifEmpty { "Untitled task" }, color = TvColors.TextPrimary, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Text("Status · ${task!!.optString("status").ifEmpty { "unknown" }}", color = TvColors.Accent, fontSize = 20.sp)
                task!!.optString("description").takeIf { it.isNotEmpty() }?.let {
                    Text(it, color = TvColors.TextSecondary, fontSize = 20.sp)
                }
                TvTextButton("Refresh", onClick = ::reload)
            }
        }
    }
}

@Composable
private fun TaskCard(task: TaskRow, onClick: () -> Unit) {
    val status = task.status?.ifEmpty { "unknown" } ?: "unknown"
    TvCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).focusable(),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
            Text(task.safeTitle, color = TvColors.TextPrimary, fontSize = 23.sp, fontWeight = FontWeight.Bold)
            Text(
                listOfNotNull(status, task.projectName, task.runner ?: task.model).joinToString(" · "),
                color = statusColor(status),
                fontSize = 17.sp,
            )
        }
        Text("Select ›", color = TvColors.TextSecondary, fontSize = 17.sp)
    }
}

private fun statusColor(status: String): Color = when (status.lowercase()) {
    "running", "queued" -> TvColors.Accent
    "completed", "review" -> TvColors.Green
    "failed", "cancelled" -> TvColors.Red
    else -> TvColors.TextSecondary
}


@Composable
fun SessionScreen(store: TvStore, nav: NavHostController) {
    placeholder(Modifier, "Session")
}

@Composable
fun VibingScreen(store: TvStore, nav: NavHostController) {
    val box by store.selectedBox.collectAsState()
    Column(
        modifier = Modifier.fillMaxSize().background(TvColors.Bg).padding(56.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        BackBar("Vibing", box?.name?.let { "Render on $it" }, onBack = { nav.popBackStack() })
        Text("remoteless.dev-server.unavailable", color = TvColors.Orange, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text("This TV can display an already-served preview, but cannot run a shell, package manager, Flutter SDK, dev server, simulator, build, test, or deploy. Use the primary/secondary render machine or Cloud Workspace.", color = TvColors.TextSecondary, fontSize = 20.sp)
        TvTextButton("Choose a capable device", onClick = { nav.navigate(Routes.MACHINES) })
    }
}

@Composable
fun PreviewStreamScreen(store: TvStore, nav: NavHostController, projectName: String) {
    placeholder(Modifier, "Preview $projectName")
}

@Composable
fun DroidStreamScreen(store: TvStore, nav: NavHostController) {
    placeholder(Modifier, "Android screen")
}
