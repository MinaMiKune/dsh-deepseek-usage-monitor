/**
 * Threshold alerts with de-duplication and a cooldown window.
 *
 * Design rules that the code enforces:
 * - A low-balance alert is raised only from a *successful* official balance
 *   response. A network failure, timeout, or 5xx never becomes "balance is low";
 *   it becomes a request-failure or staleness alert instead.
 * - An estimated cost is never described as billed money. The daily-cost alert
 *   carries `source: 'harness-observed-estimate'` and says "estimated" in its
 *   message.
 * - While a condition keeps holding, the alert is updated in place. A repeat
 *   notification is emitted at most once per `alert_cooldown` seconds.
 * - Alerts persist (they live in the state file), so a restart does not lose an
 *   active warning or its cooldown position.
 *
 * Alert records are structured (type, value, threshold, dataAt, source) and the
 * UI localizes them; `message` is an English fallback for logs and tools.
 */

/** @typedef {'low_balance'|'daily_cost'|'daily_token'|'request_failures'|'stale_data'} AlertType */

/**
 * @typedef {object} AlertRecord
 * @property {string} id
 * @property {AlertType} type
 * @property {'warning'|'critical'} severity
 * @property {'active'|'resolved'} state
 * @property {number} firstAt
 * @property {number} lastAt
 * @property {number} count
 * @property {string} message
 * @property {number | null} value
 * @property {number | null} threshold
 * @property {number | null} dataAt
 * @property {string} source
 * @property {string} [currency]
 * @property {number} [resolvedAt]
 */

/**
 * @param {object} input
 * @param {object} input.config normalized configuration
 * @param {AlertRecord[]} input.alerts persisted alert list (mutated in place)
 * @param {number} input.now
 * @param {{ totalTokens: number, estimatedUsd: number, calls: number, zone: string, dayStart: number }} input.day
 * @param {{ state: 'never'|'ok'|'error', snapshot: any, lastSuccessAt: number | null, consecutiveFailures: number }} input.balance
 * @returns {{ raised: AlertRecord[], updated: AlertRecord[], resolved: AlertRecord[], active: AlertRecord[], nextCheckAt: number }}
 */
export function evaluateAlerts({ config, alerts, now, day, balance }) {
  const cooldownMs = config.alertCooldown * 1000
  const raised = []
  const updated = []
  const resolved = []

  /**
   * @param {string} id
   * @param {AlertType} type
   * @param {boolean} condition holds right now
   * @param {boolean} evaluable whether the condition could be evaluated at all
   * @param {{ severity: 'warning'|'critical', message: string, value: number | null, threshold: number | null, dataAt: number | null, source: string, currency?: string }} detail
   */
  const apply = (id, type, condition, evaluable, detail) => {
    const index = alerts.findIndex((alert) => alert.id === id)
    const existing = index >= 0 ? alerts[index] : undefined
    if (!condition) {
      if (existing && existing.state === 'active' && evaluable) {
        existing.state = 'resolved'
        existing.resolvedAt = now
        existing.lastAt = now
        resolved.push(existing)
      }
      return
    }
    if (!existing) {
      const record = {
        id,
        type,
        severity: detail.severity,
        state: 'active',
        firstAt: now,
        lastAt: now,
        count: 1,
        message: detail.message,
        value: detail.value,
        threshold: detail.threshold,
        dataAt: detail.dataAt,
        source: detail.source,
        ...(detail.currency ? { currency: detail.currency } : {}),
      }
      alerts.push(record)
      raised.push(record)
      return
    }
    const wasResolved = existing.state === 'resolved'
    existing.state = 'active'
    existing.severity = detail.severity
    existing.message = detail.message
    existing.value = detail.value
    existing.threshold = detail.threshold
    existing.dataAt = detail.dataAt
    existing.source = detail.source
    if (detail.currency) existing.currency = detail.currency
    if (wasResolved) {
      existing.firstAt = now
      existing.lastAt = now
      existing.count = 1
      delete existing.resolvedAt
      raised.push(existing)
      return
    }
    updated.push(existing)
    if (now - existing.lastAt >= cooldownMs) {
      existing.lastAt = now
      existing.count += 1
      raised.push(existing)
    }
  }

  // --- low balance: only from a fresh, successful official snapshot ---------
  const currency = config.lowBalanceCurrency
  const info = balance.snapshot?.infos?.find((entry) => entry.currency === currency)
  const balanceEvaluable = balance.state === 'ok' && Number.isFinite(info?.total)
  const threshold = config.lowBalanceThreshold
  apply(
    `low_balance:${currency}`,
    'low_balance',
    config.alerts.low_balance && threshold > 0 && balanceEvaluable && info.total < threshold,
    config.alerts.low_balance && threshold > 0 && balance.state === 'ok',
    {
      severity: balanceEvaluable && info.total <= threshold / 2 ? 'critical' : 'warning',
      message: balanceEvaluable
        ? `Balance ${currency} ${formatAmount(info.total)} is below the configured threshold ${formatAmount(threshold)}`
        : `Balance ${currency} is below the configured threshold ${formatAmount(threshold)}`,
      value: balanceEvaluable ? info.total : null,
      threshold,
      dataAt: balance.snapshot?.fetchedAt ?? null,
      // The alert must name the route that produced the number, so a signed-in
      // account balance is not mislabelled as an API-key reading.
      source: balance.snapshot?.source ?? 'official-api',
      currency,
    },
  )

  // --- daily estimated cost ------------------------------------------------
  apply(
    'daily_cost:USD',
    'daily_cost',
    config.alerts.daily_cost && config.dailyCostThreshold > 0 && day.estimatedUsd > config.dailyCostThreshold,
    config.alerts.daily_cost && config.dailyCostThreshold > 0,
    {
      severity: 'warning',
      message: `Estimated cost today is USD ${formatAmount(day.estimatedUsd)}, above the threshold USD ${formatAmount(config.dailyCostThreshold)} (estimate from the price table, not a billed amount)`,
      value: day.estimatedUsd,
      threshold: config.dailyCostThreshold,
      dataAt: now,
      source: 'harness-observed-estimate',
      currency: 'USD',
    },
  )

  // --- daily observed tokens ----------------------------------------------
  apply(
    'daily_token',
    'daily_token',
    config.alerts.daily_token && config.dailyTokenThreshold > 0 && day.totalTokens > config.dailyTokenThreshold,
    config.alerts.daily_token && config.dailyTokenThreshold > 0,
    {
      severity: 'warning',
      message: `Observed ${day.totalTokens} tokens today, above the threshold ${config.dailyTokenThreshold} (Harness-observed only)`,
      value: day.totalTokens,
      threshold: config.dailyTokenThreshold,
      dataAt: now,
      source: 'harness-observed',
    },
  )

  // --- consecutive balance-fetch failures ----------------------------------
  apply(
    'request_failures',
    'request_failures',
    config.alerts.request_failures && balance.consecutiveFailures >= config.failureStreakThreshold,
    config.alerts.request_failures,
    {
      severity: 'critical',
      message: `${balance.consecutiveFailures} consecutive balance refreshes failed; the displayed balance is unchanged and may be stale`,
      value: balance.consecutiveFailures,
      threshold: config.failureStreakThreshold,
      dataAt: balance.lastSuccessAt,
      source: balance.snapshot?.source ?? 'official-api',
    },
  )

  // --- stale data ----------------------------------------------------------
  const staleAfterMs = config.staleAfter * 1000
  const staleEvaluable = balance.lastSuccessAt !== null
  apply(
    'stale_data:balance',
    'stale_data',
    config.alerts.stale_data && staleEvaluable && now - Number(balance.lastSuccessAt) > staleAfterMs,
    config.alerts.stale_data && staleEvaluable,
    {
      severity: 'warning',
      message: `Balance data is older than the staleness limit (${Math.round(config.staleAfter / 60)} min)`,
      value: now - Number(balance.lastSuccessAt ?? now),
      threshold: staleAfterMs,
      dataAt: balance.lastSuccessAt,
      source: balance.snapshot?.source ?? 'official-api',
    },
  )

  const active = alerts.filter((alert) => alert.state === 'active')
  const soonest = active.reduce((next, alert) => {
    const due = alert.lastAt + cooldownMs
    return due < next ? due : next
  }, Number.POSITIVE_INFINITY)
  return {
    raised,
    updated,
    resolved,
    active,
    nextCheckAt: Number.isFinite(soonest) ? soonest : now + 60_000,
  }
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatAmount(value) {
  if (!Number.isFinite(value)) return 'n/a'
  const abs = Math.abs(value)
  if (abs >= 1000) return value.toFixed(2)
  if (abs >= 1) return value.toFixed(2)
  return value.toFixed(4)
}
