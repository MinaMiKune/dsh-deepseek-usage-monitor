/**
 * Durable JSON state for the monitor.
 *
 * The state file is plugin-owned data (balance snapshots, local call records,
 * alerts), never a Session log. Writes are serialized and atomic
 * (write-temp-then-rename) so a crash mid-write cannot leave a truncated file,
 * and a corrupt file is moved aside instead of being silently reused.
 *
 * Retention is enforced here rather than at read time: call records and balance
 * snapshots older than `history_retention_days` are dropped on load and after
 * every mutation, and both collections carry a hard record cap.
 */

import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** Persisted schema version. */
export const STATE_VERSION = 1

/** Hard cap on balance snapshots retained regardless of the time window. */
export const MAX_BALANCE_SNAPSHOTS = 5_000

/** Hard cap on retained alert records. */
export const MAX_ALERTS = 200

/** Hard cap on retained diagnostic events. */
export const MAX_EVENTS = 100

/**
 * Resolve the default plugin data directory.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function defaultDataDir(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'deepseek-usage-monitor')
}

/**
 * Fresh, empty state.
 * @param {number} now
 */
export function emptyState(now = Date.now()) {
  return {
    version: STATE_VERSION,
    createdAt: now,
    balance: {
      state: 'never',
      snapshot: null,
      error: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
    },
    balanceHistory: [],
    calls: [],
    alerts: [],
    events: [],
    overrides: {},
  }
}

/**
 * Coerce an arbitrary parsed document into a usable state object.
 * Unknown or malformed members are dropped (and reported) rather than trusted.
 * @param {unknown} raw
 * @param {{ logger?: { warn: Function } }} [options]
 * @returns {{ state: ReturnType<typeof emptyState>, dropped: string[] }}
 */
export function coerceState(raw, options = {}) {
  const dropped = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    dropped.push('state root is not an object')
    return { state: emptyState(), dropped }
  }
  const source = /** @type {Record<string, any>} */ (raw)
  const state = emptyState()
  if (source.version !== STATE_VERSION) dropped.push(`state version ${String(source.version)} != ${STATE_VERSION}`)

  const balance = source.balance
  if (balance && typeof balance === 'object' && !Array.isArray(balance)) {
    const snapshot = balance.snapshot
    if (snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.infos)) {
      const infos = snapshot.infos.filter((info) => info && typeof info.currency === 'string' && Number.isFinite(info.total))
      if (infos.length > 0) {
        state.balance.snapshot = {
          isAvailable: snapshot.isAvailable === true ? true : snapshot.isAvailable === false ? false : null,
          infos: infos.map((info) => ({
            currency: info.currency,
            total: Number(info.total),
            granted: Number.isFinite(info.granted) ? Number(info.granted) : null,
            toppedUp: Number.isFinite(info.toppedUp) ? Number(info.toppedUp) : null,
          })),
          fetchedAt: Number.isFinite(snapshot.fetchedAt) ? Number(snapshot.fetchedAt) : null,
          source: typeof snapshot.source === 'string' ? snapshot.source.slice(0, 40) : 'official-api',
          warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.filter((w) => typeof w === 'string') : [],
          ...(typeof snapshot.endpoint === 'string' ? { endpoint: snapshot.endpoint.slice(0, 200) } : {}),
          ...(typeof snapshot.usageUrl === 'string' ? { usageUrl: snapshot.usageUrl.slice(0, 500) } : {}),
        }
      } else {
        dropped.push('balance snapshot had no usable entries')
      }
    }
    const declared = ['ok', 'error', 'never'].includes(balance.state) ? balance.state : state.balance.snapshot ? 'ok' : 'never'
    // A stored state of 'ok' without a usable snapshot is a contradiction: never
    // let it present a live balance that does not exist.
    state.balance.state =
      declared === 'ok' && state.balance.snapshot === null ? (state.balance.error ? 'error' : 'never') : declared
    state.balance.error = normalizeErrorRecord(balance.error)
    state.balance.lastAttemptAt = finiteOrNull(balance.lastAttemptAt)
    state.balance.lastSuccessAt = finiteOrNull(balance.lastSuccessAt)
    state.balance.consecutiveFailures = Number.isInteger(balance.consecutiveFailures) && balance.consecutiveFailures >= 0
      ? balance.consecutiveFailures
      : 0
    if (state.balance.snapshot && state.balance.lastSuccessAt === null) {
      state.balance.lastSuccessAt = state.balance.snapshot.fetchedAt
    }
  }

  state.balanceHistory = readArray(source.balanceHistory, 'balanceHistory', dropped, (entry) => {
    if (!entry || typeof entry !== 'object') return undefined
    const totals = {}
    if (!entry.totals || typeof entry.totals !== 'object') return undefined
    for (const [currency, amount] of Object.entries(entry.totals)) {
      if (/^[A-Z]{3}$/.test(currency) && Number.isFinite(amount)) totals[currency] = Number(amount)
    }
    if (Object.keys(totals).length === 0) return undefined
    if (!Number.isFinite(entry.at)) return undefined
    return { at: Number(entry.at), totals, isAvailable: entry.isAvailable === true }
  })

  state.calls = readArray(source.calls, 'calls', dropped, (entry) => {
    if (!entry || typeof entry !== 'object') return undefined
    if (!Number.isFinite(entry.at) || typeof entry.model !== 'string' || entry.model === '') return undefined
    const numberField = (value) => (Number.isFinite(value) && value >= 0 ? Number(value) : 0)
    return {
      at: Math.trunc(Number(entry.at)),
      model: entry.model.slice(0, 120),
      provider: typeof entry.provider === 'string' ? entry.provider.slice(0, 120) : 'unknown',
      purpose: typeof entry.purpose === 'string' ? entry.purpose.slice(0, 40) : undefined,
      inputTokens: numberField(entry.inputTokens),
      outputTokens: numberField(entry.outputTokens),
      cacheReadTokens: numberField(entry.cacheReadTokens),
      cacheWriteTokens: numberField(entry.cacheWriteTokens),
      reasoningTokens: numberField(entry.reasoningTokens),
      status: entry.status === 'ok' ? 'ok' : 'error',
      failureCode: typeof entry.failureCode === 'string' ? entry.failureCode.slice(0, 80) : undefined,
      durationMs: numberField(entry.durationMs),
    }
  })

  state.alerts = readArray(source.alerts, 'alerts', dropped, (entry) => {
    if (!entry || typeof entry !== 'object') return undefined
    if (typeof entry.type !== 'string' || typeof entry.id !== 'string') return undefined
    return {
      id: entry.id.slice(0, 120),
      type: entry.type.slice(0, 60),
      severity: entry.severity === 'critical' ? 'critical' : 'warning',
      state: entry.state === 'resolved' ? 'resolved' : 'active',
      firstAt: finiteOrNumber(entry.firstAt, 0),
      lastAt: finiteOrNumber(entry.lastAt, 0),
      count: Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1,
      message: typeof entry.message === 'string' ? entry.message.slice(0, 500) : '',
      value: Number.isFinite(entry.value) ? Number(entry.value) : null,
      threshold: Number.isFinite(entry.threshold) ? Number(entry.threshold) : null,
      dataAt: finiteOrNull(entry.dataAt),
      source: typeof entry.source === 'string' ? entry.source.slice(0, 120) : 'plugin',
    }
  })

  state.events = readArray(source.events, 'events', dropped, (entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.kind !== 'string') return undefined
    return {
      at: finiteOrNumber(entry.at, 0),
      kind: entry.kind.slice(0, 60),
      message: typeof entry.message === 'string' ? entry.message.slice(0, 500) : '',
      code: typeof entry.code === 'string' ? entry.code.slice(0, 60) : undefined,
    }
  })

  if (source.overrides && typeof source.overrides === 'object' && !Array.isArray(source.overrides)) {
    for (const [key, value] of Object.entries(source.overrides)) {
      if (typeof key === 'string' && (typeof value === 'number' || typeof value === 'boolean') && Number.isFinite(Number(value))) {
        state.overrides[key] = value
      }
    }
  }

  return { state, dropped }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {string[]} dropped
 * @param {(entry: any) => any} coerce
 */
function readArray(value, label, dropped, coerce) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    dropped.push(`${label} is not an array`)
    return []
  }
  const out = []
  let invalid = 0
  for (const entry of value) {
    const coerced = coerce(entry)
    if (coerced === undefined) invalid += 1
    else out.push(coerced)
  }
  if (invalid > 0) dropped.push(`${invalid} invalid ${label} record(s) dropped`)
  return out
}

/** @param {unknown} value */
const finiteOrNull = (value) => (Number.isFinite(value) ? Number(value) : null)
/** @param {unknown} value @param {number} fallback */
const finiteOrNumber = (value, fallback) => (Number.isFinite(value) ? Number(value) : fallback)

/** @param {unknown} value */
function normalizeErrorRecord(value) {
  if (!value || typeof value !== 'object') return null
  const record = /** @type {Record<string, any>} */ (value)
  if (typeof record.code !== 'string') return null
  return {
    code: record.code.slice(0, 60),
    message: typeof record.message === 'string' ? record.message.slice(0, 500) : '',
    at: finiteOrNumber(record.at, 0),
    status: Number.isFinite(record.status) ? Number(record.status) : undefined,
    attempts: Number.isFinite(record.attempts) ? Number(record.attempts) : undefined,
  }
}

/** JSON state store with serialized, atomic writes. */
export class StateStore {
  /**
   * @param {{
   *   dir: string,
   *   fileName?: string,
   *   retentionDays: number,
   *   maxCallRecords: number,
   *   logger?: { info?: Function, warn?: Function, error?: Function, debug?: Function },
   *   fsImpl?: { readFile: Function, writeFile: Function, rename: Function, mkdir: Function, rm: Function },
   * }} options
   */
  constructor(options) {
    this.dir = options.dir
    this.fileName = options.fileName ?? 'state.json'
    this.filePath = path.join(this.dir, this.fileName)
    this.retentionDays = options.retentionDays
    this.maxCallRecords = options.maxCallRecords
    this.logger = options.logger
    this.fs = options.fsImpl ?? { readFile, writeFile, rename, mkdir, rm }
    this.state = emptyState()
    this.loaded = false
    this.dropped = []
    /** @type {Promise<unknown>} */
    this.writeChain = Promise.resolve()
  }

  /**
   * Load state from disk, tolerating absence and quarantining corruption.
   * @returns {Promise<{ loaded: boolean, dropped: string[] }>}
   */
  async load() {
    await this.fs.mkdir(this.dir, { recursive: true })
    let text
    try {
      text = await this.fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') {
        this.state = emptyState()
        this.loaded = true
        this.dropped = []
        return { loaded: false, dropped: [] }
      }
      throw error
    }
    try {
      const parsed = JSON.parse(text)
      const { state, dropped } = coerceState(parsed)
      this.state = state
      this.dropped = dropped
      if (dropped.length > 0) this.logger?.warn?.('state file had unusable members', dropped.join('; '))
    } catch (error) {
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`
      this.logger?.error?.(`state file is not valid JSON; moving it to ${quarantine}`)
      try {
        await this.fs.rename(this.filePath, quarantine)
      } catch {
        await this.fs.rm?.(this.filePath, { force: true })
      }
      this.state = emptyState()
      this.dropped = ['state file was corrupt and has been replaced']
    }
    this.applyRetention(Date.now())
    this.loaded = true
    return { loaded: true, dropped: this.dropped }
  }

  /**
   * Drop data outside the retention window and above the record caps.
   * @param {number} now
   */
  applyRetention(now = Date.now()) {
    const cutoff = now - this.retentionDays * 24 * 3600_000
    const keepFrom = (entry) => entry.at >= cutoff
    this.state.calls = this.state.calls.filter(keepFrom)
    this.state.balanceHistory = this.state.balanceHistory.filter(keepFrom)
    if (this.state.calls.length > this.maxCallRecords) {
      this.state.calls = this.state.calls.slice(this.state.calls.length - this.maxCallRecords)
    }
    if (this.state.balanceHistory.length > MAX_BALANCE_SNAPSHOTS) {
      this.state.balanceHistory = this.state.balanceHistory.slice(-MAX_BALANCE_SNAPSHOTS)
    }
    if (this.state.alerts.length > MAX_ALERTS) {
      this.state.alerts = this.state.alerts.slice(-MAX_ALERTS)
    }
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events = this.state.events.slice(-MAX_EVENTS)
    }
  }

  /**
   * Apply one mutation and persist the result. Mutations are serialized so two
   * concurrent refreshes cannot interleave read-modify-write on the same file.
   * @template T
   * @param {(state: ReturnType<typeof emptyState>) => T} mutate
   * @returns {Promise<T>}
   */
  async update(mutate) {
    const run = async () => {
      const result = mutate(this.state)
      this.applyRetention(Date.now())
      await this.save()
      return result
    }
    const next = this.writeChain.then(run, run)
    this.writeChain = next.catch(() => undefined)
    return next
  }

  /** Persist the current state atomically. */
  async save() {
    await this.fs.mkdir(this.dir, { recursive: true })
    const temporary = `${this.filePath}.tmp`
    const body = JSON.stringify(this.state)
    await this.fs.writeFile(temporary, body, 'utf8')
    await this.fs.rename(temporary, this.filePath)
  }

  /** Remove recorded local usage, balance history, and alerts (but not the config). */
  async clearHistory() {
    return this.update((state) => {
      const removed = {
        calls: state.calls.length,
        balanceHistory: state.balanceHistory.length,
        alerts: state.alerts.length,
        events: state.events.length,
      }
      state.calls = []
      state.balanceHistory = []
      state.alerts = []
      state.events = []
      return removed
    })
  }
}
