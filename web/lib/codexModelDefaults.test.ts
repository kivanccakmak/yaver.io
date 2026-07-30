import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd());

function assert(condition: unknown, message: string) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${message}`);
  }
}

const devicesView = readFileSync(join(root, "components/dashboard/DevicesView.tsx"), "utf8");
const runtimeLab = readFileSync(join(root, "components/dashboard/RuntimeLabView.tsx"), "utf8");

assert(/codex:\s*"gpt-5\.4"/.test(devicesView), "DevicesView codex default is gpt-5.4");
assert(!/gpt-5\.3-codex/.test(devicesView), "DevicesView does not offer stale gpt-5.3-codex");
assert(!/gpt-5\.3-codex/.test(runtimeLab), "RuntimeLab fallback catalogue does not offer stale gpt-5.3-codex");
