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
