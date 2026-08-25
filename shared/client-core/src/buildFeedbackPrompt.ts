export interface FeedbackPromptInput {
  userPrompt: string;
  projectName?: string;
  projectPath?: string;
  hasScreenshot?: boolean;
}

/** Shared, deterministic feedback-task prompt used by every client surface. */
export function buildFeedbackPrompt(input: FeedbackPromptInput): string {
  const request = String(input.userPrompt || '').trim();
  const context: string[] = [];
  if (input.projectName?.trim()) context.push(`Project: ${input.projectName.trim()}`);
  if (input.projectPath?.trim()) context.push(`Working directory: ${input.projectPath.trim()}`);
  if (input.hasScreenshot) context.push('A screenshot is attached; use it as visual evidence.');
  return [
    'Investigate and implement this feedback request in the named project.',
    ...context,
    '',
    request || 'Inspect the attached evidence and fix the visible issue.',
  ].join('\n');
}
