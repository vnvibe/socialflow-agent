const ANTI_DETECT_SCRIPTS = [
  () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  },
  () => {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' }
        ]
        plugins.length = 3
        return plugins
      }
    })
  },
  () => {
    window.chrome = {
      runtime: { connect: () => {}, sendMessage: () => {} },
      loadTimes: () => ({})
    }
  },
  () => {
    const originalQuery = window.navigator.permissions.query
    window.navigator.permissions.query = (parameters) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission })
      }
      return originalQuery(parameters)
    }
  },
  () => {
    const props = Object.getOwnPropertyNames(document)
    for (const prop of props) {
      if (prop.startsWith('cdc_') || prop.startsWith('$cdc_')) delete document[prop]
    }
  },
  () => {
    Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN', 'vi', 'en-US', 'en'] })
  },
  () => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 })
  },
  () => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })
  }
]

function getAntiDetectScript() {
  return ANTI_DETECT_SCRIPTS.map(fn => `(${fn.toString()})()`).join(';\n')
}

module.exports = { ANTI_DETECT_SCRIPTS, getAntiDetectScript }
