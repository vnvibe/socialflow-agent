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
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (_, info) => callback(info))
  },
  onUpdateResult: (callback) => {
    ipcRenderer.on('update-result', (_, result) => callback(result))
  },
  // Scout (Do Thám)
  scoutGetTargets: () => ipcRenderer.invoke('scout-get-targets'),
  scoutAddTarget: (data) => ipcRenderer.invoke('scout-add-target', data),
  scoutUpdateTarget: (data) => ipcRenderer.invoke('scout-update-target', data),
  scoutDeleteTarget: (data) => ipcRenderer.invoke('scout-delete-target', data),
  scoutGetPosts: (filters) => ipcRenderer.invoke('scout-get-posts', filters || {}),
  scoutGetComments: (filters) => ipcRenderer.invoke('scout-get-comments', filters || {}),
  scoutGetLogs: (filters) => ipcRenderer.invoke('scout-get-logs', filters || {}),
  // Cài đặt AI đa provider (key chỉ đi lên, đọc về luôn được che)
  aiGetConfig: () => ipcRenderer.invoke('ai-get-config'),
  aiSaveConfig: (config) => ipcRenderer.invoke('ai-save-config', config),
  aiTestProvider: (p) => ipcRenderer.invoke('ai-test-provider', p || {}),
  aiGetUsage: () => ipcRenderer.invoke('ai-get-usage'),
  // Cấu hình theo từng nick (ngày tạo FB, ngách, quảng cáo, hạn mức)
  nickList: () => ipcRenderer.invoke('nick-list'),
  nickConfigGet: (accountId) => ipcRenderer.invoke('nick-config-get', accountId),
  nickConfigSave: (payload) => ipcRenderer.invoke('nick-config-save', payload),
  // Báo cáo Comment & KPI
  getReport: (opts) => ipcRenderer.invoke('get-report', opts || {}),
  getKpiToday: () => ipcRenderer.invoke('get-kpi-today'),
})
