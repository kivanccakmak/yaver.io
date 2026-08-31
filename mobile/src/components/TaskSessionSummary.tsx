import React, { useMemo } from "react";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import type { Task } from "../lib/quic";
import type { CommandCardModel } from "../lib/commandEvents";
import { remoteAgentConversationView, type RemoteAgentConversationTone } from "../_core/taskConversation";
import { buildTaskHumanSummary, type HumanStepState, type HumanTaskLike } from "../lib/taskHumanSummary";
import { useColors } from "../context/ThemeContext";
import { spacing } from "../theme/tokens";

function toneColor(tone: RemoteAgentConversationTone, c: ReturnType<typeof useColors>): string {
  if (tone === "success") return c.success;
  if (tone === "error") return c.error;
  if (tone === "attention") return "#f59e0b";
  if (tone === "muted") return c.textMuted;
  return c.accent;
}

function stateMeta(state: HumanStepState, c: ReturnType<typeof useColors>) {
  if (state === "succeeded") return { icon: "checkmark-circle" as const, label: "Succeeded", color: c.success };
  if (state === "failed") return { icon: "close-circle" as const, label: "Failed", color: c.error };
  if (state === "running") return { icon: "play-circle" as const, label: "Running", color: c.accent };
  if (state === "completed") return { icon: "checkmark-circle-outline" as const, label: "Finished", color: c.textSecondary };
  return { icon: "eye-outline" as const, label: "Recorded", color: c.textMuted };
}

export function TaskSessionSummary({
  task,
  commands,
  summaryTask,
  pendingQuestion,
  compact = false,
}: {
  task: Task;
  commands?: Record<string, CommandCardModel>;
  summaryTask?: HumanTaskLike;
  pendingQuestion?: string;
  compact?: boolean;
}) {
  const c = useColors();
  const evidence = useMemo(
    () => buildTaskHumanSummary(summaryTask || task, commands),
    [task, commands, summaryTask],
  );
  const latestActivity = evidence.steps.at(-1)?.label;
  const view = useMemo(() => remoteAgentConversationView(task, {
    pendingQuestion,
    latestActivity,
  }), [latestActivity, pendingQuestion, task]);
  const accent = toneColor(view.tone, c);
  const steps = evidence.steps.slice(-3);

  return (
    <View
      style={[styles.wrap, compact && styles.compactWrap, { backgroundColor: c.bgCard, borderColor: c.border }]}
      accessibilityRole="summary"
      accessibilityLabel={`${view.title}. ${view.detail}`}
      testID="task-session-summary"
    >
      <View style={styles.header}>
        <View style={[styles.statusIcon, { backgroundColor: `${accent}18` }]}>
          <Ionicons
            name={
              view.state === "working" || view.state === "queued" ? "sparkles" :
              view.state === "needs_answer" ? "chatbubble-ellipses" :
              view.state === "review" || view.state === "completed" ? "checkmark-circle" :
              view.state === "failed" ? "alert-circle" : "return-down-forward"
            }
            size={20}
            color={accent}
          />
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.eyebrow, { color: accent }]}>{view.eyebrow}</Text>
          <Text style={[styles.title, { color: c.textPrimary }]}>{view.title}</Text>
        </View>
      </View>

      <Text style={[styles.detail, { color: c.textSecondary }]}>{view.detail}</Text>

      {steps.length > 0 ? (
        <View style={[styles.activity, { borderTopColor: c.borderSubtle }]}>
          <Text style={[styles.activityTitle, { color: c.textMuted }]}>ACTIVITY</Text>
          {steps.map((step) => {
            const meta = stateMeta(step.state, c);
            return (
              <View key={step.id} style={styles.step}>
                <Ionicons name={meta.icon} size={17} color={meta.color} style={styles.stepIcon} />
                <View style={styles.stepBody}>
                  <Text style={[styles.stepLabel, { color: c.textPrimary }]} numberOfLines={1}>{step.label}</Text>
                  <Text style={[styles.stepDetail, { color: c.textMuted }]} numberOfLines={1}>
                    {meta.label}{step.detail ? ` · ${step.detail}` : ""}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {view.nextAction ? (
        <View style={[styles.next, { backgroundColor: `${accent}0f`, borderColor: `${accent}33` }]}>
          <Text style={[styles.nextLabel, { color: accent }]}>NEXT</Text>
          <Text style={[styles.nextText, { color: c.textPrimary }]}>{view.nextAction}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: 14,
    borderWidth: 1,
    borderRadius: 14,
  },
  compactWrap: { marginHorizontal: 0, marginVertical: 8 },
  header: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  headerText: { flex: 1 },
  eyebrow: { fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  title: { fontSize: 17, lineHeight: 22, fontWeight: "700", marginTop: 1 },
  detail: { fontSize: 14, lineHeight: 20, marginTop: 10 },
  activity: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 12, paddingTop: 10, gap: 9 },
  activityTitle: { fontSize: 10, fontWeight: "800", letterSpacing: 0.8, marginBottom: 1 },
  step: { flexDirection: "row", alignItems: "center", minHeight: 34 },
  stepIcon: { marginRight: 9 },
  stepBody: { flex: 1, minWidth: 0 },
  stepLabel: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
  stepDetail: { fontSize: 11, lineHeight: 15, marginTop: 1 },
  next: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 12 },
  nextLabel: { fontSize: 10, lineHeight: 18, fontWeight: "900", letterSpacing: 0.6 },
  nextText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: "600" },
});
