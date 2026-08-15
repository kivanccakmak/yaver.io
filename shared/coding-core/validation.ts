/**
 * Validation vocabulary shared by every Yaver client surface. A surface must
 * display the level actually executed; it must never present static inspection
 * as a compiler or test result.
 */
export type ValidationLevel = "static-preflight" | "lint" | "typecheck" | "compile" | "test" | "not-available";

export interface ValidationResult {
  level: ValidationLevel;
  executor: "this-device" | "selected-machine" | "cloud-runner" | "ci" | "none";
  executorId?: string;
  commandProfile?: string;
  ref?: string;
  commitSha?: string;
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
  passed?: boolean;
  summary: string;
  compiled: boolean;
  tested: boolean;
  issues?: Array<{ severity: "error" | "warning"; path?: string; message: string }>;
}

export const LOCAL_STATIC_PREFLIGHT: ValidationResult = {
  level: "static-preflight",
  executor: "this-device",
  summary: "Static inspection only; no compiler or tests were run.",
  compiled: false,
  tested: false,
};

export function unavailableValidation(surface: string): ValidationResult {
  return {
    level: "not-available",
    executor: "none",
    summary: `${surface} has no workspace compiler or test executor. Select a machine or CI to run them.`,
    compiled: false,
    tested: false,
  };
}
