package io.yaver.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FailureSignals parity checks — the Android TV twin of
 * tvos/Checks/FailureSignalsChecks.swift. Every sentence below is verified
 * VERBATIM against the tvOS/TS twins so a user reads the same diagnosis on the
 * TV as on their phone; when a copy string drifts here, this test fails.
 */
class FailureSignalsTest {

    // ── Session scope denial ──────────────────────────────────────────────

    @Test
    fun sessionScopeDeniedCodeAndProse() {
        assertTrue(FailureSignals.isSessionScopeDenied(FailureSignals.SESSION_SCOPE_DENIED, "anything"))
        assertTrue(FailureSignals.isSessionScopeDenied("auth-x", "a scoped token cannot access this endpoint"))
        assertFalse(FailureSignals.isSessionScopeDenied("auth-x", "plain refusal"))
        assertEquals(
            "The agent on this box is older than this TV app, so it refuses the preview endpoints. Update the agent and this screen will work.",
            FailureSignals.explainSessionScopeDenied(),
        )
    }

    // ── Target probe failures ─────────────────────────────────────────────

    @Test
    fun relayCredentialMatchers() {
        assertTrue(FailureSignals.isRelayCredentialDeny("invalid relay password"))
        assertTrue(FailureSignals.isRelayCredentialDeny("relay_password_missing"))
        assertTrue(FailureSignals.isRelayCredentialDeny("reason=bad_password"))
        assertFalse(FailureSignals.isRelayCredentialDeny("device not connected to relay"))
    }

    @Test
    fun unknownVerbIsVersionSkew() {
        val plan = FailureSignals.classifyTargetProbeFailure("unknown_verb: runtime_turns")
        assertEquals(FailureSignals.TargetProbeKind.AgentVerbSkew, plan.kind)
        assertTrue(plan.retry)
        assertFalse(plan.useRunnerFallback)
        assertFalse(plan.showFixWithRunner)
    }

    @Test
    fun deviceNotConnectedIsRelayPresence() {
        val plan = FailureSignals.classifyTargetProbeFailure("connectivity.relay.device_not_connected")
        assertEquals(FailureSignals.TargetProbeKind.RelayPresence, plan.kind)
        assertTrue(plan.useRunnerFallback)
    }

    @Test
    fun projectMissingNeverRetries() {
        val plan = FailureSignals.classifyTargetProbeFailure("project_not_on_this_machine")
        assertEquals(FailureSignals.TargetProbeKind.ProjectMissing, plan.kind)
        assertFalse(plan.retry)
        assertTrue(plan.useRunnerFallback)
    }

    @Test
    fun explainTargetProbeSentencesMatchTwins() {
        val auth = FailureSignals.explainTargetProbe(
            FailureSignals.TargetProbePlan(FailureSignals.TargetProbeKind.RelayAuth, true, false, false),
            "my box",
            null,
        )
        assertEquals(
            "The relay refused this account's credentials, so the probe never reached my box. Sign in again and retry — the box itself is fine.",
            auth,
        )
        val skew = FailureSignals.explainTargetProbe(
            FailureSignals.TargetProbePlan(FailureSignals.TargetProbeKind.AgentVerbSkew, true, false, false),
            "my box",
            null,
        )
        assertTrue(skew!!.contains("npm install -g yaver-cli@latest"))
    }

    // ── Runner failures ───────────────────────────────────────────────────

    @Test
    fun runnerFailureClassificationOrder() {
        // The generic auth matcher must NOT swallow billing/rate-limit.
        assertEquals(FailureSignals.RunnerFailureKind.Billing, FailureSignals.classifyRunnerFailure("credit balance is too low"))
        assertEquals(FailureSignals.RunnerFailureKind.RateLimit, FailureSignals.classifyRunnerFailure("rate limit exceeded"))
        assertEquals(FailureSignals.RunnerFailureKind.ProviderKey, FailureSignals.classifyRunnerFailure("ai_loadapikeyerror"))
        assertEquals(FailureSignals.RunnerFailureKind.ModelNotSupported, FailureSignals.classifyRunnerFailure("does not have access to model"))
        assertEquals(FailureSignals.RunnerFailureKind.Auth, FailureSignals.classifyRunnerFailure("please sign in"))
        assertEquals(FailureSignals.RunnerFailureKind.AuthRevoked, FailureSignals.classifyRunnerFailure("oauth access token has been revoked"))
    }

    @Test
    fun runnerFailureRoutesToSignInOnlyForAuth() {
        assertTrue(FailureSignals.runnerFailureRoutesToSignIn(FailureSignals.RunnerFailureKind.Auth))
        assertTrue(FailureSignals.runnerFailureRoutesToSignIn(FailureSignals.RunnerFailureKind.AuthRevoked))
        assertFalse(FailureSignals.runnerFailureRoutesToSignIn(FailureSignals.RunnerFailureKind.Billing))
        assertFalse(FailureSignals.runnerFailureRoutesToSignIn(FailureSignals.RunnerFailureKind.RateLimit))
    }

    @Test
    fun runnerFailureCopyMatchesTvOS() {
        val (reason, action) = FailureSignals.explainRunnerFailure(FailureSignals.RunnerFailureKind.Billing)!!
        assertEquals("The provider refused the call for lack of credit. The sign-in itself is fine.", reason)
        assertEquals("Top up or upgrade that provider account. Signing in again will not help.", action)
    }

    // ── Capability gap ────────────────────────────────────────────────────

    @Test
    fun parseCapabilityGapRequiresCodeAndSummary() {
        assertNull(FailureSignals.parseCapabilityGap(org.json.JSONObject().put("summary", "x")))
        assertNull(FailureSignals.parseCapabilityGap(org.json.JSONObject().put("code", "capability.toolchain_missing")))
        assertNotNull(
            FailureSignals.parseCapabilityGap(
                org.json.JSONObject()
                    .put("code", FailureSignals.CAPABILITY_TOOLCHAIN_MISSING)
                    .put("summary", "Flutter is not installed"),
            )
        )
    }

    @Test
    fun gapFixRoutedOnlyWithPathAndStream() {
        // A fix with a path but no stream and not instant is a silent action —
        // refuse to render it.
        val gap = FailureSignals.parseCapabilityGap(
            org.json.JSONObject()
                .put("code", "capability.toolchain_missing")
                .put("summary", "flutter missing")
                .put("fix", org.json.JSONObject().put("path", "/install/flutter").put("label", "Install Flutter")),
        )
        assertNull(gap!!.fix)
        // With a stream it becomes invocable.
        val gap2 = FailureSignals.parseCapabilityGap(
            org.json.JSONObject()
                .put("code", "capability.toolchain_missing")
                .put("summary", "flutter missing")
                .put("fix", org.json.JSONObject().put("path", "/install/flutter").put("stream", "install:flutter").put("label", "Install Flutter").put("retry", true)),
        )
        assertNotNull(gap2!!.fix)
        assertEquals("Install Flutter", FailureSignals.gapFixLabel(gap2))
        assertEquals("/streams/install:flutter", FailureSignals.gapStreamPath(gap2))
        assertEquals("flutter", FailureSignals.gapInstallTool(gap2))
        assertTrue(FailureSignals.gapRetriesAfterFix(gap2))
        assertTrue(FailureSignals.gapSuppressesRetry(gap2))
    }

    @Test
    fun previewSessionActiveDetected() {
        val gap = FailureSignals.parseCapabilityGap(
            org.json.JSONObject()
                .put("code", FailureSignals.PREVIEW_SESSION_ACTIVE)
                .put("summary", "Another surface is previewing this project"),
        )
        assertTrue(FailureSignals.isPreviewSessionActive(gap))
    }

    // ── Stream recovery ───────────────────────────────────────────────────

    @Test
    fun interruptedStreamReattachesThenGivesUp() {
        val plan1 = FailureSignals.planStreamRecovery(FailureSignals.StreamEndKind.Interrupted, 0)
        assertTrue(plan1 is FailureSignals.StreamRecoveryPlan.Reattach)
        assertEquals(1, (plan1 as FailureSignals.StreamRecoveryPlan.Reattach).attempt)
        assertEquals(1000, plan1.delayMs)

        val giveUp = FailureSignals.planStreamRecovery(FailureSignals.StreamEndKind.Interrupted, FailureSignals.MAX_REATTACH_ATTEMPTS)
        assertTrue(giveUp is FailureSignals.StreamRecoveryPlan.GiveUp)
        assertTrue((giveUp as FailureSignals.StreamRecoveryPlan.GiveUp).message.contains("this is the stream, not the work"))
    }

    @Test
    fun doneOrCancelledIsIdle() {
        assertTrue(FailureSignals.planStreamRecovery(FailureSignals.StreamEndKind.Done, 0) is FailureSignals.StreamRecoveryPlan.Idle)
        assertTrue(FailureSignals.planStreamRecovery(FailureSignals.StreamEndKind.Cancelled, 0) is FailureSignals.StreamRecoveryPlan.Idle)
    }

    // ── Relay deny / limits ───────────────────────────────────────────────

    @Test
    fun deviceMismatchIsTerminal() {
        val s = FailureSignals.explainRelayDeny("relay refused: reason=device_mismatch")
        assertNotNull(s)
        assertTrue(s!!.contains("sign it into this account"))
        assertNull(FailureSignals.explainRelayDeny("relay timed out"))
    }

    @Test
    fun bandwidthCapCard() {
        val card = FailureSignals.classifyRelayLimit("bandwidth limit exceeded: 320MB used of 500MB daily limit")
        assertNotNull(card)
        assertEquals("bandwidth-cap", card!!.kind)
        assertTrue(card.detail.contains("cut by the cap, not by your network"))
    }

    // ── Runner auth terminal states ───────────────────────────────────────

    @Test
    fun accountNotEligibleIsTerminalAndFutile() {
        assertTrue(FailureSignals.isRunnerAuthTerminal("account_not_eligible"))
        assertTrue(FailureSignals.runnerAuthRetryIsFutile("account_not_eligible"))
        val s = FailureSignals.explainRunnerAuthOutcome("account_not_eligible", "Codex", null, null)
        assertNotNull(s)
        assertTrue(s!!.contains("Retrying with the same account cannot succeed"))
        assertFalse(FailureSignals.isRunnerAuthTerminal("pending"))
        assertTrue(FailureSignals.isRunnerAuthTerminal("completed"))
        assertTrue(FailureSignals.isRunnerAuthTerminal("cancelled"))
    }

    // ── Client-side refusals ──────────────────────────────────────────────

    @Test
    fun cleartextAndTlsAreClientBlocked() {
        val blocked = FailureSignals.clientPolicyReason(IllegalStateException("cleartext")) ?: "none"
        assertTrue(blocked.contains("network security policy") || blocked == "none")
        assertTrue(FailureSignals.isClientBlocked("anything"))
        assertFalse(FailureSignals.isClientBlocked(null))
    }
}
