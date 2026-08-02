import React from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useColors } from "../context/ThemeContext";
import { monoFamily, spacing } from "../theme/tokens";

// Best-effort smart-retry detection. Each rule reads the error
// message and returns either null or a short suggestion the user can
// tap. Keep the rules narrow — false positives here send the user
// down the wrong path. New patterns belong here, not inline at call
// sites. Intentionally case-insensitive on the haystack.
export interface SmartRetrySuggestion {
  label: string;
  /** Raw key for analytics so we can see which suggestions get tapped. */
  kind: "skip-git-repo-check" | "api-key-missing" | "node-modules" | "permission" | "chown-fix" | "runner-auth-needed"
    // Non-auth provider refusals. Separate kinds on purpose: each has a
    // DIFFERENT action, and collapsing them into runner-auth-needed is what
    // produced a "Sign in" button for an out-of-credit account.
    | "billing" | "rate-limit" | "model-entitlement";
  /** Optional payload tied to the suggestion. For chown-fix this
   *  carries the exact `sudo chown -R …` command pulled out of the
   *  agent's preflight error so the UI can offer a Copy button without
   *  having to re-derive it. For runner-auth-needed it carries the
   *  runner id ("claude" | "codex") so the caller can open the right
   *  RunnerAuthModal pre-filled. */
  payload?: string;
}

/** Extract the `sudo chown -R <uid:gid> <path>` line from the agent's
 *  workdir-not-writable preflight error. The agent emits it verbatim
 *  inside backticks; pull it out so the mobile UI can put it on the
 *  clipboard with one tap. Returns "" when nothing matches.
 */
function extractChownCommand(raw: string): string {
  // Backtick-delimited form — current agent text (1.99.156+).
  const backtick = raw.match(/`(sudo chown -R [^`]+)`/i);
  if (backtick && backtick[1]) return backtick[1];
  // Defensive fallback for log lines without backticks. Match up to the
  // next sentence boundary or newline so we don't swallow trailing
  // explanatory text.
  const bare = raw.match(/sudo chown -R [^\s][^.\n]*/i);
  if (bare && bare[0]) return bare[0].trim();
  return "";
}

// Runner-auth detection: claude prints "Not logged in · Please run /login"
// (subscription token expired / Keychain locked / no creds), codex prints
// "Sign in required" / similar. Match BEFORE api-key-missing so we never
// route the user toward an API-key-style fix when the real answer is OAuth.
// Returns the runner id when we can attribute the failure.
function detectRunnerAuthFailure(haystack: string): "claude" | "codex" | null {
  const m = haystack.toLowerCase();
  const looksLikeClaude =
    m.includes("oauth access token has been revoked") ||
    m.includes("token has been revoked") ||
    m.includes("please run /login") ||
    (m.includes("not logged in") && (m.includes("/login") || m.includes("please run"))) ||
    m.includes("invalid bearer token") ||
    m.includes("invalid authentication credentials") ||
    // Anthropic's ACTUAL wording. The matcher only had "revoked" and
    // "/login", so a plain expiry — the commonest runner failure there is —
    // matched nothing and offered no route at all.
    m.includes("oauth token has expired") ||
    m.includes("oauth session expired") ||
    m.includes("authentication_error") ||
    m.includes("authentication_failed") ||
    m.includes("claude code-credentials");
  if (looksLikeClaude) return "claude";
  const looksLikeCodex =
    m.includes("refresh_token_reused") ||
    m.includes("token_expired") ||
    (m.includes("sign in required") && (m.includes("codex") || m.includes("chatgpt"))) ||
    m.includes("codex login --device-auth") ||
    (m.includes("not authenticated") && m.includes("codex"));
  if (looksLikeCodex) return "codex";
  return null;
}

// THINGS THAT ARE NOT A BROKEN SIGN-IN (2026-08-02, from the providers' real
// shapes). Each of these used to fall through to a generic handler, or worse
// toward an OAuth flow that cannot fix them:
//
//   billing      400 "Your credit balance is too low…" — the credential is
//                valid, the account cannot pay. Re-auth changes nothing.
//   rate-limit   429 rate_limit_error / "API Error: Rate limit reached".
//                Waiting fixes it; re-auth ALSO throws away a working session.
//   entitlement  400 "The '<model>' model is not supported when using Codex
//                with a ChatGPT account." Signing in cannot move a model onto
//                a plan; picking another model can.
//
// Mirrors web/lib/runnerFailure.ts. Kept in step by
// web/lib/mobileFailureParity.test.ts, because this is an independent copy and
// this repo has already drifted three relay-auth matchers apart.
export type NonAuthFailure = "billing" | "rate-limit" | "model-entitlement" | null;

export function detectNonAuthProviderFailure(haystack: string): NonAuthFailure {
  const m = String(haystack || "").toLowerCase();
  if (!m) return null;
  if (
    m.includes("credit balance is too low") ||
    m.includes("credit_balance_too_low") ||
    m.includes("plans & billing")
  ) return "billing";
  if (
    m.includes("rate_limit_error") ||
    m.includes("rate limit reached") ||
    m.includes("rate limit exceeded") ||
    m.includes("too many requests")
  ) return "rate-limit";
  if (m.includes("model is not supported") && m.includes("account")) return "model-entitlement";
  return null;
}

/** The sentence + the action for a non-auth provider failure. */
export function describeNonAuthProviderFailure(kind: Exclude<NonAuthFailure, null>): { reason: string; action: string } {
  switch (kind) {
    case "billing":
      return {
        reason: "The provider refused the call for lack of credit — the sign-in itself is fine.",
        action: "Top up or upgrade that provider account, then retry. Signing in again will not help.",
      };
    case "rate-limit":
      return {
        reason: "The provider throttled this request. The credential and the model are both fine.",
        action: "Wait for the limit to reset and retry. Do not sign in again — a fresh token does not reset a quota.",
      };
    case "model-entitlement":
      return {
        reason: "The signed-in plan does not include the selected model.",
        action: "Pick a different model for this machine. Signing in again cannot move a model onto a plan.",
      };
  }
}

export function detectSmartRetry(message: string): SmartRetrySuggestion | null {
  const raw = String(message || "");
  const m = raw.toLowerCase();
  if (!m) return null;
  // Subscription-OAuth failures take priority over generic api-key hints
  // — claude/codex auth needs the browser flow, never an API key.
  // A billing / throttling / entitlement refusal is NOT a sign-in problem and
  // must never produce a "Sign in to X" button — that is the dead end this
  // whole change exists to remove.
  const nonAuth = detectNonAuthProviderFailure(raw);
  if (nonAuth) {
    const d = describeNonAuthProviderFailure(nonAuth);
    return {
      label: nonAuth === "model-entitlement" ? "Change model" : nonAuth === "billing" ? "Open billing" : "Wait and retry",
      kind: nonAuth === "model-entitlement" ? "model-entitlement" : nonAuth,
      payload: d.action,
    } as SmartRetrySuggestion;
  }
  const runner = detectRunnerAuthFailure(raw);
  if (runner) {
    return {
      label: runner === "codex" ? "Sign in to Codex" : "Sign in to Claude Code",
      kind: "runner-auth-needed",
      payload: runner,
    };
  }
  if (m.includes("skip-git-repo-check") && m.includes("not specified")) {
    return { label: "Retry with --skip-git-repo-check", kind: "skip-git-repo-check" };
  }
  if (
    m.includes("api key not found") ||
    m.includes("missing api key") ||
    m.includes("no api key") ||
    m.includes("api_key_missing")
  ) {
    return { label: "Open API key settings", kind: "api-key-missing" };
  }
  if (
    m.includes("node_modules") ||
    m.includes("cannot find module") ||
    m.includes("module not found")
  ) {
    return { label: "Try `npm install` first", kind: "node-modules" };
  }
  // Codex bwrap workdir-not-writable preflight (agent 1.99.156+). The
  // error embeds the exact `sudo chown -R <uid:gid> <path>` to copy —
  // present it as a one-tap fix so the user doesn't have to re-derive
  // it from the message. Match this BEFORE the generic "permission
  // denied" rule so we offer the actionable suggestion first.
  if (m.includes("codex sandbox cannot write") || m.includes("must be owned by the user running yaver")) {
    const cmd = extractChownCommand(raw);
    return {
      label: cmd ? "Copy chown command" : "Open Permissions doctor",
      kind: "chown-fix",
      payload: cmd || undefined,
    };
  }
  if (m.includes("permission denied") || m.includes("eacces")) {
    return { label: "Check directory permissions", kind: "permission" };
  }
  return null;
}

export interface ErrorMessageProps {
  /** The raw error string from the agent. */
  message: string;
  /** Optional title; defaults to "Task failed". */
  title?: string;
  /** Tapping the smart-retry suggestion. Pass `undefined` to hide it
   *  even if a suggestion is detected. */
  onSmartRetry?: (suggestion: SmartRetrySuggestion) => void;
  /** Tapping "Open in agent" — escalates to the full log/REPL view. */
  onOpenInAgent?: () => void;
  /** Tapping "Copy error". Should copy and toast. */
  onCopyError?: () => void;
}

export function ErrorMessage({
  message,
  title = "Task failed",
  onSmartRetry,
  onOpenInAgent,
  onCopyError,
}: ErrorMessageProps) {
  const c = useColors();
  const suggestion = detectSmartRetry(message);
  const hasActions = (suggestion && onSmartRetry) || onOpenInAgent || onCopyError;

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.card,
          {
            backgroundColor: c.errorBg,
            borderLeftColor: c.error,
          },
        ]}
      >
        <View style={styles.header}>
          <Ionicons name="warning" size={18} color={c.error} style={styles.icon} />
          <Text style={[styles.title, { color: c.error }]}>{title}</Text>
        </View>
        <Text
          // Keep the raw agent error as clearly-secondary detail: muted +
          // capped so a stack dump can't dominate the card above the
          // smart-retry actions. The full text stays available via "Copy
          // error" below.
          numberOfLines={6}
          ellipsizeMode="tail"
          style={[
            styles.body,
            { color: c.textSecondary, fontFamily: monoFamily },
          ]}
        >
          {message}
        </Text>
        {hasActions ? (
          <View style={styles.actions}>
            {suggestion && onSmartRetry ? (
              <Pressable
                style={({ pressed }) => [
                  styles.btnPrimary,
                  { backgroundColor: c.brandPrimary },
                  pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
                ]}
                onPress={() => onSmartRetry(suggestion)}
                accessibilityRole="button"
                accessibilityLabel={suggestion.label}
              >
                <Text style={styles.btnPrimaryText}>{suggestion.label}</Text>
              </Pressable>
            ) : null}
            {onOpenInAgent ? (
              <Pressable
                style={({ pressed }) => [
                  styles.btnSecondary,
                  { borderColor: c.borderStrong },
                  pressed && { opacity: 0.7 },
                ]}
                onPress={onOpenInAgent}
                accessibilityRole="button"
                accessibilityLabel="Open full agent log"
              >
                <Text style={[styles.btnSecondaryText, { color: c.textPrimary }]}>
                  Open in agent
                </Text>
              </Pressable>
            ) : null}
            {onCopyError ? (
              <Pressable
                style={({ pressed }) => [
                  styles.btnTertiary,
                  pressed && { opacity: 0.55 },
                ]}
                onPress={onCopyError}
                accessibilityRole="button"
                accessibilityLabel="Copy error message"
              >
                <Text style={[styles.btnTertiaryText, { color: c.textSecondary }]}>
                  Copy error
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  card: {
    borderLeftWidth: 3,
    borderRadius: 12,
    padding: 14,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
  },
  icon: { marginRight: 6 },
  title: {
    fontSize: 15,
    fontWeight: "600",
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  btnPrimary: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  btnPrimaryText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
  },
  btnSecondary: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
  },
  btnSecondaryText: {
    fontSize: 13,
    fontWeight: "600",
  },
  btnTertiary: {
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  btnTertiaryText: {
    fontSize: 13,
    fontWeight: "600",
  },
});
