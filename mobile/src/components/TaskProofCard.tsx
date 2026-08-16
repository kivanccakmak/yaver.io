/**
 * TaskProofCard — the compact "task proof" evidence card rendered under a
 * completed/review task's chat thread (design:
 * docs/audits/task-proof-showcase-audit-2026-07.md §9.4).
 *
 * Hero = poster thumbnail with a ▶ overlay ("See proof" is the tap
 * affordance for the WHOLE hero); while the box is still capturing it shows
 * a quiet "Recording demo…" line with an elapsed hint instead of a spinner;
 * a failed capture renders the NAMED cause (B12) and keeps the evidence
 * rows visible — proof of work doesn't vanish because the clip did.
 *
 * Theming is strictly useColors() + tokens — no hardcoded hex (the tokens
 * file's own history shows why: an untyped hex slipped a debug orange into
 * TestFlight 482 invisibly to tsc).
 *
 * Memoized like ChatBubble (tasks.tsx): this mounts inside a screen that
 * re-renders on every streamed token, and the poster <Image> + layout are
 * not free. The comparator covers every data field the card reads; onPlay
 * is deliberately EXCLUDED (the parent passes a fresh closure per render —
 * comparing it would defeat the memo; the closure only captures stable
 * setters, so a stale one is still correct).
 */
import React, { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useColors } from "../context/ThemeContext";
import { monoFamily, spacing, typography } from "../theme/tokens";
import { clipPosterUrl } from "../lib/vibePreview";
import { stripMarkdownForPreview } from "../lib/taskPreview";
import {
  formatProofDuration,
  proofFailureLine,
  proofIsInFlight,
  proofIsReady,
} from "../lib/taskProofStatus";
import type { Task, TaskProof } from "../lib/quic";

export type TaskProofCardProps = {
  task: Task;
  /** Full proof record when hydrated; the card degrades gracefully to the
   *  task's inline proof/video fields while this is still null. */
  proof: TaskProof | null;
  /** Auth headers for the poster <Image> — proof media URLs are absolute
   *  and authed exactly like every other agent call. */
  headers: Record<string, string>;
  /** Open the proof overlay (video + narrative). Fires only when playable. */
  onPlay: () => void;
};

/** The proof record wins; the task's inline fields cover the gap before
 *  hydration (list rows carry proofStatus; older tasks only videoStatus). */
function effectiveStatus(task: Task, proof: TaskProof | null): string | undefined {
  return proof?.status ?? task.proofStatus ?? task.videoStatus;
}

function TaskProofCardImpl({ task, proof, headers, onPlay }: TaskProofCardProps) {
  const c = useColors();
  const status = effectiveStatus(task, proof);
  const failureLine = proofFailureLine(status, proof?.failedReason);
  const inFlight = proofIsInFlight(status);
  const ready = proofIsReady(status);

  const posterUri =
    proof?.posterUrl || (task.videoClipId ? clipPosterUrl(task.videoClipId) : null);
  const playable = ready && !!(proof?.videoUrl || proof?.clipId || task.videoClipId);

  // Elapsed hint while capturing — a wait that doesn't narrate itself is a
  // defect (house rule). Anchor on the task's last update; tick only while
  // the capture is actually in flight so the interval isn't a standing tax.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [inFlight]);
  const capturedElapsed = formatProofDuration(nowSec - Math.floor((task.updatedAt || Date.now()) / 1000));

  const summaryLine =
    (task.resultText || "")
      .split("\n")
      .map((l) => stripMarkdownForPreview(l).trim())
      .find(Boolean) || task.title;

  const commitSha = proof?.commitSha || task.commitSha;
  const commitSubject = proof?.commitSubject || task.commitSubject;
  const diffShortstat = proof?.diffShortstat || task.diffShortstat;
  const durationSec = proof?.durationSec;
  const costUsd = proof?.costUsd ?? task.costUsd;
  const metaBits: string[] = [];
  if (typeof durationSec === "number" && durationSec > 0) metaBits.push(formatProofDuration(durationSec));
  if (typeof costUsd === "number" && costUsd > 0) metaBits.push(`$${costUsd.toFixed(2)}`);

  return (
    <View
      testID="task-proof-card"
      style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}
    >
      {/* Hero — the single tap affordance. Failure has NO spinner and no
          dead play button: the named cause takes the hero's place while the
          evidence rows below stay. */}
      {failureLine ? (
        <View style={[styles.failWrap, { backgroundColor: c.surfaceMuted }]}>
          <Text style={[typography.caption, { color: c.textMuted }]}>{failureLine}</Text>
          {proof?.failedRoute ? (
            <Text style={[typography.monoCaption, { color: c.textMuted, marginTop: spacing.xs }]}>
              {proof.failedRoute}
            </Text>
          ) : null}
        </View>
      ) : (
        <Pressable
          testID="task-proof-play"
          accessibilityRole="button"
          accessibilityLabel="See proof"
          disabled={!playable}
          onPress={onPlay}
          style={({ pressed }) => [
            posterUri ? styles.hero : styles.heroCompact,
            { backgroundColor: c.surfaceMuted },
            pressed && playable ? { opacity: 0.85 } : null,
          ]}
        >
          {posterUri ? (
            <>
              <Image
                source={{ uri: posterUri, headers }}
                style={StyleSheet.absoluteFill}
                resizeMode="cover"
              />
              <View style={styles.playOverlay}>
                {playable ? (
                  <View style={[styles.playBadge, { backgroundColor: c.bg, borderColor: c.border }]}>
                    <Text style={[typography.bodyStrong, { color: c.textPrimary }]}>▶  See proof</Text>
                  </View>
                ) : inFlight ? (
                  <Text style={[typography.caption, { color: c.textMuted }]}>
                    Recording demo… {capturedElapsed} elapsed
                  </Text>
                ) : null}
              </View>
            </>
          ) : playable ? (
            // Ready but no poster frame — still a full-width play affordance.
            <View style={[styles.playBadge, { backgroundColor: c.bg, borderColor: c.border }]}>
              <Text style={[typography.bodyStrong, { color: c.textPrimary }]}>▶  See proof</Text>
            </View>
          ) : (
            // Quiet, compact status line — no spinner, no empty hero slab.
            <Text style={[typography.caption, { color: c.textMuted }]}>
              {inFlight ? `Recording demo… ${capturedElapsed} elapsed` : "Preparing proof…"}
            </Text>
          )}
        </Pressable>
      )}

      {/* One-line summary */}
      <View style={styles.body}>
        <Text numberOfLines={1} style={[typography.bodyStrong, { color: c.textPrimary }]}>
          {summaryLine}
        </Text>

        {/* Evidence row — commit chip + diff stats + duration/cost. Only
            rendered when present; the card never shows empty chrome. */}
        {commitSha ? (
          <View style={styles.evidenceRow}>
            <View style={[styles.commitChip, { backgroundColor: c.successBg }]}>
              <Text style={[typography.badge, { color: c.success, fontFamily: monoFamily }]}>
                {commitSha.slice(0, 7)}
              </Text>
            </View>
            {commitSubject ? (
              <Text
                numberOfLines={1}
                style={[typography.caption, { color: c.textSecondary, flexShrink: 1 }]}
              >
                {commitSubject}
              </Text>
            ) : null}
          </View>
        ) : null}
        {diffShortstat ? (
          <Text numberOfLines={1} style={[typography.caption, { color: c.textMuted, marginTop: spacing.xs }]}>
            {diffShortstat}
          </Text>
        ) : null}
        {metaBits.length > 0 ? (
          <Text style={[typography.caption, { color: c.textMuted, marginTop: spacing.xs }]}>
            {metaBits.join(" · ")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Content-equality memo (the ChatBubble pattern): only re-render when a
 *  field the card actually paints changed. onPlay is intentionally not
 *  compared — see the file-top comment. */
export const TaskProofCard = React.memo(TaskProofCardImpl, (prev, next) => {
  const a = prev.task;
  const b = next.task;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.resultText === b.resultText &&
    a.proofStatus === b.proofStatus &&
    a.videoStatus === b.videoStatus &&
    a.videoClipId === b.videoClipId &&
    a.commitSha === b.commitSha &&
    a.commitSubject === b.commitSubject &&
    a.diffShortstat === b.diffShortstat &&
    a.costUsd === b.costUsd &&
    a.updatedAt === b.updatedAt &&
    prev.proof === next.proof &&
    prev.headers === next.headers
  );
});

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.md,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  hero: {
    height: 172,
    alignItems: "center",
    justifyContent: "center",
  },
  heroCompact: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  failWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  playBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
  },
  body: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  evidenceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  commitChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 5,
  },
});

export default TaskProofCard;
