/**
 * The monitor service: balance polling, local usage recording, aggregation,
 * alert evaluation, and the query surface shared by the agent tools and the
 * Web panel.
 *
 * This class is deliberately free of Cordis types: it receives plain
 * dependencies (config, logger, store, an optional credentials service) so the
 * whole behaviour is testable in Node without a Harness process. `index.js`
 * adapts it to a Cordis context.
 */

import { createHash, randomUUID } from 'node:crypto'
import { Poller } from './scheduler.js'
import { dayKey, nextDayStart, resolveRange, systemTimeZone, zonedStartOfDay } from './time.js'
import { API_ERROR_CODES, BalanceApiError, fetchBalance } from './deepseek-api.js'
import { AccountApiError, accountClientMetadata, fetchAccountBalance } from './account.js'
import { aggregateDay, aggregateUsage, deriveBalanceDeltas, validateCallRecord } from './usage.js'
import { evaluateAlerts } from './alerts.js'
import { PRICE_SOURCE } from './pricing.js'
import { FIELD_DOCS } from './config.js'

/** Fields a runtime threshold override may change. */
const OVERRIDABLE = Object.freeze({
  low_balance_threshold: { min: 0, max: 1_000_000_000, integer: false },
  daily_cost_threshold: { min: 0, max: 1_000_000, integer: false },
  daily_token_threshold: { min: 0, max: 10_000_000_000, integer: true },
  alert_cooldown: { min: 0, max: 86_400, integer: false },
  failure_streak_threshold: { min: 1, max: 20, integer: true },
})

/** Map an override field to its normalized config key. */
const OVERRIDE_TO_CONFIG = Object.freeze({
  low_balance_threshold: 'lowBalanceThreshold',
  daily_cost_threshold: 'dailyCostThreshold',
  daily_token_threshold: 'dailyTokenThreshold',
  alert_cooldown: 'alertCooldown',
  failure_streak_threshold: 'failureStreakThreshold',
})

/** Maximum number of scheduled notifications retained in memory. */
const MAX_NOTIFICATIONS = 50

export class UsageMonitor {
  /**
   * @param {{
   *   config: Record<string, any>,
   *   issues?: Array<Record<string, any>>,
   *   logger: ReturnType<typeof import('./log.js').createLogger>,
   *   store: import('./store.js').StateStore,
   *   credentials?: { resolve: Function, describe?: Function } | null,
   *   clock?: { now: () => number, setTimeout?: Function, clearTimeout?: Function },
   *   fetchImpl?: typeof fetch,
   *   env?: Record<string, string | undefined>,
   *   sleep?: (ms: number) => Promise<void>,
   *   random?: () => number,
   * }} options
   */
  constructor(options) {
    this.config = options.config
    this.issues = options.issues ?? []
    this.logger = options.logger
    this.store = options.store
    this.credentials = options.credentials ?? null
    /** @type {(() => any) | null} */
    this.getAccount = options.getAccount ?? null
    this.clock = options.clock ?? { now: () => Date.now() }
    this.fetchImpl = options.fetchImpl
    this.env = options.env ?? process.env
    this.sleep = options.sleep
    this.random = options.random

    this.startedAt = null
    this.timeZone = this.config.timeZone || systemTimeZone()
    this.timeZoneConfigured = Boolean(this.config.timeZone)
    this.shutdown = new AbortController()
    this.dirty = false
    /** @type {any} */
    this.flushTimer = null
    /** @type {Promise<unknown> | null} */
    this.balanceTask = null
    this.observations = 0
    this.ignoredObservations = 0
    this.lastUsageRefreshAt = null
    this.lastError = null
    this.initError = null
    /** @type {'api-key' | 'account' | null} */
    this.lastBalanceProvider = null
    /** @type {Array<Record<string, any>>} */
    this.notifications = []
    /** @type {Set<(notification: Record<string, any>) => void>} */
    this.observers = new Set()

    this.balancePoller = new Poller({
      name: 'balance',
      intervalMs: this.config.balancePollInterval * 1000,
      logger: this.logger,
      clock: this.clock,
      run: ({ signal, reason }) => this.refreshBalance({ reason, signal }),
    })
    this.usagePoller = new Poller({
      name: 'usage',
      intervalMs: this.config.usagePollInterval * 1000,
      logger: this.logger,
      clock: this.clock,
      run: ({ signal }) => this.refreshUsage({ signal }),
    })
  }

  /** Load persisted state from disk. */
  async init() {
    const result = await this.store.load()
    this.logger?.debug?.('state loaded', result)
    return result
  }

  /** Effective configuration with persisted runtime overrides applied. */
  effectiveConfig() {
    const overrides = this.store.state.overrides ?? {}
    /** @type {Record<string, any>} */
    const merged = { ...this.config }
    for (const [field, value] of Object.entries(overrides)) {
      const key = OVERRIDE_TO_CONFIG[field]
      if (key) merged[key] = value
    }
    return merged
  }

  /** Subscribe to alert/staleness notifications. Returns an unsubscribe function. */
  subscribe(observer) {
    this.observers.add(observer)
    return () => this.observers.delete(observer)
  }

  /** Start both pollers. */
  start() {
    if (this.startedAt !== null) return
    this.startedAt = this.clock.now()
    this.balancePoller.start()
    this.usagePoller.start()
    this.logger?.info?.(
      `started: balance every ${this.config.balancePollInterval}s, usage every ${this.config.usagePollInterval}s, timezone ${this.timeZone}`,
    )
  }

  /** Stop everything: timers, in-flight requests, pending writes. */
  async stop() {
    this.shutdown.abort()
    await this.balancePoller.stop()
    await this.usagePoller.stop()
    if (this.flushTimer !== null) {
      this.clock.clearTimeout?.(this.flushTimer)
      this.flushTimer = null
    }
    if (this.dirty) {
      try {
        await this.store.save()
        this.dirty = false
      } catch (error) {
        this.logger?.error?.('failed to flush state on shutdown', error)
      }
    }
    this.startedAt = null
  }

  // ---------------------------------------------------------------- balance

  /**
   * Resolve the API key for this operation only (never cached).
   * @returns {Promise<{ key: string | null, source: 'plugin-config' | 'credentials' | 'environment' | 'missing' }>}
   */
  async resolveApiKey() {
    if (this.config.apiKey) return { key: this.config.apiKey, source: 'plugin-config' }
    const ref = this.config.apiKeyEnv
    if (this.credentials) {
      try {
        const resolved = await this.credentials.resolve(ref)
        if (resolved?.value) return { key: String(resolved.value), source: 'credentials' }
      } catch (error) {
        this.logger?.debug?.('credentials.resolve failed', error instanceof Error ? error.message : String(error))
      }
    }
    const fromEnv = this.env?.[ref]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { key: fromEnv.trim(), source: 'environment' }
    return { key: null, source: 'missing' }
  }

  /** Credential presence and origin, without the secret. */
  async credentialStatus() {
    const resolved = await this.resolveApiKey()
    /** @type {Record<string, any>} */
    const status = {
      configured: resolved.key !== null,
      source: resolved.source,
      reference: this.config.apiKeyEnv,
      hint:
        resolved.key === null
          ? `Set ${this.config.apiKeyEnv} for the Harness process, store it through the credentials service, or set api_key in plugin config.`
          : 'A key is available; its value is never returned by this plugin.',
    }
    if (this.credentials?.describe) {
      try {
        const described = await this.credentials.describe(this.config.apiKeyEnv)
        status.service = { configured: described?.configured === true, writable: described?.writable === true }
        if (typeof described?.source === 'string') status.service.source = described.source
      } catch {
        /* describe is advisory */
      }
    }
    return status
  }

  /**
   * Refresh the official balance. Concurrent callers share one request.
   * @param {{ reason?: string, signal?: AbortSignal }} [options]
   */
  async refreshBalance({ reason = 'manual', signal } = {}) {
    if (this.balanceTask) return this.balanceTask
    const task = this.performBalanceRefresh(reason, signal)
    this.balanceTask = task
    try {
      return await task
    } finally {
      this.balanceTask = null
    }
  }

  /**
   * @param {string} reason
   * @param {AbortSignal | undefined} signal
   */
  async performBalanceRefresh(reason, signal) {
    const now = this.clock.now()
    const effective = this.effectiveConfig()
    const { key, source } = await this.resolveApiKey()
    const provider = this.pickBalanceSource(key)
    this.logger?.debug?.(`balance refresh (${reason}); provider: ${provider}; credential source: ${source}`)

    if (provider === 'api-key-unconfigured') {
      const error = new BalanceApiError(
        API_ERROR_CODES.NOT_CONFIGURED,
        `no DeepSeek API key found (${this.config.apiKeyEnv}) and no signed-in account is available`,
      )
      await this.store.update((state) => {
        state.balance.state = 'error'
        state.balance.error = { code: error.code, message: error.message, at: now }
        state.balance.lastAttemptAt = now
        // An unconfigured key is a setup problem, not a transient failure, so it
        // never contributes to the request-failure streak.
        state.events.push({ at: now, kind: 'balance-not-configured', message: error.message, code: error.code })
      })
      this.lastError = { code: error.code, message: error.message, at: now }
      return { ok: false, error: this.serializeError(error, now) }
    }

    if (provider === 'account-missing') {
      const error = new AccountApiError(
        'ACCOUNT_UNAVAILABLE',
        'balance_source is "account" but this composition mounts no deepseekAccount service',
      )
      await this.commitBalanceFailure(error, now)
      return { ok: false, error: this.serializeError(error, now) }
    }

    const combined = signal && !this.shutdown.signal.aborted
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal

    try {
      const result =
        provider === 'account'
          ? await fetchAccountBalance({
              account: /** @type {any} */ (this.getAccount?.()),
              now: () => this.clock.now(),
              metadata: accountClientMetadata({
                locale: this.config.lowBalanceCurrency === 'CNY' ? 'zh' : 'en',
                now: new Date(this.clock.now()),
              }),
            })
          : await fetchBalance({
              apiKey: /** @type {string} */ (key),
              baseUrl: this.config.apiBaseUrl,
              timeoutMs: this.config.requestTimeout,
              maxRetries: effective.maxRetries ?? this.config.maxRetries,
              backoffBaseMs: this.config.retryBackoff,
              signal: combined,
              logger: this.logger,
              fetchImpl: this.fetchImpl,
              sleep: this.sleep,
              random: this.random,
              now: () => new Date(this.clock.now()),
            })
      const snapshot = {
        isAvailable: result.isAvailable,
        infos: result.infos,
        fetchedAt: result.fetchedAt,
        source: result.source,
        warnings: result.warnings,
        endpoint: result.endpoint,
        attempts: result.attempts,
        durationMs: result.durationMs,
        ...(result.usageUrl ? { usageUrl: result.usageUrl } : {}),
      }
      await this.store.update((state) => {
        state.balance.state = 'ok'
        state.balance.snapshot = snapshot
        state.balance.error = null
        state.balance.lastAttemptAt = result.fetchedAt
        state.balance.lastSuccessAt = result.fetchedAt
        state.balance.consecutiveFailures = 0
        /** @type {Record<string, number>} */
        const totals = {}
        for (const info of result.infos) totals[info.currency] = info.total
        state.balanceHistory.push({ at: result.fetchedAt, totals, isAvailable: result.isAvailable })
        if (result.warnings.length > 0) {
          state.events.push({
            at: result.fetchedAt,
            kind: 'balance-response-warning',
            message: result.warnings.join('; ').slice(0, 500),
          })
        }
      })
      this.lastError = null
      this.lastBalanceProvider = provider
      await this.evaluateNow('balance-refresh')
      this.logger?.debug?.(`balance refreshed in ${result.durationMs} ms via ${provider}`)
      return { ok: true, provider, snapshot: this.getBalance() }
    } catch (error) {
      const serialized = this.serializeError(error, this.clock.now())
      if (serialized.code === API_ERROR_CODES.ABORTED) {
        this.logger?.debug?.('balance refresh cancelled')
        return { ok: false, cancelled: true, error: serialized }
      }
      await this.commitBalanceFailure(error, this.clock.now())
      return { ok: false, error: this.lastError }
    }
  }

  /**
   * Record one failed balance refresh and re-evaluate alerts.
   * @param {unknown} error
   * @param {number} at
   */
  async commitBalanceFailure(error, at) {
    const serialized = this.serializeError(error, at)
    await this.store.update((state) => {
      state.balance.state = 'error'
      state.balance.error = serialized
      state.balance.lastAttemptAt = serialized.at
      state.balance.consecutiveFailures = (state.balance.consecutiveFailures ?? 0) + 1
      state.events.push({
        at: serialized.at,
        kind: 'balance-refresh-failed',
        code: serialized.code,
        message: serialized.message,
      })
    })
    this.lastError = serialized
    await this.evaluateNow('balance-failure')
    return serialized
  }

  /**
   * Which official route supplies the balance.
   * @param {string | null} key already-resolved API key
   * @returns {'api-key' | 'api-key-unconfigured' | 'account' | 'account-missing'}
   */
  pickBalanceSource(key) {
    const configured = this.config.balanceSource
    const hasAccount = Boolean(this.getAccount?.())
    if (configured === 'account') return hasAccount ? 'account' : 'account-missing'
    if (configured === 'api-key') return key ? 'api-key' : 'api-key-unconfigured'
    // auto: an explicit API credential wins; otherwise bill-side truth comes
    // from the account that actually pays for this profile's model calls.
    if (key) return 'api-key'
    if (hasAccount) return 'account'
    return 'api-key-unconfigured'
  }

  /**
   * @param {unknown} error
   * @param {number} now
   */
  serializeError(error, now) {
    if (error instanceof BalanceApiError) {
      /** @type {Record<string, any>} */
      const serialized = {
        code: error.code,
        message: error.message,
        at: now,
        retryable: error.retryable,
        hint: error.hint,
      }
      // Optional transport facts are omitted, never emitted as `undefined`:
      // tool results and Web bodies must stay lossless JSON.
      if (error.status !== undefined) serialized.status = error.status
      if (error.attempts !== undefined) serialized.attempts = error.attempts
      return serialized
    }
    if (error instanceof AccountApiError) {
      return {
        code: error.code,
        message: error.message,
        at: now,
        retryable: error.retryable,
        hint: error.hint,
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { code: 'UNKNOWN', message, at: now, retryable: false }
  }

  // ------------------------------------------------------------------ usage

  /**
   * Record one observed model call. This is called from the `llm/stream`
   * wrapper with provider-reported token counts only.
   * @param {Record<string, unknown>} observation
   * @returns {{ recorded: boolean, reason?: string, record?: Record<string, any> }}
   */
  recordCall(observation) {
    const record = validateCallRecord({ at: this.clock.now(), ...observation })
    if (!record) {
      this.ignoredObservations += 1
      this.logger?.debug?.('ignored an unusable call observation')
      return { recorded: false, reason: 'invalid-observation' }
    }
    if (this.config.trackedProviders.length > 0 && !this.config.trackedProviders.includes(record.provider)) {
      this.ignoredObservations += 1
      return { recorded: false, reason: 'provider-not-tracked' }
    }
    this.store.state.calls.push(record)
    this.observations += 1
    this.markDirty()
    return { recorded: true, record }
  }

  /** Mark state dirty and schedule a debounced write. */
  markDirty() {
    this.dirty = true
    if (this.flushTimer !== null) return
    const schedule = this.clock.setTimeout ?? setTimeout
    this.flushTimer = schedule(() => {
      this.flushTimer = null
      this.flush()
    }, 2_000)
    this.flushTimer?.unref?.()
  }

  /** Persist pending observations. */
  async flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      await this.store.update(() => undefined)
    } catch (error) {
      this.dirty = true
      this.logger?.error?.('failed to persist recorded calls', error)
    }
  }

  /**
   * Re-aggregate local usage and re-evaluate alerts. Performs no network I/O.
   * @param {{ signal?: AbortSignal }} [options]
   */
  async refreshUsage({ signal } = {}) {
    if (signal?.aborted) return { ok: false, cancelled: true }
    await this.flush()
    this.lastUsageRefreshAt = this.clock.now()
    const alerts = await this.evaluateNow('usage-refresh')
    return { ok: true, at: this.lastUsageRefreshAt, alerts }
  }

  // ----------------------------------------------------------------- alerts

  /**
   * Evaluate alert conditions against the current state and persist changes.
   * @param {string} reason
   */
  async evaluateNow(reason) {
    const now = this.clock.now()
    const config = this.effectiveConfig()
    const zone = this.timeZone
    const dayStart = zonedStartOfDay(new Date(now), zone)
    const dayEnd = nextDayStart(dayStart, zone)
    const state = this.store.state

    const day = aggregateDay(state.calls, {
      zone,
      now: new Date(now),
      prices: config.priceTable,
      dayStart,
      dayEnd,
    })
    const balanceView = {
      state: state.balance.state,
      snapshot: state.balance.snapshot,
      lastSuccessAt: state.balance.lastSuccessAt,
      consecutiveFailures: state.balance.consecutiveFailures,
    }

    /** @type {any} */
    let outcome
    await this.store.update((draft) => {
      outcome = evaluateAlerts({
        config,
        alerts: draft.alerts,
        now,
        day,
        balance: balanceView,
      })
      return undefined
    })

    for (const alert of outcome.raised) {
      const notification = {
        kind: 'alert',
        at: now,
        reason,
        alert: { ...alert },
        day,
      }
      this.recordNotification(notification)
    }
    for (const alert of outcome.resolved) {
      this.recordNotification({ kind: 'alert-resolved', at: now, reason, alert: { ...alert } })
      this.logger?.info?.(`alert resolved: ${alert.type}`)
    }
    return { ...outcome, day, at: now }
  }

  /** @param {Record<string, any>} notification */
  recordNotification(notification) {
    this.notifications.push(notification)
    if (this.notifications.length > MAX_NOTIFICATIONS) this.notifications.shift()
    if (notification.kind === 'alert') {
      this.logger?.warn?.(`ALERT ${notification.alert.type}: ${notification.alert.message}`)
    }
    for (const observer of this.observers) {
      try {
        observer(notification)
      } catch (error) {
        this.logger?.debug?.('alert observer failed', error instanceof Error ? error.message : String(error))
      }
    }
  }

  // --------------------------------------------------------------- read side

  /** Current balance view with explicit freshness classification. */
  getBalance() {
    const state = this.store.state.balance
    const now = this.clock.now()
    const cached = state.snapshot !== null
    const isLive = state.state === 'ok' && cached
    const source = cached ? state.snapshot.source : null
    return {
      // `source` names the origin of the numbers; both routes are official.
      source,
      sourceKind: source === null ? null : 'official',
      providerLabel:
        source === 'official-account'
          ? 'DeepSeek Platform account (signed-in grant)'
          : source === 'official-api'
            ? 'DeepSeek API key (GET /user/balance)'
            : null,
      endpoint: cached ? state.snapshot.endpoint ?? '/user/balance' : null,
      docs: 'https://api-docs.deepseek.com/api/get-user-balance',
      usageUrl: cached ? state.snapshot.usageUrl ?? null : null,
      state: state.state,
      isLive,
      isCached: state.state === 'error' && cached,
      isUnknown: state.state === 'never' || !cached,
      isAvailable: cached ? state.snapshot.isAvailable ?? null : null,
      infos: cached ? state.snapshot.infos : [],
      fetchedAt: cached ? state.snapshot.fetchedAt : null,
      ageSeconds: cached && state.snapshot.fetchedAt ? Math.max(0, Math.round((now - state.snapshot.fetchedAt) / 1000)) : null,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      consecutiveFailures: state.consecutiveFailures,
      error: state.error,
      warnings: cached ? state.snapshot.warnings ?? [] : [],
      pollIntervalSeconds: this.config.balancePollInterval,
      configuredSource: this.config.balanceSource,
      lastProvider: this.lastBalanceProvider,
      scheduler: this.balancePoller.status(),
    }
  }

  /**
   * Usage aggregate for one range plus the account-level spend derived from
   * official balance snapshots.
   * @param {{ range?: string, start?: string|number|Date, end?: string|number|Date }} [input]
   */
  getUsage(input = {}) {
    const now = new Date(this.clock.now())
    const zone = this.timeZone
    const resolved = resolveRange({ ...input, now, zone })
    const config = this.effectiveConfig()
    const aggregate = aggregateUsage(this.store.state.calls, {
      from: resolved.from,
      to: resolved.to,
      bucket: resolved.bucket,
      zone,
      prices: config.priceTable,
    })
    const accountSpend = deriveBalanceDeltas(this.store.state.balanceHistory, {
      from: resolved.from.getTime(),
      to: resolved.to.getTime(),
      currency: this.config.lowBalanceCurrency,
    })
    return {
      range: resolved.range,
      from: resolved.from.getTime(),
      to: resolved.to.getTime(),
      timeZone: zone,
      ...aggregate,
      accountSpend,
      costEstimate: {
        ...aggregate.cost,
        note:
          'Estimated from the price table and locally observed tokens. This is not the billed amount; see accountSpend for the official balance-derived figure.',
      },
    }
  }

  /** Today's aggregate in the configured timezone, used by the panel header. */
  getToday() {
    const now = this.clock.now()
    const zone = this.timeZone
    const dayStart = zonedStartOfDay(new Date(now), zone)
    const dayEnd = nextDayStart(dayStart, zone)
    const day = aggregateDay(this.store.state.calls, {
      zone,
      now: new Date(now),
      prices: this.effectiveConfig().priceTable,
      dayStart,
      dayEnd,
    })
    return { ...day, dayKey: dayKey(new Date(now), zone) }
  }

  /** Scheduler, credential, storage, and configuration status. */
  async getStatus() {
    const credentials = await this.credentialStatus()
    const state = this.store.state
    return {
      plugin: '@local/dsh-deepseek-usage-monitor',
      version: 1,
      startedAt: this.startedAt,
      now: this.clock.now(),
      timeZone: this.timeZone,
      timeZoneConfigured: this.timeZoneConfigured,
      debug: this.config.debug,
      autoStart: this.config.autoStart,
      credentials,
      balanceSource: {
        configured: this.config.balanceSource,
        accountServiceAvailable: Boolean(this.getAccount?.()),
        lastProvider: this.lastBalanceProvider,
        snapshotSource: state.balance.snapshot?.source ?? null,
      },
      schedulers: {
        balance: this.balancePoller.status(),
        usage: this.usagePoller.status(),
      },
      capture: {
        attached: true,
        observedCalls: this.observations,
        ignoredObservations: this.ignoredObservations,
        trackedProviders: this.config.trackedProviders,
        scope: 'calls routed through ctx.llm.stream() in this Harness process while the plugin was active',
      },
      storage: {
        dir: this.store.dir,
        file: this.store.filePath,
        loaded: this.store.loaded,
        droppedRecords: this.store.dropped,
        callRecords: state.calls.length,
        balanceSnapshots: state.balanceHistory.length,
        alerts: state.alerts.length,
        retentionDays: this.config.historyRetentionDays,
        maxCallRecords: this.config.maxCallRecords,
      },
      alerts: {
        active: state.alerts.filter((alert) => alert.state === 'active').length,
        cooldownSeconds: this.effectiveConfig().alertCooldown,
        enabled: { ...this.config.alerts },
      },
      lastUsageRefreshAt: this.lastUsageRefreshAt,
      lastError: this.lastError,
      initError: this.initError,
      configIssues: this.issues,
    }
  }

  /** Active and recently resolved alerts, plus effective thresholds. */
  getAlerts() {
    const config = this.effectiveConfig()
    const alerts = this.store.state.alerts
    return {
      active: alerts.filter((alert) => alert.state === 'active'),
      resolved: alerts.filter((alert) => alert.state === 'resolved').slice(-20),
      notifications: this.notifications.slice(-20),
      thresholds: {
        lowBalance: { threshold: config.lowBalanceThreshold, currency: config.lowBalanceCurrency, enabled: config.alerts.low_balance },
        dailyCostUsd: { threshold: config.dailyCostThreshold, enabled: config.alerts.daily_cost },
        dailyTokens: { threshold: config.dailyTokenThreshold, enabled: config.alerts.daily_token },
        requestFailures: { threshold: config.failureStreakThreshold, enabled: config.alerts.request_failures },
        staleAfterSeconds: config.staleAfter,
        staleEnabled: config.alerts.stale_data,
        cooldownSeconds: config.alertCooldown,
      },
      overrides: { ...(this.store.state.overrides ?? {}) },
      configurable: Object.keys(OVERRIDABLE),
      fieldDocs: FIELD_DOCS,
    }
  }

  /**
   * Apply a runtime threshold override, persisted in the state file.
   * @param {Record<string, unknown>} patch
   */
  async setThresholds(patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new TypeError('thresholds must be an object of field name to value')
    }
    /** @type {Record<string, number>} */
    const accepted = {}
    const rejected = []
    for (const [field, rawValue] of Object.entries(patch)) {
      const rule = OVERRIDABLE[field]
      if (!rule) {
        rejected.push({ field, reason: `not an overridable field; expected one of ${Object.keys(OVERRIDABLE).join(', ')}` })
        continue
      }
      const value = typeof rawValue === 'string' ? Number(rawValue) : rawValue
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        rejected.push({ field, reason: 'not a finite number' })
        continue
      }
      if (rule.integer && !Number.isInteger(value)) {
        rejected.push({ field, reason: 'must be an integer' })
        continue
      }
      if (value < rule.min || value > rule.max) {
        rejected.push({ field, reason: `out of range [${rule.min}, ${rule.max}]` })
        continue
      }
      accepted[field] = value
    }
    if (Object.keys(accepted).length > 0) {
      await this.store.update((state) => {
        state.overrides = { ...(state.overrides ?? {}), ...accepted }
      })
      await this.evaluateNow('threshold-change')
    }
    return { applied: accepted, rejected, effective: this.getAlerts().thresholds }
  }

  /** Clear every persisted runtime override. */
  async resetThresholds() {
    await this.store.update((state) => {
      state.overrides = {}
    })
    await this.evaluateNow('threshold-reset')
    return { effective: this.getAlerts().thresholds }
  }

  /** Remove recorded usage history, balance snapshots, and alerts. */
  async clearHistory() {
    const removed = await this.store.clearHistory()
    this.notifications = []
    await this.evaluateNow('history-cleared')
    return removed
  }

  /** Everything the panel needs in one response. */
  async getSnapshot(input = {}) {
    const status = await this.getStatus()
    return {
      generatedAt: this.clock.now(),
      status,
      balance: this.getBalance(),
      today: this.getToday(),
      usage: this.getUsage(input),
      alerts: this.getAlerts(),
      sources: {
        balance: {
          kind: 'official',
          endpoint: 'GET {api_base_url}/user/balance (API key) or ctx.deepseekAccount.getBalance() (signed-in account)',
          docs: 'https://api-docs.deepseek.com/api/get-user-balance',
          note: 'Account-wide available balance reported by DeepSeek. Both routes are official; the label on each value names the one that produced it. Refreshed on a schedule, and the timestamp and freshness state accompany every value.',
        },
        usage: {
          kind: 'official-unavailable',
          note: 'DeepSeek publishes no API for usage or billing statistics. This plugin does not scrape the console and does not invent one.',
        },
        localCalls: {
          kind: 'harness-observed',
          note: 'Token counts come from the usage chunk of each observed model response. Only calls routed through this Harness process while the plugin was active are included.',
        },
        accountSpend: {
          kind: 'derived-from-official-balance',
          note: 'Account-wide spend inferred from the difference between consecutive official balance snapshots. Coarse and not attributable to a model.',
        },
        costEstimate: {
          kind: 'estimate',
          source: PRICE_SOURCE,
          note: 'Computed from the configured/built-in price table and locally observed tokens. Not a billed amount.',
        },
      },
      ranges: ['1h', '24h', '7d', '30d', 'custom'],
      timeZone: this.timeZone,
      configIssues: this.issues,
      fieldDocs: FIELD_DOCS,
      storage: status.storage,
    }
  }

  /** Hash of the state file path, used only for diagnostics correlation. */
  diagnosticId() {
    try {
      return createHash('sha256').update(this.store.filePath).digest('hex').slice(0, 12)
    } catch {
      return randomUUID().slice(0, 12)
    }
  }
}
