import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useColors } from "../src/context/ThemeContext";
import type { ThemeColors } from "../src/constants/colors";
import { useDevice } from "../src/context/DeviceContext";
import { useAuth } from "../src/context/AuthContext";
import { connectionManager } from "../src/lib/connectionManager";
import { goalFromSlashCommand } from "../src/lib/goalSlashCommand";
import { displayRunnerLabel, normalizeTaskRunnerId, preferredDefaultModelForRunner } from "../src/lib/remoteCodingSelection";
import { listMcpServers, type McpServer } from "../src/lib/mcpServers";
import {
  loadKeepLastProjectEnabled,
  loadLastTaskProject,
  saveLastTaskProject,
} from "../src/lib/taskComposerPrefs";
import type { ModelInfo, RunnerInfo } from "../src/lib/quic";

type TVProject = {
  name: string;
  path: string;
  branch?: string;
  framework?: string;
  gitRemote?: string;
};

function projectNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || "Project";
}

export default function TVCodingScreen() {
  const c = useColors();
  const router = useRouter();
  const { devices, activeDevice, selectDevice, primaryRunnerByDevice, primaryModelByDevice } = useDevice() as any;
  const { token } = useAuth();
  const styles = makeStyles(c);

  const [deviceId, setDeviceId] = useState<string>("");
  const [projects, setProjects] = useState<TVProject[]>([]);
  const [selectedProjectPath, setSelectedProjectPath] = useState("");
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [selectedRunner, setSelectedRunner] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [inputMode, setInputMode] = useState<"write" | "speech">("write");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState("");
  const [sendFocused, setSendFocused] = useState(false);

  const deviceRows = useMemo(() => {
    const rows = Array.isArray(devices) ? devices : [];
    return rows.filter((d: any) => d?.id || d?.deviceId);
  }, [devices]);
  const selectedDevice = deviceRows.find((d: any) => (d.id || d.deviceId) === deviceId) || activeDevice || deviceRows[0];
  const selectedProject = projects.find((project) => project.path === selectedProjectPath) || null;
  const selectedRunnerRow = runners.find((runner) => normalizeTaskRunnerId(runner.id) === normalizeTaskRunnerId(selectedRunner)) || null;
  const availableModels = selectedRunnerRow?.models || [];

  useEffect(() => {
    const roleRunner = connectionManager.roleDeviceId("runner");
    const preferred = roleRunner || activeDevice?.id || activeDevice?.deviceId || deviceRows[0]?.id || deviceRows[0]?.deviceId || "";
    if (!deviceId && preferred) setDeviceId(preferred);
  }, [activeDevice, deviceId, deviceRows]);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    void (async () => {
      setBusy("Loading coding configuration...");
      const device = deviceRows.find((d: any) => (d.id || d.deviceId) === deviceId);
      try {
        if (device && token) {
          await connectionManager.ensureConnected(deviceId, {
            host: device.host,
            port: device.port,
            token,
            lanIps: device.lanIps,
            connectionPreferences: device.connectionPreferences,
          }).catch(async () => {
            try {
              await selectDevice?.(device);
            } catch {}
          });
        }
        const client = connectionManager.clientFor(deviceId);
        const [projectRows, runnerRows, mcpRows, keepLast] = await Promise.all([
          client.listProjects().catch(() => []),
          client.getRunners().catch(() => []),
          listMcpServers().catch(() => []),
          loadKeepLastProjectEnabled(),
        ]);
        if (cancelled) return;
        const normalizedProjects = (projectRows || [])
          .filter((project: any) => project?.path)
          .map((project: any) => ({
            name: String(project.name || projectNameFromPath(String(project.path))),
            path: String(project.path),
            branch: project.branch ? String(project.branch) : undefined,
            framework: project.framework ? String(project.framework) : undefined,
            gitRemote: project.gitRemote ? String(project.gitRemote) : undefined,
          }));
        const installed = (runnerRows || []).filter((runner: RunnerInfo) => runner.installed);
        setProjects(normalizedProjects);
        setRunners(installed);
        setMcpServers((mcpRows || []).filter((server) => server.enabled));

        const last = keepLast ? await loadLastTaskProject(deviceId) : null;
        if (cancelled) return;
        const projectMatch = last
          ? normalizedProjects.find((project) => project.path === last.path || project.name.toLowerCase() === last.name.toLowerCase())
          : null;
        setSelectedProjectPath((current) => current || projectMatch?.path || normalizedProjects[0]?.path || "");
        const primaryRunner = primaryRunnerByDevice?.[deviceId] || "";
        const runner =
          installed.find((row: RunnerInfo) => row.id === primaryRunner) ||
          installed.find((row: RunnerInfo) => normalizeTaskRunnerId(row.id) === "opencode" && row.ready !== false) ||
          installed.find((row: RunnerInfo) => row.ready) ||
          installed[0];
        if (runner) {
          setSelectedRunner((current) => current || runner.id);
          const primaryModel = primaryModelByDevice?.[deviceId] || "";
          const model =
            runner.models?.find((row) => row.id === primaryModel) ||
            runner.models?.find((row) => row.id === preferredDefaultModelForRunner(runner.id, device, undefined)) ||
            runner.models?.find((row) => row.isDefault) ||
            runner.models?.[0];
          setSelectedModel((current) => current || model?.id || "");
        }
        setBusy("");
      } catch (error) {
        if (!cancelled) setBusy(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, deviceRows, primaryModelByDevice, primaryRunnerByDevice, selectDevice, token]);

  const send = useCallback(async () => {
    if (!deviceId || !prompt.trim()) return;
    const client = connectionManager.clientFor(deviceId);
    const projectName = selectedProject?.name || projectNameFromPath(selectedProjectPath);
    // Yaver goal-mode: `/goal <objective>` arms a persistent goal on the
    // opencode runner via the structured `goal` field (see goalSlashCommand).
    const goalIntent = goalFromSlashCommand(prompt, selectedRunner);
    const goalText = goalIntent?.goal ?? "";
    setBusy("Sending task...");
    try {
      const task = await client.sendTask(
        goalIntent ? goalText.slice(0, 80) : (prompt.trim().slice(0, 80) || "TV coding task"),
        goalIntent ? goalText : prompt.trim(),
        selectedModel || undefined,
        selectedRunner || undefined,
        undefined,
        undefined,
        undefined,
        selectedProjectPath || undefined,
        undefined,
        undefined,
        true,
        undefined,
        projectName,
        selectedMcpServers,
        goalIntent ? goalText : undefined,
      );
      if (projectName && selectedProjectPath) {
        void saveLastTaskProject({
          deviceId,
          name: projectName,
          path: selectedProjectPath,
          branch: selectedProject?.branch,
          gitRemote: selectedProject?.gitRemote,
        });
      }
      setPrompt("");
      setBusy(`Started ${task.title || task.id}`);
    } catch (error) {
      setBusy(error instanceof Error ? error.message : String(error));
    }
  }, [deviceId, prompt, selectedMcpServers, selectedModel, selectedProject, selectedProjectPath, selectedRunner]);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <Pressable focusable onPress={() => router.back()} style={styles.back}>
            <Ionicons name="chevron-back" size={22} color={c.textSecondary} />
            <Text style={styles.backText}>Back</Text>
          </Pressable>
          <Text style={styles.title}>Coding</Text>
          <Text style={styles.subtitle}>
            {[selectedDevice?.name || "Box", selectedProject?.name || "Project", selectedRunner ? displayRunnerLabel(selectedRunner) : "Agent"].join(" · ")}
          </Text>
        </View>

        <ConfigBand title="Remote Box">
          {deviceRows.map((device: any) => {
            const id = device.id || device.deviceId;
            return (
              <TVChip key={id} active={id === deviceId} colors={c} onPress={() => {
                setDeviceId(id);
                void selectDevice?.(device).catch?.(() => undefined);
              }}>
                {device.name || device.alias || id}
              </TVChip>
            );
          })}
        </ConfigBand>

        <ConfigBand title="Project">
          {projects.length === 0 ? <Text style={styles.muted}>No projects reported by this box.</Text> : projects.map((project) => (
            <TVChip key={project.path} active={project.path === selectedProjectPath} colors={c} onPress={() => setSelectedProjectPath(project.path)}>
              {project.name}
            </TVChip>
          ))}
        </ConfigBand>

        <ConfigBand title="Agent">
          {runners.map((runner) => (
            <TVChip key={runner.id} active={runner.id === selectedRunner} colors={c} disabled={runner.ready === false} onPress={() => {
              setSelectedRunner(runner.id);
              setSelectedModel(runner.models?.find((model) => model.isDefault)?.id || runner.models?.[0]?.id || "");
            }}>
              {displayRunnerLabel(runner.id)}
            </TVChip>
          ))}
        </ConfigBand>

        {availableModels.length > 0 ? (
          <ConfigBand title="Model">
            {availableModels.map((model: ModelInfo) => (
              <TVChip key={model.id} active={model.id === selectedModel} colors={c} onPress={() => setSelectedModel(model.id)}>
                {model.name || model.id}
              </TVChip>
            ))}
          </ConfigBand>
        ) : null}

        <ConfigBand title="Task MCPs">
          <TVChip active={selectedMcpServers.length === 0} colors={c} onPress={() => setSelectedMcpServers([])}>
            No MCPs
          </TVChip>
          {mcpServers.map((server) => (
            <TVChip key={server.name} active={selectedMcpServers.includes(server.name)} colors={c} onPress={() => {
              setSelectedMcpServers((prev) => prev.includes(server.name) ? prev.filter((name) => name !== server.name) : [...prev, server.name]);
            }}>
              {server.name}
            </TVChip>
          ))}
        </ConfigBand>

        <ConfigBand title="Input">
          <TVChip active={inputMode === "write"} colors={c} onPress={() => setInputMode("write")}>
            Write
          </TVChip>
          <TVChip active={inputMode === "speech"} colors={c} onPress={() => setInputMode("speech")}>
            Speech
          </TVChip>
        </ConfigBand>

        <View style={styles.promptCard}>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder={inputMode === "speech" ? "Use TV dictation, then send" : "What should the agent do?"}
            placeholderTextColor={c.textMuted}
            multiline
            style={styles.input}
          />
          <Pressable
            focusable
            onPress={send}
            onFocus={() => setSendFocused(true)}
            onBlur={() => setSendFocused(false)}
            disabled={!prompt.trim() || !deviceId || !!busy.startsWith("Sending")}
            style={({ pressed }) => [
              styles.send,
              (pressed || sendFocused) && styles.focused,
              (!prompt.trim() || !deviceId) && styles.disabled,
            ]}
          >
            {busy.startsWith("Sending") ? <ActivityIndicator color={c.textInverse} /> : <Text style={styles.sendText}>Send</Text>}
          </Pressable>
        </View>
        {busy ? <Text style={styles.status}>{busy}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ConfigBand({ title, children }: { title: string; children: React.ReactNode }) {
  const c = useColors();
  const styles = makeStyles(c);
  return (
    <View style={styles.band}>
      <Text style={styles.bandTitle}>{title}</Text>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

function TVChip({ active, colors, disabled, onPress, children }: { active: boolean; colors: ThemeColors; disabled?: boolean; onPress: () => void; children: React.ReactNode }) {
  const [focused, setFocused] = useState(false);
  const styles = makeStyles(colors);
  return (
    <Pressable
      focusable={!disabled}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={[
        styles.chip,
        active && styles.chipActive,
        focused && styles.focused,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{children}</Text>
    </Pressable>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    scroll: { padding: 48, gap: 22 },
    header: { gap: 8 },
    back: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingRight: 18 },
    backText: { color: c.textSecondary, fontSize: 18, fontWeight: "700" },
    title: { color: c.textPrimary, fontSize: 44, fontWeight: "800", letterSpacing: 0 },
    subtitle: { color: c.textSecondary, fontSize: 18 },
    band: { gap: 12 },
    bandTitle: { color: c.textMuted, fontSize: 14, fontWeight: "800", letterSpacing: 0, textTransform: "uppercase" },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    chip: { minHeight: 56, maxWidth: 360, borderRadius: 8, borderWidth: 1, borderColor: c.border, paddingHorizontal: 22, alignItems: "center", justifyContent: "center", backgroundColor: c.bgCard },
    chipActive: { borderColor: c.accent, backgroundColor: c.accentSoft },
    chipText: { color: c.textPrimary, fontSize: 18, fontWeight: "700" },
    chipTextActive: { color: c.accent },
    focused: { transform: [{ scale: Platform.isTV ? 1.04 : 1 }], borderColor: c.accent },
    disabled: { opacity: 0.45 },
    muted: { color: c.textMuted, fontSize: 16 },
    promptCard: { borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.bgCard, padding: 18, gap: 14 },
    input: { minHeight: 110, color: c.textPrimary, fontSize: 20, lineHeight: 28, textAlignVertical: "top" },
    send: { alignSelf: "flex-start", minHeight: 56, minWidth: 150, borderRadius: 8, backgroundColor: c.brandPrimary, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 },
    sendText: { color: c.textInverse, fontSize: 18, fontWeight: "800" },
    status: { color: c.textSecondary, fontSize: 16, marginBottom: 24 },
  });
}
