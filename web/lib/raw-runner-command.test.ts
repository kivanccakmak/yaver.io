import assert from "node:assert/strict";
import { isRawRunnerCommand } from "./raw-runner-command";

const cases: Array<[string, string | null | undefined, boolean]> = [
  ["slash command", "/goal ship this", true],
  ["leading whitespace", "  /exit", true],
  ["plain text with slash later", "please run /goal", false],
  ["empty", "", false],
  ["undefined", undefined, false],
];

for (const [name, input, want] of cases) {
  assert.equal(isRawRunnerCommand(input), want, name);
  console.log(`ok ${name}`);
}
