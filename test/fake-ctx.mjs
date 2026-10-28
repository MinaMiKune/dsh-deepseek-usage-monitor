/**
 * Minimal Cordis-context stand-in for integration tests.
 *
 * It implements exactly the surface the plugin uses — `effect`, `on`, `inject`,
 * `get` — with the same cleanup semantics (disposers run in reverse order), so
 * the plugin's real wiring code runs unchanged.
 */

/**
 * @param {{
 *   services?: Record<string, any>,
 *   loggerSink?: { log: Function, warn: Function, error: Function },
 * }} [options]
 */
export function createFakeCtx({ services = {} } = {}) {
  /** @type {Array<() => any>} */
  const disposers = []
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  let disposed = false

  const ctx = {
    services,
    disposed: false,
    /** @type {Array<{ name: string, listener: Function }>} */
    registeredListeners: [],    /**
     * @param {() => any} callback
     * @param {string} [label]
     */
    effect(callback, label) {
      if (disposed) throw new Error('context is disposed')
      const result = callback()
      const disposer = typeof result === 'function' ? result : () => undefined
      disposers.push(disposer)
      return () => {
        const index = disposers.indexOf(disposer)
        if (index >= 0) disposers.splice(index, 1)
        return disposer()
      }
    },
    /**
     * @param {string} name
     * @param {Function} listener
     */
    on(name, listener) {
      if (disposed) throw new Error('context is disposed')
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      ctx.registeredListeners.push({ name, listener })
      const dispose = () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
      disposers.push(dispose)
      return dispose
    },
    /** @param {string} name */
    get(name) {
      return ctx[name] ?? services[name]
    },
    /**
     * @param {string[]} names
     * @param {(ctx: any) => any} callback
     */
    inject(names, callback) {
      if (disposed) return () => undefined
      const available = names.every((name) => Boolean(services[name]))
      if (!available) {
        // Mirror Cordis: the callback stays parked until the service exists.
        return () => undefined
      }
      const result = callback(ctx)
      const disposer = typeof result === 'function' ? result : () => undefined
      disposers.push(disposer)
      return disposer
    },
    /** Deliver an event to the registered listeners, in order. */
    async emit(name, ...args) {
      const list = listeners.get(name) ?? []
      for (const listener of list) {
        await listener(...args)
      }
    },
    /** Number of listeners registered for one event. */
    listenerCount(name) {
      return (listeners.get(name) ?? []).length
    },
    /** Run every disposer in reverse registration order. */
    async dispose() {
      disposed = true
      ctx.disposed = true
      for (const dispose of disposers.splice(0).reverse()) {
        await dispose()
      }
    },
  }
  // Cordis exposes services as context properties; mirror that so plugin code
  // using `ctx.tools` / `ctx.connection` behaves exactly as it would live.
  for (const name of Object.keys(services)) {
    Object.defineProperty(ctx, name, {
      get: () => services[name],
      enumerable: true,
      configurable: true,
    })
  }
  return ctx
}

/**
 * A recorder for tool and Web-route registrations.
 * @param {Record<string, any>} [initial]
 */
export function createServiceRecorder(initial = {}) {
  const state = {
    tools: new Map(),
    routes: new Map(),
    ...initial,
  }
  state.toolsService = {
    /** @param {any} definition */
    register(definition) {
      if (state.tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      state.tools.set(definition.name, definition)
      return () => state.tools.delete(definition.name)
    },
  }
  state.connectionService = {
    fetch: {
      /** @param {any} route */
      register(route) {
        if (state.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        state.routes.set(route.path, route)
        return async () => {
          state.routes.delete(route.path)
        }
      },
    },
  }
  return state
}
