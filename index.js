/**
 * Host half of the DeepSeek Usage Monitor bundle.
 *
 * Wiring only: configuration validation, the state store, the service, the four
 * Cordis integration points (lifecycle, `llm/stream` capture, agent tools,
 * authenticated `/api` routes), and cleanup. All behaviour lives in `lib/`.
 *
 * Every optional service is obtained through `ctx.inject` or `ctx.get`, so the
 * plugin still activates in a composition without tools, connection, or
 * credentials instead of failing the whole profile.
 */

import { normalizeConfig } from './lib/config.js'
import { createLogger } from './lib/log.js'
import { StateStore, defaultDataDir } from './lib/store.js'
import { UsageMonitor } from './lib/service.js'
import { createLlmCapture } from './lib/capture.js'
import { createUsageTool } from './lib/tools.js'
import { createHttpHandlers, registerHttpRoutes } from './lib/http.js'

/**
 * Mount the monitor on a Cordis context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  return setup({ ctx, rawConfig })
}

/**
 * Testable setup entry point. Everything the harness normally provides can be
 * substituted here.
 * @param {{
 *   ctx: any,
 *   rawConfig: unknown,
 *   dir?: string,
 *   clock?: { now: () => number, setTimeout?: Function, clearTimeout?: Function },
 *   fetchImpl?: typeof fetch,
 *   env?: Record<string, string | undefined>,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   loggerSink?: { log: Function, warn: Function, error: Function },
 * }} options
 */
export function setup({ ctx, rawConfig, dir, clock, fetchImpl, env, sleep, random, loggerSink }) {
  const { config, issues } = normalizeConfig(rawConfig)
  const logger = createLogger({ debug: config.debug, sink: /** @type {any} */ (loggerSink ?? console) })

  for (const issue of issues) {
    logger.warn(`config "${issue.field}" ${issue.message}; using ${issue.used}`)
  }

  const dataDir = dir || config.dataDir || defaultDataDir(env ?? process.env)
  const store = new StateStore({
    dir: dataDir,
    retentionDays: config.historyRetentionDays,
    maxCallRecords: config.maxCallRecords,
    logger,
  })

  /**
   * Resolve credentials lazily: the service may be mounted after this plugin, and
   * resolution must happen per operation so a rotated key is picked up without a
   * restart.
   */
  const credentials = ctx.get
    ? {
        async resolve(ref) {
          const service = ctx.get('credentials')
          if (!service) throw new Error('credentials service is not mounted')
          return service.resolve(ref)
        },
        async describe(ref) {
          const service = ctx.get('credentials')
          if (!service) throw new Error('credentials service is not mounted')
          return service.describe(ref)
        },
      }
    : null

  const monitor = new UsageMonitor({
    config,
    issues,
    logger,
    store,
    credentials,
    getAccount: () => (ctx.get ? ctx.get('deepseekAccount') : undefined),
    clock,
    fetchImpl,
    env,
    sleep,
    random,
  })
  monitor.initError = null

  /** @type {any} */
  let initError = null
  const ready = monitor
    .init()
    .catch((error) => {
      initError = error
      monitor.initError = error instanceof Error ? error.message : String(error)
      logger.error('failed to load persisted state; starting from empty state', error)
    })
  // `ready` never rejects, so request handlers can simply await it.
  const ensureReady = () => ready

  // --- lifecycle -----------------------------------------------------------
  ctx.effect(() => {
    let disposed = false
    const started = (async () => {
      await ready
      if (disposed) return
      if (config.autoStart) monitor.start()
      else logger.info('auto_start is false: pollers stay idle until a manual refresh')
    })()
    return async () => {
      disposed = true
      try {
        await started
      } catch (error) {
        logger.warn('startup task failed during unload', error)
      }
      await monitor.stop()
      logger.debug('stopped')
    }
  }, 'deepseek-usage:lifecycle')

  // --- alert sink ----------------------------------------------------------
  const disposeObserver = monitor.subscribe((notification) => {
    if (notification.kind === 'alert') {
      logger.warn(
        `alert ${notification.alert.type} (${notification.alert.severity}): ${notification.alert.message}`,
        {
          value: notification.alert.value,
          threshold: notification.alert.threshold,
          dataAt: notification.alert.dataAt,
          source: notification.alert.source,
        },
      )
    }
  })

  // --- observed model calls ------------------------------------------------
  // The capture timestamps observations with the monitor's clock so recorded
  // calls and aggregation windows always share one time source.
  const capture = createLlmCapture({ monitor, logger, now: () => monitor.clock.now() })
  const disposeStream = ctx.on('llm/stream', (options, next) => capture.wrap(options, next))
  logger.debug('llm/stream capture attached')

  // --- agent tools ---------------------------------------------------------
  const tool = createUsageTool({ monitor, ensureReady, logger })
  const disposeTools = ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const remove = toolCtx.tools.register(tool)
      logger.info('registered agent tool deepseek_usage')
      return remove
    }, 'deepseek-usage:tool')
  })

  // --- authenticated Web routes -------------------------------------------
  const handlers = createHttpHandlers({ monitor, ensureReady, logger })
  const disposeRoutes = ctx.inject(['connection'], (connectionCtx) => {
    registerHttpRoutes({ connection: connectionCtx.connection, ctx: connectionCtx, handlers, logger })
  })

  /**
   * Remove every integration and stop all activity. Cordis calls this through
   * the effects above on unload; tests call it directly.
   */
  async function dispose() {
    try {
      disposeTools?.()
    } catch (error) {
      logger.debug('tool disposal failed', error)
    }
    try {
      disposeRoutes?.()
    } catch (error) {
      logger.debug('route disposal failed', error)
    }
    try {
      disposeStream?.()
    } catch (error) {
      logger.debug('stream listener disposal failed', error)
    }
    try {
      disposeObserver?.()
    } catch {
      /* ignore */
    }
    await monitor.stop()
  }

  return {
    config,
    issues,
    logger,
    store,
    monitor,
    ready,
    tool,
    handlers,
    get initError() {
      return initError
    },
    dispose,
  }
}
