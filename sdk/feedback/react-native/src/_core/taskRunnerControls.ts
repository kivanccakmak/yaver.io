// AUTO-SYNCED from shared/client-core/src/taskRunnerControls.ts.
// DO NOT EDIT IN PLACE. Edit the source and re-run
// scripts/sync-client-core.sh. CI checks drift via `--check`.

export type FirstClassTaskRunnerControl = 'model' | 'exit';

export interface TaskRunnerControlSuggestion {
  control: FirstClassTaskRunnerControl;
  command: '/model' | '/exit';
  label: string;
  description: string;
  destructive?: boolean;
}

export const FIRST_CLASS_TASK_RUNNER_CONTROLS: readonly TaskRunnerControlSuggestion[] = [
  {
    control: 'model',
    command: '/model',
    label: 'Change model',
    description: 'Choose the model for the next turn.',
  },
  {
    control: 'exit',
    command: '/exit',
    label: 'Exit session',
    description: 'Stop the runner after confirmation.',
    destructive: true,
  },
] as const;

/**
 * Return the deliberately small slash menu for a task composer.
 *
 * `/model` and `/exit` are the only first-class task controls today. A value
 * containing whitespace is prose (for example, "explain /exit") and must not
 * open or suggest a control.
 */
export function taskRunnerControlSuggestions(input: string): readonly TaskRunnerControlSuggestion[] {
  const query = String(input ?? '').trimStart().toLowerCase();
  if (!query.startsWith('/') || /\s/.test(query)) return [];
  return FIRST_CLASS_TASK_RUNNER_CONTROLS.filter((item) => item.command.startsWith(query));
}

/** Exact whole-message interception. Mentions remain ordinary runner input. */
export function taskRunnerControlForMessage(input: string): FirstClassTaskRunnerControl | null {
  const command = String(input ?? '').trim().toLowerCase();
  const match = FIRST_CLASS_TASK_RUNNER_CONTROLS.find((item) => item.command === command);
  return match?.control ?? null;
}
