// devEventLine.ts — formatting for /dev/events SSE lines in the runtime
// console.
//
// The agent's progress events carry `pct` on a 0..100 scale (devserver.go:
// `Pct float32 \`json:"pct,omitempty"\` // 0..100, REAL number from compiler
// output`), and the mobile surfaces render it as-is (DevPreview.tsx,
// apps.tsx). The web runtime console multiplied it by 100 again, printing
// "1575% streaming" for a 15.75% compile. Keep this a pure function so the
// scale contract stays pinned by a test.
export function formatDevProgressLine(topic: string, pct: unknown, phase?: unknown): string {
  const raw = typeof pct === "number" && Number.isFinite(pct) ? pct : 0;
  const clamped = Math.min(100, Math.max(0, Math.round(raw)));
  const phaseText = typeof phase === "string" ? phase : "";
  return `${topic}: ${clamped}% ${phaseText}`.trim();
}
