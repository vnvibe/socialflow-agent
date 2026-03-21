const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agent', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
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
})
