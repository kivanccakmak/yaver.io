// ProjectsView.swift — browse the box's projects and preview one on the TV.
//
// The entry to the vibe loop on a TV: pick a project, choose a form factor
// (phone / tablet / desktop), and watch it render on the big screen. Because
// the redroid container runs the app on the BOX (not a physical phone), there's
// no Hermes push to a device — the TV just streams pixels:
//   * an RN/Android project runs in redroid → /droid/frame
//   * a web project is captured headless at the chosen viewport → vibe frames
// tvOS has no WebKit, so a web app is always streamed as pixels, never a real
// in-process webview.

import SwiftUI

/// The device form factor to render a preview at. Drives the headless viewport
/// for web, and is advisory for redroid.
enum PreviewForm: String, CaseIterable, Identifiable {
    case phone = "Phone", tablet = "Tablet", desktop = "Desktop"
    var id: String { rawValue }
    var width: Int { self == .phone ? 390 : self == .tablet ? 820 : 1280 }
    var height: Int { self == .phone ? 844 : self == .tablet ? 1180 : 720 }
    var icon: String { self == .phone ? "iphone" : self == .tablet ? "ipad" : "display" }
}

struct ProjectsView: View {
    @EnvironmentObject var store: YaverStore

    @State private var projects: [ProjectSummary] = []
    @State private var loading = true
    @State private var error: String?
    @State private var form: PreviewForm = .phone

    /// Continue a `yaver.tv.startAt` route one level deeper: "preview:<name>"
    /// opens that project's preview as soon as the list has loaded.
    ///
    /// The dashboard's half of this is documented in DashboardView.startAt —
    /// short version: the tile grid is width-adaptive and cannot be driven by
    /// remote presses. THIS screen has the same problem for a different reason.
    /// Focus lands on the "Render as" segmented control at the top, not on a
    /// project row, so the number of presses to reach a given project depends
    /// on how many projects the box happens to have (eight on the test box
    /// today, and that is data, not layout).
    ///
    /// Routing by NAME is stable against both. And it is the same thing a user
    /// wants: "put my project on the TV" without walking a remote through two
    /// screens to get there.
    @AppStorage("yaver.tv.startAt") private var startAt: String = ""
    /// Routed by NAME, not by model: `navigationDestination(item:)` needs
    /// Hashable, and adding that conformance to the SHARED ProjectSummary
    /// (tvos/YaverTV/Models.swift, also compiled into visionOS) to satisfy one
    /// view would be changing a model for a caller's convenience. The name is
    /// already the identity this route is expressed in.
    @State private var routedProjectName: String?
    @State private var didRoute = false
    /// "Start a vibe" from a project's preview dead-end — presents the
    /// composer with that project preselected (2026-08-13).
    @State private var composerProjectName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            formPicker
            Group {
                if loading {
                    center { ProgressView().scaleEffect(1.4) }
                } else if let error {
                    center {
                        VStack(spacing: 14) {
                            Text(error).foregroundStyle(.orange).multilineTextAlignment(.center)
                            Button("Try again") { Task { await load() } }
                        }
                    }
                } else if projects.isEmpty {
                    center { Text("No projects on this machine.").foregroundStyle(.secondary) }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(projects) { p in row(p) }
                        }.padding(48)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .task { await load() }
        // Continue the startAt route once the list exists. Guarded by didRoute
        // so a refresh cannot re-push the same screen, and by a name match so a
        // route naming a project this box does not have simply stays on the
        // list — where the user can see what IS here — instead of dead-ending.
        .navigationDestination(item: $routedProjectName) { name in
            if let p = projects.first(where: { $0.name == name }) {
                destination(for: p)
            }
        }
        .onChange(of: projects.count) { _, count in
            guard count > 0, !didRoute, startAt.hasPrefix("preview:") else { return }
            let wanted = String(startAt.dropFirst("preview:".count))
            guard let hit = projects.first(where: { $0.name.caseInsensitiveCompare(wanted) == .orderedSame })
                ?? projects.first(where: { $0.name.localizedCaseInsensitiveContains(wanted) }) else { return }
            didRoute = true
            routedProjectName = hit.name
        }
    }

    private var header: some View {
        HStack {
            Image(systemName: "folder.fill").font(.system(size: 26)).foregroundStyle(.orange)
            Text("Projects").font(.system(size: 30, weight: .bold))
            Spacer()
            Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.disabled(loading)
        }
        .padding(.horizontal, 48).padding(.vertical, 20)
    }

    private var formPicker: some View {
        HStack(spacing: 12) {
            Text("Render as").foregroundStyle(.secondary).font(.system(size: 18))
            Picker("Form", selection: $form) {
                ForEach(PreviewForm.allCases) { f in Label(f.rawValue, systemImage: f.icon).tag(f) }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 560)
            Spacer()
        }
        .padding(.horizontal, 48).padding(.bottom, 12)
    }

    @ViewBuilder private func row(_ p: ProjectSummary) -> some View {
        let style = FrameworkStyle.of(p.framework)
        NavigationLink(destination: destination(for: p)) {
            HStack(spacing: 18) {
                // Same framework icon + brand color the phone shows (FrameworkIcon.tsx).
                Image(systemName: style.symbol).font(.system(size: 26))
                    .foregroundStyle(style.color).frame(width: 40)
                VStack(alignment: .leading, spacing: 4) {
                    Text(p.name).font(.system(size: 24, weight: .semibold))
                    Text([p.frameworkLabel, p.branch].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 15)).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "play.rectangle.fill").foregroundStyle(.secondary)
            }
            .padding(.horizontal, 24).padding(.vertical, 18)
        }
        // `.card` is a tvOS-only button style — it does not exist on visionOS,
        // where this file is now also compiled. Guarded rather than forked: one
        // shared ProjectsView keeps the two surfaces honest about the same
        // project list, and a copy would drift the way three relay-auth matchers
        // already have. visionOS gets the platform default, which is the right
        // affordance there anyway: a headset points and pinches, it does not
        // move focus card-to-card with a remote.
        #if os(tvOS)
        .buttonStyle(.card)
        #endif
    }

    @ViewBuilder private func destination(for p: ProjectSummary) -> some View {
        switch p.kind {
        case .android:
            DroidStreamView()
        case .web:
            WebPreviewStreamView(project: p, form: form)
        case .flutter:
            unsupported("Flutter previews aren't streamable to the TV yet — run it on a device or the web.",
                        project: p)
        case .unknown:
            // Dead-end audit fix (2026-08-13): the old text said "Open it in
            // Session to run it" with NO button — a route with no tap. A
            // monorepo/unknown-framework project can't stream a preview, but
            // it can absolutely run: drive its session or start a vibe in it.
            unsupported("No preview known for \(p.frameworkLabel). Run it instead:",
                        project: p)
        }
    }

    private func unsupported(_ msg: String, project: ProjectSummary? = nil) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "questionmark.square.dashed").font(.system(size: 56)).foregroundStyle(.secondary)
            Text(msg).multilineTextAlignment(.center).frame(maxWidth: 640).foregroundStyle(.secondary)
            if let project {
                HStack(spacing: 18) {
                    NavigationLink(destination: SessionView(preselect: nil)) {
                        Label("Open in Session", systemImage: "terminal.fill")
                            .font(.system(size: 18, weight: .semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    Button {
                        composerProjectName = project.name
                    } label: {
                        Label("Start a vibe", systemImage: "wand.and.stars")
                            .font(.system(size: 18, weight: .semibold))
                    }
                    .buttonStyle(.bordered)
                }
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .sheet(isPresented: Binding(
            get: { composerProjectName != nil },
            set: { if !$0 { composerProjectName = nil } }
        )) {
            if let name = composerProjectName {
                TaskComposerView(initialProjectName: name)
                    .environmentObject(store)
            }
        }
    }

    private func center<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content().frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func load() async {
        loading = true
        error = nil
        do {
            // Projects come from the RUNNER box — the machine whose repo the
            // AI edits. In a split, the selected box may be the render-only
            // machine and its project list is not what a vibe turn will touch.
            guard let client = store.runnerClient() else {
                throw AgentError(message: store.machineSplitActive
                    ? "Your AI machine needs the relay to be reachable from this TV."
                    : "No machine selected")
            }
            projects = try await client.listProjects()
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}
