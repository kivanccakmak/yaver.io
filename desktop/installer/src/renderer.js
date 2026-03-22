// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentTaskId = null;
let currentExecId = null;
let taskPollInterval = null;
let dashPollInterval = null;
let execPollInterval = null;
let pendingImages = []; // for create-task modal
let cachedConfig = {};

// ---------------------------------------------------------------------------
// View management (auth flow views)
// ---------------------------------------------------------------------------

function showView(id) {
  document.querySelectorAll('#auth-flow .view').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) target.classList.add('active');
}

function showMainApp() {
  document.getElementById('auth-flow').style.display = 'none';
  document.getElementById('main-app').style.display = 'flex';
  startDashboardPolling();
}

function hideMainApp() {
  document.getElementById('auth-flow').style.display = 'flex';
  document.getElementById('main-app').style.display = 'none';
  stopAllPolling();
}

// ---------------------------------------------------------------------------
// Panel switching (sidebar navigation)
// ---------------------------------------------------------------------------

function switchPanel(navEl) {
  const panelId = navEl.getAttribute('data-panel');
  // Update nav
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
  navEl.classList.add('active');
  // Update panels
  document.querySelectorAll('.panel').forEach((el) => el.classList.remove('active'));
  const panel = document.getElementById(panelId);
  if (panel) panel.classList.add('active');

  // Start/stop relevant polling
  if (panelId === 'panel-dashboard') {
    startDashboardPolling();
  }
  if (panelId === 'panel-tasks') {
    refreshTaskList();
  }
}

// ---------------------------------------------------------------------------
// App initialization
// ---------------------------------------------------------------------------

async function init() {
  showView('view-loading');

  const state = await window.yaver.getAppState();

  if (!state.hasToken) {
    showView('view-signin');
    return;
  }

  if (!state.tokenValid) {
    showView('view-reauth');
    return;
  }

  if (!state.agentInstalled) {
    showView('view-setup-prereqs');
    runPrerequisites();
    return;
  }

  // Load settings
  const settings = await window.yaver.getSettings();
  if (settings.agentBaseUrl) {
    document.getElementById('setting-agent-url').value = settings.agentBaseUrl;
  }

  // Show main app
  showMainApp();
  loadConfig();
  loadSettingsUI();
  updateDashboard();
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function updateDashboard() {
  const state = await window.yaver.getAppState();
  const agentVal = document.getElementById('dash-agent-val');

  // Try to get agent info from the HTTP API
  const info = await window.yaver.getAgentInfo();
  const status = await window.yaver.getAgentStatus();
  const taskListResp = await window.yaver.listTasks();

  if (info && info.ok) {
    agentVal.innerHTML = '<span class="status-dot green"></span><span class="text-green">Running</span>';
    document.getElementById('dash-connection-val').innerHTML = '<span class="text-green">Connected</span>';
    document.getElementById('dash-hostname').textContent = info.hostname || '--';
    document.getElementById('dash-version').textContent = info.version || '--';
    document.getElementById('dash-workdir').textContent = info.workDir || '--';
    document.getElementById('dash-platform').textContent = `${friendlyPlatform(state.platform)} (${state.arch})`;
  } else if (state.agentRunning) {
    agentVal.innerHTML = '<span class="status-dot yellow"></span><span class="text-yellow">Starting...</span>';
    document.getElementById('dash-connection-val').innerHTML = '<span class="text-yellow">Connecting...</span>';
    document.getElementById('dash-platform').textContent = `${friendlyPlatform(state.platform)} (${state.arch})`;
  } else {
    agentVal.innerHTML = '<span class="status-dot red"></span><span class="text-red">Stopped</span>';
    document.getElementById('dash-connection-val').innerHTML = '<span class="text-red">Disconnected</span>';
    document.getElementById('dash-platform').textContent = `${friendlyPlatform(state.platform)} (${state.arch})`;
  }

  // Runner info
  if (status && status.ok && status.status) {
    const s = status.status;
    document.getElementById('dash-runner-val').textContent = s.runner || '--';
  }

  // Active tasks count
  if (taskListResp && taskListResp.ok && taskListResp.tasks) {
    const active = taskListResp.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
    document.getElementById('dash-tasks-val').textContent = `${active} / ${taskListResp.tasks.length}`;
  }
}

function startDashboardPolling() {
  if (dashPollInterval) clearInterval(dashPollInterval);
  dashPollInterval = setInterval(() => {
    const activePanel = document.querySelector('.panel.active');
    if (activePanel && activePanel.id === 'panel-dashboard') {
      updateDashboard();
    }
  }, 10000);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async function refreshTaskList() {
  const resp = await window.yaver.listTasks();
  const container = document.getElementById('task-list-items');
  const emptyEl = document.getElementById('task-list-empty');

  if (!resp || !resp.ok || !resp.tasks || resp.tasks.length === 0) {
    container.innerHTML = '';
    container.appendChild(createEmptyState('&#9998;', 'No tasks yet'));
    return;
  }

  // Sort tasks: running first, then by creation time (newest first)
  const tasks = resp.tasks.sort((a, b) => {
    const statusOrder = { running: 0, queued: 1, completed: 2, stopped: 3, failed: 4 };
    const sa = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 5;
    const sb = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 5;
    if (sa !== sb) return sa - sb;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  container.innerHTML = '';
  tasks.forEach((task) => {
    const div = document.createElement('div');
    div.className = 'task-item' + (task.id === currentTaskId ? ' active' : '');
    div.onclick = () => selectTask(task.id);
    div.innerHTML = `
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="task-meta">
        <span class="task-status-badge ${task.status}">${task.status}</span>
        <span>${task.runnerId || ''}</span>
        <span>${formatTime(task.createdAt)}</span>
      </div>
    `;
    container.appendChild(div);
  });
}

async function selectTask(taskId) {
  currentTaskId = taskId;

  // Highlight in list
  document.querySelectorAll('.task-item').forEach((el) => el.classList.remove('active'));
  const items = document.querySelectorAll('.task-item');
  items.forEach((el) => {
    if (el.onclick && el.querySelector('.task-title')) {
      // re-add active class based on click handler
    }
  });

  // Fetch task detail
  const resp = await window.yaver.getTask(taskId);
  if (!resp || !resp.ok || !resp.task) {
    document.getElementById('task-detail-content').innerHTML = '<div class="empty-state" style="height:100%"><div>Task not found</div></div>';
    return;
  }

  const task = resp.task;
  renderTaskDetail(task);
  startTaskPolling(taskId);
  refreshTaskList(); // update active highlight
}

function renderTaskDetail(task) {
  const container = document.getElementById('task-detail-content');
  const isActive = task.status === 'running' || task.status === 'queued';

  container.innerHTML = `
    <div class="task-detail-header">
      <div style="display:flex; align-items:center; justify-content:space-between">
        <h3 style="flex:1; margin-right:12px">${escapeHtml(task.title)}</h3>
        <div class="btn-row">
          ${isActive ? '<button class="btn btn-danger btn-sm" onclick="stopCurrentTask()">Stop</button>' : ''}
          <button class="btn btn-outline btn-sm" onclick="deleteCurrentTask()">Delete</button>
        </div>
      </div>
      <div style="margin-top:6px; display:flex; gap:12px; font-size:12px; color:var(--text-dim)">
        <span class="task-status-badge ${task.status}">${task.status}</span>
        ${task.runnerId ? `<span>Runner: ${task.runnerId}</span>` : ''}
        ${task.costUSD ? `<span>Cost: $${task.costUSD.toFixed(4)}</span>` : ''}
        ${task.turns ? `<span>Turns: ${task.turns}</span>` : ''}
        <span>${formatTime(task.createdAt)}</span>
      </div>
    </div>
    <div class="task-output-area" id="task-output-area">${renderMarkdown(task.output || task.resultText || 'No output yet...')}</div>
    ${task.status === 'completed' || task.status === 'stopped' ? `
    <div class="task-continue-bar">
      <input type="text" id="task-continue-input" placeholder="Continue with follow-up..." onkeydown="if(event.key==='Enter')continueCurrentTask()">
      <button class="btn btn-primary btn-sm" onclick="continueCurrentTask()">Send</button>
    </div>` : ''}
  `;
}

function startTaskPolling(taskId) {
  if (taskPollInterval) clearInterval(taskPollInterval);
  taskPollInterval = setInterval(async () => {
    if (currentTaskId !== taskId) return;
    const resp = await window.yaver.getTask(taskId);
    if (resp && resp.ok && resp.task) {
      renderTaskDetail(resp.task);
      // Auto-scroll output
      const outputArea = document.getElementById('task-output-area');
      if (outputArea) outputArea.scrollTop = outputArea.scrollHeight;

      // Stop polling if task is done
      if (resp.task.status !== 'running' && resp.task.status !== 'queued') {
        clearInterval(taskPollInterval);
        taskPollInterval = null;
        refreshTaskList();
      }
    }
  }, 2000);
}

async function stopCurrentTask() {
  if (!currentTaskId) return;
  await window.yaver.stopTask(currentTaskId);
  setTimeout(() => selectTask(currentTaskId), 500);
}

async function deleteCurrentTask() {
  if (!currentTaskId) return;
  await window.yaver.deleteTask(currentTaskId);
  currentTaskId = null;
  if (taskPollInterval) { clearInterval(taskPollInterval); taskPollInterval = null; }
  document.getElementById('task-detail-content').innerHTML = '<div class="empty-state" style="height:100%"><div class="empty-icon">&#8592;</div><div>Select a task to view details</div></div>';
  refreshTaskList();
}

async function continueCurrentTask() {
  if (!currentTaskId) return;
  const input = document.getElementById('task-continue-input');
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();
  input.value = '';
  await window.yaver.continueTask(currentTaskId, { input: text });
  startTaskPolling(currentTaskId);
  setTimeout(() => selectTask(currentTaskId), 500);
}

// ---- Create Task Modal ----

function showCreateTaskModal() {
  document.getElementById('create-task-modal').classList.add('active');
  pendingImages = [];
  document.getElementById('new-task-images').innerHTML = '';
  document.getElementById('new-task-title').value = '';
  document.getElementById('new-task-description').value = '';
  document.getElementById('new-task-model').value = '';
  document.getElementById('new-task-runner').value = '';
  document.getElementById('new-task-title').focus();
}

function hideCreateTaskModal() {
  document.getElementById('create-task-modal').classList.remove('active');
  pendingImages = [];
}

async function attachImage() {
  const file = await window.yaver.pickFile();
  if (!file) return;
  pendingImages.push({ base64: file.base64, mimeType: file.mimeType });

  const container = document.getElementById('new-task-images');
  const idx = pendingImages.length - 1;
  const thumb = document.createElement('div');
  thumb.className = 'image-thumb';
  thumb.innerHTML = `
    <img src="data:${file.mimeType};base64,${file.base64.substring(0, 100)}..." alt="">
    <button class="remove-img" onclick="removeImage(${idx}, this)">x</button>
  `;
  // Set proper src
  thumb.querySelector('img').src = `data:${file.mimeType};base64,${file.base64}`;
  container.appendChild(thumb);
}

function removeImage(idx, btn) {
  pendingImages[idx] = null;
  btn.parentElement.remove();
}

async function createNewTask() {
  const title = document.getElementById('new-task-title').value.trim();
  if (!title) return;

  const data = {
    title,
    description: document.getElementById('new-task-description').value.trim(),
    model: document.getElementById('new-task-model').value.trim(),
    runner: document.getElementById('new-task-runner').value,
    images: pendingImages.filter(Boolean),
  };

  hideCreateTaskModal();

  const resp = await window.yaver.createTask(data);
  if (resp && resp.ok && resp.taskId) {
    await refreshTaskList();
    selectTask(resp.taskId);
  }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

async function runTerminalCommand() {
  const input = document.getElementById('terminal-command-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';

  const output = document.getElementById('terminal-output');
  appendTerminalLine('system', `$ ${cmd}`);

  const workDir = document.getElementById('terminal-workdir').textContent;

  const resp = await window.yaver.startExec({
    command: cmd,
    workDir: workDir === '~/' ? '' : workDir,
  });

  if (!resp || !resp.ok) {
    appendTerminalLine('stderr', `Error: ${resp?.error || 'Failed to start command'}`);
    return;
  }

  currentExecId = resp.execId;
  document.getElementById('terminal-exec-status').textContent = `PID ${resp.pid} - running`;
  startExecPolling(resp.execId);
}

function handleTerminalKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    runTerminalCommand();
  }
}

function startExecPolling(execId) {
  let lastStdoutLen = 0;
  let lastStderrLen = 0;

  if (execPollInterval) clearInterval(execPollInterval);
  execPollInterval = setInterval(async () => {
    if (currentExecId !== execId) return;

    const resp = await window.yaver.getExec(execId);
    if (!resp || !resp.ok || !resp.exec) return;

    const exec = resp.exec;

    // Print new stdout
    if (exec.stdout && exec.stdout.length > lastStdoutLen) {
      appendTerminalLine('stdout', exec.stdout.substring(lastStdoutLen));
      lastStdoutLen = exec.stdout.length;
    }

    // Print new stderr
    if (exec.stderr && exec.stderr.length > lastStderrLen) {
      appendTerminalLine('stderr', exec.stderr.substring(lastStderrLen));
      lastStderrLen = exec.stderr.length;
    }

    const statusEl = document.getElementById('terminal-exec-status');
    if (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'killed') {
      const exitCode = exec.exitCode !== undefined && exec.exitCode !== null ? exec.exitCode : '?';
      appendTerminalLine('system', `Process exited with code ${exitCode}`);
      statusEl.textContent = `Exited (${exitCode})`;
      clearInterval(execPollInterval);
      execPollInterval = null;
      currentExecId = null;
    } else {
      statusEl.textContent = `PID ${exec.pid || '?'} - ${exec.status}`;
    }
  }, 500);
}

function appendTerminalLine(type, text) {
  const output = document.getElementById('terminal-output');
  const span = document.createElement('span');
  span.className = type;
  span.textContent = text;
  if (!text.endsWith('\n')) span.textContent += '\n';
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

async function signalExec(signal) {
  if (!currentExecId) return;
  await window.yaver.signalExec(currentExecId, signal);
}

async function killCurrentExec() {
  if (!currentExecId) return;
  await window.yaver.killExec(currentExecId);
  appendTerminalLine('system', 'Process killed');
  document.getElementById('terminal-exec-status').textContent = 'Killed';
  currentExecId = null;
  if (execPollInterval) { clearInterval(execPollInterval); execPollInterval = null; }
}

function clearTerminal() {
  const output = document.getElementById('terminal-output');
  output.innerHTML = '<span class="system">Terminal cleared.\n</span>';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadConfig() {
  cachedConfig = await window.yaver.getConfig();
  renderRelayList();
  renderTunnelList();
}

async function loadSettingsUI() {
  const settings = await window.yaver.getSettings();
  document.getElementById('setting-agent-url').value = settings.agentBaseUrl || 'http://localhost:18080';
  document.getElementById('setting-speech-provider').value = settings.speechProvider || 'whisper';
  document.getElementById('setting-speech-api-key').value = settings.speechApiKey || '';

  const autoToggle = document.getElementById('toggle-autostart');
  if (settings.autoStart) autoToggle.classList.add('on');
  else autoToggle.classList.remove('on');

  // Load runner list from agent
  const runners = await window.yaver.getRunners();
  if (runners && runners.ok && runners.runners) {
    const select = document.getElementById('setting-runner');
    select.innerHTML = '';
    runners.runners.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.name}${r.installed ? '' : ' (not installed)'}`;
      if (r.isDefault) opt.selected = true;
      select.appendChild(opt);
    });

    // Also update the create-task runner dropdown
    const taskRunnerSelect = document.getElementById('new-task-runner');
    taskRunnerSelect.innerHTML = '<option value="">Default</option>';
    runners.runners.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      taskRunnerSelect.appendChild(opt);
    });
  }
}

async function saveAllSettings() {
  // Save desktop settings
  const settings = {
    agentBaseUrl: document.getElementById('setting-agent-url').value.trim() || 'http://localhost:18080',
    speechProvider: document.getElementById('setting-speech-provider').value,
    speechApiKey: document.getElementById('setting-speech-api-key').value,
    autoStart: document.getElementById('toggle-autostart').classList.contains('on'),
  };
  await window.yaver.saveSettings(settings);

  // Save config with relay/tunnel changes
  await window.yaver.saveConfig(cachedConfig);

  // Switch runner if changed
  const runnerSel = document.getElementById('setting-runner');
  if (runnerSel.value) {
    await window.yaver.switchRunner(runnerSel.value);
  }

  showToast('Settings saved');
}

// ---- Relay servers ----

function renderRelayList() {
  const container = document.getElementById('relay-list');
  const relays = cachedConfig.relay_servers || [];
  if (relays.length === 0) {
    container.innerHTML = '<p class="text-dim" style="font-size:12px">No relay servers configured.</p>';
    return;
  }
  container.innerHTML = '';
  relays.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'relay-item';
    div.innerHTML = `
      <div>
        <div class="relay-info">${escapeHtml(r.label || r.quic_addr)}</div>
        <div class="relay-meta">${escapeHtml(r.quic_addr)}${r.region ? ' - ' + r.region : ''}</div>
      </div>
      <button class="btn-icon" onclick="removeRelay(${i})" title="Remove">&#10005;</button>
    `;
    container.appendChild(div);
  });
}

function showAddRelayForm() { document.getElementById('relay-add-form').style.display = 'block'; }
function hideAddRelayForm() { document.getElementById('relay-add-form').style.display = 'none'; }

function addRelay() {
  const quicAddr = document.getElementById('relay-quic-addr').value.trim();
  if (!quicAddr) return;

  if (!cachedConfig.relay_servers) cachedConfig.relay_servers = [];
  cachedConfig.relay_servers.push({
    id: generateId(),
    quic_addr: quicAddr,
    http_url: document.getElementById('relay-http-url').value.trim(),
    password: document.getElementById('relay-password').value,
    label: document.getElementById('relay-label').value.trim(),
    priority: cachedConfig.relay_servers.length,
  });

  // Clear form
  document.getElementById('relay-quic-addr').value = '';
  document.getElementById('relay-http-url').value = '';
  document.getElementById('relay-password').value = '';
  document.getElementById('relay-label').value = '';
  hideAddRelayForm();
  renderRelayList();
}

function removeRelay(idx) {
  if (!cachedConfig.relay_servers) return;
  cachedConfig.relay_servers.splice(idx, 1);
  renderRelayList();
}

// ---- Cloudflare tunnels ----

function renderTunnelList() {
  const container = document.getElementById('tunnel-list');
  const tunnels = cachedConfig.cloudflare_tunnels || [];
  if (tunnels.length === 0) {
    container.innerHTML = '<p class="text-dim" style="font-size:12px">No tunnels configured.</p>';
    return;
  }
  container.innerHTML = '';
  tunnels.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'tunnel-item';
    div.innerHTML = `
      <div>
        <div class="tunnel-info">${escapeHtml(t.label || t.url)}</div>
        <div class="tunnel-meta">${escapeHtml(t.url)}</div>
      </div>
      <button class="btn-icon" onclick="removeTunnel(${i})" title="Remove">&#10005;</button>
    `;
    container.appendChild(div);
  });
}

function showAddTunnelForm() { document.getElementById('tunnel-add-form').style.display = 'block'; }
function hideAddTunnelForm() { document.getElementById('tunnel-add-form').style.display = 'none'; }

function addTunnel() {
  const url = document.getElementById('tunnel-url').value.trim();
  if (!url) return;

  if (!cachedConfig.cloudflare_tunnels) cachedConfig.cloudflare_tunnels = [];
  cachedConfig.cloudflare_tunnels.push({
    id: generateId(),
    url,
    cf_access_client_id: document.getElementById('tunnel-client-id').value.trim(),
    cf_access_client_secret: document.getElementById('tunnel-client-secret').value,
    label: document.getElementById('tunnel-label').value.trim(),
    priority: cachedConfig.cloudflare_tunnels.length,
  });

  document.getElementById('tunnel-url').value = '';
  document.getElementById('tunnel-client-id').value = '';
  document.getElementById('tunnel-client-secret').value = '';
  document.getElementById('tunnel-label').value = '';
  hideAddTunnelForm();
  renderTunnelList();
}

function removeTunnel(idx) {
  if (!cachedConfig.cloudflare_tunnels) return;
  cachedConfig.cloudflare_tunnels.splice(idx, 1);
  renderTunnelList();
}

// ---- Toggle switch ----

function toggleSwitch(el) {
  el.classList.toggle('on');
}

// ---- Clean ----

async function cleanAgent(days) {
  const resp = await window.yaver.agentClean(days || 0);
  if (resp && resp.ok && resp.result) {
    const r = resp.result;
    showToast(`Cleaned: ${r.tasksRemoved || 0} tasks, ${r.imagesRemoved || 0} images`);
  } else {
    showToast('Clean failed: ' + (resp?.error || 'unknown error'));
  }
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

async function signInGoogle() {
  disableAuthButtons();
  clearSigninError();
  const result = await window.yaver.authenticate();
  if (result.success) {
    const state = await window.yaver.getAppState();
    if (!state.agentInstalled) {
      showView('view-setup-prereqs');
      runPrerequisites();
    } else {
      showMainApp();
      updateDashboard();
    }
  } else {
    enableAuthButtons();
    showSigninError(result.error || 'Authentication failed. Please try again.');
  }
}

async function signInMicrosoft() {
  disableAuthButtons();
  clearSigninError();
  const result = await window.yaver.authenticateMicrosoft();
  if (result.success) {
    const state = await window.yaver.getAppState();
    if (!state.agentInstalled) {
      showView('view-setup-prereqs');
      runPrerequisites();
    } else {
      showMainApp();
      updateDashboard();
    }
  } else {
    enableAuthButtons();
    showSigninError(result.error || 'Authentication failed. Please try again.');
  }
}

async function signInApple() {
  disableAuthButtons();
  clearSigninError();
  const result = await window.yaver.authenticateApple();
  if (result.success) {
    const state = await window.yaver.getAppState();
    if (!state.agentInstalled) {
      showView('view-setup-prereqs');
      runPrerequisites();
    } else {
      showMainApp();
      updateDashboard();
    }
  } else {
    enableAuthButtons();
    showSigninError(result.error || 'Authentication failed. Please try again.');
  }
}

function disableAuthButtons() {
  document.querySelectorAll('.btn-apple, .btn-google, .btn-microsoft').forEach((b) => (b.disabled = true));
}

function enableAuthButtons() {
  document.querySelectorAll('.btn-apple, .btn-google, .btn-microsoft').forEach((b) => (b.disabled = false));
}

function showSigninError(msg) {
  const el = document.getElementById('signin-error');
  if (el) {
    el.innerHTML = `<div class="banner banner-error"><span class="icon">&#10007;</span><span>${escapeHtml(msg)}</span></div>`;
  }
}

function clearSigninError() {
  const el = document.getElementById('signin-error');
  if (el) el.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

async function doSignOut() {
  await window.yaver.signOut();
  hideMainApp();
  showView('view-signin');
}

// ---------------------------------------------------------------------------
// Restart agent
// ---------------------------------------------------------------------------

async function restartAgent() {
  await window.yaver.restartService();
  showToast('Agent restarting...');
  setTimeout(updateDashboard, 2000);
}

// ---------------------------------------------------------------------------
// Prerequisites check
// ---------------------------------------------------------------------------

async function runPrerequisites() {
  const result = await window.yaver.checkPrerequisites();

  setCheckIcon('icon-claude', result.claude);

  const platLabel = document.getElementById('label-platform');
  platLabel.textContent = `${friendlyPlatform(result.platform)} (${result.arch})`;
  setCheckIcon('icon-platform', true);

  const btn = document.getElementById('btn-prereq-continue');
  btn.disabled = false;
}

function setCheckIcon(id, pass) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `check-icon ${pass ? 'pass' : 'fail'}`;
  el.textContent = pass ? '\u2713' : '\u2717';
}

// ---------------------------------------------------------------------------
// Install agent
// ---------------------------------------------------------------------------

async function startInstall() {
  showView('view-setup-install');

  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  const errDiv = document.getElementById('install-error');
  const retryBtn = document.getElementById('btn-install-retry');
  const skipBtn = document.getElementById('btn-install-skip');

  errDiv.innerHTML = '';
  retryBtn.style.display = 'none';
  skipBtn.style.display = 'none';

  // Phase 1: Download
  label.textContent = 'Downloading agent binary...';
  fill.style.width = '20%';

  const dlResult = await window.yaver.downloadAgent();

  if (!dlResult.success) {
    fill.style.width = '20%';
    label.textContent = 'Download failed';
    errDiv.innerHTML = `<div class="banner banner-error"><span class="icon">&#10007;</span><span>${escapeHtml(dlResult.error)}</span></div>`;
    retryBtn.style.display = 'inline-flex';
    skipBtn.style.display = 'inline-flex';
    return;
  }

  // Phase 2: Install service
  fill.style.width = '60%';
  label.textContent = 'Configuring system service...';

  const svcResult = await window.yaver.installService();

  if (!svcResult.success) {
    fill.style.width = '80%';
    label.textContent = 'Service setup failed';
    errDiv.innerHTML = `<div class="banner banner-error"><span class="icon">&#10007;</span><span>${escapeHtml(svcResult.error)}</span></div>`;
    retryBtn.style.display = 'inline-flex';
    skipBtn.style.display = 'inline-flex';
    return;
  }

  fill.style.width = '100%';
  label.textContent = 'Installation complete!';

  setTimeout(finishSetup, 800);
}

async function finishSetup() {
  showMainApp();
  updateDashboard();
}

// ---------------------------------------------------------------------------
// Listen for auth state changes from main process
// ---------------------------------------------------------------------------

window.yaver.onAuthStateChanged((data) => {
  if (data.signedIn) {
    init();
  } else {
    hideMainApp();
    showView('view-signin');
  }
});

// ---------------------------------------------------------------------------
// Markdown rendering (simple regex-based)
// ---------------------------------------------------------------------------

function renderMarkdown(text) {
  if (!text) return '';

  // Escape HTML first
  let html = escapeHtml(text);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<div class="md-code">${code}</div>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, '<span class="md-inline-code">$1</span>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
  html = html.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>');
  html = html.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<span class="md-bold">$1</span>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<span class="md-italic">$1</span>');

  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr class="md-hr">');

  return html;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function friendlyPlatform(p) {
  const map = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
  return map[p] || p;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

function createEmptyState(icon, text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `<div class="empty-icon">${icon}</div><div>${text}</div>`;
  return div;
}

function stopAllPolling() {
  if (dashPollInterval) { clearInterval(dashPollInterval); dashPollInterval = null; }
  if (taskPollInterval) { clearInterval(taskPollInterval); taskPollInterval = null; }
  if (execPollInterval) { clearInterval(execPollInterval); execPollInterval = null; }
}

// Simple toast notification
function showToast(message) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1a1d27;border:1px solid #2a2d3a;color:#e1e4e8;padding:10px 20px;border-radius:8px;font-size:13px;z-index:200;transition:opacity 0.3s;';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();
