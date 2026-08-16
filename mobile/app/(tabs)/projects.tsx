import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useCloudStudio } from "../../src/context/CloudStudioContext";
import { useDevice } from "../../src/context/DeviceContext";
import { useColors } from "../../src/context/ThemeContext";
import { quicClient, type RemoteProject } from "../../src/lib/quic";
import { setPendingVibingProject } from "../../src/lib/vibingStore";

const IS_TV = Boolean((Platform as typeof Platform & { isTV?: boolean }).isTV);

export default function ProjectsScreen() {
  const c = useColors();
  const { activeDevice, connectionStatus } = useDevice();
  const cloud = useCloudStudio();
  const legacyTvRunner = IS_TV
    && activeDevice?.name.trim().toLowerCase().replace(/\.local$/, "") === "ubuntu-4gb-hel1-1"
    && !activeDevice.cloudWorkspaceId;
  const [localProjects, setLocalProjects] = useState<RemoteProject[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [creatingRepositoryId, setCreatingRepositoryId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationSummary, setValidationSummary] = useState<string | null>(null);

  const loadLocal = useCallback(async () => {
    if ((IS_TV && !legacyTvRunner) || !activeDevice || connectionStatus !== "connected") {
      setLocalProjects([]);
      return;
    }
    setLocalLoading(true);
    try {
      setLocalProjects(await quicClient.listProjects(true));
    } finally {
      setLocalLoading(false);
    }
  }, [activeDevice, connectionStatus, legacyTvRunner]);

  useEffect(() => {
    loadLocal().catch(() => {});
  }, [loadLocal]);

  const createSession = async (repositoryId: string, baseRef?: string) => {
    setCreatingRepositoryId(repositoryId);
    try {
      await cloud.createProjectSession(repositoryId, baseRef);
      router.push("/tasks");
    } catch (error) {
      Alert.alert("Project Session", error instanceof Error ? error.message : "Could not create the Project Session");
    } finally {
      setCreatingRepositoryId(null);
    }
  };

  const runTests = async () => {
    if (!cloud.activeProjectSession || validating) return;
    setValidating(true);
    setValidationSummary(null);
    try {
      let run = await quicClient.startValidationRun(cloud.activeProjectSession.projectSessionId, "test");
      for (let attempt = 0; attempt < 120 && (run.status === "queued" || run.status === "running"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        run = await quicClient.getValidationRun(cloud.activeProjectSession.projectSessionId, run.validationRunId);
      }
      const summary = run.status === "passed" ? "Tests passed" : run.status === "failed" ? "Tests failed" : `Tests ${run.status}`;
      setValidationSummary(summary);
      Alert.alert(summary, run.output?.trim().slice(-1200) || "No test output was returned.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tests could not run";
      setValidationSummary(message);
      Alert.alert("Tests unavailable", message);
    } finally {
      setValidating(false);
    }
  };

  if (IS_TV && !legacyTvRunner) {
    const accessReady = cloud.status?.access.status === "active";
    const gitReady = cloud.status?.gitConnections.some((connection) => connection.status === "ready") ?? false;
    const workspaceReady = cloud.status?.workspaces.some((workspace) => workspace.state === "ready") ?? false;
    const runnerReady = activeDevice?.deviceKind === "cloud-runner" && connectionStatus === "connected";
    const prerequisiteMessage = !accessReady
      ? "Cloud Studio access is unavailable for this account."
      : !gitReady
        ? "A ready Git Connection is required."
        : !workspaceReady
          ? "Cloud Workspace is not ready yet."
          : !runnerReady
            ? "Connect to the assigned Cloud Runner."
            : null;

    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} edges={["bottom"]}>
        <ScrollView
          contentContainerStyle={styles.container}
          refreshControl={<RefreshControl refreshing={cloud.loading} onRefresh={cloud.refresh} tintColor={c.accent} />}
        >
          <Text style={[styles.title, { color: c.textPrimary }]}>Cloud Studio Projects</Text>
          <Text style={[styles.subtitle, { color: c.textSecondary }]}>Git repositories run in isolated Project Sessions on your Cloud Runner.</Text>

          {cloud.loading && !cloud.status ? (
            <ActivityIndicator style={{ marginTop: 40 }} size="large" color={c.accent} />
          ) : prerequisiteMessage ? (
            <View style={[styles.notice, { backgroundColor: c.bgCard, borderColor: c.border }]}>
              <Text style={[styles.noticeTitle, { color: c.textPrimary }]}>Setup required</Text>
              <Text style={[styles.noticeText, { color: c.textSecondary }]}>{prerequisiteMessage}</Text>
            </View>
          ) : cloud.loading && cloud.repositories.length === 0 ? (
            <ActivityIndicator style={{ marginTop: 40 }} size="large" color={c.accent} />
          ) : (
            <>
              {cloud.activeProjectSession ? (
                <View style={[styles.activeCard, { backgroundColor: c.accent + "18", borderColor: c.accent }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.sectionLabel, { color: c.accent }]}>ACTIVE PROJECT SESSION</Text>
                    <Text style={[styles.cardName, { color: c.textPrimary }]}>{cloud.activeProjectSession.repositoryName}</Text>
                    <Text style={[styles.cardPath, { color: c.textSecondary }]}>{cloud.activeProjectSession.reviewBranch}</Text>
                  </View>
                  <View style={styles.actions}>
                    <Pressable style={({ focused }) => [styles.action, { borderColor: c.border }, focused && styles.focused]} onPress={runTests} disabled={validating}>
                      <Text style={[styles.actionText, { color: c.textPrimary }]}>{validating ? "Testing…" : "Run tests"}</Text>
                    </Pressable>
                    <Pressable style={({ focused }) => [styles.action, { borderColor: c.border }, focused && styles.focused]} onPress={() => router.push("/tasks")}>
                      <Text style={[styles.actionText, { color: c.textPrimary }]}>Open</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              {validationSummary ? <Text style={[styles.validationSummary, { color: validationSummary === "Tests passed" ? c.success : c.warn }]}>{validationSummary}</Text> : null}

              {cloud.projectSessions.filter((session) => session.status === "ready" && session.projectSessionId !== cloud.activeProjectSession?.projectSessionId).length > 0 ? (
                <>
                  <Text style={[styles.sectionTitle, { color: c.textPrimary }]}>Ready sessions</Text>
                  {cloud.projectSessions.filter((session) => session.status === "ready" && session.projectSessionId !== cloud.activeProjectSession?.projectSessionId).map((session) => (
                    <Pressable key={session.projectSessionId} style={({ focused }) => [styles.card, { backgroundColor: c.bgCard, borderColor: c.border }, focused && styles.focused]} onPress={() => cloud.selectProjectSession(session)}>
                      <Text style={styles.cardIcon}>◉</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.cardName, { color: c.textPrimary }]}>{session.repositoryName}</Text>
                        <Text style={[styles.cardPath, { color: c.textSecondary }]}>{session.reviewBranch}</Text>
                      </View>
                      <Text style={[styles.cardBranch, { color: c.accent }]}>Select</Text>
                    </Pressable>
                  ))}
                </>
              ) : null}

              <Text style={[styles.sectionTitle, { color: c.textPrimary }]}>Repositories</Text>
              {cloud.repositories.length === 0 ? (
                <Text style={[styles.empty, { color: c.textMuted }]}>No repositories are available to this Cloud Runner.</Text>
              ) : cloud.repositories.map((repository) => (
                <Pressable
                  key={repository.repositoryId}
                  disabled={creatingRepositoryId !== null}
                  style={({ focused }) => [styles.card, { backgroundColor: c.bgCard, borderColor: c.border }, focused && styles.focused]}
                  onPress={() => createSession(repository.repositoryId, repository.defaultRef)}
                >
                  <Text style={styles.cardIcon}>⌘</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cardName, { color: c.textPrimary }]}>{repository.name}</Text>
                    <Text style={[styles.cardPath, { color: c.textSecondary }]}>{repository.defaultRef || "Default branch"}</Text>
                  </View>
                  {creatingRepositoryId === repository.repositoryId
                    ? <ActivityIndicator color={c.accent} />
                    : <Text style={[styles.cardBranch, { color: c.accent }]}>New session</Text>}
                </Pressable>
              ))}
            </>
          )}
          {cloud.error ? <Text style={[styles.error, { color: c.error }]}>{cloud.error}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.container} refreshControl={<RefreshControl refreshing={localLoading} onRefresh={loadLocal} tintColor={c.accent} />}>
        <Text style={[styles.title, { color: c.textPrimary }]}>{legacyTvRunner ? "Runner Projects" : "Projects"}</Text>
        <Text style={[styles.subtitle, { color: c.textSecondary }]}>{activeDevice ? `Repositories on ${activeDevice.name}` : "Connect a device to list projects"}</Text>
        {localLoading && localProjects.length === 0 ? <ActivityIndicator style={{ marginTop: 32 }} size="large" color={c.accent} /> : localProjects.length === 0 ? (
          <Text style={[styles.empty, { color: c.textMuted }]}>{activeDevice ? "No projects discovered yet." : "Connect a device to see its projects."}</Text>
        ) : localProjects.map((project) => (
          <Pressable key={project.path} style={({ focused }) => [styles.card, { backgroundColor: c.bgCard, borderColor: c.border }, focused && styles.focused]} onPress={() => {
            quicClient.setWorkDir(project.path).catch(() => {});
            setPendingVibingProject(project.path);
            router.push("/vibing");
          }}>
            <Text style={styles.cardIcon}>📁</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardName, { color: c.textPrimary }]} numberOfLines={1}>{project.name}</Text>
              <Text style={[styles.cardPath, { color: c.textSecondary }]} numberOfLines={1}>{project.path}</Text>
            </View>
            {project.branch ? <Text style={[styles.cardBranch, { color: c.accent }]}>{project.branch}</Text> : null}
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 48, paddingBottom: 80 },
  title: { fontSize: 48, fontWeight: "800" },
  subtitle: { fontSize: 20, marginTop: 4, marginBottom: 28 },
  sectionTitle: { fontSize: 26, fontWeight: "700", marginTop: 26, marginBottom: 12 },
  sectionLabel: { fontSize: 13, fontWeight: "800", marginBottom: 5 },
  notice: { borderWidth: 2, borderRadius: 16, padding: 24, marginTop: 8 },
  noticeTitle: { fontSize: 26, fontWeight: "700" },
  noticeText: { fontSize: 18, marginTop: 8 },
  empty: { fontSize: 18, marginTop: 8 },
  error: { fontSize: 16, marginTop: 18 },
  activeCard: { flexDirection: "row", alignItems: "center", borderRadius: 16, borderWidth: 2, padding: 22, gap: 16 },
  card: { flexDirection: "row", alignItems: "center", borderRadius: 16, borderWidth: 2, padding: 22, marginBottom: 14, gap: 16 },
  cardIcon: { fontSize: 32 },
  cardName: { fontSize: 26, fontWeight: "700" },
  cardPath: { fontSize: 16, marginTop: 4 },
  cardBranch: { fontSize: 16, fontWeight: "600" },
  action: { borderWidth: 2, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 },
  actions: { flexDirection: "row", gap: 10 },
  actionText: { fontSize: 18, fontWeight: "700" },
  validationSummary: { fontSize: 16, fontWeight: "600", marginTop: 10 },
  focused: { transform: [{ scale: 1.02 }], opacity: 0.92 },
});
