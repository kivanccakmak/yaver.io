import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppScreenHeader } from "../src/components/AppScreenHeader";
import { BrowserVibeBubble } from "../src/components/BrowserVibeBubble";
import LaneStartupStatus from "../src/components/LaneStartupStatus";
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

type Failure = DogfoodFailure;

export default function DogfoodLaunchScreen() {
  const c = useColors();
  const params = useLocalSearchParams<{
    workDir?: string;
    runner?: string;
    deviceId?: string;
    deviceName?: string;
    lane?: string;
  }>();
  const workDir = String(params.workDir || "");
  const runner = String(params.runner || "codex");
  const deviceId = String(params.deviceId || "");
  const deviceName = String(params.deviceName || "the primary device");
  const lane: DogfoodLane = params.lane === "webrtc" || params.lane === "hermes" ? params.lane : "browser";

  const controllerRef = useRef<DogfoodController | null>(null);
  const handedOffRef = useRef(false);
  const [running, setRunning] = useState(true);
  const [phase, setPhase] = useState("Connecting to the primary device…");
  const [lines, setLines] = useState<string[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [fixing, setFixing] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(() => Date.now());
  const [lastOutputAt, setLastOutputAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const append = useCallback((line: string) => {
    const clean = line.trim();
    if (!clean) return;
    setLastOutputAt(Date.now());
    setLines((current) => current[current.length - 1] === clean ? current : [...current.slice(-79), clean]);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
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
        },
      } as any);
    } catch {
      // The controller publishes the structured failure to onChange. Keeping
      // this catch local prevents an explicit Retry failure becoming an
      // unhandled promise rejection on Hermes.
    }
  }, [deviceId, deviceName, runner, workDir]);

  useEffect(() => {
    handedOffRef.current = false;
    const controller = new DogfoodController({
      name: "Yaver",
      workDir,
      framework: "expo",
      lane,
      repositoryUrl: "https://github.com/yaver-io/yaver.io.git",
    }, {
      async start(context) {
        if (lane === "hermes") {
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
        if (lane === "webrtc") {
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
          lane,
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
        setStartedAt(snapshot.startedAt ?? null);
        setLastOutputAt(snapshot.lastOutputAt ?? null);
        setLines(snapshot.logs.map((line) => line.text));
        setFailure(snapshot.failure ?? null);
      },
    });
    controllerRef.current = controller;
    void launch(controller);
    return () => {
      controllerRef.current = null;
      if (!handedOffRef.current) void controller.stop();
    };
  }, [deviceId, lane, launch, workDir]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={["bottom"]}>
      <AppScreenHeader title={`Starting Dogfood · ${lane === "webrtc" ? "WebRTC" : lane === "hermes" ? "Hermes" : "Browser"}`} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
          {running ? <ActivityIndicator size="large" color={c.accent} /> : null}
          <Text style={[styles.title, { color: c.textPrimary }]}>
            {running ? phase : failure ? "Dogfood could not start" : lane === "hermes" ? "Yaver delivered to Hermes" : phase}
          </Text>
          <Text style={[styles.meta, { color: c.textMuted }]}>{deviceName} · {runner}</Text>

          <LaneStartupStatus
            startedAt={startedAt}
            lastOutputAt={lastOutputAt}
            now={now}
            lines={lines}
            maxLines={6}
            emptyText="waiting for the first line from the box…"
            mutedColor={c.textMuted}
            warnColor={c.warn}
            stallHint="still waiting on the box"
          />

          {lines.length ? (
            <View style={[styles.console, { backgroundColor: "#0b0f14", borderColor: c.border }]}>
              <Text style={[styles.consoleLabel, { color: c.textMuted }]}>Live console</Text>
              <AnsiConsoleText text={lines.slice(-24).join("\n")} fontSize={10} />
            </View>
          ) : null}

          {failure ? (
            <View style={[styles.failure, { borderColor: c.errorBorder, backgroundColor: c.errorBg }]}>
              <Text style={[styles.code, { color: c.textMuted }]}>{failure.code}</Text>
              <Text style={[styles.failureText, { color: c.textPrimary }]}>{failure.error}</Text>
              <Text style={[styles.remedy, { color: c.textMuted }]}>{failure.remedy}</Text>
            </View>
          ) : null}

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
                  style={[styles.action, { backgroundColor: "#2e1f3a" }]}
                >
                  <Text style={{ color: "#c084fc", fontWeight: "700" }}>{fixing ? "Starting…" : "Fix with AI"}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
      <BrowserVibeBubble
        projectPath={workDir}
        projectName="Yaver"
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
  console: { width: "100%", maxHeight: 260, overflow: "hidden", marginTop: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10 },
  consoleLabel: { fontSize: 10, fontWeight: "700", marginBottom: 7, textTransform: "uppercase", letterSpacing: 0.5 },
  failure: { width: "100%", marginTop: 16, borderWidth: 1, borderRadius: 12, padding: 12 },
  code: { fontSize: 10, marginBottom: 5 },
  failureText: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
  remedy: { marginTop: 5, fontSize: 11, lineHeight: 16 },
  actions: { width: "100%", flexDirection: "row", gap: 8, marginTop: 12 },
  action: { flex: 1, minHeight: 42, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
});
