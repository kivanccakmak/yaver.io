// ScreenContextChip — the visible, switchable half of "the agent knows which
// screen you're looking at", on the phone.
//
// ── The rule this exists to satisfy ───────────────────────────────────────
//
// SILENT PROMPT MUTATION IS A DEFECT. The agent prepends a block describing the
// user's screen to the prompt they typed (screen_context_turn.go, every turn
// including follow-ups). If the user cannot see that happening and cannot stop
// it, we have built exactly the kind of hidden behaviour this repo treats as a
// bug — the UI equivalent of a `serve` that logs nothing.
//
// So the chip states the screen BY NAME ("Adın ne? (3 controls)"), expands to
// the literal facts being sent, and the toggle does not merely stop future
// posts: it DELETES what was already reported (DELETE /screen-context), so
// "off" means the agent is not holding your screen rather than holding it and
// promising not to look.
//
// ── Why it renders here and not in the preview ────────────────────────────
//
// The observation is made in the Hot Reload tab / DevPreview modal; the prompt
// is typed in Tasks. The chip belongs where the PROMPT is, because that is
// where the mutation happens and where the user is deciding what to say. The
// bridge (screenContextBridge.ts) carries the observation across the tab
// boundary.

import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useColors } from "../context/ThemeContext";
import {
  type ObservedScreen,
  getObservedScreen,
  screenContextPrefReady,
  setEnabled as setBridgeEnabled,
  subscribeScreenContext,
} from "../lib/screenContextBridge";
import { isScreenContextEnabled, screenContextDetail, screenContextSummary } from "../lib/screenContext";
import { monoFamily } from "../theme/tokens";

export function ScreenContextChip({
  /** The project this composer will send work to. When set, a screen observed
   *  in a DIFFERENT project is not shown: the agent keys context by workDir, so
   *  claiming attachment across projects would be a chip that lies. */
  workDir,
  style,
}: {
  workDir?: string | null;
  style?: any;
}) {
  const c = useColors();
  const [screen, setScreen] = useState<ObservedScreen | null>(() => getObservedScreen());
  const [enabled, setEnabledState] = useState(() => isScreenContextEnabled());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    const unsub = subscribeScreenContext(setScreen);
    // The opt-out hydrates from AsyncStorage asynchronously. Re-read once it
    // has, rather than after a guessed delay: a chip mounted at cold start must
    // not render "ON" to a user who turned it off — a switch that lies about
    // its own position is worse than no switch.
    void screenContextPrefReady.then(() => {
      if (alive) setEnabledState(isScreenContextEnabled());
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabledState(next);
    setBridgeEnabled(next);
  }, [enabled]);

  // Nothing observed yet: render nothing rather than an empty promise. A chip
  // reading "context: —" would assert a capability that is not currently doing
  // anything.
  if (!screen) return null;

  const scoped = String(workDir || "").trim();
  if (scoped && screen.workDir && screen.workDir !== scoped) return null;

  const summary = screenContextSummary(screen.ctx);
  if (!summary) return null;
  const detail = screenContextDetail(screen.ctx);
  const project = screen.workDir ? screen.workDir.split("/").filter(Boolean).pop() || screen.workDir : "";
  // A preview whose project we never learned cannot be attached to anything —
  // the agent stores screen context per workDir. Say so instead of showing a
  // chip that quietly forwards nothing.
  const unattachable = !screen.workDir;

  const tint = unattachable ? c.textMuted : enabled ? c.success : c.textMuted;
  const bg = unattachable ? c.bgCardElevated : enabled ? c.successBg : c.bgCardElevated;
  const border = unattachable ? c.border : enabled ? c.successBorder : c.border;

  return (
    <View
      style={[
        {
          borderWidth: 1,
          borderColor: border,
          backgroundColor: bg,
          borderRadius: 10,
          paddingHorizontal: 10,
          paddingVertical: 6,
          gap: 4,
        },
        style,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
          style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, flexGrow: 1, gap: 6 }}
          accessibilityRole="button"
          accessibilityLabel={
            enabled
              ? `Screen context attached: ${summary}. Tap to see exactly what is sent with your prompt.`
              : `Screen context off. Last seen: ${summary}.`
          }
          accessibilityState={{ expanded }}
        >
          <Text style={{ color: tint, fontSize: 11, opacity: 0.8 }}>▣</Text>
          <Text
            numberOfLines={1}
            style={{
              color: tint,
              fontSize: 11,
              flexShrink: 1,
              textDecorationLine: enabled && !unattachable ? "none" : "line-through",
            }}
          >
            <Text style={{ opacity: 0.7 }}>context: </Text>
            {summary}
            {project ? <Text style={{ opacity: 0.7 }}> · {project}</Text> : null}
          </Text>
          <Text style={{ color: tint, fontSize: 9, opacity: 0.6 }}>{expanded ? "▾" : "▸"}</Text>
        </Pressable>
        <Pressable
          onPress={toggle}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={
            enabled
              ? "Stop attaching the screen you're viewing, and delete what was already reported"
              : "Attach the screen you're viewing to your prompts"
          }
          style={{
            borderWidth: 1,
            borderColor: tint,
            borderRadius: 6,
            paddingHorizontal: 6,
            paddingVertical: 2,
          }}
        >
          <Text style={{ color: tint, fontSize: 9, fontWeight: "700", letterSpacing: 0.6 }}>
            {enabled ? "ON" : "OFF"}
          </Text>
        </Pressable>
      </View>

      {expanded ? (
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 4, gap: 2 }}>
          {unattachable ? (
            <Text style={{ color: c.textSecondary, fontSize: 10 }}>
              Seen in the preview, but Yaver doesn&apos;t know which project it belongs to yet, so nothing was
              attached. Start the dev server from a project so the preview reports a working directory.
            </Text>
          ) : enabled ? (
            <>
              <Text style={{ color: c.textSecondary, fontSize: 10, opacity: 0.8 }}>
                Sent with your prompt, so the agent starts on the right file:
              </Text>
              {detail.map((line) => (
                <Text
                  key={line}
                  style={{ color: c.textSecondary, fontSize: 10, fontFamily: monoFamily }}
                >
                  {line}
                </Text>
              ))}
              <Text style={{ color: c.textMuted, fontSize: 10 }}>
                Labels and route only — never what you type into a field. Stays on your machine; never synced.
              </Text>
            </>
          ) : (
            <Text style={{ color: c.textSecondary, fontSize: 10 }}>
              Off. Your prompts are sent exactly as typed, and the agent is not holding this screen.
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}
