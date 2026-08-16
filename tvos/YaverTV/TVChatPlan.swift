// TVChatPlan.swift — the native-TV copy of mobile's followUpPlan contract.
//
// A live task continues in place. A terminal task silently forks to a child on
// the SAME recorded runner, and the view carries the transcript across. This is
// what makes a quick coding run read as one conversation instead of replacing
// the user's chat with an empty task after every reply.

import Foundation

enum TVChatFollowUpAction: Equatable {
    case continueCurrent
    case forkSameRunner(String)
}

func tvChatFollowUpAction(status: String?, runner: String?) -> TVChatFollowUpAction {
    let terminal = Set(["completed", "review", "failed", "stopped"])
    if terminal.contains((status ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) {
        let recorded = (runner ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return .forkSameRunner(recorded.isEmpty ? "claude" : recorded)
    }
    return .continueCurrent
}
