const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execSync, spawn } = require('child_process');
const os = require('os');

const AGENT_REPO = 'yaver-io/agent';
const AGENT_BINARY_NAME = process.platform === 'win32' ? 'yaver-agent.exe' : 'yaver-agent';
const INSTALL_DIR = process.platform === 'win32'
  ? path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Yaver')
  : '/usr/local/bin';
const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'Yaver')
  : path.join(os.homedir(), '.yaver');
// Default hosted Convex instance (public endpoint). Override via CONVEX_SITE_URL env var.
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL || 'https://shocking-echidna-394.eu-west-1.convex.site';

let mainWindow;
let tray = null;

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    // Hide to tray instead of quitting (macOS / Linux)
    if (tray && process.platform !== 'win32') {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // Tiny 16x16 template icon for menu bar
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAmklEQVQ4T2NkoBAwUqifYdAY8J+B4T8jECMDEJuRgQGOQWxkNciADEBDQGyQGqgaFAPABjAw/GdgZPzPwMjw/z8jwBUMDEBnMjD8h7sEZCLIJSA+IwPY1XAXgA0gygCQSxgZ/v9nBLkY7A0GBrigYjYjigEkNSgqQJqQvAFjI/lBZABMPwi5AJlrIGYSFQYY4CUJDJgBAACqEFBE0GFnQAAAABJRU5ErkJggg=='
  );
  tray = new Tray(icon);
  tray.setToolTip('Yaver');

  const updateTrayMenu = () => {
    const isSignedIn = hasToken();
    const agentRunning = isAgentRunning();

    const menu = Menu.buildFromTemplate([
      {
        label: agentRunning ? '● Agent Running' : '○ Agent Stopped',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Open Yaver',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            createWindow();
          }
        },
      },
      { type: 'separator' },
      ...(isSignedIn
        ? [{ label: 'Sign Out', click: () => signOut() }]
        : [{ label: 'Sign In...', click: () => { mainWindow?.show(); mainWindow?.focus(); } }]),
      { type: 'separator' },
      { label: 'Quit Yaver', click: () => { app.quit(); } },
    ]);

    tray.setContextMenu(menu);
  };

  updateTrayMenu();
  // Refresh tray menu every 30 seconds
  setInterval(updateTrayMenu, 30000);
}

app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  } else {
    createWindow();
  }
});

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getTokenPath() {
  return path.join(CONFIG_DIR, 'token');
}

function hasToken() {
  return fs.existsSync(getTokenPath());
}

function getToken() {
  try {
    return fs.readFileSync(getTokenPath(), 'utf8').trim();
  } catch {
    return null;
  }
}

function clearToken() {
  try {
    fs.unlinkSync(getTokenPath());
  } catch { /* ignore */ }
}

function signOut() {
  clearToken();
  // Stop agent service
  try {
    if (process.platform === 'darwin') {
      execSync('launchctl unload ~/Library/LaunchAgents/io.yaver.agent.plist 2>/dev/null', { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      execSync('systemctl --user stop yaver-agent 2>/dev/null', { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execSync('sc stop YaverAgent 2>nul', { stdio: 'ignore' });
    }
  } catch { /* ignore */ }

  if (mainWindow) {
    mainWindow.webContents.send('auth-state-changed', { signedIn: false });
    mainWindow.show();
    mainWindow.focus();
  }
}

function isAgentRunning() {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('launchctl list io.yaver.agent 2>&1', { encoding: 'utf8' });
      return !out.includes('Could not find');
    } else if (process.platform === 'linux') {
      const out = execSync('systemctl --user is-active yaver-agent 2>&1', { encoding: 'utf8' });
      return out.trim() === 'active';
    } else if (process.platform === 'win32') {
      const out = execSync('sc query YaverAgent 2>&1', { encoding: 'utf8' });
      return out.includes('RUNNING');
    }
  } catch { /* */ }
  return false;
}

function isAgentInstalled() {
  return fs.existsSync(path.join(INSTALL_DIR, AGENT_BINARY_NAME));
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

ipcMain.handle('get-app-state', async () => {
  const token = getToken();
  let tokenValid = false;

  if (token) {
    try {
      tokenValid = await validateToken(token);
    } catch {
      tokenValid = false;
    }
  }

  return {
    hasToken: !!token,
    tokenValid,
    agentInstalled: isAgentInstalled(),
    agentRunning: isAgentRunning(),
    platform: process.platform,
    arch: process.arch,
  };
});

ipcMain.handle('check-prerequisites', async () => {
  const results = { claude: false, platform: process.platform, arch: process.arch };

  try {
    execSync('claude --version', { stdio: 'ignore' });
    results.claude = true;
  } catch { /* not found */ }

  return results;
});

ipcMain.handle('download-agent', async () => {
  try {
    const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
    const archMap = { x64: 'amd64', arm64: 'arm64' };
    const plat = platformMap[process.platform] || process.platform;
    const arch = archMap[process.arch] || process.arch;
    const assetName = `yaver-agent-${plat}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;

    const releaseUrl = `https://api.github.com/repos/${AGENT_REPO}/releases/latest`;
    const releaseMeta = await httpGetJson(releaseUrl);

    const asset = releaseMeta.assets && releaseMeta.assets.find((a) => a.name === assetName);
    if (!asset) {
      return { success: false, error: `No release asset found for ${assetName}. You may need to build from source.` };
    }

    const destDir = INSTALL_DIR;
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const destPath = path.join(destDir, AGENT_BINARY_NAME);
    await downloadFile(asset.browser_download_url, destPath);

    if (process.platform !== 'win32') {
      fs.chmodSync(destPath, 0o755);
    }

    return { success: true, path: destPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Shared auth handler — opens yaver.io auth page, waits for local callback
function startOAuthFlow(provider) {
  // Open the web auth page with provider pre-selected, or generic page
  const authUrl = provider
    ? `https://yaver.io/api/auth/oauth/${provider}?client=desktop`
    : 'https://yaver.io/auth?client=desktop';
  shell.openExternal(authUrl);

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) {
        if (!fs.existsSync(CONFIG_DIR)) {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(getTokenPath(), token, { mode: 0o600 });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="background:#0f1117;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
          <h2 style="margin-bottom:8px">Authenticated!</h2>
          <p style="color:#9ca3af">You can close this tab and return to Yaver.</p>
        </body></html>`);
        server.close();

        if (mainWindow) {
          mainWindow.webContents.send('auth-state-changed', { signedIn: true });
        }

        resolve({ success: true });
      } else {
        res.writeHead(400);
        res.end('Missing token');
      }
    });

    server.listen(19836, '127.0.0.1');

    setTimeout(() => {
      server.close();
      resolve({ success: false, error: 'Authentication timed out.' });
    }, 5 * 60 * 1000);
  });
}

ipcMain.handle('authenticate', () => startOAuthFlow('google'));
ipcMain.handle('authenticate-microsoft', () => startOAuthFlow('microsoft'));
ipcMain.handle('authenticate-apple', () => startOAuthFlow('apple'));

ipcMain.handle('install-service', async () => {
  try {
    const agentPath = path.join(INSTALL_DIR, AGENT_BINARY_NAME);

    if (!fs.existsSync(agentPath)) {
      return { success: false, error: 'Agent binary not found. Please download first.' };
    }

    if (process.platform === 'darwin') {
      return installLaunchd(agentPath);
    } else if (process.platform === 'linux') {
      return installSystemd(agentPath);
    } else if (process.platform === 'win32') {
      return installWindowsService(agentPath);
    }

    return { success: false, error: `Unsupported platform: ${process.platform}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('restart-service', async () => {
  try {
    if (process.platform === 'darwin') {
      execSync('launchctl unload ~/Library/LaunchAgents/io.yaver.agent.plist 2>/dev/null || true', { stdio: 'ignore' });
      execSync('launchctl load -w ~/Library/LaunchAgents/io.yaver.agent.plist', { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      execSync('systemctl --user restart yaver-agent');
    } else if (process.platform === 'win32') {
      execSync('sc stop YaverAgent 2>nul & sc start YaverAgent');
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-status', async () => {
  return {
    running: isAgentRunning(),
    installed: isAgentInstalled(),
    hasToken: hasToken(),
  };
});

ipcMain.handle('sign-out', async () => {
  signOut();
  return { success: true };
});

ipcMain.handle('validate-token', async () => {
  const token = getToken();
  if (!token) return { valid: false };
  try {
    const valid = await validateToken(token);
    return { valid };
  } catch {
    return { valid: false };
  }
});

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

async function validateToken(token) {
  return new Promise((resolve) => {
    const url = new URL('/auth/validate', CONVEX_SITE_URL);
    https.get(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'YaverDesktop/1.0',
      },
    }, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Platform service installers
// ---------------------------------------------------------------------------

function installLaunchd(agentPath) {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.yaver.agent.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.yaver.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${agentPath}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${CONFIG_DIR}/agent.log</string>
  <key>StandardErrorPath</key>
  <string>${CONFIG_DIR}/agent.err</string>
</dict>
</plist>`;

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // Unload first if already loaded
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' });
  } catch { /* ignore */ }

  fs.writeFileSync(plistPath, plist);
  execSync(`launchctl load -w "${plistPath}"`);
  return { success: true };
}

function installSystemd(agentPath) {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  if (!fs.existsSync(unitDir)) {
    fs.mkdirSync(unitDir, { recursive: true });
  }
  const unitPath = path.join(unitDir, 'yaver-agent.service');
  const unit = `[Unit]
Description=Yaver Desktop Agent
After=network.target

[Service]
ExecStart=${agentPath} serve
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(unitPath, unit);
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable --now yaver-agent');
  return { success: true };
}

function installWindowsService(agentPath) {
  try {
    execSync(`sc create YaverAgent binPath= "\\"${agentPath}\\" serve" start= auto DisplayName= "Yaver Agent"`);
    execSync('sc start YaverAgent');
    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to create Windows service: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'YaverDesktop/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON response')); }
        });
      }).on('error', reject);
    };
    get(url);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const download = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'YaverDesktop/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    download(url);
  });
}
