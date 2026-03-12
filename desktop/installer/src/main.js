const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execSync, exec } = require('child_process');
const os = require('os');

const AGENT_REPO = 'yaver-io/agent';
const AGENT_BINARY_NAME = process.platform === 'win32' ? 'yaver-agent.exe' : 'yaver-agent';
const INSTALL_DIR = process.platform === 'win32'
  ? path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Yaver')
  : '/usr/local/bin';
const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'Yaver')
  : path.join(os.homedir(), '.yaver');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

ipcMain.handle('check-prerequisites', async () => {
  const results = { claude: false, go: false, platform: process.platform, arch: process.arch };

  try {
    execSync('claude --version', { stdio: 'ignore' });
    results.claude = true;
  } catch { /* not found */ }

  try {
    execSync('go version', { stdio: 'ignore' });
    results.go = true;
  } catch { /* not found */ }

  return results;
});

ipcMain.handle('download-agent', async (_event) => {
  try {
    // Determine the right asset name for this platform
    const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
    const archMap = { x64: 'amd64', arm64: 'arm64' };
    const plat = platformMap[process.platform] || process.platform;
    const arch = archMap[process.arch] || process.arch;
    const assetName = `yaver-agent-${plat}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;

    // Fetch latest release metadata from GitHub
    const releaseUrl = `https://api.github.com/repos/${AGENT_REPO}/releases/latest`;
    const releaseMeta = await httpGetJson(releaseUrl);

    const asset = releaseMeta.assets && releaseMeta.assets.find((a) => a.name === assetName);
    if (!asset) {
      // Fallback: just report what we looked for
      return { success: false, error: `No release asset found for ${assetName}. You may need to build from source.` };
    }

    // Download the binary
    const destDir = INSTALL_DIR;
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const destPath = path.join(destDir, AGENT_BINARY_NAME);
    await downloadFile(asset.browser_download_url, destPath);

    // Make executable on Unix
    if (process.platform !== 'win32') {
      fs.chmodSync(destPath, 0o755);
    }

    return { success: true, path: destPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('authenticate', async () => {
  // Open OAuth URL in the default browser
  const authUrl = 'https://yaver.io/auth/desktop';
  shell.openExternal(authUrl);

  // Start a tiny local HTTP server to catch the callback
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) {
        // Persist token
        if (!fs.existsSync(CONFIG_DIR)) {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(path.join(CONFIG_DIR, 'token'), token, { mode: 0o600 });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="background:#0f1117;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Authenticated! You can close this tab.</h2></body></html>');
        server.close();
        resolve({ success: true });
      } else {
        res.writeHead(400);
        res.end('Missing token');
      }
    });

    server.listen(19836, '127.0.0.1', () => {
      // The OAuth flow will redirect back to http://localhost:19836?token=...
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      resolve({ success: false, error: 'Authentication timed out.' });
    }, 5 * 60 * 1000);
  });
});

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

ipcMain.handle('get-status', async () => {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('launchctl list io.yaver.agent 2>&1', { encoding: 'utf8' });
      return { running: !out.includes('Could not find'), detail: out.trim() };
    } else if (process.platform === 'linux') {
      const out = execSync('systemctl --user is-active yaver-agent 2>&1', { encoding: 'utf8' });
      return { running: out.trim() === 'active', detail: out.trim() };
    } else if (process.platform === 'win32') {
      const out = execSync('sc query YaverAgent 2>&1', { encoding: 'utf8' });
      return { running: out.includes('RUNNING'), detail: out.trim() };
    }
  } catch {
    return { running: false, detail: 'Service not installed' };
  }
});

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
  // Use sc.exe to create a simple Windows service
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
      https.get(u, { headers: { 'User-Agent': 'YaverInstaller/1.0' } }, (res) => {
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
      mod.get(u, { headers: { 'User-Agent': 'YaverInstaller/1.0' } }, (res) => {
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
