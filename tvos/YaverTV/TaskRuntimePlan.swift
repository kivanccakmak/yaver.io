// TaskRuntimePlan.swift — task/chat authority is independent from rendering.
//
// A tvOS task may run on the account's runner box while no render box is
// configured, asleep, or intentionally omitted. Keeping this as a small pure
// policy object prevents views from accidentally using renderClient() as a
// proxy for task availability. A future boxless Git+coding executor can plug
// into the same task-only branch without changing the remote-runner contract.

import Foundation

enum TVTaskRuntimeKind: Equatable {
    case remoteRunner
    case boxlessUnavailable
    case signedOut
}

struct TVTaskRuntimePlan: Equatable {
    let kind: TVTaskRuntimeKind
    let runnerDeviceID: String?
    /// Rendering is a separate capability. It is deliberately false for all
    /// task plans: creating/listing/chatting about a task must never probe or
    /// require a simulator, dev server, WebRTC session, or render box.
    let requiresRender: Bool

    var available: Bool { kind == .remoteRunner }

    static func resolve(
        authenticated: Bool,
        runnerDeviceID: String?,
        hasRunnerBox: Bool
    ) -> TVTaskRuntimePlan {
        guard authenticated else {
            return TVTaskRuntimePlan(kind: .signedOut, runnerDeviceID: nil, requiresRender: false)
        }
        guard hasRunnerBox else {
            // Do not claim that a boxless executor exists yet. This named
            // state is the insertion point for the optional Git+coding lane.
            return TVTaskRuntimePlan(kind: .boxlessUnavailable, runnerDeviceID: runnerDeviceID, requiresRender: false)
        }
        return TVTaskRuntimePlan(kind: .remoteRunner, runnerDeviceID: runnerDeviceID, requiresRender: false)
    }
}
