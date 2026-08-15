// VibingView.swift — resume the remembered project's live preview.
//
// The old dashboard split "Projects" (where previews lived) from "Vibing"
// (a terminal session). That made the user's intended loop impossible to see:
// pick SFMG → watch the stream while continuing the vibe. A project rail only
// appears when the account has no remembered project; monorepos only pause for
// a child-app choice when they genuinely contain multiple runnable apps.

import SwiftUI

struct VibingView: View {
    @EnvironmentObject var store: YaverStore

    @State private var projects: [ProjectSummary] = []
    @State private var selectedRepository: ProjectSummary?
    @State private var targets: [ProjectSummary] = []
    @State private var activePreview: ProjectSummary?
    @State private var form: PreviewForm = .phone
    @State private var loading = true
    @State private var loadingOptions = false
    @State private var error: String?

    var body: some View {
        Group {
            if let target = activePreview {
                previewSurface(for: target)
            } else if let repository = selectedRepository {
                selectedProjectView(repository)
            } else {
                projectPicker
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .task { if projects.isEmpty { await loadProjects() } }
    }

    private var projectPicker: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                // Vibing is the live preview/control surface, so give it a
                // screen/stream silhouette. Keep wand/sparkles for AI runner
                // actions such as "New vibe"; the two destinations should not
                // read as the same kind of screen from across the room.
                Image(systemName: "play.rectangle.fill").font(.system(size: 28)).foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Vibing").font(.system(size: 34, weight: .bold))
                    Text("Choose a project, then Yaver will show only previews this repository and machine can run.")
                        .font(.system(size: 16)).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await loadProjects() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(loading)
            }
            .padding(.horizontal, 48).padding(.vertical, 24)

            Group {
                if loading {
                    center { ProgressView().scaleEffect(1.4) }
                } else if let error {
                    center {
                        VStack(spacing: 14) {
                            Text(error).foregroundStyle(.orange).multilineTextAlignment(.center)
                            Button("Try again") { Task { await loadProjects() } }
                        }
                    }
                } else if projects.isEmpty {
                    center { Text("No projects were discovered on this machine.").foregroundStyle(.secondary) }
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(alignment: .top, spacing: 20) {
                            ForEach(projects) { projectRow($0) }
                        }
                        .padding(48)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func projectRow(_ project: ProjectSummary) -> some View {
        let style = FrameworkStyle.of(project.framework)
        Button {
            Task { await openProject(project) }
        } label: {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: style.symbol)
                    .font(.system(size: 32))
                    .foregroundStyle(style.color)
                    .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 5) {
                    Text(project.name)
                        .font(.system(size: 24, weight: .semibold))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    Text(projectSummary(project))
                        .font(.system(size: 15))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
                Label("Open", systemImage: "play.rectangle.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(24)
            .frame(width: 330, height: 220, alignment: .leading)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
        }
        #if os(tvOS)
        .buttonStyle(.card)
        #endif
    }

    private func selectedProjectView(_ repository: ProjectSummary) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 16) {
                Button {
                    selectedRepository = nil
                    activePreview = nil
                    targets = []
                    error = nil
                } label: {
                    Label("Change project", systemImage: "chevron.left")
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(repository.name).font(.system(size: 32, weight: .bold)).lineLimit(1)
                    Text("Choose the app to open live").foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
            }

            if loadingOptions {
                HStack(spacing: 16) {
                    ProgressView()
                    Text("Finding runnable apps…").foregroundStyle(.secondary).lineLimit(1)
                }
                .padding(.vertical, 28)
            } else if let error {
                VStack(alignment: .leading, spacing: 14) {
                    Label("Vibing unavailable", systemImage: "exclamationmark.triangle.fill")
                        .font(.title3.bold()).foregroundStyle(.orange)
                    Text(error).foregroundStyle(.secondary)
                    Button("Try again") { Task { await loadTargets(for: repository) } }
                }
                .padding(22)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 18) {
                        ForEach(targets) { target in
                            targetButton(target)
                        }
                    }
                    .padding(.vertical, 18)
                }
            }
            Spacer()
        }
        .padding(48)
    }

    @ViewBuilder
    private func targetButton(_ target: ProjectSummary) -> some View {
        Button {
            activate(target, in: selectedRepository)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: FrameworkStyle.of(target.framework).symbol)
                    .foregroundStyle(FrameworkStyle.of(target.framework).color)
                VStack(alignment: .leading, spacing: 4) {
                    Text(target.name)
                        .font(.system(size: 20, weight: .semibold))
                        .lineLimit(1)
                    Text(projectSummary(target))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
            }
            .padding(20)
            .frame(width: 360, height: 150, alignment: .leading)
        }
        .buttonStyle(.bordered)
        .tint(.secondary)
    }

    private func projectSummary(_ project: ProjectSummary) -> String {
        let surfaces = (project.surfaces ?? []).filter { $0 != "backend" }
        let surfaceText = surfaces.isEmpty ? "" : " · " + surfaces.map { $0.capitalized }.joined(separator: " + ")
        let monorepo = project.isMonorepo == true ? " · monorepo" : ""
        return "\(project.frameworkLabel)\(surfaceText)\(monorepo)"
    }

    private func loadProjects() async {
        loading = true
        error = nil
        do {
            guard let client = store.runnerClient() else { throw AgentError(message: "No machine selected") }
            let loaded = try await client.listProjects().sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
            projects = loaded
            // Opening Vibing is itself an action. If another Yaver surface has
            // already established this runner box's project context, go
            // straight to its available preview lanes. With no remembered
            // project, stay on the picker; discovery order is never a default.
            if selectedRepository == nil {
                if store.lastProject(for: store.runnerBox()?.id, projects: loaded) == nil,
                   let settings = try? await MachineRegistry.fetchSettings(token: store.token) {
                    store.adoptSettings(settings)
                }
                if let remembered = store.lastProject(for: store.runnerBox()?.id, projects: loaded) {
                    await openProject(remembered)
                }
            }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func loadTargets(for repository: ProjectSummary) async {
        loadingOptions = true
        error = nil
        do {
            guard let client = store.runnerClient() else { throw AgentError(message: "No machine selected") }
            if repository.isMonorepo == true, let root = repository.path, !root.isEmpty {
                let apps = try await client.workspaceApps(root: root)
                targets = apps.filter(\.isPreviewable).map { $0.asProject(in: repository) }
                if targets.isEmpty {
                    error = "No runnable app is declared in this workspace. Add it to yaver.workspace.yaml so every surface gets the same answer."
                } else if let resumed = store.rememberedVibingTarget(
                    for: store.renderBox()?.id,
                    repository: repository,
                    targets: targets
                ) {
                    form = resumed.form
                    activePreview = resumed.target
                    loadingOptions = false
                    return
                } else {
                    // Older builds remembered only the repository. Do not make
                    // those users re-select a child on every entry: open the
                    // agent-declared first runnable app once, then persist that
                    // exact page for subsequent launches.
                    activate(targets[0], in: repository)
                    loadingOptions = false
                    return
                }
            } else {
                targets = [repository]
                if let resumed = store.rememberedVibingTarget(
                    for: store.renderBox()?.id,
                    repository: repository,
                    targets: targets
                ) {
                    form = resumed.form
                }
                activate(repository, in: repository)
                loadingOptions = false
                return
            }
        } catch {
            self.error = error.localizedDescription
        }
        loadingOptions = false
    }

    private func openProject(_ project: ProjectSummary) async {
        selectedRepository = project
        activePreview = nil
        if let boxId = store.runnerBox()?.id {
            store.rememberProject(project, for: boxId)
        }
        await loadTargets(for: project)
    }

    private func activate(_ target: ProjectSummary, in repository: ProjectSummary?) {
        guard let repository else { return }
        activePreview = target
        store.rememberVibingTarget(
            target,
            repository: repository,
            form: form,
            for: store.renderBox()?.id
        )
    }

    @ViewBuilder
    private func previewSurface(for target: ProjectSummary) -> some View {
        switch target.kind {
        case .web:
            RemoteRuntimeWebRTCView(project: target, form: form)
                .accessibilityIdentifier("vibing.live-preview")
        case .android:
            DroidStreamView()
                .accessibilityIdentifier("vibing.live-preview")
        case .unknown:
            VStack(spacing: 18) {
                Image(systemName: "questionmark.square.dashed")
                    .font(.system(size: 56)).foregroundStyle(.secondary)
                Text("\(target.name) has no TV preview lane.")
                    .font(.title2).lineLimit(2).multilineTextAlignment(.center)
                Button("Choose another project") {
                    activePreview = nil
                    selectedRepository = nil
                }
            }
        }
    }

    private func center<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
