// DashboardView.swift — lean-back launcher, shaped like the web dashboard.
//
// The tile grid used to be twelve boxes (Session, Tasks, Projects, Runtime,
// Apple TV, Capture, Feedback, Android, Switch, Update agent, Shared with,
// Sign out). On a TV that is a wall of inventory; the web's sidebar is five
// items — Devices, Chat, Projects, Vibing — and sign-out lives in the profile.
// This surface is the same five, plus a "More" tile that hides the secondary
// tools instead of showing them all at once:
//
//   Devices  → MachinePickerView  (your account's machines, switch/wake)
//   Chat     → TasksView          (tasks & vibes — the web/mobile chat)
//   Projects → ProjectsView       (browse & preview on the TV)
//   Vibing   → SessionView        (drive a live coding session)
//   More     → secondary tools    (Runtime · Apple TV · capture · feedback)
//
// The profile menu (top-right) owns the account-level actions: Sign out,
// Update agent. The connected PC is shown as a first-class card
// under the header — name, host, live status — so "which box am I on" is the
// first thing the initial screen answers, exactly like web/mobile.

import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var store: YaverStore
    @State private var showPicker = false
    @State private var showMore = false
    @State private var showUpdateAgent = false
    @StateObject private var lifecycle = BoxLifecycle()

    /// Open the TV directly on a screen instead of the tile grid.
    ///
    /// Same class of configuration as `yaver.tv.selectedBox` and
    /// `yaver.tv.boxes` above it — read from UserDefaults, so the argument
    /// domain sets it too. Values: "" (normal), "projects",
    /// "preview:<projectName>".
    ///
    /// "preview:<name>" routes THROUGH here to Projects, which then continues
    /// the route to that project (ProjectsView.startAt). Matching this key by
    /// EQUALITY against "projects" was a real regression: adding the deeper
    /// value silently stopped the first hop, the app stayed on the dashboard,
    /// and the screenshots showed a tile grid where a preview was expected.
    /// A route with two segments has to match on its prefix, not its whole.
    ///
    /// This is a ROUTE, not a test hook, and it earns its place twice:
    ///
    ///  1. Product. A TV is the one surface where getting somewhere costs the
    ///     most — every screen is a focus walk with a remote. "Open Yaver on
    ///     the TV at my projects" is the handoff the phone should be able to
    ///     perform, and CLAUDE.md's failure-plumbing rule asks for exactly this
    ///     shape: a route the surface can be sent to, not a sentence describing
    ///     where to go.
    ///
    ///  2. Testability, honestly stated. The tile grid is
    ///     `LazyVGrid(GridItem(.adaptive(minimum: 300)))` — its COLUMN COUNT
    ///     DEPENDS ON WIDTH, so there is no stable press-route to it. Six
    ///     closed-loop runs were spent discovering that: a `.right` sweep
    ///     walked focus out of the grid, `hasFocus` reads false while focus is
    ///     passing through an element, and the accessibility tree order is not
    ///     the on-screen order (Projects is index 3 in the tree and neither 2
    ///     nor 3 presses away on screen). Driving an adaptive grid by
    ///     coordinates is not a test that can be trusted.
    @AppStorage("yaver.tv.startAt") private var startAt: String = ""
    @State private var routedFromStartAt = false

    /// Both "projects" and "preview:<name>" enter through Projects.
    private var routesToProjects: Bool {
        startAt == "projects" || startAt.hasPrefix("preview:")
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 36) {
                    header

                    if store.selectedBox == nil {
                        if store.autoConnecting {
                            autoConnectPanel
                        } else {
                            emptyBoxPrompt
                        }
                    } else {
                        selectedMachinePanel
                        wakePanel

                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 24)], spacing: 24) {
                            // Devices — the account's machines, with liveness +
                            // wake, same list web's Devices tab shows.
                            Button { showPicker = true } label: {
                                Tile(icon: "laptopcomputer", title: "Devices", detail: "Machines on your account · switch or wake")
                            }
                            NavigationLink(destination: TasksView()) {
                                Tile(icon: "bubble.left.and.bubble.right.fill", title: "Chat", detail: "Tasks & vibes — what's running, start a vibe")
                            }
                            NavigationLink(destination: ProjectsView()) {
                                Tile(icon: "folder.fill", title: "Projects", detail: "Browse & preview on the TV")
                            }
                            NavigationLink(destination: SessionView()) {
                                Tile(icon: "wand.and.stars", title: "Vibing", detail: "Drive a live coding session")
                            }
                            // Everything that used to be its own box lives here,
                            // one level down: Runtime, Apple TV remote, Capture,
                            // Android, Feedback. Capability is not deleted, it
                            // just stops crowding the five surfaces.
                            Button { showMore = true } label: {
                                Tile(icon: "ellipsis.circle.fill", title: "More", detail: "Runtime · Apple TV · capture · feedback")
                            }
                        }
                    }
                }
                .padding(56)
            }
            // Programmatic route from `yaver.tv.startAt` — see the property.
            // Fires once, and only when a box is actually selected: routing into
            // Projects before there is a machine would show an empty screen and
            // read as a broken deep link rather than as "pick a box first".
            .navigationDestination(isPresented: $routedFromStartAt) { ProjectsView() }
            .onChange(of: store.selectedBox?.id) { _, id in
                guard id != nil, routesToProjects, !routedFromStartAt else { return }
                routedFromStartAt = true
            }
            .onAppear {
                guard store.selectedBox != nil, routesToProjects, !routedFromStartAt else { return }
                routedFromStartAt = true
            }
            .sheet(isPresented: $showPicker) { MachinePickerView() }
            .sheet(isPresented: $showMore) { MoreToolsView() }
            .sheet(isPresented: $showUpdateAgent) { UpdateAgentView() }
            .task(id: store.selectedBox?.id) {
                await store.refreshSelectedRelaySettings()
                guard let box = store.selectedBox else { return }
                lifecycle.refreshReachability(box)
                // Seamless connectivity self-heal (tvOS analog of mobile's relay
                // self-heal): if the box isn't answering over direct/relay and
                // it isn't a parkable managed box (which has its own Wake path),
                // re-resolve a fresh reachable address once and re-probe. The
                // task id is the deviceId, which a host swap doesn't change, so
                // this can't loop.
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                if lifecycle.reachable == false, !(box.managed ?? false) {
                    await store.healReachability()
                    if let healed = store.selectedBox, healed.host != box.host {
                        lifecycle.refreshReachability(healed)
                    }
                }
            }
            // Stream C: on launch, silently connect to a live machine + narrate,
            // rather than dropping the user on the "Choose machine" wall.
            .onAppear { store.autoConnectOnLaunch() }
        }
    }

    // Shown above the tiles when the selected box is unreachable, and while a
    // wake is running. A reachable box shows nothing here.
    @ViewBuilder private var wakePanel: some View {
        if lifecycle.isRunning {
            WakeProgressView(lifecycle: lifecycle, boxName: store.selectedBox?.name)
        } else if let blocked = lifecycle.clientBlocked {
            // NOT ASLEEP — THIS DEVICE REFUSED THE REQUEST.
            //
            // Measured 2026-08-03: the TV showed "Box asleep — start it from
            // your computer or phone" while that box answered GET /info with
            // 200 throughout. ATS had refused the connection before a packet
            // left the headset. Sending someone to go start a machine that is
            // already running is worse than saying nothing: it costs a trip and
            // teaches them the product cannot be trusted.
            //
            // Deliberately offers NO Wake button. Waking cannot fix a
            // client-side policy, and a button that cannot work is the defect
            // this file family keeps paying for.
            VStack(alignment: .leading, spacing: 16) {
                Label("This device blocked the connection", systemImage: "hand.raised.fill")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(.orange)
                Text(blocked)
                    .font(.system(size: 19)).foregroundStyle(.secondary)
                    .frame(maxWidth: 820, alignment: .leading)
            }
            .padding(28)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
        } else if (lifecycle.needsWake || lifecycle.error != nil), let box = store.selectedBox {
            VStack(alignment: .leading, spacing: 16) {
                Label("Box asleep", systemImage: "moon.zzz.fill")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(.orange)
                if box.wakeable {
                    Text("\(box.name) isn't answering. It may have parked itself to save cost. Wake it to keep working.")
                        .font(.system(size: 19)).foregroundStyle(.secondary).frame(maxWidth: 820, alignment: .leading)
                    Button {
                        lifecycle.wake(box, token: store.token)
                    } label: {
                        Label(lifecycle.error == nil ? "Wake" : "Try again", systemImage: "power")
                            .font(.system(size: 22, weight: .semibold))
                            .padding(.horizontal, 28).padding(.vertical, 12)
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    Text("\(box.name) isn't answering, and it can't be woken from the TV — start it from your computer or phone.")
                        .font(.system(size: 19)).foregroundStyle(.secondary).frame(maxWidth: 820, alignment: .leading)
                }
                if let err = lifecycle.error {
                    Text(err).font(.system(size: 16, design: .monospaced)).foregroundStyle(.red)
                }
            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
        }
    }

    /// Header: brand on the left, the PROFILE menu on the right. Sign-out is
    /// an account action, so it lives here — never buried in a tile grid.
    private var header: some View {
        HStack(alignment: .center, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Yaver").font(.system(size: 48, weight: .heavy))
                Text(store.selectedBox.map { "Remote runtime on \($0.name)" } ?? "No box selected")
                    .font(.system(size: 20)).foregroundStyle(.secondary)
            }
            Spacer()
            Menu {
                Button(role: .destructive) { store.signOut() } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
                Button { showUpdateAgent = true } label: {
                    Label("Update agent", systemImage: "arrow.down.circle")
                }
            } label: {
                Image(systemName: "person.crop.circle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// The connected PC, named and alive — the first thing the initial screen
    /// answers. Status dot: green = reachable, orange = unreachable, gray =
    /// checking. Detail names host, relay fallback and the runner/render split
    /// badge so a split is never two silent sources.
    private var selectedMachinePanel: some View {
        HStack(spacing: 22) {
            Image(systemName: "server.rack")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(connectivityColor)
                .frame(width: 54, height: 54)
                .background(connectivityColor.opacity(0.16), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 12) {
                    Text(store.selectedBox?.name ?? "Selected machine")
                        .font(.system(size: 26, weight: .bold))
                    statusChip
                }
                Text(machineDetail)
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Button { showPicker = true } label: {
                Label("Switch", systemImage: "rectangle.2.swap")
                    .font(.system(size: 19, weight: .semibold))
                    .padding(.horizontal, 22).padding(.vertical, 10)
            }
            .buttonStyle(.bordered)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    private var connectivityColor: Color {
        switch lifecycle.reachable {
        case .some(true): return .green
        case .some(false): return .orange
        case nil: return .gray
        }
    }

    @ViewBuilder private var statusChip: some View {
        switch lifecycle.reachable {
        case .some(true):
            chip("Connected", .green)
        case .some(false):
            chip("Unreachable", .orange)
        case nil:
            chip("Checking…", .gray)
        }
    }

    private func chip(_ text: String, _ color: Color) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 9, height: 9)
            Text(text)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(color.opacity(0.14), in: Capsule())
    }

    private var machineDetail: String {
        guard let box = store.selectedBox else { return "No machine selected" }
        var parts = [box.host]
        if box.wakeable { parts.append("wakeable") }
        if box.relayBaseUrl?.isEmpty == false { parts.append("relay fallback") }
        // Runner/render split badge — two silent sources are two
        // unfalsifiable states; the dashboard names both boxes.
        if let badge = store.machineRolesBadge { parts.append(badge) }
        return parts.joined(separator: " · ")
    }

    private var emptyBoxPrompt: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Pick a machine")
                .font(.system(size: 26, weight: .semibold))
            Text("Choose one of the machines on your account, or type a LAN address. A machine appears here once it's running `yaver serve` signed in as you.")
                .font(.system(size: 19)).foregroundStyle(.secondary).frame(maxWidth: 720, alignment: .leading)
            Button("Choose machine") { showPicker = true }.padding(.top, 8)
        }
    }

    // Narrated auto-connect (Stream C): while the launch sweep is in flight, show
    // WHICH machine we're reaching for + a way to bail, instead of the static
    // "Choose machine" wall. Mirrors mobile's NoMachineEmpty auto-connect branch.
    private var autoConnectPanel: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 16) {
                ProgressView().scaleEffect(1.3)
                Text(AutoConnectStatus.sentence(store.autoConnectTarget))
                    .font(.system(size: 26, weight: .semibold))
            }
            Text("Connecting automatically. This opens the moment your machine is ready.")
                .font(.system(size: 19)).foregroundStyle(.secondary).frame(maxWidth: 720, alignment: .leading)
            Button("Choose a machine myself") {
                store.cancelAutoConnect()
                showPicker = true
            }
            .padding(.top, 8)
        }
    }
}

private struct Tile: View {
    let icon: String
    let title: String
    let detail: String
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: icon).font(.system(size: 40))
            Spacer(minLength: 0)
            Text(title).font(.system(size: 24, weight: .bold))
            if !detail.isEmpty {
                Text(detail).font(.system(size: 16)).foregroundStyle(.secondary)
            }
        }
        .frame(width: 280, height: 180, alignment: .leading)
        .padding(24)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }
}

// AddBoxView moved to ../AddBoxView.swift — the shared client layer — so the
// visionOS target can present it too. It was the only caller of store.addBox()
// in the repo, and living here made it unreachable from the headset.
