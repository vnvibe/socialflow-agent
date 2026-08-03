class JobRegistry {
  constructor() {
    this.handlers = new Map()
  }

  register(type, handler, meta = {}) {
    this.handlers.set(type, {
      handler,
      needsBrowser: meta.needsBrowser !== false,
      isUtility: meta.isUtility || false,
      isPostType: meta.isPostType || false,
      label: meta.label || type,
      icon: meta.icon || '⚙️',
    })
  }

  get(type) {
    const entry = this.handlers.get(type)
    return entry ? entry.handler : undefined
  }

  getMeta(type) {
    return this.handlers.get(type)
  }

  has(type) {
    return this.handlers.has(type)
  }

  getUtilityTypes() {
    return [...this.handlers].filter(([, v]) => v.isUtility).map(([k]) => k)
  }

  getPostTypes() {
    return [...this.handlers].filter(([, v]) => v.isPostType).map(([k]) => k)
  }

  getBrowserFreeTypes() {
    return [...this.handlers].filter(([, v]) => !v.needsBrowser).map(([k]) => k)
  }
}

module.exports = new JobRegistry()
