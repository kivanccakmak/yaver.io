#!/usr/bin/env bash
set -euo pipefail

# External-consumer proof for `yaver integrate`.
#
# This deliberately runs outside the repository with a fresh HOME and a stock
# create-expo-app project. It catches the class of false green where unit tests
# see package/config inventory but a new user's app cannot typecheck or bundle.
# No account, Yaver MCP config, repository instructions, deploy, or publish is
# used. Set YAVER_INTEGRATION_KEEP_TEMP=1 to retain the fixture for inspection.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d /tmp/yaver-sdk-integrate-cleanroom.XXXXXX)"
yaver_bin="${YAVER_INTEGRATION_BIN:-$fixture_root/yaver}"

cleanup() {
  if [[ "${YAVER_INTEGRATION_KEEP_TEMP:-0}" == "1" ]]; then
    printf 'Clean-room fixture retained at %s\n' "$fixture_root"
    return
  fi
  case "$fixture_root" in
    /tmp/yaver-sdk-integrate-cleanroom.*)
      ls -la "$fixture_root" >/dev/null
      rm -r -- "$fixture_root"
      ;;
    *)
      printf 'Refusing to clean unexpected fixture path: %s\n' "$fixture_root" >&2
      ;;
  esac
}
trap cleanup EXIT

if [[ ! -x "$yaver_bin" ]]; then
  printf 'Building local Yaver binary...\n'
  (cd "$repo_root/desktop/agent" && GOMAXPROCS=2 go build -p 2 -o "$yaver_bin" .)
fi

printf 'Creating stock Expo app with isolated npm cache...\n'
HOME="$fixture_root/home" \
  npm_config_cache="$fixture_root/npm-cache" \
  npx --yes create-expo-app@latest "$fixture_root/app" --template blank-typescript --yes

printf 'Running full integration proof...\n'
first_json="$("$yaver_bin" integrate \
  --dir "$fixture_root/app" \
  --framework expo \
  --verify web \
  --json)"

INTEGRATION_JSON="$first_json" node - <<'NODE'
const result = JSON.parse(process.env.INTEGRATION_JSON);
const required = ['expo-config', 'typescript', 'expo-web-export'];
if (!result.ok) throw new Error(result.error || 'integration did not report ok');
for (const check of required) {
  if (!result.verification?.includes(check)) throw new Error(`missing verification: ${check}`);
}
for (const file of ['app.json', 'App.tsx', 'yaver/YaverFeedbackRoot.tsx']) {
  if (!result.changed_files?.includes(file)) throw new Error(`first run did not change ${file}`);
}
NODE

printf 'Proving idempotent rerun...\n'
second_json="$("$yaver_bin" integrate \
  --dir "$fixture_root/app" \
  --framework expo \
  --no-install \
  --verify web \
  --json)"

INTEGRATION_JSON="$second_json" node - <<'NODE'
const result = JSON.parse(process.env.INTEGRATION_JSON);
if (!result.ok) throw new Error(result.error || 'idempotent integration did not report ok');
if ((result.changed_files || []).length !== 0) {
  throw new Error(`idempotent run changed files: ${result.changed_files.join(', ')}`);
}
NODE

printf 'Proving isolated stdio MCP discovery and execution...\n'
YAVER_CLEANROOM_BIN="$yaver_bin" YAVER_CLEANROOM_APP="$fixture_root/app" \
  HOME="$fixture_root/fresh-home" node - <<'NODE'
const { spawnSync } = require('node:child_process');
const requests = [
  {jsonrpc:'2.0', id:1, method:'initialize', params:{clientInfo:{name:'clean-room',version:'1'}}},
  {jsonrpc:'2.0', id:2, method:'tools/list', params:{}},
  {jsonrpc:'2.0', id:3, method:'tools/call', params:{
    name:'yaver_sdk_integrate',
    arguments:{directory:process.env.YAVER_CLEANROOM_APP,framework:'expo',verify:'none',skip_install:true},
  }},
];
const proc = spawnSync(process.env.YAVER_CLEANROOM_BIN, ['mcp'], {
  input: requests.map(JSON.stringify).join('\n') + '\n',
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  env: process.env,
});
if (proc.status !== 0) throw new Error(`MCP exited ${proc.status}: ${proc.stderr}`);
const rows = proc.stdout.trim().split('\n').map(JSON.parse);
const init = rows.find(row => row.id === 1)?.result;
const tools = rows.find(row => row.id === 2)?.result?.tools || [];
const call = JSON.parse(rows.find(row => row.id === 3)?.result?.content?.[0]?.text || '{}');
if (!init?.instructions?.includes('yaver_sdk_integrate')) throw new Error('stdio initialize omitted SDK integration instructions');
if (!init?.instructions?.includes('yaver_openrouter_integrate')) throw new Error('stdio initialize omitted OpenRouter integration instructions');
if (!tools.some(tool => tool.name === 'yaver_sdk_integrate')) throw new Error('tools/list omitted yaver_sdk_integrate');
if (!tools.some(tool => tool.name === 'yaver_openrouter_integrate')) throw new Error('tools/list omitted yaver_openrouter_integrate');
if (!call.ok || (call.changed_files || []).length !== 0) throw new Error('isolated MCP integration was not idempotently successful');
NODE

printf 'PASS: fresh Expo app installs, wires, typechecks, bundles, reruns idempotently, and works through isolated stdio MCP.\n'
