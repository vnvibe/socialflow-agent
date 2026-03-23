const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agent', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  getUser: () => ipcRenderer.invoke('get-user'),
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),
  logout: () => ipcRenderer.invoke('logout'),
  start: () => ipcRenderer.invoke('start-agent'),
  stop: () => ipcRenderer.invoke('stop-agent'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  onLog: (callback) => {
    ipcRenderer.on('log', (_, entry) => callback(entry))
  },
  onStatus: (callback) => {
    ipcRenderer.on('status', (_, status) => callback(status))
  },
  onSetup: (callback) => {
    ipcRenderer.on('setup-progress', (_, msg) => callback(msg))
  },
  onUser: (callback) => {
    ipcRenderer.on('user', (_, user) => callback(user))
  },
  // Auto-update
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (_, info) => callback(info))
  },
  onUpdateResult: (callback) => {
    ipcRenderer.on('update-result', (_, result) => callback(result))
  },
})
