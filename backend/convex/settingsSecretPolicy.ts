export const RAW_SETTINGS_SECRET_FIELDS = [
  "speechApiKey",
  "openAiApiKey",
  "glmApiKey",
  "anthropicApiKey",
  "deepseekApiKey",
  "githubToken",
  "gitlabToken",
  "bitbucketToken",
] as const;

/** Settings is a preference/metadata API, never a credential transport. */
export function rawSecretFieldsInSettings(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return RAW_SETTINGS_SECRET_FIELDS.filter((field) => {
    const candidate = record[field];
    return typeof candidate === "string" && candidate.trim().length > 0;
  });
}

export function settingsWithoutSecrets<T extends Record<string, unknown>>(settings: T): T {
  const safe = { ...settings };
  for (const field of RAW_SETTINGS_SECRET_FIELDS) delete safe[field];
  return safe;
}
