const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yaver', {
  // Existing auth/service handlers
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

  // Agent API proxy — all go through local agent HTTP API
  agentRequest: (method, path, body) => ipcRenderer.invoke('agent-request', method, path, body),

  // Tasks
  listTasks: () => ipcRenderer.invoke('agent-request', 'GET', '/tasks'),
  createTask: (data) => ipcRenderer.invoke('agent-request', 'POST', '/tasks', data),
  getTask: (id) => ipcRenderer.invoke('agent-request', 'GET', `/tasks/${id}`),
  stopTask: (id) => ipcRenderer.invoke('agent-request', 'POST', `/tasks/${id}/stop`),
  deleteTask: (id) => ipcRenderer.invoke('agent-request', 'DELETE', `/tasks/${id}`),
  continueTask: (id, data) => ipcRenderer.invoke('agent-request', 'POST', `/tasks/${id}/continue`, data),

  // Agent status & runners
  getAgentStatus: () => ipcRenderer.invoke('agent-request', 'GET', '/agent/status'),
  getAgentInfo: () => ipcRenderer.invoke('agent-request', 'GET', '/info'),
  getRunners: () => ipcRenderer.invoke('agent-request', 'GET', '/agent/runners'),
  switchRunner: (runnerId) => ipcRenderer.invoke('agent-request', 'POST', '/agent/runner/switch', { runnerId }),
  restartRunner: () => ipcRenderer.invoke('agent-request', 'POST', '/agent/runner/restart'),
  agentShutdown: () => ipcRenderer.invoke('agent-request', 'POST', '/agent/shutdown'),
  agentClean: (days) => ipcRenderer.invoke('agent-request', 'POST', '/agent/clean', { days }),

  // Exec
  listExecs: () => ipcRenderer.invoke('agent-request', 'GET', '/exec'),
  startExec: (data) => ipcRenderer.invoke('agent-request', 'POST', '/exec', data),
  getExec: (id) => ipcRenderer.invoke('agent-request', 'GET', `/exec/${id}`),
  killExec: (id) => ipcRenderer.invoke('agent-request', 'DELETE', `/exec/${id}`),
  sendExecInput: (id, input) => ipcRenderer.invoke('agent-request', 'POST', `/exec/${id}/input`, { input }),
  signalExec: (id, signal) => ipcRenderer.invoke('agent-request', 'POST', `/exec/${id}/signal`, { signal }),

  // Doctor & Tools
  runDoctor: () => ipcRenderer.invoke('agent-request', 'GET', '/agent/doctor'),
  getTools: () => ipcRenderer.invoke('agent-request', 'GET', '/agent/tools'),

  // Analytics
  getAnalytics: () => ipcRenderer.invoke('agent-request', 'GET', '/analytics'),

  // Config (local ~/.yaver/config.json)
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Survey & Auth
  submitSurvey: (data) => ipcRenderer.invoke('submit-survey', data),
  getUserInfo: () => ipcRenderer.invoke('get-user-info'),

  // File picker for image attachments
  pickFile: (options) => ipcRenderer.invoke('pick-file', options),

  // Listen for auth state changes from main process
  onAuthStateChanged: (callback) => {
    ipcRenderer.on('auth-state-changed', (_event, data) => callback(data));
  },
});
