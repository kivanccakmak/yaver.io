import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { AppScreenHeader } from "../../src/components/AppScreenHeader";
import { useColors } from "../../src/context/ThemeContext";
import { useDevice, type Device } from "../../src/context/DeviceContext";
import { useTabletContentStyle } from "../../src/hooks/useTabletContentStyle";
import { quicClient, type MobileWorkspaceGate, type WizardQuestion, type WizardSession } from "../../src/lib/quic";
import { setPendingVibingProject } from "../../src/lib/vibingStore";
import {
  MOBILE_APP_PALETTES,
  MOBILE_APP_GIT_PROVIDERS,
  buildMobileAppBuilderPrompt,
  chooseBuilderRemote,
  projectSlug,
  type MobileAppPalette,
  type MobileAppGitProvider,
} from "../../src/lib/mobileAppBuilderFlow";

type Step = "location" | "git" | "palette" | "initializing";

const INITIALIZATION_STEPS = [
  "Creating the Yaver workspace",
  "Adding the iOS and Android app",
  "Initializing Yaver Serverless",
  "Preparing chat and live rendering",
];

export default function NewProjectScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const tabletContent = useTabletContentStyle("regular");
  const {
    activeDevice,
    connectionStatus,
    devices,
    connectedDeviceIds,
    primaryDeviceId,
    selectDevice,
    codingMode,
    setCodingMode,
    primaryRunnerByDevice,
    primaryModelByDevice,
  } = useDevice();

  const [step, setStep] = useState<Step>("location");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [selectedGitProvider, setSelectedGitProvider] = useState<MobileAppGitProvider>("yaver-git");
  const [selectedPalette, setSelectedPalette] = useState<MobileAppPalette>(
    MOBILE_APP_PALETTES.find((palette) => palette.id === "ocean") ?? MOBILE_APP_PALETTES[0],
  );
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [gitProbeLoading, setGitProbeLoading] = useState(false);
  const [gitGates, setGitGates] = useState<MobileWorkspaceGate[]>([]);
  const [gitProbeError, setGitProbeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializationStage, setInitializationStage] = useState(0);

  const connectedIds = useMemo(() => {
    const ids = new Set(connectedDeviceIds);
    if (connectionStatus === "connected" && activeDevice) ids.add(activeDevice.id);
    return ids;
  }, [activeDevice, connectedDeviceIds, connectionStatus]);

  const recommendedRemote = useMemo(
    () => chooseBuilderRemote(devices, connectedIds, primaryDeviceId, activeDevice?.id),
    [activeDevice?.id, connectedIds, devices, primaryDeviceId],
  );

  useEffect(() => {
    if (selectedDeviceId && connectedIds.has(selectedDeviceId)) return;
    setSelectedDeviceId(recommendedRemote?.id ?? null);
  }, [connectedIds, recommendedRemote, selectedDeviceId]);

  const selectedDevice = selectedDeviceId
    ? devices.find((device) => device.id === selectedDeviceId) ?? null
    : null;
  const usingPhone = !selectedDevice;
  const connectedRemotes = devices.filter((device) => connectedIds.has(device.id));
  const primaryIsReady = !!primaryDeviceId && recommendedRemote?.id === primaryDeviceId;
  const selectedRunner = selectedDevice
    ? primaryRunnerByDevice[selectedDevice.id] || "default runner"
    : "on-device runner";
  const selectedModel = selectedDevice ? primaryModelByDevice[selectedDevice.id] : "";
  const selectedGitGate = gitGates.find((gate) => gate.id === selectedGitProvider);
  const selectedGitReady = !gitProbeLoading && !!selectedGitGate?.ready;

  const probeGitIntegrations = async () => {
    if (!selectedDevice) {
      setGitGates([{ id: "yaver-git", code: "mobile_workspace.git.ready", label: "Yaver Git", ready: true, configured: true, detail: "Built in on this phone" }]);
      setGitProbeError(null);
      return;
    }
    setGitProbeLoading(true);
    setGitProbeError(null);
    try {
      const target = selectedDevice.id === activeDevice?.id ? undefined : selectedDevice.id;
      const probe = await quicClient.mobileWorkspaceStatusProbe(target);
      if (!probe.status) {
        throw new Error(probe.reason === "agent-upgrade-required" ? "Update the Yaver agent on this box to test Git integrations." : "The selected box did not answer the Git integration probe.");
      }
      setGitGates(probe.status.gitProviders);
    } catch (cause) {
      setGitGates([]);
      setGitProbeError(cause instanceof Error ? cause.message : "Could not test Git integrations.");
    } finally {
      setGitProbeLoading(false);
    }
  };

  useEffect(() => {
    if (step !== "git") return;
    void probeGitIntegrations();
  }, [step, selectedDevice?.id]);

  const continueFromLocation = async () => {
    if (!projectName.trim()) {
      setError("Give the project a name first.");
      return;
    }
    setChoosing(true);
    setError(null);
    try {
      if (selectedDevice) {
        if (codingMode === "local-only") await setCodingMode("remote-preferred");
        if (activeDevice?.id !== selectedDevice.id) await selectDevice(selectedDevice);
      } else {
        await setCodingMode("local-only");
      }
      setStep("git");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not select that development location.");
    } finally {
      setChoosing(false);
    }
  };

  const answerWizard = async (sessionId: string, questionId: string, answer: string) => {
    const response = await quicClient.wizardAnswer(sessionId, questionId, answer);
    if (!response) throw new Error(`Project initialization stopped at ${questionId}.`);
    return response;
  };

  const initializeProject = async () => {
    setStep("initializing");
    setInitializationStage(0);
    setError(null);
    try {
      const started = await quicClient.wizardStart();
      if (!started) throw new Error("The selected box could not start project initialization.");
      let session: WizardSession = started.session;
      let question: WizardQuestion | null = started.question;
      const answers: Record<string, string> = {
        app_name: projectName.trim(),
        slug: projectSlug(projectName),
        description: `${projectName.trim()} mobile app`,
        primary_color: selectedPalette.colors[0],
        secondary_color: selectedPalette.colors[1],
        accent_color: selectedPalette.colors[2],
        surface_color: selectedPalette.colors[3],
        tone: selectedPalette.id === "electric" ? "dark" : "system",
        include_web: "false",
        include_mobile: "true",
        include_backend: "true",
        include_landing: "false",
        backend: "sqlite",
        mobile_stack: "expo-rn",
        git_provider: selectedGitProvider,
        git_visibility: "private",
        git_repo_name: projectSlug(projectName),
      };

      setInitializationStage(1);
      for (const [questionId, answer] of Object.entries(answers)) {
        const response = await answerWizard(session.id, questionId, answer);
        session = response.session;
        question = response.question;
      }

      setInitializationStage(2);
      let guard = 0;
      while (question && question.kind !== "done" && guard < 100) {
        const answer = question.id === "confirm" ? "true" : question.default ?? "";
        const response = await answerWizard(session.id, question.id, answer);
        session = response.session;
        question = response.question;
        guard += 1;
      }
      if (guard >= 100) throw new Error("Project initialization did not reach a finished state.");

      setInitializationStage(3);
      const result = await quicClient.wizardGenerate(session.id);
      if (!result?.ok || !result.directory) throw new Error("The selected box could not create the project.");
      setPendingVibingProject(result.directory);
      setInitializationStage(4);
      router.replace({
        pathname: "/(tabs)/tasks",
        params: {
          dir: result.directory,
          title: projectName.trim(),
          prompt: buildMobileAppBuilderPrompt(selectedPalette, selectedDevice?.name),
          autoSubmit: "1",
          hideInitialPrompt: "1",
          selectProject: "1",
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project initialization failed.");
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AppScreenHeader
        title="Create an app"
        onBack={() => {
          if (step === "palette") setStep("git");
          else if (step === "git") setStep("location");
          else if (step !== "initializing") router.navigate("/(tabs)/more" as any);
        }}
        style={{ paddingTop: insets.top + 12 }}
      />

      <ScrollView
        contentContainerStyle={[styles.content, tabletContent]}
        showsVerticalScrollIndicator={false}
      >
        {step !== "initializing" ? <Text style={[styles.step, { color: c.accent }]}>STEP {step === "location" ? "1" : step === "git" ? "2" : "3"} OF 3</Text> : null}

        {step === "location" ? (
          <>
            <Text style={[styles.title, { color: c.textPrimary }]}>Where should we build?</Text>
            <Text style={[styles.subtitle, { color: c.textMuted }]}>Name the project. Yaver already picked the best connected box and its runner.</Text>

            <Text style={[styles.fieldLabel, { color: c.textPrimary }]}>Project name</Text>
            <TextInput
              value={projectName}
              onChangeText={(value) => { setProjectName(value); if (error) setError(null); }}
              placeholder="e.g. Talos"
              placeholderTextColor={c.textMuted}
              autoFocus
              returnKeyType="next"
              onSubmitEditing={() => { if (projectName.trim()) void continueFromLocation(); }}
              style={[styles.nameInput, { color: c.textPrimary, backgroundColor: c.bgCard, borderColor: c.border }]}
            />

            {selectedDevice ? (
              <View style={[styles.locationCard, { backgroundColor: c.bgCard, borderColor: c.accent }]}>
                <View style={[styles.machineIcon, { backgroundColor: c.accent + "20" }]}>
                  <Text style={styles.machineEmoji}>▣</Text>
                </View>
                <View style={styles.locationCopy}>
                  <Text style={[styles.locationKicker, { color: c.accent }]}>WE'LL USE THIS {primaryIsReady ? "PRIMARY BOX" : "BOX"}</Text>
                  <Text style={[styles.locationName, { color: c.textPrimary }]}>{selectedDevice.name}</Text>
                  <Text style={[styles.locationDetail, { color: c.textMuted }]}>Connected · {selectedRunner}{selectedModel ? ` · ${selectedModel}` : ""}</Text>
                </View>
                <View style={styles.readyDot} />
              </View>
            ) : (
              <View style={[styles.locationCard, { backgroundColor: c.bgCard, borderColor: c.border }]}>
                <View style={[styles.machineIcon, { backgroundColor: c.accent + "20" }]}>
                  <Text style={styles.machineEmoji}>▤</Text>
                </View>
                <View style={styles.locationCopy}>
                  <Text style={[styles.locationKicker, { color: c.accent }]}>THIS PHONE</Text>
                  <Text style={[styles.locationName, { color: c.textPrimary }]}>Build locally</Text>
                  <Text style={[styles.locationDetail, { color: c.textMuted }]}>No connected remote box · {selectedRunner}</Text>
                </View>
              </View>
            )}

            {connectedRemotes.length > 1 ? (
              <Pressable onPress={() => setShowAlternatives((value) => !value)} style={styles.quietAction}>
                <Text style={[styles.quietActionText, { color: c.textMuted }]}>
                  {showAlternatives ? "Hide other boxes" : "Use another connected box"}
                </Text>
              </Pressable>
            ) : null}

            {showAlternatives ? (
              <View style={styles.alternatives}>
                {connectedRemotes.map((device) => (
                  <RemoteChoice
                    key={device.id}
                    device={device}
                    selected={device.id === selectedDeviceId}
                    primary={device.id === primaryDeviceId}
                    onPress={() => setSelectedDeviceId(device.id)}
                    colors={c}
                  />
                ))}
                <Pressable
                  onPress={() => setSelectedDeviceId(null)}
                  style={[styles.alternativeRow, { borderColor: !selectedDeviceId ? c.accent : c.border }]}
                >
                  <Text style={[styles.alternativeName, { color: c.textPrimary }]}>This phone</Text>
                  {!selectedDeviceId ? <Text style={{ color: c.accent, fontWeight: "800" }}>✓</Text> : null}
                </Pressable>
              </View>
            ) : null}

            {error ? <Text style={[styles.error, { color: c.error }]}>{error}</Text> : null}

            <Pressable
              onPress={() => void continueFromLocation()}
              disabled={choosing}
              style={[styles.primaryButton, { backgroundColor: c.accent, opacity: choosing ? 0.65 : 1 }]}
            >
              {choosing ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Continue</Text>}
            </Pressable>
          </>
        ) : step === "git" ? (
          <>
            <Text style={[styles.title, { color: c.textPrimary }]}>Choose where the project starts</Text>
            <Text style={[styles.subtitle, { color: c.textMuted }]}>Every option creates real Git history. External providers use the account connected on the selected box.</Text>

            <View style={styles.gitChoices}>
              {MOBILE_APP_GIT_PROVIDERS.map((provider) => {
                const selected = provider.id === selectedGitProvider;
                const gate = gitGates.find((candidate) => candidate.id === provider.id);
                const status = provider.id === "yaver-git" && !selectedDevice
                  ? "Ready"
                  : gitProbeLoading
                    ? "Testing…"
                    : gate?.ready
                      ? "Verified"
                      : gate
                        ? "Needs setup"
                        : "Not tested";
                return (
                  <Pressable
                    key={provider.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Use ${provider.name}`}
                    onPress={() => setSelectedGitProvider(provider.id)}
                    style={[
                      styles.gitCard,
                      {
                        backgroundColor: selected ? c.accent + "18" : c.bgCard,
                        borderColor: selected ? c.accent : c.border,
                        borderWidth: selected ? 2 : 1,
                      },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.gitName, { color: c.textPrimary }]}>{provider.name} · {status}</Text>
                      <Text style={[styles.gitDetail, { color: c.textMuted }]}>{provider.detail}</Text>
                      {gate?.detail ? <Text style={[styles.gitProbeDetail, { color: gate.ready ? c.success : c.textMuted }]}>{gate.detail}</Text> : null}
                    </View>
                    <Text style={{ color: selected ? c.accent : c.textMuted, fontSize: 20 }}>{selected ? "✓" : "○"}</Text>
                  </Pressable>
                );
              })}
            </View>

            {gitProbeError ? (
              <View>
                <Text style={[styles.error, { color: c.error }]}>{gitProbeError}</Text>
                <Pressable onPress={() => void probeGitIntegrations()} style={styles.quietAction}>
                  <Text style={[styles.quietActionText, { color: c.accent }]}>Retry integration tests</Text>
                </Pressable>
              </View>
            ) : null}

            <Pressable
              onPress={() => setStep("palette")}
              disabled={!selectedGitReady}
              style={[styles.primaryButton, { backgroundColor: c.accent, opacity: selectedGitReady ? 1 : 0.45 }]}
            >
              <Text style={styles.primaryButtonText}>Continue</Text>
            </Pressable>
          </>
        ) : step === "palette" ? (
          <>
            <Text style={[styles.title, { color: c.textPrimary }]}>Choose a color palette</Text>
            <Text style={[styles.subtitle, { color: c.textMuted }]}>A starting point, not a commitment. Change it anytime in chat.</Text>

            <View style={styles.paletteGrid}>
              {MOBILE_APP_PALETTES.map((palette) => {
                const selected = palette.id === selectedPalette.id;
                return (
                  <Pressable
                    key={palette.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${palette.name} color palette`}
                    onPress={() => setSelectedPalette(palette)}
                    style={[
                      styles.paletteCard,
                      {
                        backgroundColor: palette.surface,
                        borderColor: selected ? c.accent : c.border,
                        borderWidth: selected ? 2 : 1,
                      },
                    ]}
                  >
                    <View style={styles.swatches}>
                      <View style={styles.labeledSwatch}>
                        <View style={[styles.swatch, { backgroundColor: palette.colors[0] }]} />
                        <Text style={[styles.swatchLabel, { color: palette.muted }]}>Primary</Text>
                      </View>
                      <View style={styles.labeledSwatch}>
                        <View style={[styles.swatch, { backgroundColor: palette.colors[1] }]} />
                        <Text style={[styles.swatchLabel, { color: palette.muted }]}>Secondary</Text>
                      </View>
                      <View style={styles.labeledSwatch}>
                        <View style={[styles.swatch, { backgroundColor: palette.colors[2] }]} />
                        <Text style={[styles.swatchLabel, { color: palette.muted }]}>Accent</Text>
                      </View>
                    </View>
                    <Text style={[styles.paletteName, { color: palette.text }]}>{palette.name}</Text>
                    <Text style={[styles.paletteMood, { color: palette.muted }]}>{palette.mood}</Text>
                    {selected ? (
                      <View style={[styles.selectedBadge, { backgroundColor: c.accent }]}>
                        <Text style={styles.selectedBadgeText}>✓</Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

            <View style={[styles.handoff, { borderColor: c.border }]}>
              <Text style={[styles.handoffTitle, { color: c.textPrimary }]}>That’s all the setup.</Text>
              <Text style={[styles.handoffBody, { color: c.textMuted }]}>Next is the full vibe chat with Build/Plan mode. Describe the app naturally; Yaver will use Serverless by default and infer navigation, permissions, and the rest while it builds and renders.</Text>
            </View>

            <Pressable onPress={() => void initializeProject()} style={[styles.primaryButton, { backgroundColor: c.accent }]}>
              <Text style={styles.primaryButtonText}>Initialize {projectName.trim()} →</Text>
            </Pressable>
          </>
        ) : (
          <View style={styles.initializing}>
            <View style={[styles.initOrb, { backgroundColor: selectedPalette.colors[0] + "22", borderColor: selectedPalette.colors[0] }]}>
              <ActivityIndicator size="large" color={selectedPalette.colors[0]} />
            </View>
            <Text style={[styles.initTitle, { color: c.textPrimary }]}>Initializing {projectName.trim()}</Text>
            <Text style={[styles.initSubtitle, { color: c.textMuted }]}>{selectedDevice ? `On ${selectedDevice.name} with ${selectedRunner}` : "On this phone"}</Text>
            <View style={styles.initSteps}>
              {INITIALIZATION_STEPS.map((label, index) => {
                const done = index < initializationStage;
                const active = index === initializationStage;
                return (
                  <View key={label} style={styles.initRow}>
                    <View style={[styles.initDot, { backgroundColor: done ? c.success : active ? c.accent : c.border }]} />
                    <Text style={{ color: done || active ? c.textPrimary : c.textMuted, fontSize: 14, fontWeight: active ? "800" : "600" }}>{label}</Text>
                  </View>
                );
              })}
            </View>
            {error ? (
              <>
                <Text style={[styles.error, { color: c.error, textAlign: "center" }]}>{error}</Text>
                <Pressable onPress={() => void initializeProject()} style={[styles.primaryButton, { backgroundColor: c.accent, alignSelf: "stretch" }]}>
                  <Text style={styles.primaryButtonText}>Retry initialization</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function RemoteChoice({
  device,
  selected,
  primary,
  onPress,
  colors,
}: {
  device: Device;
  selected: boolean;
  primary: boolean;
  onPress: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.alternativeRow, { borderColor: selected ? colors.accent : colors.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.alternativeName, { color: colors.textPrimary }]}>{device.name}</Text>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>{primary ? "Primary · connected" : "Connected"}</Text>
      </View>
      {selected ? <Text style={{ color: colors.accent, fontWeight: "800" }}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { width: "100%", alignSelf: "center", padding: 24, paddingBottom: 56 },
  step: { fontSize: 12, fontWeight: "900", letterSpacing: 1.4, marginTop: 10, marginBottom: 12 },
  title: { fontSize: 32, lineHeight: 38, fontWeight: "900", letterSpacing: -0.8 },
  subtitle: { fontSize: 16, lineHeight: 23, marginTop: 8, marginBottom: 28 },
  fieldLabel: { fontSize: 13, fontWeight: "800", marginBottom: 8 },
  nameInput: { borderWidth: 1, borderRadius: 18, minHeight: 58, paddingHorizontal: 18, fontSize: 18, fontWeight: "700", marginBottom: 16 },
  locationCard: { minHeight: 138, borderWidth: 2, borderRadius: 24, padding: 20, flexDirection: "row", alignItems: "center", gap: 16 },
  machineIcon: { width: 58, height: 58, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  machineEmoji: { color: "#7c5cff", fontSize: 28, fontWeight: "900" },
  locationCopy: { flex: 1 },
  locationKicker: { fontSize: 11, fontWeight: "900", letterSpacing: 0.8, marginBottom: 5 },
  locationName: { fontSize: 21, fontWeight: "900" },
  locationDetail: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  readyDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: "#22c55e" },
  quietAction: { alignSelf: "center", paddingHorizontal: 16, paddingVertical: 16 },
  quietActionText: { fontSize: 13, fontWeight: "700" },
  alternatives: { gap: 8, marginBottom: 8 },
  alternativeRow: { minHeight: 60, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, flexDirection: "row", alignItems: "center" },
  alternativeName: { fontSize: 15, fontWeight: "800" },
  error: { fontSize: 13, lineHeight: 18, marginTop: 12 },
  primaryButton: { minHeight: 58, borderRadius: 18, alignItems: "center", justifyContent: "center", marginTop: 24 },
  primaryButtonText: { color: "#fff", fontSize: 17, fontWeight: "900" },
  paletteGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  gitChoices: { gap: 12 },
  gitCard: { minHeight: 86, borderRadius: 20, padding: 18, flexDirection: "row", alignItems: "center", gap: 14 },
  gitName: { fontSize: 17, fontWeight: "900" },
  gitDetail: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  gitProbeDetail: { fontSize: 11, lineHeight: 16, marginTop: 6, fontWeight: "700" },
  paletteCard: { width: "48%", minHeight: 146, borderRadius: 22, padding: 16, position: "relative" },
  swatches: { flexDirection: "row", gap: 10, marginBottom: 16 },
  labeledSwatch: { alignItems: "center", gap: 4 },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: "rgba(255,255,255,0.65)" },
  swatchLabel: { fontSize: 8, fontWeight: "700" },
  paletteName: { fontSize: 17, fontWeight: "900" },
  paletteMood: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  selectedBadge: { position: "absolute", right: 12, top: 12, width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  selectedBadgeText: { color: "#fff", fontSize: 14, fontWeight: "900" },
  handoff: { borderTopWidth: 1, marginTop: 28, paddingTop: 22 },
  handoffTitle: { fontSize: 17, fontWeight: "900" },
  handoffBody: { fontSize: 14, lineHeight: 21, marginTop: 6 },
  initializing: { flex: 1, minHeight: 560, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  initOrb: { width: 96, height: 96, borderRadius: 48, borderWidth: 1, alignItems: "center", justifyContent: "center", marginBottom: 26 },
  initTitle: { fontSize: 28, fontWeight: "900", textAlign: "center" },
  initSubtitle: { fontSize: 14, marginTop: 8, textAlign: "center" },
  initSteps: { alignSelf: "stretch", marginTop: 36, gap: 18, paddingHorizontal: 24 },
  initRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  initDot: { width: 10, height: 10, borderRadius: 5 },
});
