import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { BrowserVibeBubble } from "../src/components/BrowserVibeBubble";
import { AnsiConsoleText } from "../src/components/AnsiConsoleText";
import { useColors } from "../src/context/ThemeContext";
import {
  prepareDogfoodMode,
  prepareDogfoodCheckoutOnly,
  requestDogfoodFixWithAI,
  startDogfoodHermesLane,
  stopAttachSession,
} from "../src/lib/attachClient";
import {
  DogfoodController,
  DogfoodRuntimeError,
  type DogfoodFailure,
  type DogfoodLane,
} from "../../sdk/feedback/react-native/src/DogfoodRuntime";
import { DogfoodLiveConsole } from "../../sdk/feedback/react-native/src/DogfoodSessionUi";

type Failure = DogfoodFailure;

export default function DogfoodLaunchScreen() {
  const c = useColors();
  const params = useLocalSearchParams<{
    workDir?: string;
    runner?: string;
    deviceId?: string;
    deviceName?: string;
    lane?: string;
    fallbackLane?: string;
    usageMode?: string;
    startBehavior?: string;
    renderBehavior?: string;
    sessionBehavior?: string;
  }>();
  const workDir = String(params.workDir || "");
  const runner = String(params.runner || "codex");
  const deviceId = String(params.deviceId || "");
  const deviceName = String(params.deviceName || "the primary device");
  const lane: DogfoodLane = params.lane === "webrtc" || params.lane === "hermes" ? params.lane : "browser";
  const fallbackLane: DogfoodLane | undefined = params.fallbackLane === "browser" || params.fallbackLane === "webrtc" || params.fallbackLane === "hermes"
    ? params.fallbackLane
    : undefined;
  const usageMode = params.usageMode === "chat-only" || params.usageMode === "reload-and-chat"
    ? params.usageMode
    : "reload-only";
  const startBehavior = params.startBehavior === "render-on-open" ? "render-on-open" : "vibe-first";
  const renderBehavior = params.renderBehavior === "auto-on-request" ? "auto-on-request" : "manual";
  const sessionBehavior = params.sessionBehavior === "new-session" ? "new-session" : "resume-last";

  const controllerRef = useRef<DogfoodController | null>(null);
  const handedOffRef = useRef(false);
  const [running, setRunning] = useState(startBehavior === "render-on-open");
  const [phase, setPhase] = useState(startBehavior === "render-on-open"
    ? "Connecting to the primary device…"
    : "Vibe first. Render only when you are ready to see the changes.");
  const [runtimeLane, setRuntimeLane] = useState<DogfoodLane>(lane);
  const [lines, setLines] = useState<string[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [fixing, setFixing] = useState(false);

  const append = useCallback((line: string) => {
    const clean = line.trim();
    if (!clean) return;
    setLines((current) => current[current.length - 1] === clean ? current : [...current.slice(-79), clean]);
  }, []);

  const launch = useCallback(async (controller: DogfoodController) => {
    setFixing(false);
    try {
      const result = await controller.trigger();
      const handed = await controller.handoff();
      if (!handed) return;
      handedOffRef.current = true;
      if (result.lane === "hermes") {
        // Delivery swaps the host bridge to the freshly built guest. If a
        // platform takes a moment to recreate, keep this native launch screen
        // alive rather than navigating to a browser-only route with no URL.
        return;
      }
      if (result.lane === "webrtc") {
        router.replace({
          pathname: "/remote-runtime" as any,
          params: {
            project: "Yaver",
            path: workDir.replace(/\/+$/, "") + "/mobile",
            framework: "expo",
            usageMode,
            renderBehavior,
            sessionBehavior,
          },
        } as any);
        return;
      }
      router.replace({
        pathname: "/attach" as any,
        params: {
          sessionId: result.sessionId,
          url: result.url,
          workDir,
          runner,
          deviceId,
          deviceName,
          usageMode,
          renderBehavior,
          sessionBehavior,
        },
      } as any);
    } catch {
      // The controller publishes the structured failure to onChange. Keeping
      // this catch local prevents an explicit Retry failure becoming an
      // unhandled promise rejection on Hermes.
    }
  }, [deviceId, deviceName, renderBehavior, runner, sessionBehavior, usageMode, workDir]);

  useEffect(() => {
    handedOffRef.current = false;
    const controller = new DogfoodController({
      name: "Yaver",
      workDir,
      framework: "expo",
      lane,
      fallbackLane,
      repositoryUrl: "https://github.com/yaver-io/yaver.io.git",
    }, {
      async start(context) {
        const requestedLane = context.project.lane;
        if (requestedLane === "hermes") {
          const prepared = await prepareDogfoodCheckoutOnly(deviceId, workDir, (message) => {
            context.setPhase("preparing", message);
            context.log({ text: message, at: Date.now(), stream: "system" });
          });
          if (!prepared.ok) {
            throw new DogfoodRuntimeError({
              code: prepared.code, error: prepared.error, remedy: prepared.remedy,
              retryable: true, fixPrompt: prepared.fixPrompt,
            });
          }
          context.setPhase("compiling", "Compiling Yaver for the installed Hermes host…");
          const delivered = await startDogfoodHermesLane(deviceId, workDir);
          if (!delivered.ok) {
            throw new DogfoodRuntimeError({
              code: delivered.code, error: delivered.error, remedy: delivered.remedy, retryable: true,
            });
          }
          context.log({ text: delivered.message, at: Date.now(), stream: "system" });
          return {
            lane: "hermes",
            metadata: { branch: prepared.branch, pushPolicy: prepared.pushPolicy, deliveredTo: delivered.deliveredTo },
          };
        }
        if (requestedLane === "webrtc") {
          const prepared = await prepareDogfoodCheckoutOnly(deviceId, workDir, (message) => {
            context.setPhase("preparing", message);
            context.log({ text: message, at: Date.now(), stream: "system" });
          });
          if (!prepared.ok) {
            throw new DogfoodRuntimeError({
              code: prepared.code,
              error: prepared.error,
              remedy: prepared.remedy,
              retryable: true,
              fixPrompt: prepared.fixPrompt,
            });
          }
          context.setPhase("starting", "Opening Yaver's native WebRTC runtime…");
          return {
            lane: "webrtc",
            metadata: { branch: prepared.branch, pushPolicy: prepared.pushPolicy },
          };
        }
        const result = await prepareDogfoodMode(
          deviceId,
          workDir,
          (next) => {
            const lower = next.toLowerCase();
            context.setPhase(
              lower.includes("compil") ? "compiling" : lower.includes("start") || lower.includes("authoriz") ? "starting" : "preparing",
              next,
            );
            context.log({ text: next, at: Date.now(), stream: "system" });
          },
          (line) => context.log(line),
        );
        if (!result.ok) {
          throw new DogfoodRuntimeError({
            code: result.code,
            error: result.error,
            remedy: result.remedy,
            retryable: true,
            fixPrompt: result.fixPrompt,
          });
        }
        context.registerCleanup(async () => { await stopAttachSession(deviceId, result.sessionId); }, "session");
        return {
          lane: requestedLane,
          sessionId: result.sessionId,
          url: result.url,
          metadata: { branch: result.branch, pushPolicy: result.pushPolicy },
        };
      },
    }, {
      maxLogLines: 200,
      onChange(snapshot) {
        setRunning(["preparing", "starting", "compiling"].includes(snapshot.phase));
        setPhase(snapshot.message);
        setRuntimeLane(snapshot.project.lane);
        setLines(snapshot.logs.map((line) => line.text));
        setFailure(snapshot.failure ?? null);
      },
    });
    controllerRef.current = controller;
    if (startBehavior === "render-on-open") void launch(controller);
    return () => {
      controllerRef.current = null;
      if (!handedOffRef.current) void controller.stop();
    };
  }, [deviceId, fallbackLane, lane, launch, startBehavior, workDir]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
          {running ? <ActivityIndicator size="large" color={c.accent} /> : null}
          <Text style={[styles.title, { color: c.textPrimary }]}>
            {running ? phase : failure ? "Dogfood could not start" : runtimeLane === "hermes" ? "Yaver delivered to Hermes" : phase}
          </Text>
          <Text style={[styles.meta, { color: c.textMuted }]}>{deviceName} · {runner}</Text>

          {!running && !failure && !handedOffRef.current && startBehavior === "vibe-first" ? (
            <View style={styles.vibeFirst}>
              <Text style={[styles.vibeFirstCopy, { color: c.textSecondary }]}>Chat can use one or several durable runner sessions now. Rendering remains idle until you tap below.</Text>
              <Pressable onPress={() => { const controller = controllerRef.current; if (controller) void launch(controller); }} style={[styles.renderAction, { backgroundColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Render updates">
                <Text style={styles.renderActionText}>Render updates</Text>
              </Pressable>
            </View>
          ) : null}

          {/* The live source is the first detail in the launch card. Status is
              already in its header; a second truncated log/status widget hid
              the compiler output users actually need. */}
          <DogfoodLiveConsole
            lane={runtimeLane}
            phase={failure ? "failed" : running ? "starting" : "ready"}
            message={phase}
            logs={lines.map((text, index) => ({ text, at: index, stream: "system" as const }))}
            failure={failure || undefined}
            maxLines={24}
            colors={{
              background: c.bg, border: c.border, text: c.textPrimary, muted: c.textMuted,
              accent: c.accent, accentSoft: c.accentSoft, ready: c.success,
              attention: c.warn, blocked: c.error, console: "#0b0f14",
            }}
            renderText={(text) => <AnsiConsoleText text={text} fontSize={10} />}
          />

          {!running && failure ? (
            <View style={styles.actions}>
              <Pressable onPress={() => router.back()} style={[styles.action, { backgroundColor: c.bg }]}>
                <Text style={{ color: c.textPrimary, fontWeight: "700" }}>Back</Text>
              </Pressable>
              {failure.retryable ? <Pressable onPress={() => {
                const controller = controllerRef.current;
                if (controller) void launch(controller);
              }} style={[styles.action, { backgroundColor: c.accent }]}>
                <Text style={{ color: "#fff", fontWeight: "700" }}>Retry</Text>
              </Pressable> : null}
              {failure?.fixPrompt ? (
                <Pressable
                  disabled={fixing}
                  onPress={() => {
                    setFixing(true);
                    void requestDogfoodFixWithAI(deviceId, workDir, runner, failure.fixPrompt!)
                      .then(({ taskId }) => append(`Fix task ${taskId} started`))
                      .finally(() => setFixing(false));
                  }}
                  style={[styles.action, { backgroundColor: c.accentSoft, borderColor: c.accent }]}
                >
                  <Text style={{ color: c.accent, fontWeight: "700" }}>{fixing ? "Starting…" : "Fix with AI"}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
      <BrowserVibeBubble
        projectPath={workDir}
        projectName="Yaver"
        usageMode={usageMode}
        renderBehavior={renderBehavior}
        sessionBehavior={sessionBehavior}
        onExitPreview={() => router.back()}
        onReload={() => {
          if (running) return false;
          const controller = controllerRef.current;
          if (controller) void launch(controller);
          return true;
        }}
        reloadBusy={running}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, justifyContent: "center", padding: 16 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 18, alignItems: "center" },
  title: { marginTop: 12, fontSize: 17, fontWeight: "800", textAlign: "center" },
  meta: { marginTop: 5, fontSize: 11 },
  actions: { width: "100%", flexDirection: "row", gap: 8, marginTop: 12 },
  action: { flex: 1, minHeight: 42, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  vibeFirst: { width: "100%", marginTop: 14, gap: 10 },
  vibeFirstCopy: { fontSize: 12, lineHeight: 18, textAlign: "center" },
  renderAction: { minHeight: 44, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  renderActionText: { color: "#fff", fontWeight: "800" },
});
