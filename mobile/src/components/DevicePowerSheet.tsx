// DevicePowerSheet — cloud-console power control for a machine, on the phone.
//
// Mirrors web/components/dashboard/DevicePowerModal.tsx. GCP and AWS can put a
// Reset button on every instance card because the console owns the hypervisor;
// Yaver does not own the machine, so this sheet never renders a power button
// from a guess. It ASKS the box (`GET /infra/power`, a read-only dry run) and
// renders the answer — including the cases where the honest answer is "not from
// in here":
//
//   - inside a container there is no host to power-cycle, and a reboot command
//     would at best stop the container;
//   - a WSL distro restart is not a Windows reboot;
//   - an agent running as an ordinary user cannot reboot at all — and that one
//     IS fixable, so it gets a remedy instead of a dead button.
//
// Two rules on top of the report:
//
//   1. Destructive actions need a TYPED confirmation, never a stray tap. On a
//      phone this matters more than on a desktop: a mis-tap in a list should
//      never be able to power off someone's build machine.
//   2. After a reboot the box goes silent, and silence is indistinguishable
//      from a crash unless we narrate it. powerProgress.ts owns those sentences
//      and refuses to say "recovered" until it has watched the box disappear.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useColors } from "../context/ThemeContext";
import { quicClient, type PowerAction, type PowerReport } from "../lib/quic";
import { rebootProgressFor, humanizeRebootSeconds, type RebootProgress } from "../lib/powerProgress";

/** The word the user types to arm each action. Short enough to type on a phone
 *  keyboard, specific enough that it cannot be muscle memory from elsewhere. */
function confirmWordFor(id: PowerAction["id"]): string {
  return id === "host_reboot" ? "reboot" : "restart";
}

export function DevicePowerSheet({
  visible,
  deviceId,
  deviceName,
  onClose,
}: {
  visible: boolean;
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}) {
  const c = useColors();
  const [report, setReport] = useState<PowerReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PowerAction["id"] | null>(null);
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [progress, setProgress] = useState<RebootProgress | null>(null);
  const watchRef = useRef<{ startedAt: number; eta: number; sawDown: boolean } | null>(null);

  // Load the capability report. This is the only thing that decides what the
  // sheet offers — nothing here re-derives availability from the device row.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setReport(null);
    setLoadError(null);
    setProgress(null);
    setSelected(null);
    setTyped("");
    watchRef.current = null;
    (async () => {
      try {
        const r = await quicClient.infraPowerReport(deviceId);
        if (!cancelled) setReport(r);
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || "could not read the power report");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, deviceId]);

  // Recovery watch. `sawDown` is the guard: a box keeps answering for seconds
  // after accepting a reboot, so we may not call it recovered until we have
  // actually seen it go away.
  useEffect(() => {
    if (!progress || progress.done || !watchRef.current) return;
    let stopped = false;
    const timer = setTimeout(async () => {
      const w = watchRef.current;
      if (!w || stopped) return;
      let reachable = false;
      try {
        await quicClient.infraPowerReport(deviceId);
        reachable = true;
      } catch {
        reachable = false;
      }
      if (!reachable) w.sawDown = true;
      if (stopped) return;
      setProgress(
        rebootProgressFor({
          elapsedSeconds: Math.round((Date.now() - w.startedAt) / 1000),
          etaSeconds: w.eta,
          reachable,
          sawUnreachable: w.sawDown,
          machineName: deviceName,
        }),
      );
    }, 4000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [progress, deviceId, deviceName]);

  const run = useCallback(
    async (action: PowerAction) => {
      setSubmitting(true);
      setActionError(null);
      try {
        const res: any = await quicClient.infraPower(action.id, deviceId);
        if (action.id === "host_reboot" || action.id === "agent_restart") {
          const eta = Number(res?.etaSeconds) || action.etaSeconds || 60;
          watchRef.current = { startedAt: Date.now(), eta, sawDown: false };
          setProgress(
            rebootProgressFor({
              elapsedSeconds: 0,
              etaSeconds: eta,
              reachable: true,
              sawUnreachable: false,
              machineName: deviceName,
            }),
          );
        } else {
          onClose();
        }
      } catch (e: any) {
        setActionError(e?.message || "the action failed");
      } finally {
        setSubmitting(false);
      }
    },
    [deviceId, deviceName, onClose],
  );

  const hostLine = report
    ? [
        report.facts.goos,
        report.facts.container ? `${report.facts.container} container` : null,
        report.facts.wslVersion ? `WSL${report.facts.wslVersion}` : null,
        report.facts.isRoot ? "root" : report.facts.agentUser ? `agent runs as ${report.facts.agentUser}` : null,
        report.facts.serviceManager || null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <View style={{
          backgroundColor: c.bgCard, borderTopLeftRadius: 16, borderTopRightRadius: 16,
          maxHeight: "85%", borderWidth: 1, borderColor: c.border,
        }}>
          <View style={{
            flexDirection: "row", justifyContent: "space-between", alignItems: "center",
            paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border,
          }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.textPrimary, fontSize: 15, fontWeight: "700" }}>Power</Text>
              <Text style={{ color: c.textMuted, fontSize: 11 }} numberOfLines={1}>{deviceName}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={{ color: c.textMuted, fontSize: 13, fontWeight: "600" }}>Close</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {/* Recovery narration takes over once an action is in flight — the
                machine is gone and this is the only thing worth showing. */}
            {progress ? (
              <View style={{ gap: 8 }}>
                <Text style={{ color: c.textPrimary, fontSize: 14, fontWeight: "700" }}>{progress.headline}</Text>
                <Text style={{ color: c.textMuted, fontSize: 12, lineHeight: 18 }}>{progress.detail}</Text>
                {!progress.done ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <ActivityIndicator size="small" color={c.textMuted} />
                    <Text style={{ color: c.textMuted, fontSize: 11 }}>
                      {humanizeRebootSeconds(progress.elapsedSeconds)} elapsed
                      {progress.remainingSeconds > 0
                        ? ` · ~${humanizeRebootSeconds(progress.remainingSeconds)} to go`
                        : ""}
                    </Text>
                  </View>
                ) : null}
                {progress.remedy ? (
                  <Text style={{
                    color: c.warn, fontSize: 11, lineHeight: 17,
                    backgroundColor: c.warnBg, borderRadius: 8, padding: 10,
                  }}>
                    {progress.remedy}
                  </Text>
                ) : null}
                {progress.done ? (
                  <Pressable
                    onPress={onClose}
                    style={{
                      marginTop: 4, paddingVertical: 10, borderRadius: 8,
                      backgroundColor: c.successBg, alignItems: "center",
                    }}
                  >
                    <Text style={{ color: c.success, fontSize: 13, fontWeight: "700" }}>Done</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : loadError ? (
              <Text style={{ color: c.error, fontSize: 12, lineHeight: 18 }}>
                Could not read what this machine can do: {loadError}
              </Text>
            ) : !report ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ActivityIndicator size="small" color={c.textMuted} />
                <Text style={{ color: c.textMuted, fontSize: 12 }}>Asking the machine what it can do…</Text>
              </View>
            ) : (
              <View style={{ gap: 12 }}>
                {/* Say what kind of host this is BEFORE the actions, so the
                    refusals below read as facts about the machine rather than
                    as Yaver being broken. */}
                <Text style={{ color: c.textMuted, fontSize: 11 }}>{hostLine}</Text>
                {report.actions.map((a) => (
                  <PowerActionCard
                    key={a.id}
                    action={a}
                    expanded={selected === a.id}
                    typed={typed}
                    submitting={submitting}
                    error={selected === a.id ? actionError : null}
                    onToggle={() => {
                      setSelected(selected === a.id ? null : a.id);
                      setTyped("");
                      setActionError(null);
                    }}
                    onType={setTyped}
                    onConfirm={() => run(a)}
                  />
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function PowerActionCard({
  action,
  expanded,
  typed,
  submitting,
  error,
  onToggle,
  onType,
  onConfirm,
}: {
  action: PowerAction;
  expanded: boolean;
  typed: string;
  submitting: boolean;
  error: string | null;
  onToggle: () => void;
  onType: (v: string) => void;
  onConfirm: () => void;
}) {
  const c = useColors();
  const word = confirmWordFor(action.id);
  const armed = typed.trim().toLowerCase() === word;

  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.textPrimary, fontSize: 13, fontWeight: "700" }}>{action.label}</Text>
          <Text style={{ color: c.textMuted, fontSize: 11, lineHeight: 17, marginTop: 2 }}>{action.means}</Text>
        </View>
        <Pressable
          disabled={!action.available}
          onPress={onToggle}
          style={{
            paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1,
            borderColor: action.available ? c.errorBorder : c.border,
            backgroundColor: action.available ? c.errorBg : "transparent",
          }}
        >
          <Text style={{
            color: action.available ? c.error : c.textMuted, fontSize: 11, fontWeight: "700",
          }}>
            {action.available ? (expanded ? "Cancel" : "Run…") : "Unavailable"}
          </Text>
        </Pressable>
      </View>

      {/* An unavailable action states its cause and its remedy. A bare disabled
          button is exactly what sent users to a spinner. */}
      {!action.available ? (
        <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 }}>
          {action.reason ? (
            <Text style={{ color: c.textMuted, fontSize: 11, lineHeight: 17 }}>{action.reason}</Text>
          ) : null}
          {action.remedy ? (
            <Text style={{
              color: c.textMuted, fontSize: 10, lineHeight: 16, fontFamily: "Menlo",
              backgroundColor: "rgba(127,127,127,0.10)", borderRadius: 6, padding: 8,
            }}>
              {action.remedy}
            </Text>
          ) : null}
          {action.alternative ? (
            <Text style={{ color: c.textMuted, fontSize: 11 }}>
              You can still use {action.alternative.replace(/_/g, " ")} below.
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Typed confirmation. States the cost, then asks for the word. */}
      {expanded && action.available ? (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 }}>
          {action.loses?.length ? (
            <View>
              <Text style={{ color: c.textPrimary, fontSize: 11, fontWeight: "700" }}>This kills:</Text>
              {action.loses.map((l) => (
                <Text key={l} style={{ color: c.textMuted, fontSize: 11, lineHeight: 17 }}>• {l}</Text>
              ))}
            </View>
          ) : null}
          {action.command ? (
            <Text style={{ color: c.textMuted, fontSize: 10, fontFamily: "Menlo" }}>runs: {action.command}</Text>
          ) : null}
          {action.etaSeconds ? (
            <Text style={{ color: c.textMuted, fontSize: 11 }}>
              Expect it back in about {humanizeRebootSeconds(action.etaSeconds)}.
            </Text>
          ) : null}
          <Text style={{ color: c.textMuted, fontSize: 11 }}>
            Type <Text style={{ fontWeight: "700", color: c.textPrimary }}>{word}</Text> to confirm:
          </Text>
          <TextInput
            value={typed}
            onChangeText={onType}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={word}
            placeholderTextColor={c.textMuted}
            style={{
              borderWidth: 1, borderColor: c.border, borderRadius: 8,
              paddingHorizontal: 10, paddingVertical: 8, color: c.textPrimary, fontSize: 13, fontFamily: "Menlo",
            }}
          />
          {error ? <Text style={{ color: c.error, fontSize: 11, lineHeight: 17 }}>{error}</Text> : null}
          <Pressable
            disabled={!armed || submitting}
            onPress={onConfirm}
            style={{
              paddingVertical: 11, borderRadius: 8, alignItems: "center",
              backgroundColor: armed && !submitting ? c.error : "rgba(127,127,127,0.15)",
            }}
          >
            <Text style={{
              color: armed && !submitting ? "#fff" : c.textMuted, fontSize: 13, fontWeight: "700",
            }}>
              {submitting ? "Sending…" : action.label}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export default DevicePowerSheet;
