import Foundation

/// FailureSignals — runner-failure classification for the watch.
///
/// Mirrors `docs/architecture/FAILURE_SIGNALS.json`, the canonical table every
/// surface embeds. Native surfaces cannot import `web/lib`, so this is a copy;
/// `web/lib/failureSignalParity.test.ts` fails when it drifts from the others.
///
/// WHY A WATCH NEEDS THIS. It has the least room and the fewest interactions of
/// any surface, so a wrong route costs more here than anywhere else: showing
/// "Sign in again" for an out-of-credit account spends the single tap the user
/// had, fixes nothing, and leaves them with no idea what actually happened.
///
/// THE LAW: a failure that is not about the credential must never route to a
/// sign-in flow. Billing, throttling, model entitlement and a missing provider
/// key are all VALID credentials failing for other reasons — and in the
/// rate-limit case re-authenticating also destroys a working session.
enum FailureSignals {

    enum RunnerFailureKind: String, Sendable {
        case auth
        case authRevoked = "auth-revoked"
        case billing
        case rateLimit = "rate-limit"
        case modelNotSupported = "model-not-supported"
        case modelNotFound = "model-not-found"
        case providerKey = "provider-key"
        case unknown
    }

    /// Ordered most-specific first. The generic auth matcher would otherwise
    /// swallow billing and throttling — which is precisely how a working
    /// credential ended up being told to sign in again.
    static func classifyRunnerFailure(_ output: String?) -> RunnerFailureKind {
        let m = (output ?? "").lowercased()
        if m.isEmpty { return .unknown }

        if m.contains("credit balance is too low") || m.contains("credit_balance_too_low")
            || m.contains("plans & billing") { return .billing }
        if m.contains("rate_limit_error") || m.contains("rate limit reached")
            || m.contains("rate limit exceeded") || m.contains("too many requests") { return .rateLimit }
        if m.contains("ai_loadapikeyerror") || m.contains("api key is missing")
            || m.contains("load api key") { return .providerKey }
        if m.contains("model is not supported") || m.contains("does not have access to model")
            || m.contains("unsupported model") { return .modelNotSupported }
        if m.contains("providermodelnotfounderror") || m.contains("provider model not found")
            || m.contains("invalid model") { return .modelNotFound }
        if m.contains("oauth access token has been revoked") || m.contains("token has been revoked") {
            return .authRevoked
        }
        if m.contains("oauth token has expired") || m.contains("oauth session expired")
            || m.contains("authentication_error") || m.contains("authentication_failed")
            || m.contains("not authenticated") || m.contains("not logged in")
            || m.contains("please sign in") || m.contains("invalid bearer token")
            || m.contains("unauthorized") || m.contains("expired token")
            || m.contains("token_expired") || m.contains("please run /login")
            || m.contains("run codex login") || m.contains("codex login --device-auth")
            || m.contains("refresh_token_reused") { return .auth }
        return .unknown
    }

    static func runnerFailureRoutesToSignIn(_ kind: RunnerFailureKind) -> Bool {
        kind == .auth || kind == .authRevoked
    }

    /// One short line for a small screen. Watch copy is deliberately terser
    /// than TV or web — but it still NAMES the cause; a spinner is the only
    /// unacceptable answer.
    static func explainRunnerFailure(_ kind: RunnerFailureKind) -> (reason: String, action: String)? {
        switch kind {
        case .auth:
            return ("Coding agent sign-in expired.", "Sign in again from your phone or the box.")
        case .authRevoked:
            return ("Sign-in was revoked by the provider.", "Sign in again to issue a new one.")
        case .billing:
            return ("Provider is out of credit.", "Top up that account. Signing in will not help.")
        case .rateLimit:
            return ("Provider rate limit reached.", "Wait for the reset, then retry. Do not sign in again.")
        case .modelNotSupported:
            return ("The plan does not include that model.", "Pick a different model.")
        case .modelNotFound:
            return ("That model id does not resolve.", "Pick a model the runner lists.")
        case .providerKey:
            return ("Provider API key missing or rejected.", "Set the key on that machine.")
        case .unknown:
            return nil
        }
    }
}
