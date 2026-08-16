/* eslint-disable no-undef */

const $ = (id) => document.getElementById(id);

function bg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function load() {
  const s = await bg({ type: 'yaver:get-settings' });
  $('agent-url').value = s.agentUrl || '';
  $('auth-token').value = s.authToken || '';
  $('auto-send').checked = s.autoSend !== false;
  pingAgent();
}

async function save() {
  await bg({
    type: 'yaver:set-settings',
    settings: {
      agentUrl: $('agent-url').value.trim(),
      authToken: $('auth-token').value.trim(),
      autoSend: $('auto-send').checked,
      kind: 'design-reference',
    },
  });
  pingAgent();
}

async function pingAgent() {
  const dot = $('status-dot');
  dot.className = 'dot';
  const r = await bg({ type: 'yaver:ping-agent' });
  dot.className = `dot ${r.ok ? 'ok' : 'bad'}`;
  dot.title = r.ok ? `Connected to ${r.agentUrl}` : `Unreachable: ${r.agentUrl} (${r.error || r.status})`;
  loadRecent(r.ok);
  refreshReloadTools();
}

// ─── Reload actions ────────────────────────────────────────────────────────
//
// Rendered from the shared YaverReloadActions seam rather than hard-coded, so
// the rules it encodes hold here by construction:
//   • an agent URL this extension cannot reach (anything but localhost /
//     127.0.0.1 — see manifest host_permissions) renders NO reload UI;
//   • a blocked action renders DISABLED with the reason beneath it, not
//     hidden, because hidden teaches the user nothing;
//   • Flutter's second action is a Hot RESTART, everyone else's a Full Reload.
let devSnapshot = null;

async function refreshReloadTools() {
  const tools = $('reload-tools');
  const hint = $('reload-hint');
  const agentUrl = $('agent-url').value.trim();

  if (!YaverReloadActions.isDevAgentUrl(agentUrl)) {
    tools.innerHTML = '';
    hint.textContent = '';
    return;
  }

  const status = await bg({ type: 'yaver:dev-status' });
  devSnapshot = status && status.ok ? status.snapshot : null;

  const actions = YaverReloadActions.reloadActions(devSnapshot, {
    isDevBuild: true, // already established by isDevAgentUrl above
    connected: devSnapshot !== null,
    machineLabel: agentUrl,
  });

  tools.innerHTML = '';
  if (!actions.length) {
    hint.textContent = '';
    return;
  }

  actions.forEach((action) => {
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = action.label;
    if (!action.enabled) button.style.opacity = '0.55';
    button.addEventListener('click', () => {
      if (!action.enabled) {
        // A control that also SAYS why when pressed beats a tooltip nobody
        // hovers. Doing nothing in silence is the defect.
        hint.textContent = action.disabledReason;
        return;
      }
      runReloadAction(action, button);
    });
    tools.appendChild(button);
  });

  hint.textContent = actions[0].enabled ? actions[0].hint : actions[0].disabledReason;
}

async function runReloadAction(action, button) {
  const hint = $('reload-hint');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = `${action.label}…`;
  hint.textContent = `${action.label}…`;

  const result = await bg({
    type: 'yaver:dev-reload',
    mode: action.mode,
    snapshot: devSnapshot,
  });

  // The background already produced a NAMED cause via describeReloadFailure.
  // Show it verbatim rather than replacing it with "Reload failed".
  hint.textContent = result.ok
    ? result.message
    : result.error || `${action.label} did not start, and the agent gave no reason.`;
  button.disabled = false;
  button.textContent = original;
  refreshReloadTools();
}

async function loadRecent(agentOk) {
  const container = $('recent');
  if (!agentOk) {
    container.innerHTML = '<div class="recent-empty">Agent unreachable.</div>';
    return;
  }
  const r = await bg({ type: 'yaver:list-references' });
  if (!r.ok || !Array.isArray(r.items) || r.items.length === 0) {
    container.innerHTML = '<div class="recent-empty">No captures yet.</div>';
    return;
  }
  container.innerHTML = '';
  for (const item of r.items.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'recent-item';
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = item.title || item.url || item.id;
    url.title = item.url || item.id;
    const mode = document.createElement('span');
    mode.className = 'mode';
    mode.textContent = item.mode || '—';
    row.appendChild(url);
    row.appendChild(mode);
    container.appendChild(row);
  }
}

async function sendToContent(type) {
  const tab = await activeTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type });
  window.close();
}

$('capture-element').addEventListener('click', () => sendToContent('yaver:start-element-pick'));
$('capture-page').addEventListener('click', () => sendToContent('yaver:capture-page-now'));
$('capture-fullpage').addEventListener('click', () => sendToContent('yaver:capture-fullpage-now'));
$('save').addEventListener('click', save);

// Show platform-correct shortcut hints.
if (!navigator.platform.toLowerCase().includes('mac')) {
  $('kbd-elem').textContent = 'Ctrl+Shift+Y';
  $('kbd-page').textContent = 'Ctrl+Shift+P';
}

load();
