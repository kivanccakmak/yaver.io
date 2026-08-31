import assert from 'node:assert/strict';
import test from 'node:test';

import { taskRunnerControlForMessage, taskRunnerControlSuggestions } from './taskRunnerControls';

test('slash prefix suggests only the two first-class task controls', () => {
  assert.deepEqual(taskRunnerControlSuggestions('/').map((item) => item.command), ['/model', '/exit']);
  assert.deepEqual(taskRunnerControlSuggestions('/m').map((item) => item.command), ['/model']);
  assert.deepEqual(taskRunnerControlSuggestions('/e').map((item) => item.command), ['/exit']);
  assert.deepEqual(taskRunnerControlSuggestions('/unknown'), []);
});

test('only exact whole messages become controls', () => {
  assert.equal(taskRunnerControlForMessage('  /MODEL\n'), 'model');
  assert.equal(taskRunnerControlForMessage('/exit'), 'exit');
  assert.equal(taskRunnerControlForMessage('explain /exit'), null);
  assert.equal(taskRunnerControlForMessage('/model after this turn'), null);
});
