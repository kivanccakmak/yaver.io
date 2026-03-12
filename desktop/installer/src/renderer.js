let currentStep = 0;
const totalSteps = 5;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function showStep(index) {
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('visible'));
  document.getElementById(`step-${index}`).classList.add('visible');

  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.classList.remove('active');
    if (i < index) dot.classList.add('done');
    if (i === index) dot.classList.add('active');
  });
}

function nextStep() {
  if (currentStep >= totalSteps - 1) return;
  currentStep++;
  showStep(currentStep);

  // Trigger actions when entering a step
  if (currentStep === 1) runPrerequisites();
  if (currentStep === 3) runInstall();
  if (currentStep === 4) runStatusCheck();
}

// ---------------------------------------------------------------------------
// Step 1 — Prerequisites
// ---------------------------------------------------------------------------

async function runPrerequisites() {
  const btn = document.getElementById('btn-prereq');
  btn.disabled = true;

  const result = await window.yaver.checkPrerequisites();

  // Claude CLI
  setCheckIcon('icon-claude', result.claude);

  // Go
  setCheckIcon('icon-go', result.go);

  // Platform
  const platLabel = document.getElementById('label-platform');
  platLabel.textContent = `${friendlyPlatform(result.platform)} (${result.arch})`;
  setCheckIcon('icon-platform', true);

  btn.disabled = false;
  btn.textContent = 'Continue';
}

function setCheckIcon(id, pass) {
  const el = document.getElementById(id);
  el.className = `check-icon ${pass ? 'pass' : 'fail'}`;
  el.textContent = pass ? '\u2713' : '\u2717';
}

function friendlyPlatform(p) {
  const map = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
  return map[p] || p;
}

// ---------------------------------------------------------------------------
// Step 2 — Authentication
// ---------------------------------------------------------------------------

async function authenticate() {
  // Disable buttons while waiting
  document.querySelectorAll('.auth-buttons .btn').forEach((b) => (b.disabled = true));

  const result = await window.yaver.authenticate();

  if (result.success) {
    nextStep();
  } else {
    document.querySelectorAll('.auth-buttons .btn').forEach((b) => (b.disabled = false));
    alert('Authentication failed: ' + (result.error || 'Unknown error'));
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Download & Install
// ---------------------------------------------------------------------------

async function runInstall() {
  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  const btn = document.getElementById('btn-install');

  // Phase 1: Download
  label.textContent = 'Downloading agent binary...';
  fill.style.width = '20%';

  const dlResult = await window.yaver.downloadAgent();

  if (!dlResult.success) {
    label.textContent = `Download failed: ${dlResult.error}`;
    fill.style.width = '20%';
    btn.style.display = 'inline-flex';
    btn.textContent = 'Skip & Continue';
    return;
  }

  fill.style.width = '60%';
  label.textContent = 'Configuring system service...';

  // Phase 2: Install service
  const svcResult = await window.yaver.installService();

  if (!svcResult.success) {
    fill.style.width = '80%';
    label.textContent = `Service setup failed: ${svcResult.error}`;
    btn.style.display = 'inline-flex';
    btn.textContent = 'Skip & Continue';
    return;
  }

  fill.style.width = '100%';
  label.textContent = 'Installation complete!';

  // Auto advance after a brief pause
  setTimeout(() => nextStep(), 800);
}

// ---------------------------------------------------------------------------
// Step 4 — Status
// ---------------------------------------------------------------------------

async function runStatusCheck() {
  const badge = document.getElementById('status-badge');
  const result = await window.yaver.getStatus();

  if (result.running) {
    badge.innerHTML = '<div class="pulse"></div><span>Agent running</span>';
    badge.className = 'status-badge running';
  } else {
    badge.innerHTML = '<span>Agent not running</span>';
    badge.style.background = '#3b1a1a';
    badge.style.color = '#ef4444';
    badge.style.borderColor = '#ef444433';
  }
}
