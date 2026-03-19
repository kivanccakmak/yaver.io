// ---------------------------------------------------------------------------
// View management
// ---------------------------------------------------------------------------

function showView(id) {
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) target.classList.add('active');
}

// ---------------------------------------------------------------------------
// App initialization — determine which view to show
// ---------------------------------------------------------------------------

async function init() {
  showView('view-loading');

  const state = await window.yaver.getAppState();

  if (!state.hasToken) {
    // Never signed in
    showView('view-signin');
    return;
  }

  if (!state.tokenValid) {
    // Token expired — show re-auth (Tailscale-style)
    showView('view-reauth');
    return;
  }

  if (!state.agentInstalled) {
    // Signed in but agent not installed — run setup
    showView('view-setup-prereqs');
    runPrerequisites();
    return;
  }

  // Everything set up — show dashboard
  showDashboard(state);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function showDashboard(state) {
  if (state && state.agentRunning) {
    showView('view-dashboard');
  } else {
    showView('view-dashboard-stopped');
  }
}

async function refreshDashboard() {
  const state = await window.yaver.getAppState();

  if (!state.hasToken) {
    showView('view-signin');
    return;
  }

  if (!state.tokenValid) {
    showView('view-reauth');
    return;
  }

  showDashboard(state);
}

// Refresh dashboard status every 15 seconds
setInterval(async () => {
  const currentView = document.querySelector('.view.active');
  if (currentView && (currentView.id === 'view-dashboard' || currentView.id === 'view-dashboard-stopped')) {
    const status = await window.yaver.getStatus();
    if (status.running) {
      showView('view-dashboard');
    } else {
      showView('view-dashboard-stopped');
    }
  }
}, 15000);

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

async function signInGoogle() {
  disableAuthButtons();
  clearSigninError();

  const result = await window.yaver.authenticate();

  if (result.success) {
    // Auth succeeded — check if agent is installed
    const state = await window.yaver.getAppState();
    if (!state.agentInstalled) {
      showView('view-setup-prereqs');
      runPrerequisites();
    } else {
      showDashboard(state);
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
      showDashboard(state);
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
      showDashboard(state);
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
    el.innerHTML = `<div class="error-banner"><span class="icon">&#10007;</span><span class="text">${msg}</span></div>`;
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
  showView('view-signin');
}

// ---------------------------------------------------------------------------
// Restart agent
// ---------------------------------------------------------------------------

async function restartAgent() {
  const result = await window.yaver.restartService();
  // Wait a second for the service to come up, then refresh
  setTimeout(refreshDashboard, 1500);
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

function friendlyPlatform(p) {
  const map = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
  return map[p] || p;
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
    errDiv.innerHTML = `<div class="error-banner"><span class="icon">&#10007;</span><span class="text">${dlResult.error}</span></div>`;
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
    errDiv.innerHTML = `<div class="error-banner"><span class="icon">&#10007;</span><span class="text">${svcResult.error}</span></div>`;
    retryBtn.style.display = 'inline-flex';
    skipBtn.style.display = 'inline-flex';
    return;
  }

  fill.style.width = '100%';
  label.textContent = 'Installation complete!';

  setTimeout(finishSetup, 800);
}

async function finishSetup() {
  const state = await window.yaver.getAppState();
  showDashboard(state);
}

// ---------------------------------------------------------------------------
// Listen for auth state changes from main process (e.g. sign out from tray)
// ---------------------------------------------------------------------------

window.yaver.onAuthStateChanged((data) => {
  if (data.signedIn) {
    refreshDashboard();
  } else {
    showView('view-signin');
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();
