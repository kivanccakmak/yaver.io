const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yaver', {
  checkPrerequisites: () => ipcRenderer.invoke('check-prerequisites'),
  downloadAgent: () => ipcRenderer.invoke('download-agent'),
  authenticate: () => ipcRenderer.invoke('authenticate'),
  installService: () => ipcRenderer.invoke('install-service'),
  getStatus: () => ipcRenderer.invoke('get-status'),
});
