// AttachModeSection.tsx — the owner-only More → Dogfood mode runtime gate.
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
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ThemeColors } from "../constants/colors";
import { useDevice } from "../context/DeviceContext";
import { computeAttachGate, computeNestingVerdict, ATTACH_SENTINEL_KEY, type AttachStep } from "../lib/attachMode";
import type { BoxReadiness } from "../lib/boxInit";
import { loadBoxReadiness } from "../lib/boxInitStore";
import { discoverYaverCheckout, startAttachSession, startYaverBrowserLane, verifyYaverCheckout } from "../lib/attachClient";
import { appLog } from "../lib/logger";

const CHECKOUT_KEY = "@yaver/attach_checkout_dir";
const RUNNER_KEY = "@yaver/attach_runner";

export default function AttachModeSection({
  c,
  readiness,
  primaryOnly = false,
}: {
  c: ThemeColors;
  readiness?: BoxReadiness | null;
  primaryOnly?: boolean;
}) {
  const { devices, activeDevice, connectionStatus, primaryDeviceId, selectDevice } = useDevice();
  const primaryDevice = primaryDeviceId ? devices.find((d) => d.id === primaryDeviceId) ?? null : null;
  const targetDevice = primaryOnly ? primaryDevice : activeDevice;
  const targetConnected = !!targetDevice && connectionStatus === "connected" && activeDevice?.id === targetDevice.id;
  const [checkoutDir, setCheckoutDir] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const [runner, setRunner] = useState("claude-code");
  const [verified, setVerified] = useState<boolean | undefined>(undefined);
  const [verifying, setVerifying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<{ error: string; remedy?: string } | null>(null);
  const [measuredReadiness, setMeasuredReadiness] = useState<BoxReadiness | null>(readiness ?? null);
  const [connectingPrimary, setConnectingPrimary] = useState(false);
  const [mayOffer, setMayOffer] = useState(true);
  const [nestingReason, setNestingReason] = useState<string | undefined>();

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
        const [dir, r] = await Promise.all([
          AsyncStorage.getItem(CHECKOUT_KEY),
          AsyncStorage.getItem(RUNNER_KEY),
        ]);
        if (dir) setCheckoutDir(dir);
        if (r) setRunner(r);
      } catch {
        // best-effort
      } finally {
        setConfigLoaded(true);
      }
    })();
  }, []);

  // Primary-device dogfood should be one action in the normal case. Ask the
  // box for its actual repo inventory instead of guessing a username/path.
  useEffect(() => {
    if (!primaryOnly || !configLoaded || !targetConnected || !targetDevice?.id || checkoutDir.trim()) return;
    let cancelled = false;
    void discoverYaverCheckout(targetDevice.id).then((dir) => {
      if (cancelled || !dir) return;
      setCheckoutDir(dir);
      AsyncStorage.setItem(CHECKOUT_KEY, dir).catch(() => {});
    });
    return () => { cancelled = true; };
  }, [checkoutDir, configLoaded, primaryOnly, targetConnected, targetDevice?.id]);

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
      const ok = await verifyYaverCheckout(targetDevice.id, dir.trim());
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

  const attach = useCallback(async () => {
    if (!targetDevice?.id || !gate.canAttach) return;
    setStarting(true);
    setFailure(null);
    try {
      const dir = checkoutDir.trim();
      // 1. Mint the capability. This REFUSES a non-Yaver checkout server-side,
      //    so the client-side gate is a courtesy, not the guarantee.
      const session = await startAttachSession(targetDevice.id, dir);
      if (!session.ok || !session.sessionId) {
        setFailure({
          error: session.error || "Could not start Dogfood mode.",
          remedy: session.remedy,
        });
        return;
      }

      // 2. Serve Yaver's own mobile app on the BROWSER lane. Hermes is refused
      //    for self-development (409 YAVER_SELF_DEVELOPMENT_RECURSION); the web
      //    target is the route that refusal names.
      const status = await startYaverBrowserLane(targetDevice.id, dir);

      const url = (status as any)?.previewUrl || (status as any)?.bundleUrl || "";
      if (!url) {
        setFailure({
          error: "The box started the dev server but did not report an address to render.",
          remedy:
            "Open the Apps tab and check the browser-lane preview there — the doctor reports which stage it stopped at.",
        });
        return;
      }

      router.push({
        pathname: "/attach" as any,
        params: {
          sessionId: session.sessionId,
          url,
          workDir: dir,
          runner,
          deviceId: targetDevice.id,
          deviceName: targetDevice.name,
        },
      } as any);
    } catch (err: any) {
      appLog("warn", `attach: start failed: ${err?.message || String(err)}`);
      setFailure({
        error: err?.message || "Could not start Dogfood mode.",
        remedy: "Check the box is reachable and try again.",
      });
    } finally {
      setStarting(false);
    }
  }, [checkoutDir, gate.canAttach, runner, targetDevice?.id, targetDevice?.name]);

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
      <Text style={{ color: c.textPrimary, fontWeight: "700", fontSize: 15 }}>Dogfood Yaver in the browser</Text>
      <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 4, lineHeight: 17 }}>
        Serve mobile/ with Expo on your primary device, render it full-screen, and refresh it when a
        coding turn lands. Production mode always remains one tap away in native chrome.
      </Text>

      {primaryOnly && !primaryDevice ? (
        <Text style={{ color: c.warn, fontSize: 12, marginTop: 10 }}>
          Pick a primary device in Settings before starting Dogfood mode.
        </Text>
      ) : null}

      {primaryOnly && primaryDevice && !targetConnected ? (
        <Pressable
          disabled={connectingPrimary}
          onPress={() => {
            setConnectingPrimary(true);
            void selectDevice(primaryDevice)
              .catch((err) => setFailure({
                error: err instanceof Error ? err.message : String(err),
                remedy: "Wake or repair the primary device, then retry.",
              }))
              .finally(() => setConnectingPrimary(false));
          }}
          style={{ marginTop: 12, alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.accentSoft }}
        >
          <Text style={{ color: c.accent, fontSize: 12, fontWeight: "700" }}>
            {connectingPrimary ? "Connecting…" : `Connect ${primaryDevice.name}`}
          </Text>
        </Pressable>
      ) : null}

      {/* The gate. One line per step, each with its fix. */}
      <View style={{ marginTop: 12, gap: 8 }}>
        {gate.steps.map((step) => (
          <StepRow key={step.key} c={c} step={step} />
        ))}
      </View>

      <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 14, marginBottom: 6 }}>
        Yaver checkout on the box
      </Text>
      <TextInput
        value={checkoutDir}
        onChangeText={(t) => {
          setCheckoutDir(t);
          AsyncStorage.setItem(CHECKOUT_KEY, t).catch(() => {});
        }}
        placeholder="/root/Workspace/yaver.io"
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

      <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 12, marginBottom: 6 }}>Runner</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(["claude-code", "codex", "opencode"] as const).map((r) => {
          const on = runner === r;
          return (
            <Pressable
              key={r}
              onPress={() => {
                setRunner(r);
                AsyncStorage.setItem(RUNNER_KEY, r).catch(() => {});
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
          <Text style={{ color: c.textPrimary, fontSize: 12, lineHeight: 17 }}>{failure.error}</Text>
          {failure.remedy ? (
            <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 6, lineHeight: 16 }}>
              {failure.remedy}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* ONE primary action. Disabled states say what is missing via the gate
          rows above rather than a second explanation down here. */}
      <Pressable
        onPress={() => void attach()}
        disabled={!gate.canAttach || starting}
        style={({ pressed }) => [
          {
            marginTop: 14,
            paddingVertical: 12,
            borderRadius: 10,
            alignItems: "center",
            backgroundColor: gate.canAttach ? c.accent : c.bg,
            borderWidth: gate.canAttach ? 0 : 1,
            borderColor: c.border,
            opacity: !gate.canAttach || starting ? 0.6 : 1,
            flexDirection: "row",
            justifyContent: "center",
            gap: 8,
          },
          pressed && { opacity: 0.75 },
        ]}
      >
        {starting ? <ActivityIndicator size="small" color={c.textPrimary} /> : null}
        <Text
          style={{
            color: gate.canAttach ? "#fff" : c.textMuted,
            fontWeight: "700",
            fontSize: 14,
          }}
        >
          {starting ? "Starting Dogfood…" : "Enter Dogfood mode"}
        </Text>
      </Pressable>
    </View>
  );
}

function StepRow({ c, step }: { c: ThemeColors; step: AttachStep }) {
  const tone =
    step.status === "ok" ? c.success : step.status === "blocked" ? c.error : c.textMuted;
  const glyph = step.status === "ok" ? "✓" : step.status === "blocked" ? "!" : "·";
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <Text style={{ color: tone, fontSize: 12, width: 12, textAlign: "center" }}>{glyph}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.textPrimary, fontSize: 12, fontWeight: "600" }}>{step.label}</Text>
        <Text style={{ color: tone, fontSize: 11, lineHeight: 16 }}>{step.detail}</Text>
      </View>
    </View>
  );
}
