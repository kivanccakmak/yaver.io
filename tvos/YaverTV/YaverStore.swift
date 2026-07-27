// YaverStore.swift — app-wide session + selected-box state, persisted in
// UserDefaults. The session token is the 1-year token from device-code auth
// (same contract as the phone). Kept deliberately small: this is a lean-back
// control app, not the full account surface.

import Foundation
import SwiftUI

@MainActor
final class YaverStore: ObservableObject {
    @AppStorage("yaver.tv.token") private var legacyStoredToken: String = ""
    @AppStorage("yaver.tv.boxes") private var storedBoxesJSON: String = "[]"
    @AppStorage("yaver.tv.selectedBox") private var selectedBoxId: String = ""

    @Published var token: String = ""
    @Published var boxes: [BoxTarget] = []
    @Published var selectedBox: BoxTarget?

    // Narrated auto-connect (Stream C parity with mobile). On launch, if no box
    // is picked yet, silently reach the account's best LIVE machine and connect,
    // narrating which one — instead of dropping the user on a "Choose machine"
    // wall while a connect could just happen. Cancellable. See AutoConnectStatus.
    @Published var autoConnecting: Bool = false
    @Published var autoConnectTarget: AutoConnectTarget?
    private var autoConnectStarted = false
    private var autoConnectCancelled = false

    // Runner/render machine split — the account-wide favorite row from
    // userSettings.machineRolesByProject (same Convex rows web + mobile use;
    // key off the config, never a per-surface copy). Nil = single-box.
    @Published var machineRoles: MachineRegistry.MachineRolesRow?
    /// deviceId → display name, cached from the registry fetches so the split
    /// badge can name boxes without a second network call.
    @Published var deviceNamesById: [String: String] = [:]

    /// True when the favorite row genuinely splits work across two machines.
    var machineSplitActive: Bool {
        guard let r = machineRoles else { return false }
        guard let render = r.renderDeviceId, !render.isEmpty else { return false }
        return render != r.runnerDeviceId
    }

    /// "AI: ubuntu · Render: mac mini" — nil when no split. Render on the
    /// dashboard + runtime rows; a split with no badge is two silent sources.
    var machineRolesBadge: String? {
        guard machineSplitActive, let r = machineRoles else { return nil }
        let runner = deviceNamesById[r.runnerDeviceId] ?? String(r.runnerDeviceId.prefix(8))
        let renderId = r.renderDeviceId ?? r.runnerDeviceId
        let render = deviceNamesById[renderId] ?? String(renderId.prefix(8))
        return "AI: \(runner) · Render: \(render)"
    }

    func adoptSettings(_ settings: MachineRegistry.UserSettings?, devices: [RegisteredDevice] = []) {
        if let rows = settings?.machineRolesByProject {
            machineRoles = rows.first(where: { ($0.projectName ?? "").isEmpty && !$0.runnerDeviceId.isEmpty })
        }
        if !devices.isEmpty {
            var names = deviceNamesById
            for d in devices { names[d.deviceId] = d.displayName }
            deviceNamesById = names
        }
    }

    /// Box addressed as the AI-task RUNNER: the machine-roles runner when a
    /// split is active, else the selected box. Cross-machine addressing rides
    /// the relay `/d/<deviceId>` path ONLY — host is cleared so a stale LAN
    /// address can never hit the wrong machine first. Returns nil (refuse by
    /// name at the call site) when a split is active but no relay is wired.
    func runnerBox() -> BoxTarget? { roleBox(machineRoles?.runnerDeviceId) }

    /// Box addressed for previews/streams/builds — the render machine.
    func renderBox() -> BoxTarget? { roleBox(machineRoles?.renderDeviceId) }

    private func roleBox(_ roleDeviceId: String?) -> BoxTarget? {
        guard let box = selectedBox else { return nil }
        guard let id = roleDeviceId, !id.isEmpty, id != box.id else { return box }
        guard let relay = box.relayBaseUrl, !relay.isEmpty else { return nil }
        return BoxTarget(id: id,
                         name: deviceNamesById[id] ?? String(id.prefix(8)),
                         host: "", // relay-only: never let a stale LAN host win
                         port: box.port,
                         managed: box.managed,
                         machineId: nil,
                         relayBaseUrl: relay,
                         relayPassword: box.relayPassword)
    }

    /// Client for AI-task dispatch (sessions/tasks). Nil when signed out or a
    /// split is configured but unreachable — callers surface the named cause.
    func runnerClient() -> AgentClient? {
        guard isAuthenticated, let box = runnerBox() else { return nil }
        return AgentClient(token: token, box: box)
    }

    /// Client for preview/stream/build flows — the render box.
    func renderClient() -> AgentClient? {
        guard isAuthenticated, let box = renderBox() else { return nil }
        return AgentClient(token: token, box: box)
    }

    var isAuthenticated: Bool { !token.isEmpty }

    init() {
        let keychainToken = TokenStore.load()
        if !keychainToken.isEmpty {
            token = keychainToken
            if !legacyStoredToken.isEmpty { legacyStoredToken = "" }
        } else if !legacyStoredToken.isEmpty {
            token = legacyStoredToken
            TokenStore.save(legacyStoredToken)
            legacyStoredToken = ""
        }
        boxes = (try? JSONDecoder().decode([BoxTarget].self, from: Data(storedBoxesJSON.utf8))) ?? []
        selectedBox = boxes.first(where: { $0.id == selectedBoxId }) ?? boxes.first
        refreshSessionOnLaunch()
    }

    /// Netflix-on-AppleTV contract: extend the 1-year session every launch so a
    /// signed-in TV never re-prompts for OAuth. No-op when signed out. See
    /// Backend.refreshSession for the extend-only (no-rotation) rationale.
    private func refreshSessionOnLaunch() {
        let current = token
        guard !current.isEmpty else { return }
        Task { [weak self] in
            let rotated = await DeviceCodeAuth.refreshSession(token: current)
            guard let rotated, !rotated.isEmpty else { return }
            await MainActor.run {
                guard let self else { return }
                // Only adopt the rotated token if we're still on the same one —
                // the user may have signed out/in while the refresh was in flight.
                guard self.token == current else { return }
                self.token = rotated
                TokenStore.save(rotated)
            }
        }
    }

    func signIn(token: String) {
        self.token = token
        legacyStoredToken = ""
        TokenStore.save(token)
    }

    func signOut() {
        token = ""
        legacyStoredToken = ""
        TokenStore.clear()
        // Clear the machine list too. On a family Apple TV, leaving boxes behind
        // hands the next person the previous user's machine names and LAN IPs.
        boxes = []
        selectedBox = nil
        selectedBoxId = ""
        storedBoxesJSON = "[]"
    }

    /// Remove a box (a typo'd address, a decommissioned machine). Without this a
    /// bad entry was permanent — the dashboard could only ever ADD.
    func removeBox(_ box: BoxTarget) {
        boxes.removeAll { $0.id == box.id }
        if selectedBox?.id == box.id {
            selectedBox = boxes.first
            selectedBoxId = boxes.first?.id ?? ""
        }
        persistBoxes()
    }

    func addBox(_ box: BoxTarget) {
        if let idx = boxes.firstIndex(where: { $0.id == box.id }) {
            boxes[idx] = box
        } else {
            boxes.append(box)
        }
        persistBoxes()
        if selectedBox == nil { select(box) }
    }

    func select(_ box: BoxTarget) {
        selectedBox = box
        selectedBoxId = box.id
    }

    // MARK: - Connectivity self-heal (tvOS analog of mobile's relay self-heal)

    /// tvOS connects DIRECT to a box's host — there's no platform relay or
    /// per-user relay password here, so mobile's `/settings/repair-relay` heal
    /// doesn't apply. The equivalent staleness on this surface is a CACHED host
    /// that's no longer reachable (the box changed IP or moved networks). When a
    /// call fails, re-resolve the selected box's best reachable address from the
    /// registry and swap it in, so the next call succeeds without the user
    /// re-picking a machine. Idempotent; no-op when signed out, no box selected,
    /// the box is gone, or nothing better resolves.
    func healReachability() async {
        guard isAuthenticated, let box = selectedBox else { return }
        let list = (try? await MachineRegistry.fetch(token: token)) ?? []
        let settings = try? await MachineRegistry.fetchSettings(token: token)
        adoptSettings(settings, devices: list)
        guard let dev = list.first(where: { $0.deviceId == box.id }) else { return }
        let host = await MachineRegistry.firstReachable(dev.addressCandidates, port: dev.port, token: token)
        guard let host, !host.isEmpty, host != box.host else { return }
        let healed = BoxTarget(id: dev.deviceId, name: dev.displayName, host: host,
                               port: dev.port, managed: dev.managed, machineId: dev.machineId,
                               relayBaseUrl: settings?.relayUrl, relayPassword: settings?.relayPassword)
        addBox(healed)
        select(healed)
    }

    /// Backfill relay metadata onto an already-selected/stored box. Older tvOS
    /// builds persisted only the LAN host, so after upgrade the user could still
    /// be stuck LAN-only until they re-picked the machine. This is idempotent and
    /// only changes transport metadata, not the selected device.
    func refreshSelectedRelaySettings() async {
        guard isAuthenticated, let box = selectedBox else { return }
        guard box.relayBaseUrl?.isEmpty != false || box.relayPassword?.isEmpty != false else { return }
        guard let settings = try? await MachineRegistry.fetchSettings(token: token) else { return }
        adoptSettings(settings)
        guard settings.relayUrl?.isEmpty == false || settings.relayPassword?.isEmpty == false else { return }
        let updated = BoxTarget(id: box.id, name: box.name, host: box.host, port: box.port,
                                managed: box.managed, machineId: box.machineId,
                                relayBaseUrl: settings.relayUrl, relayPassword: settings.relayPassword)
        addBox(updated)
        select(updated)
    }

    // MARK: - Narrated auto-connect (Stream C)

    /// Kick the launch auto-connect once. No-op if signed out, a box is already
    /// picked (a sticky choice always wins), or it already ran this launch.
    ///
    /// `autoConnectStarted` is set here but cleared again by `cancelAutoConnect`
    /// and by every early return in `runAutoConnect` — see the note there. It
    /// marks "a sweep COMPLETED", not "a sweep was attempted".
    func autoConnectOnLaunch() {
        // `!autoConnecting` is the in-flight guard. It used to be implicit in
        // `autoConnectStarted` (which was never cleared); now that the flag
        // re-arms on failure, concurrent `.onAppear` calls need their own guard
        // or a re-arm could start a second overlapping sweep.
        guard isAuthenticated, selectedBox == nil, !autoConnectStarted, !autoConnecting else { return }
        autoConnectStarted = true
        autoConnectCancelled = false
        Task { await runAutoConnect() }
    }

    /// User bailed out of the sweep to pick a machine themselves.
    ///
    /// Re-arms the launch sweep. Previously this left `autoConnectStarted` true,
    /// so bailing out and then dismissing the picker WITHOUT choosing a machine
    /// left the surface permanently unconnected: `selectedBox` was still nil, so
    /// `.onAppear` kept firing, but the flag made every call a no-op until the
    /// app was relaunched. Same class of bug as the mobile auto-connect sweep
    /// (see mobile/src/context/DeviceContext.tsx) — a retry token burned on
    /// entry can never distinguish "already succeeded" from "was interrupted".
    func cancelAutoConnect() {
        autoConnectCancelled = true
        autoConnecting = false
        autoConnectTarget = nil
        autoConnectStarted = false
    }

    /// Fetch the account's machines, pick the best LIVE one (live-first, then by
    /// name — same rule as MachinePickerView), resolve a reachable address, and
    /// select it. Narrates the target before probing. If nothing is live, quietly
    /// yield to the picker prompt (NOT an error — the boxes may just be asleep).
    private func runAutoConnect() async {
        autoConnecting = true
        // Re-arm unless we actually selected a box. A sweep that was cancelled,
        // found nothing live, or failed to resolve an address must leave the
        // launch trigger available — otherwise the surface sits disconnected
        // with no way back short of a relaunch. `select(_:)` sets `selectedBox`,
        // which is the honest "we're done" signal.
        defer {
            autoConnecting = false
            autoConnectTarget = nil
            if selectedBox == nil { autoConnectStarted = false }
        }
        let list = (try? await MachineRegistry.fetch(token: token)) ?? []
        let settings = try? await MachineRegistry.fetchSettings(token: token)
        adoptSettings(settings, devices: list)
        if autoConnectCancelled { return }
        let nowMs = Date().timeIntervalSince1970 * 1000
        func isLive(_ d: RegisteredDevice) -> Bool {
            guard d.isOnline == true else { return false }
            guard let hb = d.lastHeartbeat else { return true }
            return (nowMs - hb) < RegisteredDevice.heartbeatStaleMs
        }
        let target = list
            .filter(isLive)
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            .first
        guard let target else { return }
        // Narrate BEFORE probing so the surface shows which box we're reaching for.
        autoConnectTarget = AutoConnectTarget(name: target.displayName, role: .machine)
        if autoConnectCancelled { return }
        let host = await MachineRegistry.firstReachable(target.addressCandidates, port: target.port, token: token)
            ?? target.addressCandidates.first
            ?? target.quicHost
        if autoConnectCancelled { return }
        guard let host, !host.isEmpty else { return }
        let box = BoxTarget(id: target.deviceId, name: target.displayName, host: host,
                            port: target.port, managed: target.managed, machineId: target.machineId,
                            relayBaseUrl: settings?.relayUrl, relayPassword: settings?.relayPassword)
        addBox(box)
        select(box)
    }

    func client() -> AgentClient? {
        guard isAuthenticated, let box = selectedBox else { return nil }
        return AgentClient(token: token, box: box)
    }

    private func persistBoxes() {
        if let data = try? JSONEncoder().encode(boxes), let s = String(data: data, encoding: .utf8) {
            storedBoxesJSON = s
        }
    }
}

// MARK: - Auto-connect narration (mirrors mobile/src/lib/autoConnectStatus.ts)

enum AutoConnectRole {
    case primary
    case secondary
    /// We know the machine but not its primary/secondary role — tvOS doesn't yet
    /// fetch userSettings, so narrate by name only. Honest, not a false "Primary".
    /// (Fetching primaryDeviceId to upgrade this to full role narration is a
    /// small follow-up: GET /settings, same as web/mobile.)
    case machine
}

struct AutoConnectTarget: Equatable {
    let name: String
    let role: AutoConnectRole
}

enum AutoConnectStatus {
    static func roleWord(_ r: AutoConnectRole) -> String {
        switch r {
        case .primary: return "Primary"
        case .secondary: return "Secondary"
        case .machine: return "Your machine"
        }
    }

    /// Full sentence for the large lean-back surface. Matches autoConnectSentence.
    static func sentence(_ t: AutoConnectTarget?) -> String {
        guard let t else { return "Reaching your machines…" }
        switch t.role {
        case .machine: return "Connecting to \(t.name)…"
        case .primary, .secondary: return "\(roleWord(t.role)) (\(t.name)) is online — connecting…"
        }
    }
}
