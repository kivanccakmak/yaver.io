const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yaver', {
  getAppState: () => ipcRenderer.invoke('get-app-state'),
  checkPrerequisites: () => ipcRenderer.invoke('check-prerequisites'),
  downloadAgent: () => ipcRenderer.invoke('download-agent'),
  authenticate: () => ipcRenderer.invoke('authenticate'),
  authenticateMicrosoft: () => ipcRenderer.invoke('authenticate-microsoft'),
  authenticateApple: () => ipcRenderer.invoke('authenticate-apple'),
  installService: () => ipcRenderer.invoke('install-service'),
  restartService: () => ipcRenderer.invoke('restart-service'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  validateToken: () => ipcRenderer.invoke('validate-token'),

  // Listen for auth state changes from main process
  onAuthStateChanged: (callback) => {
    ipcRenderer.on('auth-state-changed', (_event, data) => callback(data));
  },
});
