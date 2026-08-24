// TVChatPlan.swift — the native-TV copy of mobile's followUpPlan contract.
//
// Every reply continues the same task, native runner conversation, and
// task-owned tmux seat. A terminal status ends one turn, not the conversation.

import Foundation

/// Runner coding is an explicit state shared by every companion surface.
/// Keep this policy beside the follow-up plan rather than in the tvOS-only
/// TaskDetailView, which is deliberately not compiled into visionOS.
func tvTaskIsRunnerCoding(_ status: String?) -> Bool {
    switch (status ?? "").lowercased() {
    case "queued", "running": return true
    default: return false
    }
}

/// A `done` frame closes one concrete SSE response, not necessarily the task's
/// conversation. When a live follow-up rolls the task onto its next runner
/// process, older agents close the previous response with queued/running status.
/// The TV must follow that next channel so repeated turns remain one live chat.
func tvTaskStreamShouldReattachAfterDone(_ status: String?) -> Bool {
    tvTaskIsRunnerCoding(status)
}

struct TVParkedTurnNotice: Equatable {
    let line: String
    let offersRunnerSignIn: Bool
}

/// A parked turn means the agent retained the user's words. Stable reason
/// codes decide whether runner OAuth can actually help; a generic 409 must not
/// turn into a dead sign-in button for a sandbox or transient host failure.
func tvParkedTurnNotice(code: String?, runner: String?, reauthable: Bool) -> TVParkedTurnNotice {
    let rawRunner = RegisteredRunner.canonical(runner ?? "")
    let label: String
    switch rawRunner {
    case "claude": label = "Claude Code"
    case "codex": label = "Codex"
    case "opencode": label = "OpenCode"
    case let value where !value.isEmpty: label = value
    default: label = "the runner"
    }

    switch code {
    case "runner.codex.linux_sandbox_blocked":
        return TVParkedTurnNotice(
            line: "Message saved. This machine is blocking the sandbox \(label) needs; it will run after the host is fixed.",
            offersRunnerSignIn: false
        )
    case "runner.codex.refresh_lineage_lost",
         "runner.codex.credential_expired",
         "runner.codex.credential_is_copy",
         "runner.codex.credential_corrupt",
         "runner.codex.not_authenticated":
        return TVParkedTurnNotice(
            line: "Message saved. \(label) needs to be signed in on this machine; it will run automatically afterward.",
            offersRunnerSignIn: reauthable
        )
    default:
        return TVParkedTurnNotice(
            line: "Message saved. It will run automatically when \(label) is ready.",
            offersRunnerSignIn: false
        )
    }
}

enum TVChatFollowUpAction: Equatable {
    case continueCurrent
    case settingsChangeBlocked(String)
}

func tvChatFollowUpAction(
    status: String?,
    runner: String?,
    selectedRunner: String? = nil,
    settingsChanged: Bool = false
) -> TVChatFollowUpAction {
    let recorded = RegisteredRunner.canonical(
        (runner ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    )
    let selected = RegisteredRunner.canonical(
        (selectedRunner ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    )
    // A task owns one runner conversation and one tmux seat. Changing hidden
    // settings therefore requires an explicit New Task; a reply must never
    // silently fork and move Vibing/render state to another task identity.
    if settingsChanged {
        let next = selected.isEmpty ? (recorded.isEmpty ? "the selected runner" : recorded) : selected
        return .settingsChangeBlocked(
            "This vibe stays in its existing runner and tmux session. Start a new task to use \(next) or different settings."
        )
    }
    // Terminal describes the last turn, not the conversation. Continue it in
    // place; the agent reattaches the exact native runner session in the same
    // task-owned tmux pane.
    return .continueCurrent
}
