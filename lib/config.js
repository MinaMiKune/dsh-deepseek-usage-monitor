/**
 * Configuration defaults, validation, and normalization.
 *
 * The package deliberately does not export a Cordis `Config` schema: a plugin
 * bundle installed outside the dsh installation cannot resolve
 * `@deepseek-ai/schemastery` (its dependencies resolve from the profile, which
 * holds only installed bundles), and an unresolvable schema would fail
 * activation. Validation therefore runs here at activation: every field is
 * type-checked and range-checked, invalid values fall back to their default,
 * and each fallback is reported in `issues` so the panel and the log say what
 * happened instead of silently ignoring a typo.
 *
 * Units are part of each name's contract and are stated in `FIELD_DOCS`:
 * intervals and cooldowns are seconds, `request_timeout` is milliseconds.
 */

import { validateTimeZone } from './time.js'

/** @typedef {{ field: string, message: string, received?: string, used: string }} ConfigIssue */

/** Documented defaults; also the fallback for every rejected value. */
export const DEFAULTS = Object.freeze({
  api_key: null,
  api_key_env: 'DEEPSEEK_API_KEY',
  api_base_url: 'https://api.deepseek.com',
  balance_source: 'auto',
  balance_poll_interval: 300,
  usage_poll_interval: 120,
  request_timeout: 15_000,
  max_retries: 2,
  retry_backoff: 1_000,
  low_balance_threshold: 10,
  low_balance_currency: 'CNY',
  daily_cost_threshold: 0,
  daily_token_threshold: 0,
  alert_cooldown: 3_600,
  failure_streak_threshold: 3,
  stale_after: 0,
  history_retention_days: 30,
  timezone: '',
  debug: false,
  auto_start: true,
  data_dir: '',
  max_call_records: 20_000,
  tracked_providers: [],
  alerts: Object.freeze({
    low_balance: true,
    daily_cost: true,
    daily_token: true,
    request_failures: true,
    stale_data: true,
  }),
  price_table: null,
})

/** Human-readable unit and meaning per field, used by the docs endpoint. */
export const FIELD_DOCS = Object.freeze({
  api_key: 'Literal DeepSeek API key. Discouraged: prefer api_key_env or the credentials service.',
  api_key_env: 'Credential reference resolved through ctx.credentials, then process.env, then .env.',
  api_base_url: 'DeepSeek API origin; the balance endpoint is GET {origin}/user/balance.',
  balance_source:
    'auto (API key when one is resolvable, otherwise the signed-in DeepSeek account), api-key, or account.',
  balance_poll_interval: 'Seconds between balance polls (30-86400).',
  usage_poll_interval: 'Seconds between local usage re-aggregations (30-86400); performs no network I/O.',
  request_timeout: 'Milliseconds allowed for one balance HTTP attempt (1000-120000).',
  max_retries: 'Retries after the first balance attempt (0-5).',
  retry_backoff: 'Base exponential-backoff delay in milliseconds (100-30000).',
  low_balance_threshold: 'Alert when the configured currency total falls below this amount (0 disables).',
  low_balance_currency: 'ISO-4217 currency whose balance_infos entry is compared (default CNY).',
  daily_cost_threshold: 'Alert when the estimated cost of the current timezone day exceeds this USD amount (0 disables).',
  daily_token_threshold: 'Alert when the observed total tokens of the current timezone day exceed this count (0 disables).',
  alert_cooldown: 'Seconds an unchanged active alert is suppressed for (0-86400).',
  failure_streak_threshold: 'Consecutive failed balance refreshes that raise a request-failure alert.',
  stale_after: 'Seconds without a successful balance refresh before a staleness alert (0 = auto).',
  history_retention_days: 'Days of local call records and balance snapshots kept on disk (1-365).',
  timezone: 'IANA zone used for day/hour buckets and daily thresholds; empty uses the host zone.',
  debug: 'Emit verbose diagnostics (never credentials, prompts, or response bodies).',
  auto_start: 'Start the pollers when the plugin activates.',
  data_dir: 'Directory for the state file; empty uses $DSH_HOME/deepseek-usage-monitor.',
  max_call_records: 'Maximum persisted local call records (100-200000).',
  tracked_providers: 'Provider routes to record; empty records every route.',
  alerts: 'Per-alert-type enable switches.',
  price_table: 'Price overrides in USD per 1M tokens; null uses the built-in DeepSeek table.',
})

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** @param {unknown} value */
const describe = (value) => {
  if (value === undefined) return 'undefined'
  try {
    const text = JSON.stringify(value)
    return text.length > 80 ? `${text.slice(0, 77)}...` : text
  } catch {
    return typeof value
  }
}

/**
 * Normalize and validate raw plugin configuration.
 * @param {unknown} raw configuration as read from the Cordis entry.
 * @returns {{ config: Record<string, any>, issues: ConfigIssue[] }}
 */
export function normalizeConfig(raw) {
  /** @type {ConfigIssue[]} */
  const issues = []
  const source = isObject(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isObject(raw)) {
    issues.push({ field: '<root>', message: 'configuration is not an object', received: describe(raw), used: '{}' })
  }

  /**
   * @param {string} field
   * @param {(value: unknown, fallback: unknown) => unknown} read
   * @param {unknown} fallback
   */
  const take = (field, read, fallback) => {
    const value = Object.prototype.hasOwnProperty.call(source, field) ? source[field] : undefined
    if (value === undefined) return fallback
    const result = read(value, fallback)
    if (result === BREAK) {
      issues.push({
        field,
        message: 'invalid value',
        received: describe(value),
        used: describe(fallback),
      })
      return fallback
    }
    return result
  }

  const number = (min, max) => (value, fallback) => {
    if (typeof value === 'string' && value.trim() !== '') value = Number(value)
    if (typeof value !== 'number' || !Number.isFinite(value)) return BREAK
    if (value < min || value > max) return BREAK
    return value
  }
  const integer = (min, max) => (value, fallback) => {
    const parsed = number(min, max)(value, fallback)
    if (parsed === BREAK) return BREAK
    if (!Number.isInteger(parsed)) return BREAK
    return parsed
  }
  const boolean = (value) => (typeof value === 'boolean' ? value : BREAK)
  const text = (value) => (typeof value === 'string' ? value : BREAK)

  const cliIssues = []

  const apiKeyRaw = source.api_key
  let apiKey = null
  if (apiKeyRaw !== undefined && apiKeyRaw !== null && apiKeyRaw !== '') {
    if (typeof apiKeyRaw === 'string' && apiKeyRaw.trim() !== '') apiKey = apiKeyRaw.trim()
    else cliIssues.push({ field: 'api_key', message: 'not a non-empty string', used: 'null' })
  }

  const apiKeyEnv = take('api_key_env', (value) => {
    if (typeof value !== 'string') return BREAK
    const trimmed = value.trim()
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? trimmed : BREAK
  }, DEFAULTS.api_key_env)

  const apiBaseUrl = take('api_base_url', (value) => {
    if (typeof value !== 'string' || value.trim() === '') return BREAK
    try {
      const url = new URL(value.trim())
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return BREAK
      return url.origin + url.pathname.replace(/\/+$/, '')
    } catch {
      return BREAK
    }
  }, DEFAULTS.api_base_url)

  const balanceSource = take('balance_source', (value) => {
    if (typeof value !== 'string') return BREAK
    const normalized = value.trim().toLowerCase().replace(/_/g, '-')
    return ['auto', 'api-key', 'account'].includes(normalized) ? normalized : BREAK
  }, DEFAULTS.balance_source)

  const timezoneRaw = take('timezone', (value) => (typeof value === 'string' ? value.trim() : BREAK), DEFAULTS.timezone)
  let timeZone = ''
  if (timezoneRaw !== '') {
    const validated = validateTimeZone(timezoneRaw)
    if (validated === undefined) {
      issues.push({ field: 'timezone', message: 'unknown IANA timezone', received: describe(timezoneRaw), used: 'host timezone' })
      timeZone = ''
    } else {
      timeZone = validated
    }
  }

  const alertsRaw = isObject(source.alerts) ? source.alerts : {}
  if (source.alerts !== undefined && source.alerts !== null && !isObject(source.alerts)) {
    issues.push({ field: 'alerts', message: 'not an object', received: describe(source.alerts), used: 'defaults' })
  }
  const alerts = {}
  for (const key of Object.keys(DEFAULTS.alerts)) {
    const value = alertsRaw[key]
    if (value === undefined) alerts[key] = DEFAULTS.alerts[key]
    else if (typeof value === 'boolean') alerts[key] = value
    else {
      alerts[key] = DEFAULTS.alerts[key]
      issues.push({ field: `alerts.${key}`, message: 'not a boolean', received: describe(value), used: describe(alerts[key]) })
    }
  }

  let priceTable = null
  if (isObject(source.price_table)) {
    /** @type {Record<string, any>} */
    const models = {}
    for (const [model, entry] of Object.entries(source.price_table)) {
      if (!isObject(entry)) {
        issues.push({ field: `price_table.${model}`, message: 'not an object', received: describe(entry), used: 'ignored' })
        continue
      }
      const peak = isObject(entry.peak) ? entry.peak : null
      const offPeak = isObject(entry.off_peak) ? entry.off_peak : null
      if (!peak || !offPeak) {
        issues.push({
          field: `price_table.${model}`,
          message: 'peak and off_peak price objects are required',
          received: describe(entry),
          used: 'ignored',
        })
        continue
      }
      models[model] = { peak: snapshotPrice(peak, `price_table.${model}.peak`, issues), offPeak: snapshotPrice(offPeak, `price_table.${model}.off_peak`, issues) }
    }
    if (Object.keys(models).length > 0) priceTable = models
  } else if (source.price_table !== undefined && source.price_table !== null) {
    issues.push({ field: 'price_table', message: 'not an object', received: describe(source.price_table), used: 'built-in table' })
  }

  const trackedProviders = take('tracked_providers', (value) => {
    if (!Array.isArray(value)) return BREAK
    const list = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    return list.length === value.length ? list : BREAK
  }, DEFAULTS.tracked_providers)

  const balancePollInterval = take('balance_poll_interval', number(30, 86_400), DEFAULTS.balance_poll_interval)
  const staleAfter = take('stale_after', number(0, 86_400), DEFAULTS.stale_after)

  const config = {
    apiKey,
    apiKeyEnv,
    apiBaseUrl,
    balanceSource,
    balancePollInterval: balancePollInterval,
    usagePollInterval: take('usage_poll_interval', number(30, 86_400), DEFAULTS.usage_poll_interval),
    requestTimeout: take('request_timeout', integer(1_000, 120_000), DEFAULTS.request_timeout),
    maxRetries: take('max_retries', integer(0, 5), DEFAULTS.max_retries),
    retryBackoff: take('retry_backoff', integer(100, 30_000), DEFAULTS.retry_backoff),
    lowBalanceThreshold: take('low_balance_threshold', number(0, 1_000_000_000), DEFAULTS.low_balance_threshold),
    lowBalanceCurrency: take('low_balance_currency', (value) => {
      if (typeof value !== 'string') return BREAK
      const upper = value.trim().toUpperCase()
      return /^[A-Z]{3}$/.test(upper) ? upper : BREAK
    }, DEFAULTS.low_balance_currency),
    dailyCostThreshold: take('daily_cost_threshold', number(0, 1_000_000), DEFAULTS.daily_cost_threshold),
    dailyTokenThreshold: take('daily_token_threshold', integer(0, 10_000_000_000), DEFAULTS.daily_token_threshold),
    alertCooldown: take('alert_cooldown', number(0, 86_400), DEFAULTS.alert_cooldown),
    failureStreakThreshold: take('failure_streak_threshold', integer(1, 20), DEFAULTS.failure_streak_threshold),
    staleAfter: staleAfter === 0 ? Math.max(600, Math.round(balancePollInterval * 2.5)) : staleAfter,
    staleAfterConfigured: staleAfter !== 0,
    historyRetentionDays: take('history_retention_days', integer(1, 365), DEFAULTS.history_retention_days),
    timeZone,
    debug: take('debug', boolean, DEFAULTS.debug),
    autoStart: take('auto_start', boolean, DEFAULTS.auto_start),
    dataDir: take('data_dir', (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : BREAK), DEFAULTS.data_dir),
    maxCallRecords: take('max_call_records', integer(100, 200_000), DEFAULTS.max_call_records),
    trackedProviders,
    alerts,
    priceTable,
  }

  return { config, issues: [...cliIssues, ...issues] }
}

/**
 * @param {Record<string, any>} entry
 * @param {string} field
 * @param {ConfigIssue[]} issues
 */
function snapshotPrice(entry, field, issues) {
  const pick = (name) => {
    const value = entry[name]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      issues.push({ field: `${field}.${name}`, message: 'expected a non-negative number', received: describe(value), used: '0' })
      return 0
    }
    return value
  }
  return {
    cacheHit: pick('cache_hit'),
    cacheMiss: pick('cache_miss'),
    output: pick('output'),
  }
}

const BREAK = Symbol('invalid')
