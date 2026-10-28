import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { evaluateAlerts } from '../lib/alerts.js'

/** @param {Record<string, unknown>} [overrides] */
function configWith(overrides = {}) {
  return normalizeConfig({
    low_balance_threshold: 10,
    low_balance_currency: 'CNY',
    daily_cost_threshold: 5,
    daily_token_threshold: 1_000,
    alert_cooldown: 60,
    failure_streak_threshold: 3,
    stale_after: 600,
    ...overrides,
  }).config
}

/** @param {Partial<Record<string, unknown>>} [overrides] */
function balanceWith(overrides = {}) {
  return {
    state: 'ok',
    snapshot: { isAvailable: true, infos: [{ currency: 'CNY', total: 5, granted: 0, toppedUp: 5 }], fetchedAt: 1_000 },
    lastSuccessAt: 1_000,
    consecutiveFailures: 0,
    ...overrides,
  }
}

/** @param {Partial<Record<string, unknown>>} [overrides] */
function dayWith(overrides = {}) {
  return { totalTokens: 0, estimatedUsd: 0, calls: 0, zone: 'Asia/Shanghai', dayStart: 0, ...overrides }
}

test('a low balance raises once from a successful snapshot', () => {
  const config = configWith()
  /** @type {any[]} */
  const alerts = []
  const result = evaluateAlerts({
    config,
    alerts,
    now: 2_000,
    day: dayWith(),
    balance: balanceWith(),
  })
  assert.equal(result.raised.length, 1)
  const alert = result.raised[0]
  assert.equal(alert.id, 'low_balance:CNY')
  assert.equal(alert.type, 'low_balance')
  assert.equal(alert.severity, 'critical')
  assert.equal(alert.value, 5)
  assert.equal(alert.threshold, 10)
  assert.equal(alert.dataAt, 1_000)
  assert.equal(alert.source, 'official-api')
  assert.equal(result.active.length, 1)
})

test('the alert is de-duplicated inside the cooldown and re-emitted after it', () => {
  const config = configWith()
  /** @type {any[]} */
  const alerts = []
  evaluateAlerts({ config, alerts, now: 2_000, day: dayWith(), balance: balanceWith() })

  const withinCooldown = evaluateAlerts({ config, alerts, now: 30_000, day: dayWith(), balance: balanceWith() })
  assert.equal(withinCooldown.raised.length, 0, 'no duplicate notification inside the cooldown')
  assert.equal(withinCooldown.updated.length, 1)
  assert.equal(alerts[0].count, 1)

  const afterCooldown = evaluateAlerts({ config, alerts, now: 90_000, day: dayWith(), balance: balanceWith() })
  assert.equal(afterCooldown.raised.length, 1)
  assert.equal(alerts[0].count, 2)
  assert.equal(alerts.length, 1, 'still one alert record, not two')
})

test('the alert resolves when the balance recovers and re-raises afterwards', () => {
  const config = configWith()
  /** @type {any[]} */
  const alerts = []
  evaluateAlerts({ config, alerts, now: 2_000, day: dayWith(), balance: balanceWith() })
  const recovered = balanceWith({
    snapshot: { isAvailable: true, infos: [{ currency: 'CNY', total: 20, granted: 0, toppedUp: 20 }], fetchedAt: 5_000 },
    lastSuccessAt: 5_000,
  })
  const resolved = evaluateAlerts({ config, alerts, now: 6_000, day: dayWith(), balance: recovered })
  assert.equal(resolved.resolved.length, 1)
  assert.equal(alerts[0].state, 'resolved')
  assert.equal(resolved.active.length, 0)

  const again = evaluateAlerts({ config, alerts, now: 7_000, day: dayWith(), balance: balanceWith({ lastSuccessAt: 7_000 }) })
  assert.equal(again.raised.length, 1)
  assert.equal(again.raised[0].state, 'active')
  assert.equal(again.raised[0].count, 1, 'a re-raised alert restarts its count')
})

test('the low-balance alert names the route that produced the balance', () => {
  const config = configWith()
  /** @type {any[]} */
  const fromAccount = []
  const account = evaluateAlerts({
    config,
    alerts: fromAccount,
    now: 2_000,
    day: dayWith(),
    balance: balanceWith({
      snapshot: {
        isAvailable: null,
        infos: [{ currency: 'CNY', total: 5, granted: 5, toppedUp: 0 }],
        fetchedAt: 1_000,
        source: 'official-account',
      },
    }),
  })
  assert.equal(account.raised[0].source, 'official-account')

  /** @type {any[]} */
  const fromApi = []
  const api = evaluateAlerts({ config, alerts: fromApi, now: 2_000, day: dayWith(), balance: balanceWith() })
  assert.equal(api.raised[0].source, 'official-api')
})

test('a network error never raises or silently clears a low-balance alert', () => {
  const config = configWith()
  /** @type {any[]} */
  const alerts = []
  const failed = balanceWith({ state: 'error', consecutiveFailures: 1 })
  const result = evaluateAlerts({ config, alerts, now: 2_000, day: dayWith(), balance: failed })
  assert.equal(result.raised.length, 0, 'a stale cached snapshot must not raise a fresh alert')
  assert.equal(alerts.length, 0)

  // Now the alert is active and the next refresh fails: it must stay active.
  evaluateAlerts({ config, alerts, now: 2_000, day: dayWith(), balance: balanceWith() })
  const failedAgain = evaluateAlerts({ config, alerts, now: 10_000, day: dayWith(), balance: failed })
  assert.equal(failedAgain.resolved.length, 0)
  assert.equal(alerts[0].state, 'active')
})

test('a failure streak raises its own alert with the count as the value', () => {
  const config = configWith()
  /** @type {any[]} */
  const alerts = []
  const result = evaluateAlerts({
    config,
    alerts,
    now: 2_000,
    day: dayWith(),
    balance: balanceWith({ state: 'error', consecutiveFailures: 3, lastSuccessAt: null }),
  })
  const failure = result.raised.find((alert) => alert.type === 'request_failures')
  assert.ok(failure)
  assert.equal(failure.value, 3)
  assert.equal(failure.threshold, 3)
})

test('stale data raises only after a previous success', () => {
  const config = configWith()
  /** @type {any[]} */
  const fresh = []
  const notYet = evaluateAlerts({
    config,
    alerts: fresh,
    now: 2_000,
    day: dayWith(),
    balance: balanceWith({ lastSuccessAt: null, state: 'error' }),
  })
  assert.equal(notYet.raised.some((alert) => alert.type === 'stale_data'), false)

  /** @type {any[]} */
  const stale = []
  const result = evaluateAlerts({
    config,
    alerts: stale,
    now: 1_000 + 601_000,
    day: dayWith(),
    balance: balanceWith({ lastSuccessAt: 1_000 }),
  })
  const alert = result.raised.find((entry) => entry.type === 'stale_data')
  assert.ok(alert)
  assert.equal(alert.threshold, 600_000)
})

test('daily cost and token thresholds raise while staying separate from official data', () => {
  const config = configWith()
  /** @type {any[]} */
  const alerts = []
  const result = evaluateAlerts({
    config,
    alerts,
    now: 2_000,
    day: dayWith({ totalTokens: 2_000, estimatedUsd: 7.5, calls: 4 }),
    balance: balanceWith({
      snapshot: { isAvailable: true, infos: [{ currency: 'CNY', total: 100, granted: 0, toppedUp: 100 }], fetchedAt: 1_000 },
    }),
  })
  const cost = result.raised.find((alert) => alert.type === 'daily_cost')
  const tokens = result.raised.find((alert) => alert.type === 'daily_token')
  assert.ok(cost)
  assert.equal(cost.source, 'harness-observed-estimate')
  assert.match(cost.message, /estimate/i)
  assert.ok(tokens)
  assert.equal(tokens.source, 'harness-observed')
  assert.equal(tokens.value, 2_000)
})

test('disabled alert types do not raise, and their enable flag is respected', () => {
  const config = configWith({ alerts: { low_balance: false, daily_cost: false, daily_token: false } })
  /** @type {any[]} */
  const alerts = []
  const result = evaluateAlerts({
    config,
    alerts,
    now: 2_000,
    day: dayWith({ totalTokens: 9_999, estimatedUsd: 99 }),
    balance: balanceWith(),
  })
  assert.equal(result.raised.length, 0)
  assert.equal(alerts.length, 0)

  // Re-enabling only one type raises only that type.
  const enabled = configWith({ alerts: { low_balance: false, daily_cost: true, daily_token: true } })
  /** @type {any[]} */
  const second = []
  const raised = evaluateAlerts({
    config: enabled,
    alerts: second,
    now: 2_000,
    day: dayWith({ totalTokens: 9_999, estimatedUsd: 99 }),
    balance: balanceWith(),
  })
  assert.deepEqual(
    raised.raised.map((alert) => alert.type).sort(),
    ['daily_cost', 'daily_token'],
  )
})

test('a zero threshold means the alert is off', () => {
  const config = configWith({ low_balance_threshold: 0 })
  /** @type {any[]} */
  const alerts = []
  const result = evaluateAlerts({ config, alerts, now: 2_000, day: dayWith(), balance: balanceWith() })
  assert.equal(alerts.length, 0)
  assert.equal(result.raised.length, 0)
})

test('alerts persist their resolution timestamp and survive a serialization round-trip', () => {
  const config = configWith()
  /** @type {any[]} */
  const alerts = []
  evaluateAlerts({ config, alerts, now: 2_000, day: dayWith(), balance: balanceWith() })
  const recovered = balanceWith({
    snapshot: { isAvailable: true, infos: [{ currency: 'CNY', total: 30, granted: 0, toppedUp: 30 }], fetchedAt: 3_000 },
    lastSuccessAt: 3_000,
  })
  evaluateAlerts({ config, alerts, now: 4_000, day: dayWith(), balance: recovered })
  const roundTripped = JSON.parse(JSON.stringify(alerts))
  assert.equal(roundTripped[0].state, 'resolved')
  assert.equal(roundTripped[0].resolvedAt, 4_000)
})
