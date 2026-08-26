// AttachModeSection.tsx — the contributor-facing More → Develop Yaver gate.
//
// Yaver rendering Yaver: the phone shows Yaver's own app, served as RN-web from
// a box over the browser lane, and refreshes when a coding turn lands.
//
// ── Why this is a GATE and not just a switch ────────────────────────────────
//
// Turning the mode on with nothing connected used to mean landing somewhere
// broken with no route out. So enabling walks an ordered gate — box, runner,
// checkout — where every step reports what is wrong AND the action that fixes
// it. The policy is computeAttachGate() in attachMode.ts (pure + tested); this
// component only renders it and wires the buttons, so the rules stay auditable
// on any host.
//
// Readiness comes from computeBoxReadiness() (boxInit.ts), not a second
// opinion, so this panel and the box checklist cannot drift apart.

import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ThemeColors } from "../constants/colors";
import { useDevice } from "../context/DeviceContext";
import { computeAttachGate, computeNestingVerdict, ATTACH_SENTINEL_KEY, type AttachStep } from "../lib/attachMode";
import type { BoxReadiness } from "../lib/boxInit";
import { loadBoxReadiness } from "../lib/boxInitStore";
import { runBoxAction } from "../lib/boxInitStore";
import {
  getDogfoodSourceStatus,
  getDogfoodRunners,
  dogfoodNativeRuntimeAvailable,
  installDogfoodGit,
  installDogfoodSource,
  requestDogfoodFixWithAI,
  verifyYaverCheckout,
  type DogfoodSourceStatus,
} from "../lib/attachClient";
import {
  dogfoodLaneOptions,
  type DogfoodLane,
} from "../../../sdk/feedback/react-native/src/DogfoodRuntime";
import RunnerAuthModal from "./RunnerAuthModal";
import { OpenCodeConfigModal } from "./OpenCodeConfigModal";

const CHECKOUT_KEY = "@yaver/attach_checkout_dir";
const GIT_CONFIG_FAILURE_CODES = new Set([
  "DOGFOOD_GIT_AUTH_UNCONFIGURED",
  "DOGFOOD_GIT_CREDENTIALS_EMBEDDED",
  "DOGFOOD_GIT_FETCH_FAILED",
  "DOGFOOD_GIT_ORIGIN_MISSING",
  "DOGFOOD_GIT_UPSTREAM_MISSING",
  "DOGFOOD_SOURCE_MISSING",
]);

export default function AttachModeSection({
  c,
  readiness,
}: {
  c: ThemeColors;
  readiness?: BoxReadiness | null;
}) {
  const {
    devices,
    activeDevice,
    connectionStatus,
    connectedDeviceIds,
    primaryRunnerByDevice,
    primaryModelByDevice,
    selectDevice,
    setPrimaryRunnerForDevice,
  } = useDevice();
  const targetDevice = activeDevice;
  const targetConnected = !!targetDevice && (
    connectedDeviceIds.includes(targetDevice.id) ||
    (connectionStatus === "connected" && activeDevice?.id === targetDevice.id)
  );
  const [checkoutDir, setCheckoutDir] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const [runner, setRunner] = useState("codex");
  const [runnerRows, setRunnerRows] = useState<Awaited<ReturnType<typeof getDogfoodRunners>>>([]);
  const [lane, setLane] = useState<DogfoodLane>("browser");
  const [nativeRuntimeAvailable, setNativeRuntimeAvailable] = useState(false);
  const [runnerSetupBusy, setRunnerSetupBusy] = useState(false);
  const [runnerSetupMessage, setRunnerSetupMessage] = useState<string | null>(null);
  const [runnerAuthFor, setRunnerAuthFor] = useState<"claude" | "codex" | null>(null);
  const [showOpenCodeConfig, setShowOpenCodeConfig] = useState(false);
  const [verified, setVerified] = useState<boolean | undefined>(undefined);
  const [verifying, setVerifying] = useState(false);
  const [failure, setFailure] = useState<{ code?: string; error: string; remedy?: string; fixPrompt?: string } | null>(null);
  const [fixing, setFixing] = useState(false);
  const [sourceStatus, setSourceStatus] = useState<DogfoodSourceStatus | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceProgress, setSourceProgress] = useState<string | null>(null);
  const [measuredReadiness, setMeasuredReadiness] = useState<BoxReadiness | null>(readiness ?? null);
  const [connectingPrimary, setConnectingPrimary] = useState(false);
  const [mayOffer, setMayOffer] = useState(true);
  const [nestingReason, setNestingReason] = useState<string | undefined>();
  const [expandedStep, setExpandedStep] = useState<AttachStep["key"] | null>(null);

  // Nesting guard: an already-attached instance must not offer to attach again.
  useEffect(() => {
    let alive = true;
    (async () => {
      let sentinel: string | null = null;
      try {
        sentinel = await AsyncStorage.getItem(ATTACH_SENTINEL_KEY);
      } catch {
        // absent is the normal host case
      }
      if (!alive) return;
      const v = computeNestingVerdict(sentinel);
      setMayOffer(v.mayOffer);
      setNestingReason(v.reason);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const dir = await AsyncStorage.getItem(CHECKOUT_KEY);
        if (dir) setCheckoutDir(dir);
      } catch {
        // best-effort
      } finally {
        setConfigLoaded(true);
      }
    })();
  }, []);

  // Dogfood uses the same per-device runner preference as Tasks and Vibing.
  // Switching the connected/primary device therefore restores its runner
  // instead of maintaining a second Dogfood-only choice.
  useEffect(() => {
    if (!targetDevice?.id) return;
    setRunner(primaryRunnerByDevice[targetDevice.id] || "codex");
  }, [primaryRunnerByDevice, targetDevice?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!targetDevice?.id || !targetConnected) {
      setRunnerRows([]);
      return;
    }
    void getDogfoodRunners(targetDevice.id)
      .then((rows) => { if (!cancelled) setRunnerRows(rows); })
      .catch(() => { if (!cancelled) setRunnerRows([]); });
    return () => { cancelled = true; };
  }, [targetConnected, targetDevice?.id]);

  // Dogfood should be one action in the normal case. The Go
  // agent owns this answer because only it can inspect the box's source and
  // Git origin. A cached client-side repo list is not an operational check.
  useEffect(() => {
    if (!configLoaded || !targetConnected || !targetDevice?.id) return;
    let cancelled = false;
    void (async () => {
      const requestedPath = checkoutDir.trim();
      const [requested, discovered] = await Promise.all([
        getDogfoodSourceStatus(targetDevice.id, requestedPath || undefined),
        requestedPath ? getDogfoodSourceStatus(targetDevice.id) : Promise.resolve(null),
      ]);
      let status = requested;
      if (discovered) {
        const candidates = [...(discovered.candidates || []), ...(requested.candidates || [])]
          .filter((candidate, index, rows) => rows.findIndex((row) => row.path === candidate.path) === index);
        if (!requested.ready && discovered.ready) {
          status = { ...discovered, candidates };
        } else {
          status = { ...requested, candidates };
        }
      }
      // Cached test/validation worktrees are commonly detached. Prefer the
      // agent's normal named checkout when it can prove one, so a stale local
      // preference does not strand Dogfood on a disposable clone.
      if (status.ready && status.branch === "HEAD" && discovered?.ready && discovered.branch && discovered.branch !== "HEAD") {
        status = { ...discovered, candidates: status.candidates };
      }
      if (cancelled) return;
      setSourceStatus(status);
      if (status.ready && status.path && status.path !== checkoutDir.trim()) {
        setCheckoutDir(status.path);
        AsyncStorage.setItem(CHECKOUT_KEY, status.path).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  // The explicit checkout is verified by the debounced effect below; this
  // effect is for initial agent-owned discovery only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded, targetConnected, targetDevice?.id]);

  // Verification is the AGENT's answer, never a path guess here. Re-runs when
  // the directory or the box changes, and resets to "unknown" first so a stale
  // green can never stand in for the new answer.
  const verify = useCallback(
    async (dir: string) => {
      if (!targetDevice?.id || !targetConnected || !dir.trim()) {
        setVerified(undefined);
        return;
      }
      setVerifying(true);
      setVerified(undefined);
      const [ok, status] = await Promise.all([
        verifyYaverCheckout(targetDevice.id, dir.trim()),
        getDogfoodSourceStatus(targetDevice.id, dir.trim()),
      ]);
      setSourceStatus(status);
      setVerified(ok);
      setVerifying(false);
    },
    [targetConnected, targetDevice?.id],
  );

  useEffect(() => {
    if (!checkoutDir.trim()) {
      setVerified(undefined);
      return;
    }
    const t = setTimeout(() => void verify(checkoutDir), 600);
    return () => clearTimeout(t);
  }, [checkoutDir, verify]);

  useEffect(() => {
    let cancelled = false;
    if (!targetDevice?.id || !targetConnected || verified !== true) {
      setNativeRuntimeAvailable(false);
      return;
    }
    void dogfoodNativeRuntimeAvailable(targetDevice.id, checkoutDir.trim())
      .then((available) => { if (!cancelled) setNativeRuntimeAvailable(available); });
    return () => { cancelled = true; };
  }, [checkoutDir, targetConnected, targetDevice?.id, verified]);

  const laneOptions = useMemo(() => dogfoodLaneOptions("expo", {
    nativeRuntimeAvailable,
    selfDevelopment: true,
  }), [nativeRuntimeAvailable]);
  const normalizedRunner = runner === "claude-code" ? "claude" : runner;
  const selectedRunnerRow = runnerRows.find((row) => (row.id === "claude-code" ? "claude" : row.id) === normalizedRunner);
  const selectedModel = targetDevice?.id ? primaryModelByDevice[targetDevice.id] || "" : "";
  const checkoutCandidates = sourceStatus?.candidates || [];

  useEffect(() => {
    if (!laneOptions.some((option) => option.lane === lane && option.supported)) {
      setLane("browser");
    }
  }, [lane, laneOptions]);

  // Readiness is an operational probe, not an optional decoration. The old
  // call site supplied no value, leaving the gate at "checking…" forever.
  useEffect(() => {
    let cancelled = false;
    if (!targetDevice?.id || !targetConnected) {
      setMeasuredReadiness(null);
      return;
    }
    void loadBoxReadiness(targetDevice.id)
      .then((next) => { if (!cancelled) setMeasuredReadiness(next); })
      .catch((err) => {
        if (!cancelled) {
          setMeasuredReadiness(null);
          setFailure({
            error: err instanceof Error ? err.message : String(err),
            remedy: "Reconnect the primary device, then try Dogfood mode again.",
          });
        }
      });
    return () => { cancelled = true; };
  }, [targetConnected, targetDevice?.id]);

  useEffect(() => {
    if (readiness !== undefined) setMeasuredReadiness(readiness ?? null);
  }, [readiness]);

  const gate = computeAttachGate({
    deviceId: targetConnected ? targetDevice?.id : null,
    deviceName: targetDevice?.name,
    readiness: measuredReadiness,
    runner,
    checkoutDir: checkoutDir.trim() || null,
    checkoutVerified: verifying ? undefined : verified,
  });
  const runnerCheckKey = runner === "claude-code" ? "claude" : runner;
  const runnerCheck = measuredReadiness?.checks.find((check) => check.key === runnerCheckKey);

  const configureRunner = useCallback(async () => {
    if (!targetDevice?.id || !runnerCheck || runnerCheck.status === "ok" || runnerSetupBusy) return;
    if (runnerCheck.status !== "missing") {
      if (runner === "opencode") setShowOpenCodeConfig(true);
      else setRunnerAuthFor(runner === "claude-code" ? "claude" : "codex");
      return;
    }
    setRunnerSetupBusy(true);
    setRunnerSetupMessage(`Installing ${runner}…`);
    setFailure(null);
    try {
      const result = await runBoxAction(targetDevice.id, runnerCheck.action);
      if (!result.ok) throw new Error(result.error || `Could not install ${runner}.`);
      const next = await loadBoxReadiness(targetDevice.id);
      setMeasuredReadiness(next);
      const nextCheck = next.checks.find((check) => check.key === runnerCheckKey);
      setRunnerSetupMessage(result.detail || "Runner installed");
      if (nextCheck?.status !== "ok") {
        if (runner === "opencode") setShowOpenCodeConfig(true);
        else setRunnerAuthFor(runner === "claude-code" ? "claude" : "codex");
      }
    } catch (error) {
      setFailure({
        code: "DOGFOOD_RUNNER_SETUP_FAILED",
        error: error instanceof Error ? error.message : String(error),
        remedy: `Retry ${runner} setup on ${targetDevice.name}.`,
      });
    } finally {
      setRunnerSetupBusy(false);
    }
  }, [runner, runnerCheck, runnerCheckKey, runnerSetupBusy, targetDevice?.id, targetDevice?.name]);

  const attach = useCallback(() => {
    if (!targetDevice?.id || !gate.canAttach) return;
    setFailure(null);
    router.push({
      pathname: "/dogfood-launch" as any,
      params: {
        workDir: checkoutDir.trim(),
        runner,
        lane,
        deviceId: targetDevice.id,
        deviceName: targetDevice.name,
      },
    } as any);
  }, [checkoutDir, gate.canAttach, lane, runner, targetDevice?.id, targetDevice?.name]);

  const runSourceFix = useCallback(async () => {
    if (!targetDevice?.id || sourceBusy) return;
    setSourceBusy(true);
    setFailure(null);
    setSourceProgress("Looking for a Yaver checkout…");
    try {
      let status = await getDogfoodSourceStatus(targetDevice.id);
      setSourceStatus(status);
      if (status.ready && status.path) {
        setCheckoutDir(status.path);
        await AsyncStorage.setItem(CHECKOUT_KEY, status.path);
        await verify(status.path);
        return;
      }

      if (status.code === "DOGFOOD_GIT_NOT_INSTALLED") {
        setSourceProgress("Installing Git…");
        const git = await installDogfoodGit(
          targetDevice.id,
          (line) => setSourceProgress(line.trim() || "Installing Git…"),
        );
        if (!git.ok) {
          setFailure({
            code: status.code,
            error: git.error || "Git installation did not complete.",
            remedy: "Open Git configuration on this box, or retry the install.",
          });
          return;
        }
        setSourceProgress("Looking for a Yaver checkout…");
        status = await getDogfoodSourceStatus(targetDevice.id);
        setSourceStatus(status);
        if (status.ready && status.path) {
          setCheckoutDir(status.path);
          await AsyncStorage.setItem(CHECKOUT_KEY, status.path);
          await verify(status.path);
          return;
        }
      }

      setSourceProgress("Cloning Yaver source…");
      const result = await installDogfoodSource(targetDevice.id, runner);
      if (!result.ok || !result.path) {
        setFailure({
          code: status.code || "DOGFOOD_SOURCE_CLONE_FAILED",
          error: result.error || "The source repair did not complete.",
          remedy: "Open Git configuration if GitHub access is required, then retry the clone.",
        });
        return;
      }

      const installed = await getDogfoodSourceStatus(targetDevice.id, result.path);
      setSourceStatus(installed);
      if (!installed.ready || !installed.path) {
        setFailure({
          code: installed.code,
          error: installed.message,
          remedy: installed.remedy || "Choose another Yaver checkout or open Git configuration.",
        });
        return;
      }
      setCheckoutDir(installed.path);
      await AsyncStorage.setItem(CHECKOUT_KEY, installed.path);
      await verify(installed.path);
    } catch (error) {
      setFailure({
        code: "DOGFOOD_SOURCE_FIX_FAILED",
        error: error instanceof Error ? error.message : String(error),
        remedy: "Reconnect the box, then retry. Open Git configuration if cloning still fails.",
      });
    } finally {
      setSourceBusy(false);
      setSourceProgress(null);
    }
  }, [runner, sourceBusy, targetDevice?.id, verify]);

  const toggleStep = useCallback((step: AttachStep) => {
    setExpandedStep((current) => current === step.key ? null : step.key);
    if (step.key === "checkout" && step.status !== "ok" && !sourceBusy) {
      void runSourceFix();
    }
  }, [runSourceFix, sourceBusy]);

  if (!mayOffer) {
    return (
      <View>
        <Text style={{ color: c.textPrimary, fontWeight: "700", fontSize: 15 }}>Dogfood mode</Text>
        <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
          {nestingReason}
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text style={{ color: c.textPrimary, fontWeight: "700", fontSize: 15 }}>Dogfood Yaver</Text>

      {/* The default surface is only the answer: Box, Runner, Checkout. Each
          inventory stays behind its own Change/Fix action. */}
      <View style={{ marginTop: 12, gap: 4 }}>
        {gate.steps.map((step) => (
          <StepRow
            key={step.key}
            c={c}
            step={step}
            expanded={expandedStep === step.key}
            busy={step.key === "checkout" && sourceBusy}
            onPress={() => toggleStep(step)}
          />
        ))}
      </View>

      {expandedStep === "box" ? (
        <View accessibilityLabel="Box choices" style={{ marginTop: 8, paddingLeft: 20 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {devices.map((device) => {
              const selected = targetDevice?.id === device.id;
              const connected = connectedDeviceIds.includes(device.id);
              return (
                <Pressable
                  key={device.id}
                  disabled={connectingPrimary}
                  onPress={() => {
                    setConnectingPrimary(true);
                    setFailure(null);
                    void selectDevice(device)
                      .catch((err) => setFailure({
                        error: err instanceof Error ? err.message : String(err),
                        remedy: `Wake or repair ${device.name}, then retry.`,
                      }))
                      .finally(() => setConnectingPrimary(false));
                  }}
                  style={{
                    paddingHorizontal: 11,
                    paddingVertical: 8,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: selected ? c.accent : c.border,
                    backgroundColor: selected ? `${c.accent}22` : c.bg,
                    opacity: connected ? 1 : 0.65,
                  }}
                >
                  <Text style={{ color: c.textPrimary, fontSize: 12, fontWeight: selected ? "700" : "500" }}>
                    {device.name}{connected ? "" : " · offline"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {!devices.length ? (
            <Text style={{ color: c.warn, fontSize: 12 }}>Connect a same-account device to start Dogfood.</Text>
          ) : null}
        </View>
      ) : null}

      {expandedStep === "runner" ? (
        <View accessibilityLabel="Runner choices" style={{ marginTop: 8, paddingLeft: 20 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {(["claude-code", "codex", "opencode"] as const).map((r) => {
              const on = runner === r;
              return (
                <Pressable
                  key={r}
                  onPress={() => {
                    setRunner(r);
                    if (targetDevice?.id) void setPrimaryRunnerForDevice(targetDevice.id, r, null);
                  }}
                  style={({ pressed }) => [
                    {
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: on ? c.accent : c.border,
                      backgroundColor: on ? `${c.accent}22` : c.bg,
                    },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={{ color: c.textPrimary, fontSize: 12, fontWeight: on ? "700" : "500" }}>{r}</Text>
                </Pressable>
              );
            })}
          </View>
          {selectedRunnerRow?.models?.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              {selectedRunnerRow.models.map((model) => {
                const on = selectedModel === model.id || (!selectedModel && model.isDefault);
                return (
                  <Pressable
                    key={model.id}
                    onPress={() => targetDevice?.id && void setPrimaryRunnerForDevice(targetDevice.id, runner, model.id)}
                    style={{ paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: on ? c.accent : c.border, backgroundColor: on ? `${c.accent}22` : c.bg }}
                  >
                    <Text style={{ color: c.textPrimary, fontSize: 11, fontWeight: on ? "700" : "500" }}>{model.name || model.id}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {verified === true && runnerCheck && runnerCheck.status !== "ok" ? (
            <Pressable
              disabled={runnerSetupBusy}
              onPress={() => void configureRunner()}
              style={{ marginTop: 8, alignSelf: "flex-start", paddingHorizontal: 11, paddingVertical: 8, borderRadius: 8, backgroundColor: c.accentSoft }}
            >
              <Text style={{ color: c.accent, fontSize: 12, fontWeight: "700" }}>
                {runnerSetupBusy ? "Installing…" : runnerCheck.status === "missing" ? `Install ${runner}` : `Configure ${runner}`}
              </Text>
            </Pressable>
          ) : null}
          {runnerSetupMessage ? <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 6 }}>{runnerSetupMessage}</Text> : null}

          <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 12, marginBottom: 6 }}>Runtime</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {laneOptions.map((option) => {
              const selected = lane === option.lane;
              return (
                <Pressable
                  key={option.lane}
                  disabled={!option.supported}
                  onPress={() => setLane(option.lane)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: !option.supported }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: selected ? c.accent : c.border,
                    backgroundColor: selected ? `${c.accent}22` : c.bg,
                    opacity: option.supported ? 1 : 0.45,
                  }}
                >
                  <Text style={{ color: c.textPrimary, fontSize: 12, fontWeight: selected ? "700" : "500" }}>
                    {option.label}{option.default ? " · default" : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {laneOptions.filter((option) => !option.supported).map((option) => (
            <Text key={`${option.lane}-reason`} style={{ color: c.textMuted, fontSize: 10, lineHeight: 14, marginTop: 5 }}>
              {option.label}: {option.reason}
            </Text>
          ))}
        </View>
      ) : null}

      {expandedStep === "checkout" ? (
        <View accessibilityLabel="Yaver checkout choices" style={{ marginTop: 8, paddingLeft: 20 }}>
          {sourceBusy ? (
            <Text style={{ color: c.textMuted, fontSize: 11, marginBottom: 8 }}>{sourceProgress || "Working…"}</Text>
          ) : null}
          {checkoutCandidates.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              {checkoutCandidates.map((candidate) => {
                const selected = checkoutDir.trim() === candidate.path;
                return (
                  <Pressable
                    key={candidate.path}
                    onPress={() => {
                      setCheckoutDir(candidate.path);
                      void AsyncStorage.setItem(CHECKOUT_KEY, candidate.path);
                      void verify(candidate.path);
                    }}
                    style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: selected ? c.accent : c.border, backgroundColor: selected ? `${c.accent}22` : c.bg }}
                  >
                    <Text style={{ color: c.textPrimary, fontSize: 11, fontWeight: selected ? "700" : "500" }}>{candidate.path}</Text>
                    {candidate.branch ? <Text style={{ color: c.textMuted, fontSize: 10, marginTop: 2 }}>{candidate.branch}</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {sourceStatus && !sourceStatus.ready ? (
            <View style={{ borderWidth: 1, borderColor: c.warn, borderRadius: 10, padding: 10, marginBottom: 10 }}>
              <Text style={{ color: c.textPrimary, fontSize: 12, fontWeight: "600" }}>{sourceStatus.message}</Text>
              {sourceStatus.remedy ? (
                <Text style={{ color: c.textMuted, fontSize: 11, lineHeight: 16, marginTop: 4 }}>{sourceStatus.remedy}</Text>
              ) : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 9 }}>
                <Pressable
                  disabled={sourceBusy}
                  onPress={() => void runSourceFix()}
                  style={{ paddingHorizontal: 11, paddingVertical: 8, borderRadius: 8, backgroundColor: c.accent }}
                >
                  <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>{sourceBusy ? "Working…" : "Try checkout fix"}</Text>
                </Pressable>
                {GIT_CONFIG_FAILURE_CODES.has(sourceStatus.code) && targetDevice?.id ? (
                  <Pressable
                    onPress={() => router.push({ pathname: "/(tabs)/settings" as any, params: { gitWizard: "1", deviceId: targetDevice.id } } as any)}
                    style={{ paddingHorizontal: 11, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: c.accent }}
                  >
                    <Text style={{ color: c.accent, fontSize: 12, fontWeight: "700" }}>Open Git configuration</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}
          <TextInput
            value={checkoutDir}
            onChangeText={(t) => {
              setCheckoutDir(t);
              AsyncStorage.setItem(CHECKOUT_KEY, t).catch(() => {});
            }}
            accessibilityLabel="Yaver checkout path"
            placeholder="Path to yaver.io"
            placeholderTextColor={c.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={{
              color: c.textPrimary,
              borderColor: c.border,
              backgroundColor: c.bg,
              borderWidth: 1,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 10,
              fontSize: 13,
            }}
          />
        </View>
      ) : null}

      {failure ? (
        <View
          style={{
            marginTop: 12,
            borderWidth: 1,
            borderColor: c.errorBorder,
            backgroundColor: c.errorBg,
            borderRadius: 10,
            padding: 10,
          }}
        >
          {failure.code ? <Text style={{ color: c.textMuted, fontSize: 10, marginBottom: 4 }}>{failure.code}</Text> : null}
          <Text style={{ color: c.textPrimary, fontSize: 12, lineHeight: 17 }}>{failure.error}</Text>
          {failure.remedy ? (
            <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 6, lineHeight: 16 }}>
              {failure.remedy}
            </Text>
          ) : null}
          {failure.code && GIT_CONFIG_FAILURE_CODES.has(failure.code) && targetDevice?.id ? (
            <Pressable
              onPress={() => router.push({ pathname: "/(tabs)/settings" as any, params: { gitWizard: "1", deviceId: targetDevice.id } } as any)}
              style={{ marginTop: 10, alignSelf: "flex-start", borderWidth: 1, borderColor: c.accent, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 8 }}
            >
              <Text style={{ color: c.accent, fontSize: 12, fontWeight: "700" }}>Configure Git on this box</Text>
            </Pressable>
          ) : null}
          {failure.fixPrompt && targetDevice?.id && targetConnected ? (
            <Pressable
              disabled={fixing}
              onPress={() => {
                if (fixing || !failure.fixPrompt) return;
                setFixing(true);
                void requestDogfoodFixWithAI(targetDevice.id, checkoutDir.trim(), runner, failure.fixPrompt)
                  .then(({ taskId }) => setFailure({
                    error: `AI fix task ${taskId} started on ${targetDevice.name}.`,
                    remedy: "Follow it in Tasks. When it completes, return here and retry Dogfood mode.",
                  }))
                  .catch((err) => setFailure({
                    error: err instanceof Error ? err.message : String(err),
                    remedy: "Reconnect the primary device and retry Fix with AI.",
                    fixPrompt: failure.fixPrompt,
                  }))
                  .finally(() => setFixing(false));
              }}
              style={{ marginTop: 10, alignSelf: "flex-start", borderWidth: 1, borderColor: c.accent, backgroundColor: c.accentSoft, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 8 }}
            >
              <Text style={{ color: c.accent, fontSize: 12, fontWeight: "700" }}>
                {fixing ? "Starting AI fix…" : "Fix with AI"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* ONE primary action. Disabled states say what is missing via the gate
          rows above rather than a second explanation down here. */}
      <Pressable
        onPress={() => void attach()}
        disabled={!gate.canAttach}
        style={({ pressed }) => [
          {
            marginTop: 14,
            paddingVertical: 12,
            borderRadius: 10,
            alignItems: "center",
            backgroundColor: gate.canAttach ? c.accent : c.bg,
            borderWidth: gate.canAttach ? 0 : 1,
            borderColor: c.border,
            opacity: !gate.canAttach ? 0.6 : 1,
            flexDirection: "row",
            justifyContent: "center",
            gap: 8,
          },
          pressed && { opacity: 0.75 },
        ]}
      >
        <Text
          style={{
            color: gate.canAttach ? "#fff" : c.textMuted,
            fontWeight: "700",
            fontSize: 14,
          }}
        >
          Enter Dogfood mode
        </Text>
      </Pressable>
      <RunnerAuthModal
        visible={runnerAuthFor !== null}
        runner={runnerAuthFor || "codex"}
        deviceName={targetDevice?.name || "primary device"}
        target={targetDevice?.id}
        onClose={() => setRunnerAuthFor(null)}
        onCompleted={() => {
          setRunnerAuthFor(null);
          if (targetDevice?.id) void loadBoxReadiness(targetDevice.id).then(setMeasuredReadiness);
        }}
      />
      <OpenCodeConfigModal
        visible={showOpenCodeConfig}
        target={targetDevice?.id}
        onClose={() => {
          setShowOpenCodeConfig(false);
          if (targetDevice?.id) void loadBoxReadiness(targetDevice.id).then(setMeasuredReadiness);
        }}
      />
    </View>
  );
}

function StepRow({
  c,
  step,
  expanded,
  busy,
  onPress,
}: {
  c: ThemeColors;
  step: AttachStep;
  expanded: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const tone =
    step.status === "ok" ? c.success : step.status === "blocked" ? c.error : c.textMuted;
  const glyph = step.status === "ok" ? "✓" : step.status === "blocked" ? "!" : "·";
  const action = busy ? "Fixing…" : step.status === "ok" ? "Change" : "Fix";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48 }}>
      <Text style={{ color: tone, fontSize: 12, width: 12, textAlign: "center" }}>{glyph}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.textPrimary, fontSize: 12, fontWeight: "600" }}>{step.label}</Text>
        <Text style={{ color: tone, fontSize: 11, lineHeight: 16 }}>{step.detail}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${action} ${step.label}`}
        accessibilityState={{ expanded, disabled: busy }}
        disabled={busy}
        onPress={onPress}
        style={({ pressed }) => ({
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          opacity: busy ? 0.55 : pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ color: c.accent, fontSize: 11, fontWeight: "700" }}>{action}</Text>
      </Pressable>
    </View>
  );
}
