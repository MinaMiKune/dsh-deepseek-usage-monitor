import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalizeConfig } from '../lib/config.js'

test('an empty configuration yields documented defaults', () => {
  const { config, issues } = normalizeConfig(undefined)
  assert.deepEqual(issues, [])
  assert.equal(config.apiKey, null)
  assert.equal(config.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(config.apiBaseUrl, 'https://api.deepseek.com')
  assert.equal(config.balancePollInterval, 300)
  assert.equal(config.usagePollInterval, 120)
  assert.equal(config.requestTimeout, 15_000)
  assert.equal(config.maxRetries, 2)
  assert.equal(config.alertCooldown, 3_600)
  assert.equal(config.historyRetentionDays, 30)
  assert.equal(config.failureStreakThreshold, 3)
  assert.equal(config.alerts.low_balance, true)
  assert.equal(config.priceTable, null)
})

test('unit-bearing fields keep the documented units', () => {
  const { config } = normalizeConfig({
    balance_poll_interval: 60,
    usage_poll_interval: 90,
    request_timeout: 5_000,
    alert_cooldown: 120,
    stale_after: 300,
  })
  assert.equal(config.balancePollInterval, 60)
  assert.equal(config.usagePollInterval, 90)
  assert.equal(config.requestTimeout, 5_000)
  assert.equal(config.alertCooldown, 120)
  assert.equal(config.staleAfter, 300)
})

test('stale_after defaults to 2.5x the balance interval, never below 600s', () => {
  assert.equal(normalizeConfig({}).config.staleAfter, 750)
  assert.equal(normalizeConfig({ balance_poll_interval: 60 }).config.staleAfter, 600)
  assert.equal(normalizeConfig({ balance_poll_interval: 3_600 }).config.staleAfter, 9_000)
})

test('invalid scalar values fall back and are reported, never silently clamped', () => {
  const { config, issues } = normalizeConfig({
    balance_poll_interval: 5,
    usage_poll_interval: 'soon',
    request_timeout: -1,
    max_retries: 99,
    alert_cooldown: 'x',
    low_balance_currency: 'renminbi',
    history_retention_days: 0,
    failure_streak_threshold: 1.5,
  })
  assert.equal(config.balancePollInterval, DEFAULTS.balance_poll_interval)
  assert.equal(config.usagePollInterval, DEFAULTS.usage_poll_interval)
  assert.equal(config.requestTimeout, DEFAULTS.request_timeout)
  assert.equal(config.maxRetries, DEFAULTS.max_retries)
  assert.equal(config.alertCooldown, DEFAULTS.alert_cooldown)
  assert.equal(config.lowBalanceCurrency, DEFAULTS.low_balance_currency)
  assert.equal(config.historyRetentionDays, DEFAULTS.history_retention_days)
  assert.equal(config.failureStreakThreshold, DEFAULTS.failure_streak_threshold)
  const fields = issues.map((issue) => issue.field).sort()
  assert.deepEqual(fields, [
    'alert_cooldown',
    'balance_poll_interval',
    'failure_streak_threshold',
    'history_retention_days',
    'low_balance_currency',
    'max_retries',
    'request_timeout',
    'usage_poll_interval',
  ])
})

test('numeric strings from YAML are accepted', () => {
  const { config, issues } = normalizeConfig({ balance_poll_interval: '600', max_retries: '1' })
  assert.equal(config.balancePollInterval, 600)
  assert.equal(config.maxRetries, 1)
  assert.deepEqual(issues, [])
})

test('an unknown timezone is reported and degrades to the host zone', () => {
  const { config, issues } = normalizeConfig({ timezone: 'Mars/Olympus' })
  assert.equal(config.timeZone, '')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'timezone')
  const valid = normalizeConfig({ timezone: 'Asia/Shanghai' })
  assert.equal(valid.config.timeZone, 'Asia/Shanghai')
  assert.deepEqual(valid.issues, [])
})

test('alerts can be disabled individually and a bad value is reported', () => {
  const { config, issues } = normalizeConfig({ alerts: { low_balance: false, daily_cost: 'yes' } })
  assert.equal(config.alerts.low_balance, false)
  assert.equal(config.alerts.daily_cost, DEFAULTS.alerts.daily_cost)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'alerts.daily_cost')
})

test('the API key is never echoed into diagnostics', () => {
  const secret = 'sk-super-secret-value-123456'
  const { config, issues } = normalizeConfig({ api_key: secret, api_base_url: 'not-a-url' })
  assert.equal(config.apiKey, secret)
  assert.equal(JSON.stringify(issues).includes(secret), false)
  assert.equal(JSON.stringify(config).includes('authorization'), false)
})

test('an empty api_key is treated as absent rather than as a credential', () => {
  assert.equal(normalizeConfig({ api_key: '' }).config.apiKey, null)
  assert.equal(normalizeConfig({ api_key: '   ' }).config.apiKey, null)
})

test('api_key_env must look like an environment variable name', () => {
  const { config, issues } = normalizeConfig({ api_key_env: 'not a name' })
  assert.equal(config.apiKeyEnv, DEFAULTS.api_key_env)
  assert.equal(issues[0].field, 'api_key_env')
})

test('api_base_url is normalized to an origin plus path without a trailing slash', () => {
  assert.equal(normalizeConfig({ api_base_url: 'https://api.deepseek.com/' }).config.apiBaseUrl, 'https://api.deepseek.com')
  assert.equal(
    normalizeConfig({ api_base_url: 'http://127.0.0.1:8080/proxy/' }).config.apiBaseUrl,
    'http://127.0.0.1:8080/proxy',
  )
  const bad = normalizeConfig({ api_base_url: 'ftp://example.com' })
  assert.equal(bad.config.apiBaseUrl, DEFAULTS.api_base_url)
  assert.equal(bad.issues[0].field, 'api_base_url')
})

test('a custom price table must declare peak and off_peak rates', () => {
  const { config, issues } = normalizeConfig({
    price_table: {
      'my-model': {
        peak: { cache_hit: 1, cache_miss: 2, output: 3 },
        off_peak: { cache_hit: 0.5, cache_miss: 1, output: 1.5 },
      },
      broken: { peak: { cache_hit: 1 } },
    },
  })
  assert.deepEqual(config.priceTable['my-model'].peak, { cacheHit: 1, cacheMiss: 2, output: 3 })
  assert.deepEqual(config.priceTable['my-model'].offPeak, { cacheHit: 0.5, cacheMiss: 1, output: 1.5 })
  assert.equal(config.priceTable.broken, undefined)
  assert.equal(issues.some((issue) => issue.field === 'price_table.broken'), true)
})

test('tracked_providers filters to a clean string list', () => {
  assert.deepEqual(normalizeConfig({ tracked_providers: ['deepseek-official'] }).config.trackedProviders, ['deepseek-official'])
  const bad = normalizeConfig({ tracked_providers: ['ok', 5] })
  assert.deepEqual(bad.config.trackedProviders, [])
  assert.equal(bad.issues[0].field, 'tracked_providers')
})
