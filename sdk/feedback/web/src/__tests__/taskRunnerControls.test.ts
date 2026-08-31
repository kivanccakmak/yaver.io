import { taskRunnerControlForMessage, taskRunnerControlSuggestions } from '../taskRunnerControls';

test('shows the deliberately small slash menu', () => {
  expect(taskRunnerControlSuggestions('/').map((item) => item.command)).toEqual(['/model', '/exit']);
  expect(taskRunnerControlSuggestions('/m').map((item) => item.command)).toEqual(['/model']);
  expect(taskRunnerControlSuggestions('/unknown')).toEqual([]);
});

test('intercepts only exact whole-message controls', () => {
  expect(taskRunnerControlForMessage(' /MODEL ')).toBe('model');
  expect(taskRunnerControlForMessage('/exit')).toBe('exit');
  expect(taskRunnerControlForMessage('explain /exit')).toBeNull();
});
