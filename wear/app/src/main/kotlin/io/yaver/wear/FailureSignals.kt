package io.yaver.wear

/**
 * Runner-failure classification for Wear OS.
 *
 * Mirrors `docs/architecture/FAILURE_SIGNALS.json`, the canonical table every
 * surface embeds. Native surfaces cannot import `web/lib`, so this is a copy;
 * `web/lib/failureSignalParity.test.ts` fails when it drifts from the others.
 *
 * WHY A WATCH NEEDS THIS. It has the least room and the fewest interactions of
 * any surface, so a wrong route costs more here: offering "Sign in again" for
 * an out-of-credit account spends the single tap the user had and fixes
 * nothing.
 *
 * THE LAW: a failure that is not about the credential must never route to a
 * sign-in flow. Billing, throttling, model entitlement and a missing provider
 * key are all VALID credentials failing for other reasons — and re-auth in the
 * rate-limit case also destroys a working session.
 */
object FailureSignals {

    enum class RunnerFailureKind(val wire: String) {
        AUTH("auth"),
        AUTH_REVOKED("auth-revoked"),
        BILLING("billing"),
        RATE_LIMIT("rate-limit"),
        MODEL_NOT_SUPPORTED("model-not-supported"),
        MODEL_NOT_FOUND("model-not-found"),
        PROVIDER_KEY("provider-key"),
        UNKNOWN("unknown"),
    }

    /**
     * Ordered most-specific first: the generic auth matcher would otherwise
     * swallow billing and throttling, which is how a working credential ended
     * up being told to sign in again.
     */
    @JvmStatic
    fun classifyRunnerFailure(output: String?): RunnerFailureKind {
        val m = (output ?: "").lowercase()
        if (m.isEmpty()) return RunnerFailureKind.UNKNOWN

        if (m.contains("credit balance is too low") || m.contains("credit_balance_too_low") ||
            m.contains("plans & billing")
        ) return RunnerFailureKind.BILLING
        if (m.contains("rate_limit_error") || m.contains("rate limit reached") ||
            m.contains("rate limit exceeded") || m.contains("too many requests")
        ) return RunnerFailureKind.RATE_LIMIT
        if (m.contains("ai_loadapikeyerror") || m.contains("api key is missing") ||
            m.contains("load api key")
        ) return RunnerFailureKind.PROVIDER_KEY
        if (m.contains("model is not supported") || m.contains("does not have access to model") ||
            m.contains("unsupported model")
        ) return RunnerFailureKind.MODEL_NOT_SUPPORTED
        if (m.contains("providermodelnotfounderror") || m.contains("provider model not found") ||
            m.contains("invalid model")
        ) return RunnerFailureKind.MODEL_NOT_FOUND
        if (m.contains("oauth access token has been revoked") || m.contains("token has been revoked")) {
            return RunnerFailureKind.AUTH_REVOKED
        }
        if (m.contains("oauth token has expired") || m.contains("oauth session expired") ||
            m.contains("authentication_error") || m.contains("authentication_failed") ||
            m.contains("not authenticated") || m.contains("not logged in") ||
            m.contains("please sign in") || m.contains("invalid bearer token") ||
            m.contains("unauthorized") || m.contains("expired token") ||
            m.contains("token_expired") || m.contains("please run /login") ||
            m.contains("run codex login") || m.contains("codex login --device-auth") ||
            m.contains("refresh_token_reused")
        ) return RunnerFailureKind.AUTH
        return RunnerFailureKind.UNKNOWN
    }

    @JvmStatic
    fun routesToSignIn(kind: RunnerFailureKind): Boolean =
        kind == RunnerFailureKind.AUTH || kind == RunnerFailureKind.AUTH_REVOKED

    /** One short line for a small screen — terse, but it NAMES the cause. */
    @JvmStatic
    fun explain(kind: RunnerFailureKind): Pair<String, String>? = when (kind) {
        RunnerFailureKind.AUTH ->
            "Coding agent sign-in expired." to "Sign in again from your phone or the box."
        RunnerFailureKind.AUTH_REVOKED ->
            "Sign-in was revoked by the provider." to "Sign in again to issue a new one."
        RunnerFailureKind.BILLING ->
            "Provider is out of credit." to "Top up that account. Signing in will not help."
        RunnerFailureKind.RATE_LIMIT ->
            "Provider rate limit reached." to "Wait for the reset, then retry. Do not sign in again."
        RunnerFailureKind.MODEL_NOT_SUPPORTED ->
            "The plan does not include that model." to "Pick a different model."
        RunnerFailureKind.MODEL_NOT_FOUND ->
            "That model id does not resolve." to "Pick a model the runner lists."
        RunnerFailureKind.PROVIDER_KEY ->
            "Provider API key missing or rejected." to "Set the key on that machine."
        RunnerFailureKind.UNKNOWN -> null
    }
}
