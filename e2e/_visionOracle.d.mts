/**
 * Types for _visionOracle.mjs.
 *
 * The oracle is plain .mjs so the node-only arcs (tv, vision) can import it
 * without a build step, but the mobile/web arc is TypeScript under
 * `tsc --noEmit`, and an untyped import there is an implicit `any` — which
 * means a rename or a changed return shape would fail at RUNTIME, inside a
 * catch block, on the surface least likely to be watched. That is the same
 * class as the `.ts`/`.web.ts` drift CLAUDE.md calls out, so it gets the same
 * treatment: declare the contract once, and let the compiler hold both callers
 * to it.
 */

export interface OracleAvailability {
  ok: boolean;
  /** Path to the compiled Swift helper. */
  path: string;
  /** Why it is unavailable, or "ready". Carries the build command when missing. */
  reason: string;
}

export interface OracleBlock {
  text: string;
  confidence: number;
}

export interface OracleRead {
  /** All recognised blocks joined with " | ". */
  text: string;
  blocks: OracleBlock[];
}

export interface OracleExplanation {
  /** Stable code: "dev-server-warming" | "signed-out" | "build-error" | … */
  cause: string;
  /** A sentence naming what is wrong, for a human reading the run. */
  reason: string;
  text: string;
}

export function available(): OracleAvailability;
export function readFrame(pngPath: string): OracleRead | null;
export function nameFromText(text: string | null): { cause: string; say: string } | null;
/** Returns null ONLY when the oracle could not run — never treat that as a failure. */
export function explainFrame(pngPath: string): OracleExplanation | null;
