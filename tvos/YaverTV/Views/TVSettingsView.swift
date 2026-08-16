// TVSettingsView.swift — cross-surface defaults, kept out of Chat.
//
// These values are the shared /settings rows used by web and mobile. The TV
// does not maintain a parallel preference model: choosing a primary machine,
// runner, project or MCP here changes what the next one-step vibe uses on every
// client surface.

import SwiftUI

struct TVSettingsView: View {
    @EnvironmentObject private var store: YaverStore
    @Environment(\.dismiss) private var dismiss

    @State private var devices: [RegisteredDevice] = []
    @State private var projects: [ProjectSummary] = []
    @State private var mcpServers: [String] = []
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var savedMessage: String?

    private var deviceId: String? {
        store.primaryDeviceId ?? store.selectedBox?.id
    }

    private var selectedDevice: RegisteredDevice? {
        guard let deviceId else { return nil }
        return devices.first(where: { $0.deviceId == deviceId })
    }

    private var canReadRuntimeOptions: Bool {
        guard let deviceId else { return false }
        return deviceId == store.runnerBox()?.id
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    intro

                    if loading {
                        HStack(spacing: 14) {
                            ProgressView()
                            Text("Loading shared defaults…").foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 24)
                    } else {
                        settingRow(
                            icon: "desktopcomputer",
                            title: "Primary device",
                            detail: "The machine Yaver connects to first"
                        ) { deviceMenu }

                        settingRow(
                            icon: "cpu",
                            title: "Primary runner",
                            detail: "Used automatically when Chat starts a vibe"
                        ) { runnerMenu }

                        settingRow(
                            icon: "folder.fill",
                            title: "Latest project",
                            detail: "Preselected in Chat and first in Vibing"
                        ) { projectMenu }

                        settingRow(
                            icon: "point.3.connected.trianglepath.dotted",
                            title: "MCP defaults",
                            detail: "Optional tools added to new vibes"
                        ) { mcpMenu }

                        if !canReadRuntimeOptions, deviceId != nil {
                            Label(
                                "Connect this primary device from Devices to refresh its live project and MCP lists.",
                                systemImage: "info.circle"
                            )
                            .font(.system(size: 15))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                        }
                    }

                    if let savedMessage {
                        Label(savedMessage, systemImage: "checkmark.circle.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.green)
                            .padding(.horizontal, 8)
                    }
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 15))
                            .foregroundStyle(.orange)
                            .padding(.horizontal, 8)
                    }
                }
                .padding(40)
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await load() } } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(loading || saving)
                }
            }
        }
        .task { await load() }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Defaults")
                .font(.system(size: 30, weight: .bold))
            Text("Chat uses these silently. Vibing shows the latest project first, but waits for you to open it.")
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
        }
        .padding(.bottom, 8)
    }

    private func settingRow<Control: View>(
        icon: String,
        title: String,
        detail: String,
        @ViewBuilder control: () -> Control
    ) -> some View {
        HStack(spacing: 20) {
            Image(systemName: icon)
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.blue)
                .frame(width: 48, height: 48)
                .background(Color.blue.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 22, weight: .semibold))
                Text(detail).font(.system(size: 15)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 30)
            control()
                .frame(maxWidth: 420, alignment: .trailing)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    private var deviceMenu: some View {
        Menu {
            ForEach(devices) { device in
                Button {
                    Task { await chooseDevice(device) }
                } label: {
                    if device.deviceId == deviceId {
                        Label(device.realName, systemImage: "checkmark")
                    } else {
                        Text(device.realName)
                    }
                }
            }
        } label: {
            VStack(alignment: .trailing, spacing: 3) {
                Text(selectedDevice?.realName ?? "Choose device")
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(1)
                if let alias = selectedDevice?.aliasLabel {
                    Text(alias).font(.system(size: 13)).foregroundStyle(.secondary)
                }
            }
        }
        .disabled(saving || devices.isEmpty)
        .accessibilityIdentifier("settings.primary-device")
    }

    private var runnerMenu: some View {
        let rows = availableRunners
        let selected = deviceId.flatMap { store.primaryRunnerByDevice[$0] }
        return Menu {
            ForEach(rows) { runner in
                Button {
                    Task { await chooseRunner(runner.id) }
                } label: {
                    if runner.id == selected {
                        Label(runner.label, systemImage: "checkmark")
                    } else {
                        Text(runner.label)
                    }
                }
            }
        } label: {
            Text(runnerLabel(selected))
                .font(.system(size: 17, weight: .semibold))
                .lineLimit(1)
        }
        .disabled(saving || deviceId == nil || rows.isEmpty)
        .accessibilityIdentifier("settings.primary-runner")
    }

    private var projectMenu: some View {
        let remembered = store.lastProject(for: deviceId, projects: projects)
        let savedName = deviceId.flatMap { store.lastProjectByDevice[$0]?.projectName }
        return Menu {
            ForEach(projects) { project in
                Button {
                    guard let deviceId else { return }
                    store.rememberProject(project, for: deviceId)
                    savedMessage = "Latest project saved"
                    error = nil
                } label: {
                    if project.id == remembered?.id {
                        Label(project.name, systemImage: "checkmark")
                    } else {
                        Text(project.name)
                    }
                }
            }
        } label: {
            Text(remembered?.name ?? savedName ?? "No latest project")
                .font(.system(size: 17, weight: .semibold))
                .lineLimit(1)
        }
        .disabled(!canReadRuntimeOptions || projects.isEmpty)
        .accessibilityIdentifier("settings.latest-project")
    }

    private var mcpMenu: some View {
        let pref = deviceId.flatMap { store.lastMCPServersByDevice[$0] }
        let selected = Set(pref?.mcpServers ?? [])
        let includeYaver = pref?.includeYaverMcp ?? true
        let count = selected.count + (includeYaver ? 1 : 0)
        return Menu {
            Button { saveMCP(selected, includeYaver: !includeYaver) } label: {
                if includeYaver { Label("Yaver MCP", systemImage: "checkmark") }
                else { Text("Yaver MCP") }
            }
            if !mcpServers.isEmpty { Divider() }
            ForEach(mcpServers, id: \.self) { name in
                Button {
                    var next = selected
                    if next.contains(name) { next.remove(name) } else { next.insert(name) }
                    saveMCP(next, includeYaver: includeYaver)
                } label: {
                    if selected.contains(name) { Label(name, systemImage: "checkmark") }
                    else { Text(name) }
                }
            }
        } label: {
            Text(count == 0 ? "No MCP" : "\(count) enabled")
                .font(.system(size: 17, weight: .semibold))
                .lineLimit(1)
        }
        .disabled(!canReadRuntimeOptions)
        .accessibilityIdentifier("settings.latest-mcp")
    }

    private var availableRunners: [RegisteredRunner] {
        guard let device = selectedDevice else { return [] }
        var rows = (device.runners ?? []).filter { $0.installed != false }
        if rows.isEmpty {
            rows = (device.installedRunnerIds ?? []).map {
                RegisteredRunner(runnerId: $0, installed: true, ready: nil, authConfigured: nil, status: nil)
            }
        }
        var seen = Set<String>()
        return rows.filter { seen.insert($0.id).inserted }
    }

    private func runnerLabel(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "Choose runner" }
        switch RegisteredRunner.canonical(value) {
        case "claude": return "Claude Code"
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        default: return value
        }
    }

    private func chooseDevice(_ device: RegisteredDevice) async {
        saving = true
        error = nil
        savedMessage = nil
        defer { saving = false }
        do {
            try await store.setPrimaryDevice(device.deviceId)
            savedMessage = "Primary device saved"
            await loadRuntimeOptions()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func chooseRunner(_ runner: String) async {
        guard let deviceId else { return }
        saving = true
        error = nil
        savedMessage = nil
        defer { saving = false }
        do {
            try await store.setPrimaryRunner(runner, for: deviceId)
            savedMessage = "Primary runner saved"
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func saveMCP(_ selected: Set<String>, includeYaver: Bool) {
        guard let deviceId else { return }
        store.rememberMCPServers(Array(selected).sorted(), includeYaverMcp: includeYaver, for: deviceId)
        savedMessage = "MCP defaults saved"
        error = nil
    }

    private func load() async {
        loading = true
        error = nil
        savedMessage = nil
        do {
            async let deviceRows = MachineRegistry.fetch(token: store.token)
            async let settings = MachineRegistry.fetchSettings(token: store.token)
            let (loadedDevices, loadedSettings) = try await (deviceRows, settings)
            devices = loadedDevices
                .filter { !$0.shared }
                .sorted { $0.realName.localizedCaseInsensitiveCompare($1.realName) == .orderedAscending }
            store.adoptSettings(loadedSettings, devices: loadedDevices)
            await loadRuntimeOptions()
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func loadRuntimeOptions() async {
        projects = []
        mcpServers = []
        guard canReadRuntimeOptions, let client = store.runnerClient() else { return }
        async let projectRows: [ProjectSummary]? = try? client.listProjects()
        async let mcpRows: [McpServerSummary]? = try? client.listMCPServers()
        projects = ((await projectRows) ?? []).sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        mcpServers = ((await mcpRows) ?? []).map(\.name).sorted()
    }
}
