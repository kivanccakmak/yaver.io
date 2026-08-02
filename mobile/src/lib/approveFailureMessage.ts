/**
 * approveFailureMessage — why a device-code approval failed, in one sentence.
 *
 * Pure and dependency-free ON PURPOSE. It lives apart from deviceCodeApprove.ts
 * because that module imports backendConfig, which pulls in React Native, which
 * cannot load under `npx tsx` — so a classifier defined there is a classifier
 * nobody can test. Same reasoning as connectGuard.ts: the logic that SHIPS has
 * to be the logic that is TESTED.
 *
 * Tests: mobile/src/lib/deviceCodeApprove.test.ts
 */

/**
 * The sentence to show for a failed approval.
 *
 * Keys off the stable `code` the backend sends, falling back to the HTTP
 * status. It must never render the raw body: this used to return `res.text()`
 * verbatim, so the user was shown a JSON blob — and before the backend fix
 * (2026-08-01) that blob read `{"error":"Failed to authorize"}` for a mistyped
 * code, because the sentinels never survived the Convex boundary. See
 * thrownSentinel() in backend/convex/http.ts.
 *
 * Wording is deliberately identical to the web approver's, so a user who tries
 * one surface and then the other is not told two different stories about the
 * same code.
 */
export function approveFailureMessage(status: number, body: string): string {
  let code = "";
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    if (typeof parsed?.code === "string") code = parsed.code;
  } catch {
    // Not JSON — fall through to the status.
  }
  if (code === "invalid_code" || status === 404) {
    return "Invalid code. Check the code on the machine and try again.";
  }
  if (code === "code_expired" || status === 410) {
    return "That code has expired. Get a fresh one from the machine and try again.";
  }
  if (code === "code_already_used" || status === 409) {
    return "That code has already been used.";
  }
  if (code === "too_many_attempts" || status === 429) {
    return "Too many attempts on that code. Get a fresh one and try again.";
  }
  if (status === 401) {
    return "This phone is not signed in any more. Sign in again, then approve.";
  }
  return `Could not approve the machine (${status}). Try again in a moment.`;
}
