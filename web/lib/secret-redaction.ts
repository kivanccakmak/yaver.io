// Browser-agent last-mile secret protection. Provider keys and Git tokens must
// never appear in visible answers, diagnostics, or provider error messages.
const TOKEN_PATTERNS = [
  /\b(?:sk-ant-|sk-|ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_\-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*['"]?[^\s,'"}]+/gi,
];

export function redactSecrets(value: unknown, secrets: readonly string[] = []): string {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 4) text = text.split(trimmed).join("[REDACTED]");
  }
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match) => {
      const separator = match.search(/[:=]/);
      return separator >= 0 ? `${match.slice(0, separator + 1)}[REDACTED]` : "[REDACTED]";
    });
  }
  return text;
}
