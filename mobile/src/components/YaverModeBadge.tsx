// YaverModeBadge.tsx — the small, polite "you are inside Yaver" mark.
//
// A single low-contrast Y in the header. No text, no colour shouting, no
// banner. Tapping it opens a sheet that says which mode you're in and offers
// the way back to the installed app.
//
// ── Why a mark and not a chip ───────────────────────────────────────────────
//
// The surface belongs to whatever is being previewed. Our indicator earns a few
// pixels and no more — a chip spelling out "ATTACHED · DEV BUILD" in every
// header is exactly the accretion the LESS IS MORE rule exists to stop, and
// wallpaper is what people stop reading. One Y the user already recognises
// carries the whole message: Yaver is between you and this app.
//
// ── Why it must never be the escape ─────────────────────────────────────────
//
// This badge is a HINT, not the exit. The real escape is the host's native
// chrome (attach.tsx's Detach) or the container overlay (shake). If the badge
// were the only way out, a previewed app that drew over the header would trap
// the user — the exact recursion trap the Hermes refusal exists to prevent.
// So: the badge is additive, and every mode's genuine escape lives elsewhere.

import React, { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColors } from "../context/ThemeContext";
import {
  planRevert,
  resolveRuntimeMode,
  runtimeModeBadge,
  type RuntimeMode,
} from "../lib/runtimeMode";
import { ATTACH_SENTINEL_KEY } from "../lib/attachMode";
import { appLog } from "../lib/logger";

export interface YaverModeBadgeProps {
  /** Host-side: an Attach Mode session this instance owns is live. */
  hostAttachSessionLive?: boolean;
  guestBundleMounted?: boolean;
  browserPreviewOpen?: boolean;
  /** Performs the way-back. The badge never reverts by itself — it asks the
   *  owner of the escape to do it, because only that layer can. */
  onRevert?: (mode: RuntimeMode) => void | Promise<void>;
}

export function YaverModeBadge(props: YaverModeBadgeProps) {
  const c = useColors();
  const [sentinel, setSentinel] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [reverting, setReverting] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(ATTACH_SENTINEL_KEY)
      .then((v) => {
        if (alive) setSentinel(v);
      })
      .catch(() => {
        // Absent is the normal installed-app case, not an error.
      });
    return () => {
      alive = false;
    };
  }, []);

  const mode = resolveRuntimeMode({
    attachSentinel: sentinel,
    hostAttachSessionLive: props.hostAttachSessionLive,
    guestBundleMounted: props.guestBundleMounted,
    browserPreviewOpen: props.browserPreviewOpen,
  });
  const isAttachedInstance = sentinel === "1" || sentinel === "true";
  const badge = runtimeModeBadge(mode, { isAttachedInstance });

  const revert = useCallback(async () => {
    const plan = planRevert(mode);
    if (!plan) return;
    setReverting(true);
    try {
      await props.onRevert?.(mode);
    } catch (err) {
      appLog("warn", `mode badge: revert failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReverting(false);
      setOpen(false);
    }
  }, [mode, props]);

  // The installed app shows nothing at all.
  if (!badge) return null;

  const markColor = badge.tone === "dev" ? c.accent : c.textMuted;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Running in Yaver: ${badge.label}`}
        hitSlop={8}
        style={({ pressed }) => [
          {
            width: 22,
            height: 22,
            borderRadius: 11,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: markColor + "66",
            backgroundColor: markColor + "1A",
          },
          pressed && { opacity: 0.6 },
        ]}
      >
        <Text style={{ color: markColor, fontSize: 12, fontWeight: "700", lineHeight: 14 }}>
          {badge.mark}
        </Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "#0008" }} onPress={() => setOpen(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              margin: 24,
              marginTop: "auto",
              marginBottom: 48,
              borderRadius: 16,
              padding: 18,
              backgroundColor: c.bgCard,
              borderWidth: 1,
              borderColor: c.border,
              gap: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: markColor, fontSize: 15, fontWeight: "800" }}>{badge.mark}</Text>
              <Text style={{ color: c.textPrimary, fontSize: 15, fontWeight: "700" }}>{badge.label}</Text>
            </View>

            <Text style={{ color: c.textSecondary, fontSize: 13, lineHeight: 19 }}>{badge.detail}</Text>

            {badge.canRevertHere ? (
              <Pressable
                onPress={() => void revert()}
                disabled={reverting}
                style={({ pressed }) => [
                  {
                    marginTop: 6,
                    paddingVertical: 12,
                    borderRadius: 10,
                    alignItems: "center",
                    backgroundColor: c.accent,
                    opacity: reverting ? 0.6 : 1,
                  },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
                  {reverting ? planRevert(mode)?.message ?? "Reverting…" : badge.revertLabel}
                </Text>
              </Pressable>
            ) : (
              // No button, because this layer genuinely cannot do it. Saying so
              // beats a control that would appear to work and wouldn't.
              <Text style={{ color: c.textMuted, fontSize: 12, lineHeight: 17, marginTop: 4 }}>
                {`The way out is "${badge.revertLabel}" in the bar above — it belongs to the app ` +
                  "around this one, which is what makes it impossible to lose."}
              </Text>
            )}

            <Pressable onPress={() => setOpen(false)} style={{ paddingVertical: 10, alignItems: "center" }}>
              <Text style={{ color: c.textMuted, fontSize: 13 }}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export default YaverModeBadge;
