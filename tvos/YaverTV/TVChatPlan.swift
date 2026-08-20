// TVChatPlan.swift — the native-TV copy of mobile's followUpPlan contract.
//
// A live task continues in place. A terminal task silently forks to a child on
// the SAME recorded runner, and the view carries the transcript across. This is
// what makes a quick coding run read as one conversation instead of replacing
// the user's chat with an empty task after every reply.

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
    case fork(String)
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
    // A live runner session cannot safely change runner/model/project/MCP in
    // place. Once the user changes any hidden chat setting, fork with bounded
    // context; an untouched reply continues the current session as before.
    if settingsChanged {
        return .fork(selected.isEmpty ? (recorded.isEmpty ? "claude" : recorded) : selected)
    }
    let terminal = Set(["completed", "review", "failed", "stopped"])
    if terminal.contains((status ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) {
        return .fork(recorded.isEmpty ? "claude" : recorded)
    }
    return .continueCurrent
}
