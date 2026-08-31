export type FirstClassTaskRunnerControl = 'model' | 'exit';

export const FIRST_CLASS_TASK_RUNNER_CONTROLS = [
  { control: 'model' as const, command: '/model' as const, label: 'Change model', description: 'Choose the model for the next turn.', destructive: false },
  { control: 'exit' as const, command: '/exit' as const, label: 'Exit session', description: 'Stop the runner after confirmation.', destructive: true },
] as const;

export function taskRunnerControlSuggestions(input: string) {
  const query = String(input ?? '').trimStart().toLowerCase();
  if (!query.startsWith('/') || /\s/.test(query)) return [];
  return FIRST_CLASS_TASK_RUNNER_CONTROLS.filter((item) => item.command.startsWith(query));
}

export function taskRunnerControlForMessage(input: string): FirstClassTaskRunnerControl | null {
  const command = String(input ?? '').trim().toLowerCase();
  return FIRST_CLASS_TASK_RUNNER_CONTROLS.find((item) => item.command === command)?.control ?? null;
}
