import { router, usePathname } from "expo-router";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { BrowserVibeBubble } from "../components/BrowserVibeBubble";
import {
  prepareDogfoodCheckoutOnly,
  prepareDogfoodMode,
  refreshAttachSession,
  reloadAttachedDogfoodBrowserLane,
  startDogfoodHermesLane,
  stopAttachSession,
} from "../lib/attachClient";
import {
  DogfoodController,
  DogfoodRuntimeError,
  type DogfoodLane,
  type DogfoodResult,
  type DogfoodSnapshot,
} from "../../../sdk/feedback/react-native/src/DogfoodRuntime";

export type DogfoodOverlayRequest = {
  workDir: string;
  runner: string;
  deviceId: string;
  deviceName: string;
  lane: DogfoodLane;
  fallbackLane?: DogfoodLane;
  usageMode: "chat-only" | "reload-only" | "reload-and-chat";
  startBehavior: "vibe-first" | "render-on-open";
  renderBehavior: "manual" | "auto-on-request";
  sessionBehavior: "resume-last" | "new-session";
};

type DogfoodOverlayValue = {
  begin(request: DogfoodOverlayRequest): void;
  end(): Promise<void>;
  goHome(): void;
};

const DogfoodOverlayContext = createContext<DogfoodOverlayValue | null>(null);

function previewRoute(request: DogfoodOverlayRequest, result: DogfoodResult) {
  if (result.lane === "webrtc") {
    router.navigate({
      pathname: "/remote-runtime" as any,
      params: {
        project: "Yaver",
        path: request.workDir.replace(/\/+$/, "") + "/mobile",
        framework: "expo",
        usageMode: request.usageMode,
        renderBehavior: request.renderBehavior,
        sessionBehavior: request.sessionBehavior,
      },
    } as any);
    return;
  }
  if (result.lane !== "browser") return;
  router.navigate({
    pathname: "/attach" as any,
    params: {
      sessionId: result.sessionId,
      url: result.url,
      workDir: request.workDir,
      runner: request.runner,
      deviceId: request.deviceId,
      deviceName: request.deviceName,
      usageMode: request.usageMode,
      renderBehavior: request.renderBehavior,
      sessionBehavior: request.sessionBehavior,
    },
  } as any);
}

export function DogfoodOverlayProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const controllerRef = useRef<DogfoodController | null>(null);
  const requestRef = useRef<DogfoodOverlayRequest | null>(null);
  const runRef = useRef<Promise<DogfoodResult> | null>(null);
  const [request, setRequest] = useState<DogfoodOverlayRequest | null>(null);
  const [snapshot, setSnapshot] = useState<DogfoodSnapshot | null>(null);

  // `kind` is present only for an explicit Reload control. Entering with
  // "render on open" hands off the already-proven surface without asking the
  // box to reload it a second time. Before this distinction, Fast Reload from
  // Tasks only navigated to the existing attach session: no request reached
  // the browser lane, so the UI honestly did nothing.
  const openPreparedPreview = useCallback(async (kind?: "fast" | "full") => {
    const controller = controllerRef.current;
    const activeRequest = requestRef.current;
    if (!controller || !activeRequest) return false;
    const result = runRef.current ? await runRef.current : controller.snapshot().result || await controller.trigger();
    if (controllerRef.current !== controller || requestRef.current !== activeRequest) return false;
    if (kind && result.lane === "browser") {
      const reload = await reloadAttachedDogfoodBrowserLane(activeRequest.deviceId, activeRequest.workDir, kind);
      if (!reload.ok) {
        const message = reload.message || reload.error || "Dogfood browser reload failed.";
        throw new Error(reload.remedy ? `${message} ${reload.remedy}` : message);
      }
    }
    const handed = await controller.handoff();
    if (!handed) throw new Error("Dogfood is not ready to open yet. Wait for preparation to finish, then try Fast Reload again.");
    previewRoute(activeRequest, result);
    return true;
  }, []);

  const begin = useCallback((next: DogfoodOverlayRequest) => {
    const previous = controllerRef.current;
    if (previous) void previous.stop();
    requestRef.current = next;
    setRequest(next);

    const controller = new DogfoodController({
      name: "Yaver",
      workDir: next.workDir,
      framework: "expo",
      lane: next.lane,
      fallbackLane: next.fallbackLane,
      repositoryUrl: "https://github.com/yaver-io/yaver.io.git",
    }, {
      async start(context) {
        if (context.project.lane === "hermes") {
          const prepared = await prepareDogfoodCheckoutOnly(next.deviceId, next.workDir, (message) => {
            context.setPhase("preparing", message);
            context.log({ text: message, at: Date.now(), stream: "system" });
          });
          if (!prepared.ok) throw new DogfoodRuntimeError({
            code: prepared.code, error: prepared.error, remedy: prepared.remedy,
            retryable: true, fixPrompt: prepared.fixPrompt,
          });
          context.setPhase("compiling", "Compiling Yaver for the installed Hermes host…");
          const delivered = await startDogfoodHermesLane(next.deviceId, next.workDir);
          if (!delivered.ok) throw new DogfoodRuntimeError({
            code: delivered.code, error: delivered.error, remedy: delivered.remedy, retryable: true,
          });
          context.log({ text: delivered.message, at: Date.now(), stream: "system" });
          return { lane: "hermes", metadata: { branch: prepared.branch, pushPolicy: prepared.pushPolicy } };
        }
        if (context.project.lane === "webrtc") {
          const prepared = await prepareDogfoodCheckoutOnly(next.deviceId, next.workDir, (message) => {
            context.setPhase("preparing", message);
            context.log({ text: message, at: Date.now(), stream: "system" });
          });
          if (!prepared.ok) throw new DogfoodRuntimeError({
            code: prepared.code, error: prepared.error, remedy: prepared.remedy,
            retryable: true, fixPrompt: prepared.fixPrompt,
          });
          context.setPhase("starting", "Opening Yaver's native WebRTC runtime…");
          return { lane: "webrtc", metadata: { branch: prepared.branch, pushPolicy: prepared.pushPolicy } };
        }
        const result = await prepareDogfoodMode(
          next.deviceId,
          next.workDir,
          (message) => {
            const lower = message.toLowerCase();
            context.setPhase(lower.includes("compil") ? "compiling" : lower.includes("start") || lower.includes("authoriz") ? "starting" : "preparing", message);
            context.log({ text: message, at: Date.now(), stream: "system" });
          },
          (line) => context.log(line),
        );
        if (!result.ok) throw new DogfoodRuntimeError({
          code: result.code, error: result.error, remedy: result.remedy,
          retryable: true, fixPrompt: result.fixPrompt,
        });
        context.registerCleanup(async () => { await stopAttachSession(next.deviceId, result.sessionId); }, "session");
        return {
          lane: "browser",
          sessionId: result.sessionId,
          url: result.url,
          metadata: { branch: result.branch, pushPolicy: result.pushPolicy },
        };
      },
    }, {
      maxLogLines: 200,
      onChange(nextSnapshot) {
        if (controllerRef.current === controller) setSnapshot(nextSnapshot);
      },
    });
    controllerRef.current = controller;
    setSnapshot(controller.snapshot());
    const run = controller.trigger();
    runRef.current = run;
    void run.then(async () => {
      if (controllerRef.current !== controller) return;
      runRef.current = null;
      if (next.startBehavior === "render-on-open") await openPreparedPreview();
    }).catch(() => {
      if (controllerRef.current === controller) runRef.current = null;
    });
  }, [openPreparedPreview]);

  const end = useCallback(async () => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    requestRef.current = null;
    runRef.current = null;
    setRequest(null);
    setSnapshot(null);
    if (controller) await controller.stop();
  }, []);

  const goHome = useCallback(() => {
    router.navigate("/(tabs)/tasks" as any);
  }, []);

  useEffect(() => () => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    if (controller) void controller.stop();
  }, []);

  useEffect(() => {
    const sessionId = snapshot?.result?.lane === "browser" ? snapshot.result.sessionId : undefined;
    if (!request || !sessionId) return;
    const timer = setInterval(() => { void refreshAttachSession(request.deviceId, sessionId); }, 4 * 60_000);
    return () => clearInterval(timer);
  }, [request, snapshot?.result]);

  const previewOwnsOverlay = pathname === "/attach" || pathname === "/remote-runtime";
  return (
    <DogfoodOverlayContext.Provider value={{ begin, end, goHome }}>
      {children}
      {request && snapshot && !previewOwnsOverlay ? (
        <BrowserVibeBubble
          projectPath={request.workDir}
          projectName="Yaver"
          usageMode={request.usageMode}
          renderBehavior={request.renderBehavior}
          sessionBehavior={request.sessionBehavior}
          exitLabel="Go to Tasks"
          endLabel="End Dogfood"
          onGoHome={goHome}
          onExitPreview={() => { void end(); }}
          onReload={openPreparedPreview}
          reloadBusy={["preparing", "starting", "compiling"].includes(snapshot.phase)}
          reloadProgress={{
            lane: snapshot.project.lane,
            phase: snapshot.phase,
            message: snapshot.message,
            logs: snapshot.logs,
            failure: snapshot.failure,
          }}
        />
      ) : null}
    </DogfoodOverlayContext.Provider>
  );
}

export function useDogfoodOverlay(): DogfoodOverlayValue {
  const value = useContext(DogfoodOverlayContext);
  if (!value) throw new Error("useDogfoodOverlay must be used inside DogfoodOverlayProvider");
  return value;
}
