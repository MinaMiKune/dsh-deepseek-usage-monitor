/**
 * Local usage aggregation.
 *
 * SCOPE: these numbers cover only model calls this Harness process actually
 * routed through `ctx.llm.stream()` while the plugin was active. They are not
 * the account's official usage: DeepSeek publishes no usage endpoint, and
 * traffic from other tools, other machines, or a previous process is invisible
 * here. Every response produced from this module is labelled
 * `source: 'harness-observed'` so it can never be mistaken for official data.
 *
 * Token accounting follows `TokenUsage` in dsh-llm: `inputTokens` is uncached
 * input only; `cacheReadTokens` and `cacheWriteTokens` are disjoint from it, so
 * billed input is their sum and `reasoningTokens` is already part of output.
 */

import { bucketKey, buildBuckets, isPeakPricing } from './time.js'
import { estimateCallCost, estimateCost } from './pricing.js'

/** Failure statuses recorded per call. */
export const CALL_STATUS = Object.freeze({ OK: 'ok', ERROR: 'error' })

/**
 * Validate one call record; returns undefined when the shape is unusable so a
 * malformed observation can never enter the persisted statistics.
 * @param {unknown} raw
 * @returns {{
 *   at: number, model: string, provider: string, purpose?: string,
 *   inputTokens: number, outputTokens: number, cacheReadTokens: number,
 *   cacheWriteTokens: number, reasoningTokens: number,
 *   status: 'ok'|'error', failureCode?: string, durationMs: number,
 * } | undefined}
 */
export function validateCallRecord(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = /** @type {Record<string, unknown>} */ (raw)
  const at = Number(record.at)
  if (!Number.isFinite(at) || at <= 0) return undefined
  if (typeof record.model !== 'string' || record.model.trim() === '') return undefined
  const count = (value) => {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined
  }
  const inputTokens = count(record.inputTokens) ?? 0
  const outputTokens = count(record.outputTokens) ?? 0
  const cacheReadTokens = count(record.cacheReadTokens) ?? 0
  const cacheWriteTokens = count(record.cacheWriteTokens) ?? 0
  const reasoningTokens = count(record.reasoningTokens) ?? 0
  const status = record.status === CALL_STATUS.ERROR ? CALL_STATUS.ERROR : CALL_STATUS.OK
  return {
    at: Math.trunc(at),
    model: record.model.trim().slice(0, 120),
    provider: typeof record.provider === 'string' && record.provider !== '' ? record.provider.slice(0, 120) : 'unknown',
    purpose: typeof record.purpose === 'string' && record.purpose !== '' ? record.purpose.slice(0, 40) : undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: Math.min(reasoningTokens, outputTokens),
    status,
    failureCode: typeof record.failureCode === 'string' && record.failureCode !== '' ? record.failureCode.slice(0, 80) : undefined,
    durationMs: count(record.durationMs) ?? 0,
  }
}

/**
 * Sum token fields of several records.
 * @param {readonly any[]} records
 */
export function sumTokens(records) {
  const totals = {
    calls: records.length,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: 0,
  }
  for (const record of records) {
    if (record.status === CALL_STATUS.ERROR) totals.failedCalls += 1
    totals.inputTokens += record.inputTokens ?? 0
    totals.outputTokens += record.outputTokens ?? 0
    totals.cacheReadTokens += record.cacheReadTokens ?? 0
    totals.cacheWriteTokens += record.cacheWriteTokens ?? 0
    totals.reasoningTokens += record.reasoningTokens ?? 0
    totals.durationMs += record.durationMs ?? 0
  }
  totals.billedInputTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  totals.totalTokens = totals.billedInputTokens + totals.outputTokens
  totals.cacheHitRatio = totals.billedInputTokens > 0 ? totals.cacheReadTokens / totals.billedInputTokens : 0
  totals.averageDurationMs = totals.calls > 0 ? Math.round(totals.durationMs / totals.calls) : 0
  return totals
}

/**
 * Aggregate the locally observed calls inside one resolved range.
 * @param {readonly any[]} records
 * @param {{
 *   from: Date, to: Date, bucket: 'hour'|'day', zone: string,
 *   prices?: Record<string, any> | null,
 * }} range
 */
export function aggregateUsage(records, range) {
  const fromMs = range.from.getTime()
  const toMs = range.to.getTime()
  const inRange = records.filter((record) => record.at >= fromMs && record.at <= toMs)

  const totals = sumTokens(inRange)

  /** @type {Map<string, any[]>} */
  const byModelMap = new Map()
  for (const record of inRange) {
    const key = `${record.provider}\u0000${record.model}`
    const list = byModelMap.get(key)
    if (list) list.push(record)
    else byModelMap.set(key, [record])
  }
  const byModel = [...byModelMap.entries()]
    .map(([key, list]) => {
      const [provider, model] = key.split('\u0000')
      const modelTotals = sumTokens(list)
      const cost = estimateCost(list, { prices: range.prices ?? null })
      return {
        provider,
        model,
        calls: modelTotals.calls,
        failedCalls: modelTotals.failedCalls,
        inputTokens: modelTotals.inputTokens,
        outputTokens: modelTotals.outputTokens,
        cacheReadTokens: modelTotals.cacheReadTokens,
        cacheWriteTokens: modelTotals.cacheWriteTokens,
        totalTokens: modelTotals.totalTokens,
        estimatedUsd: cost.usd,
        priced: cost.unpricedCalls === 0,
      }
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const buckets = buildBuckets({ from: range.from, to: range.to, bucket: range.bucket }, range.zone).map(
    (bucket) => ({
      key: bucket.key,
      start: bucket.start,
      end: bucket.end,
      calls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      estimatedUsd: 0,
    }),
  )
  /** @type {Map<string, any>} */
  const bucketIndex = new Map(buckets.map((bucket) => [bucket.key, bucket]))
  for (const record of inRange) {
    const key = bucketKey(new Date(record.at), range.zone, range.bucket)
    const bucket = bucketIndex.get(key)
    if (!bucket) continue
    bucket.calls += 1
    if (record.status === CALL_STATUS.ERROR) bucket.failedCalls += 1
    bucket.inputTokens += record.inputTokens
    bucket.outputTokens += record.outputTokens
    bucket.cacheReadTokens += record.cacheReadTokens
    bucket.totalTokens += record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens
    const cost = estimateCallCost(record, { prices: range.prices ?? null })
    if (cost.priced) bucket.estimatedUsd += cost.usd
  }

  const cost = estimateCost(inRange, { prices: range.prices ?? null })
  const providers = [...new Set(inRange.map((record) => record.provider))].sort()
  const peakCalls = inRange.filter((record) => isPeakPricing(new Date(record.at))).length

  return {
    source: 'harness-observed',
    scope: 'calls routed through this Harness process while the plugin was active; not account-wide',
    granularity: range.bucket,
    timeZone: range.zone,
    from: range.from.getTime(),
    to: range.to.getTime(),
    totals,
    byModel,
    buckets,
    cost: { ...cost, estimated: true },
    providers,
    includesNonDeepSeekProviders: providers.some((provider) => !provider.toLowerCase().includes('deepseek')),
    peakCalls,
    offPeakCalls: inRange.length - peakCalls,
    observedCalls: inRange.length,
  }
}

/**
 * Totals for one calendar day in the configured zone, used by daily alerts.
 * @param {readonly any[]} records
 * @param {{ zone: string, now: Date, prices?: Record<string, any> | null, dayStart: Date, dayEnd: Date }} input
 */
export function aggregateDay(records, input) {
  const { zone, prices = null, dayStart, dayEnd } = input
  const from = dayStart.getTime()
  const to = dayEnd.getTime()
  const filtered = records.filter((record) => record.at >= from && record.at < to)
  const totals = sumTokens(filtered)
  const cost = estimateCost(filtered, { prices })
  return {
    zone,
    dayStart: from,
    dayEnd: to,
    calls: totals.calls,
    failedCalls: totals.failedCalls,
    totalTokens: totals.totalTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    estimatedUsd: cost.usd,
    unpricedCalls: cost.unpricedCalls,
  }
}

/**
 * Derive account-level spend from consecutive official balance snapshots.
 *
 * A decrease between two snapshots is real deducted balance (spend), and an
 * increase is a top-up or a granted-balance refresh. This is the only
 * account-wide cost figure available without a billing API, but it is coarse:
 * it can only see what happened between two successful polls, it cannot break
 * spend down by model, and a spend spike larger than the poll gap is still
 * reported correctly as one decrease.
 *
 * @param {readonly { at: number, totals: Record<string, number> }[]} history
 * @param {{ from: number, to: number, currency: string }} range
 */
export function deriveBalanceDeltas(history, range) {
  const points = history
    .filter((entry) => entry.at >= range.from && entry.at <= range.to)
    .slice()
    .sort((a, b) => a.at - b.at)

  const currency = range.currency
  let spent = 0
  let added = 0
  const movements = []
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const before = previous.totals?.[currency]
    const after = current.totals?.[currency]
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue
    const delta = Number(after) - Number(before)
    if (delta < 0) {
      spent += -delta
      movements.push({ at: current.at, delta, kind: 'spend' })
    } else if (delta > 0) {
      added += delta
      movements.push({ at: current.at, delta, kind: 'increase' })
    }
  }

  return {
    source: 'derived-from-official-balance',
    currency,
    spent,
    added,
    snapshots: points.length,
    movements: movements.slice(-50),
    coverageStart: points.length > 0 ? points[0].at : null,
    coverageEnd: points.length > 0 ? points[points.length - 1].at : null,
    note:
      'Account-wide spend inferred from consecutive official GET /user/balance snapshots; spend before the first snapshot in the window is invisible, and it cannot be split by model.',
  }
}
