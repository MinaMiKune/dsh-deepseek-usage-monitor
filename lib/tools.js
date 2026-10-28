/**
 * Agent-tool adapter.
 *
 * One tool (`deepseek_usage`) exposes every monitor operation through an
 * `action` discriminator, so the model gets a structured, machine-readable
 * result from the same service methods the Web panel uses. Nothing here holds
 * its own state or duplicates business logic.
 *
 * The tool definition is written by hand instead of importing `defineTool`:
 * a bundle installed through the profile cannot resolve `@deepseek-ai/dsh-tools`
 * at runtime, and the registry validates the raw `output.schema`, arguments, and
 * returned value itself.
 */

import { toJsonValue } from './json.js'

/** Actions the tool accepts. */
export const TOOL_ACTIONS = Object.freeze([  'status',
  'balance',
  'usage',
  'refresh',
  'alerts',
  'set_thresholds',
  'reset_thresholds',
  'clear_history',
])

/** JSON Schema for the tool arguments (raw schema, validated by the registry). */
export const TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...TOOL_ACTIONS],
      description:
        'status: schedulers, credentials, storage and capture status. balance: the official account balance with freshness classification. usage: token/call/cost aggregates for one range. refresh: force a balance and/or usage refresh now. alerts: active alerts, thresholds and recent notifications. set_thresholds: persist runtime threshold overrides. reset_thresholds: clear them. clear_history: delete local records (requires confirm).',
    },
    range: {
      type: 'string',
      enum: ['1h', '24h', '7d', '30d', 'custom'],
      description: 'Usage window for action=usage. Defaults to 24h.',
    },
    start: { type: 'string', description: 'ISO-8601 start instant for range=custom.' },
    end: { type: 'string', description: 'ISO-8601 end instant for range=custom.' },
    scope: {
      type: 'string',
      enum: ['balance', 'usage', 'all'],
      description: 'What action=refresh refreshes. Defaults to all.',
    },
    thresholds: {
      type: 'object',
      additionalProperties: true,
      description:
        'For set_thresholds: low_balance_threshold, daily_cost_threshold, daily_token_threshold, alert_cooldown (seconds), failure_streak_threshold.',
    },
    confirm: {
      type: 'boolean',
      description: 'Must be true for action=clear_history; the call is rejected otherwise.',
    },
  },
  required: ['action'],
  additionalProperties: false,
})

/**
 * Build the tool definition handed to `ctx.tools.register`.
 * @param {{
 *   monitor: import('./service.js').UsageMonitor,
 *   ensureReady: () => Promise<void>,
 *   logger: { debug?: Function, warn?: Function, error?: Function },
 * }} options
 */
export function createUsageTool({ monitor, ensureReady, logger }) {
  return {
    name: 'deepseek_usage',
    description:
      'Inspect and configure the DeepSeek usage monitor. Returns data plus its provenance: the account balance comes from the official DeepSeek GET /user/balance endpoint, while token counts and costs are Harness-observed/estimated and never account-wide. Never returns an API key.',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      /**
       * @param {unknown} args
       * @param {any} value
       */
      render(args, value) {
        const action = /** @type {any} */ (args)?.action ?? 'unknown'
        return [
          { type: 'text', text: summarize(action, value) },
          { type: 'text', text: '```json\n' + JSON.stringify(value, null, 2) + '\n```' },
        ]
      },
    },
    timeoutMs: 60_000,
    /**
     * Tool results are validated as lossless JSON, so optional fields that are
     * `undefined` must be dropped once at the boundary instead of failing the
     * call.
     * @param {any} args
     * @param {{ signal?: AbortSignal }} exec
     */
    async execute(args, exec) {
      return toJsonValue(await this.executeRaw(args, exec))
    },
    /**
     * @param {any} args
     * @param {{ signal?: AbortSignal }} exec
     */
    async executeRaw(args, exec) {
      await ensureReady()
      const action = args?.action
      if (!TOOL_ACTIONS.includes(action)) {
        throw new Error(`unknown action "${String(action)}"; expected one of ${TOOL_ACTIONS.join(', ')}`)
      }
      switch (action) {
        case 'status':
          return { action, status: await monitor.getStatus() }
        case 'balance':
          return { action, balance: monitor.getBalance() }
        case 'usage':
          return {
            action,
            usage: monitor.getUsage({ range: args?.range ?? '24h', start: args?.start, end: args?.end }),
          }
        case 'refresh': {
          const scope = args?.scope ?? 'all'
          const result = { action, scope }
          if (scope === 'balance' || scope === 'all') {
            result.balance = await monitor.refreshBalance({ reason: 'tool', signal: exec?.signal })
          }
          if (scope === 'usage' || scope === 'all') {
            result.usage = await monitor.refreshUsage({ signal: exec?.signal })
          }
          result.summary = monitor.getBalance()
          return result
        }
        case 'alerts':
          return { action, alerts: monitor.getAlerts() }
        case 'set_thresholds':
          return { action, result: await monitor.setThresholds(args?.thresholds ?? {}) }
        case 'reset_thresholds':
          return { action, result: await monitor.resetThresholds() }
        case 'clear_history': {
          if (args?.confirm !== true) {
            throw new Error('clear_history requires confirm: true; no data was deleted')
          }
          const removed = await monitor.clearHistory()
          logger?.warn?.('local usage history was cleared through the agent tool', removed)
          return { action, removed }
        }
        default:
          throw new Error(`unhandled action "${String(action)}"`)
      }
    },
  }
}

/**
 * One-line, provenance-labelled summary for the model-facing text block.
 * @param {string} action
 * @param {any} value
 * @returns {string}
 */
function summarize(action, value) {
  switch (action) {
    case 'balance': {
      const balance = value?.balance
      if (!balance) return 'Balance: no data'
      if (balance.isUnknown) return `Balance: unknown (${balance.error?.code ?? 'never fetched'})`
      const lines = balance.infos.map(
        (info) => `${info.currency} ${info.total} (granted ${info.granted ?? 'n/a'}, topped up ${info.toppedUp ?? 'n/a'})`,
      )
      const state = balance.isLive ? 'live official' : `cached official, ${balance.ageSeconds}s old`
      return `Balance [${state}]: ${lines.join('; ')}${balance.error ? ` — last refresh failed: ${balance.error.code}` : ''}`
    }
    case 'usage': {
      const usage = value?.usage
      if (!usage) return 'Usage: no data'
      const totals = usage.totals
      return `Usage ${usage.range} [harness-observed, ${usage.granularity} buckets, ${usage.timeZone}]: ${totals.calls} calls, ${totals.totalTokens} tokens (in ${totals.inputTokens}, out ${totals.outputTokens}, cache read ${totals.cacheReadTokens}), estimated USD ${usage.cost.usd.toFixed(4)}; account spend from official balance snapshots: ${usage.accountSpend.currency} ${usage.accountSpend.spent.toFixed(2)}`
    }
    case 'status': {
      const status = value?.status
      if (!status) return 'Status unavailable'
      return `Monitor status: balance poller ${status.schedulers.balance.enabled ? 'enabled' : 'disabled'} (${status.schedulers.balance.intervalSeconds}s), usage poller ${status.schedulers.usage.enabled ? 'enabled' : 'disabled'} (${status.schedulers.usage.intervalSeconds}s), key ${status.credentials.configured ? `configured via ${status.credentials.source}` : 'not configured'}, ${status.storage.callRecords} local records, ${status.alerts.active} active alerts, timezone ${status.timeZone}`
    }
    case 'alerts': {
      const alerts = value?.alerts
      if (!alerts) return 'Alerts unavailable'
      if (alerts.active.length === 0) return 'No active alerts.'
      return `Active alerts: ${alerts.active.map((alert) => `${alert.type} (${alert.message})`).join(' | ')}`
    }
    case 'refresh':
      return `Refresh ${value?.scope}: balance ${value?.balance?.ok === false ? `failed (${value.balance.error?.code})` : 'ok'}; usage ${value?.usage?.ok === false ? 'failed' : 'ok'}`
    case 'set_thresholds':
      return `Threshold overrides applied: ${Object.keys(value?.result?.applied ?? {}).join(', ') || 'none'}; rejected: ${(value?.result?.rejected ?? []).map((item) => item.field).join(', ') || 'none'}`
    case 'reset_thresholds':
      return 'Runtime threshold overrides cleared.'
    case 'clear_history':
      return `Local history cleared: ${JSON.stringify(value?.removed ?? {})}`
    default:
      return `${action}: see the structured result`
  }
}
