package io.yaver.feedback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the PURE reload-decision seam.
 *
 * These need no emulator and no Android framework — [ReloadActions] touches
 * neither, which is the whole reason it is a separate file from
 * [YaverReloadControl].
 *
 * ── NOT YET EXECUTED ─────────────────────────────────────────────────────────
 *
 * `sdk/feedback/kotlin/` has NO build harness — no build.gradle, no wrapper,
 * and there is no kotlinc on the machine this was written on, so this file has
 * never been run. It is committed anyway so that the guard exists the moment a
 * harness does, but it must not be counted as passing until someone has
 * watched it fail. The identical logic IS executed today in the web, RN,
 * Flutter and Swift ports, whose equivalents of
 * [releaseBuildGetsNoReloadActionsAtAll] have each been verified by breaking
 * the guard and watching the suite go red.
 */
class ReloadActionsTest {

    private fun running(framework: String) =
        DevServerSnapshot(running = true, framework = framework)

    // ─── THE GUARD ───────────────────────────────────────────────────────────
    //
    // Prove it by breaking it: change `if (!isDevBuild) return emptyList()` in
    // ReloadActions.build to `if (isDevBuild)` and this single test fails
    // while every other test in this file still passes.
    @Test
    fun releaseBuildGetsNoReloadActionsAtAll() {
        val actions = ReloadActions.build(running("expo"), isDevBuild = false, connected = true)

        assertTrue(actions.isEmpty())
    }

    @Test
    fun debugBuildGetsHotAndFull() {
        val actions = ReloadActions.build(running("expo"), isDevBuild = true, connected = true)

        assertEquals(listOf(ReloadActionId.HOT, ReloadActionId.FULL), actions.map { it.id })
        assertTrue(actions.all { it.enabled })
    }

    @Test
    fun frameworkFamilyMapsTheAgentNames() {
        assertEquals(ReloadFrameworkFamily.FLUTTER, ReloadActions.frameworkFamily("flutter"))
        assertEquals(ReloadFrameworkFamily.REACT_NATIVE, ReloadActions.frameworkFamily("expo"))
        assertEquals(ReloadFrameworkFamily.REACT_NATIVE, ReloadActions.frameworkFamily("react-native"))
        assertEquals(ReloadFrameworkFamily.WEB, ReloadActions.frameworkFamily("vite"))
        assertEquals(ReloadFrameworkFamily.WEB, ReloadActions.frameworkFamily("nextjs"))
        assertEquals(ReloadFrameworkFamily.UNKNOWN, ReloadActions.frameworkFamily(""))
        assertEquals(ReloadFrameworkFamily.UNKNOWN, ReloadActions.frameworkFamily("godot"))
    }

    @Test
    fun flutterSecondActionIsAHotRestartNotAFullReload() {
        val actions = ReloadActions.build(running("flutter"), isDevBuild = true, connected = true)

        assertEquals("Hot Reload", actions[0].label)
        assertEquals("Hot Restart", actions[1].label)
        assertTrue(actions[1].hint.contains("(R)"))
    }

    @Test
    fun everyOtherFrameworkCallsItAFullReload() {
        for (framework in listOf("expo", "vite", "nextjs")) {
            val actions =
                ReloadActions.build(running(framework), isDevBuild = true, connected = true)
            assertEquals(framework, "Full Reload", actions[1].label)
        }
    }

    @Test
    fun payloadIsFastThenFullBothOnDevReload() {
        val actions = ReloadActions.build(running("expo"), isDevBuild = true, connected = true)

        assertEquals("/dev/reload", actions[0].path)
        assertEquals("""{"mode":"fast"}""", actions[0].bodyJson)
        assertEquals("/dev/reload", actions[1].path)
        assertEquals("""{"mode":"full"}""", actions[1].bodyJson)
    }

    @Test
    fun neverOffersTheHermesBundlePathAKotlinAppCannotLoad() {
        val actions = ReloadActions.build(running("expo"), isDevBuild = true, connected = true)

        assertFalse(actions.any { it.path == ReloadActions.RELOAD_APP_PATH })
    }

    @Test
    fun noDevServerNamesTheMachineAndTheCommandThatStartsIt() {
        val actions = ReloadActions.build(
            DevServerSnapshot(running = false),
            isDevBuild = true,
            connected = true,
            machineLabel = "primary",
        )

        for (action in actions) {
            assertFalse(action.enabled)
            assertTrue(action.disabledReason!!.contains("primary"))
            assertTrue(action.disabledReason!!.contains("yaver dev start"))
        }
    }

    @Test
    fun buildingSaysStillBuildingNotNoDevServer() {
        val actions = ReloadActions.build(
            DevServerSnapshot(running = true, building = true, framework = "expo"),
            isDevBuild = true,
            connected = true,
        )

        assertTrue(actions[0].disabledReason!!.contains("still building"))
    }

    @Test
    fun disconnectedSaysNotConnectedNotNoDevServer() {
        val actions = ReloadActions.build(running("expo"), isDevBuild = true, connected = false)

        assertTrue(actions[0].disabledReason!!.contains("Not connected"))
    }

    @Test
    fun snapshotFromJsonDegradesToNotRunningNeverOptimism() {
        val live = DevServerSnapshot.fromJson(
            JSONObject("""{"running":true,"framework":"expo"}""")
        )
        assertTrue(live.running)
        assertEquals("expo", live.framework)

        val empty = DevServerSnapshot.fromJson(JSONObject("{}"))
        assertFalse(empty.running)
        assertFalse(empty.building)
        assertNull(empty.framework)
    }

    @Test
    fun describeFailureNamesACauseNeverJustFailed() {
        assertTrue(
            ReloadActions.describeFailure(503, "dev server not available")
                .contains("No dev server is running")
        )
        assertTrue(
            ReloadActions.describeFailure(500, "vite does not support hot reload", running("vite"))
                .contains("vite")
        )
        assertTrue(
            ReloadActions.describeFailure(
                502,
                "Get \"http://127.0.0.1:8081/reload\": dial tcp 127.0.0.1:8081: connect: connection refused"
            ).contains("not listening")
        )
        assertTrue(ReloadActions.describeFailure(401, "").contains("sign in again"))
        assertTrue(ReloadActions.describeFailure(403, "").contains("sign in again"))
        assertTrue(ReloadActions.describeFailure(404, "not found").contains("yaver-cli@latest"))
        assertTrue(ReloadActions.describeFailure(500, "boom").contains("yaver logs"))
        assertTrue(ReloadActions.describeFailure(0, "").contains("yaver serve"))
    }
}
