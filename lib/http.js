/**
 * Host Web surface for the panel.
 *
 * The routes are registered on the authenticated `/api` channel through
 * `ctx.connection.fetch.register`, so the existing browser-cookie trust check
 * and Host/Origin fence apply before this code runs: the panel needs no
 * bespoke authentication, and a request without a valid browser credential is
 * rejected by the carrier. Responses are JSON, never cached, and never contain
 * an API key.
 *
 * Registration is a Cordis effect: unloading the plugin removes the routes.
 */

import { toJsonValue } from './json.js'

/** Exact path for the combined snapshot used by the panel. */
export const SNAPSHOT_PATH = '/api/deepseek-usage/snapshot'

/** Exact path for a manual refresh. */
export const REFRESH_PATH = '/api/deepseek-usage/refresh'

/**
 * Create the handlers independently of Cordis so they can be exercised directly
 * in tests.
 * @param {{
 *   monitor: import('./service.js').UsageMonitor,
 *   ensureReady: () => Promise<void>,
 *   logger: { warn?: Function, debug?: Function, error?: Function },
 * }} options
 */
export function createHttpHandlers({ monitor, ensureReady, logger }) {
  /**
   * @param {() => Promise<any>} produce
   * @param {string} label
   */
  const respond = async (produce, label) => {
    try {
      await ensureReady()
      const body = await produce()
      return json(200, { ok: true, ...body })
    } catch (error) {
      if (error instanceof RangeError) {
        return json(400, { ok: false, error: { code: 'INVALID_RANGE', message: error.message } })
      }
      const code = /** @type {any} */ (error)?.code
      if (code === 'NOT_READY') {
        return json(503, { ok: false, error: { code: 'NOT_READY', message: 'the monitor has not finished loading its state' } })
      }
      logger?.error?.(`${label} failed`, error)
      return json(500, { ok: false, error: { code: 'INTERNAL', message: 'the monitoring request failed; see the Harness log' } })
    }
  }

  return [
    {
      path: SNAPSHOT_PATH,
      methods: ['GET'],
      /**
       * @param {Request} request
       * @returns {Promise<Response>}
       */
      async fetch(request) {
        const url = new URL(request.url)
        const range = url.searchParams.get('range') ?? '24h'
        const start = url.searchParams.get('start') ?? undefined
        const end = url.searchParams.get('end') ?? undefined
        return respond(async () => ({ snapshot: await monitor.getSnapshot({ range, start, end }) }), 'snapshot')
      },
    },
    {
      path: REFRESH_PATH,
      methods: ['POST'],
      /**
       * @param {Request} request
       * @returns {Promise<Response>}
       */
      async fetch(request) {
        let payload = {}
        try {
          const text = await request.text()
          if (text.trim() !== '') payload = JSON.parse(text)
        } catch {
          return json(400, { ok: false, error: { code: 'INVALID_BODY', message: 'refresh expects a JSON object body' } })
        }
        const scope = payload?.scope ?? 'all'
        if (!['balance', 'usage', 'all'].includes(scope)) {
          return json(400, { ok: false, error: { code: 'INVALID_SCOPE', message: 'scope must be balance, usage, or all' } })
        }
        return respond(async () => {
          const result = { scope }
          if (scope === 'balance' || scope === 'all') {
            result.balance = await monitor.refreshBalance({ reason: 'panel' })
          }
          if (scope === 'usage' || scope === 'all') {
            result.usage = await monitor.refreshUsage()
          }
          result.balanceView = monitor.getBalance()
          return result
        }, 'refresh')
      },
    },
  ]
}

/**
 * Register the handlers on the authenticated `/api` channel.
 * @param {{
 *   connection: { fetch: { register: (route: any) => () => Promise<void> } },
 *   ctx: { effect: (callback: () => any, label?: string) => unknown },
 *   handlers: ReturnType<typeof createHttpHandlers>,
 *   logger: { warn?: Function, error?: Function, debug?: Function },
 * }} options
 */
export function registerHttpRoutes({ connection, ctx, handlers, logger }) {
  const disposers = []
  for (const handler of handlers) {
    ctx.effect(() => {
      let dispose
      try {
        dispose = connection.fetch.register({
          path: handler.path,
          methods: handler.methods,
          requestBody: 'buffered',
          fetch: handler.fetch,
        })
      } catch (error) {
        logger?.error?.(`failed to register ${handler.path}`, error)
        return () => undefined
      }
      disposers.push(dispose)
      logger?.debug?.(`registered ${handler.methods.join('/')} ${handler.path}`)
      return () => {
        try {
          return dispose()
        } catch (error) {
          logger?.warn?.(`failed to remove ${handler.path}`, error)
          return undefined
        }
      }
    }, `deepseek-usage:route:${handler.path}`)
  }
  return disposers
}

/**
 * @param {number} status
 * @param {unknown} body
 * @returns {Response}
 */
function json(status, body) {
  return new Response(JSON.stringify(toJsonValue(body)), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
