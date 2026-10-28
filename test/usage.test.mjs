import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bucketKey,
  buildBuckets,
  dayKey,
  isPeakPricing,
  nextDayStart,
  resolveRange,
  zonedStartOfDay,
  zonedStartOfHour,
} from '../lib/time.js'
import { estimateCallCost, estimateCost, resolveModelPrice } from '../lib/pricing.js'
import {
  aggregateDay,
  aggregateUsage,
  deriveBalanceDeltas,
  sumTokens,
  validateCallRecord,
} from '../lib/usage.js'

/** @param {Partial<Record<string, unknown>>} [overrides] */
function call(overrides = {}) {
  return {
    at: Date.parse('2026-10-27T03:00:00Z'),
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    status: 'ok',
    durationMs: 1_000,
    ...overrides,
  }
}

test('day boundaries follow the configured timezone, not the host zone', () => {
  const instant = new Date('2026-10-27T00:30:00Z')
  assert.equal(dayKey(instant, 'Asia/Shanghai'), '2026-10-27')
  assert.equal(dayKey(instant, 'UTC'), '2026-10-27')
  assert.equal(zonedStartOfDay(instant, 'Asia/Shanghai').toISOString(), '2026-10-26T16:00:00.000Z')
  // 23:30 UTC on the 26th is already the 27th in Shanghai.
  assert.equal(dayKey(new Date('2026-10-26T15:30:00Z'), 'Asia/Shanghai'), '2026-10-26')
  assert.equal(dayKey(new Date('2026-10-26T16:30:00Z'), 'Asia/Shanghai'), '2026-10-27')
})

test('a half-hour offset zone starts its hours on the half hour', () => {
  const instant = new Date('2026-10-27T00:30:00Z')
  // Asia/Kolkata is UTC+05:30, so the containing local hour starts at 06:00 local = 00:30 UTC.
  assert.equal(zonedStartOfHour(instant, 'Asia/Kolkata').toISOString(), '2026-10-27T00:30:00.000Z')
  assert.equal(bucketKey(new Date('2026-10-27T00:30:00Z'), 'Asia/Kolkata', 'hour'), '2026-10-27 06:00')
})

test('adjacent day starts advance exactly one calendar day', () => {
  const start = zonedStartOfDay(new Date('2026-03-28T12:00:00Z'), 'Europe/Berlin')
  const next = nextDayStart(start, 'Europe/Berlin')
  assert.equal(dayKey(next, 'Europe/Berlin'), '2026-03-29')
  // DST starts on 2026-03-29 in Berlin, so that day is 23 hours long.
  assert.equal((next.getTime() - start.getTime()) / 3_600_000, 24)
  const after = nextDayStart(next, 'Europe/Berlin')
  assert.equal((after.getTime() - next.getTime()) / 3_600_000, 23)
})

test('resolveRange validates relative and custom windows', () => {
  const now = new Date('2026-10-27T12:00:00Z')
  const day = resolveRange({ range: '24h', now, zone: 'UTC' })
  assert.equal(day.bucket, 'hour')
  assert.equal(day.to.getTime() - day.from.getTime(), 24 * 3_600_000)

  const week = resolveRange({ range: '7d', now, zone: 'UTC' })
  assert.equal(week.bucket, 'day')

  const custom = resolveRange({
    range: 'custom',
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-04T00:00:00Z',
    now,
    zone: 'UTC',
  })
  assert.equal(custom.from.toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(custom.bucket, 'day')

  assert.throws(() => resolveRange({ range: '2w', now, zone: 'UTC' }), /unsupported range/)
  assert.throws(() => resolveRange({ range: 'custom', now, zone: 'UTC' }), /start and end/)
  assert.throws(
    () => resolveRange({ range: 'custom', start: '2026-10-03T00:00:00Z', end: '2026-10-01T00:00:00Z', now, zone: 'UTC' }),
    /after start/,
  )
  assert.throws(
    () =>
      resolveRange({
        range: 'custom',
        start: '2020-01-01T00:00:00Z',
        end: '2022-01-01T00:00:00Z',
        now,
        zone: 'UTC',
      }),
    /366 days/,
  )
})

test('buckets cover the whole window and stay bounded', () => {
  const range = resolveRange({ range: '24h', now: new Date('2026-10-27T12:00:00Z'), zone: 'Asia/Shanghai' })
  const buckets = buildBuckets(range, 'Asia/Shanghai')
  assert.equal(buckets.length, 24)
  assert.equal(buckets[0].start, zonedStartOfHour(range.from, 'Asia/Shanghai').getTime())
  for (let index = 1; index < buckets.length; index += 1) {
    assert.equal(buckets[index].start, buckets[index - 1].end)
  }
  assert.ok(buckets[buckets.length - 1].end >= range.to.getTime())
})

test('peak pricing follows the published UTC weekday rule', () => {
  // 2026-10-27 is a Tuesday.
  assert.equal(isPeakPricing(new Date('2026-10-27T02:00:00Z')), true)
  assert.equal(isPeakPricing(new Date('2026-10-27T07:00:00Z')), true)
  assert.equal(isPeakPricing(new Date('2026-10-27T05:00:00Z')), false)
  assert.equal(isPeakPricing(new Date('2026-10-27T12:00:00Z')), false)
  // Saturday and Sunday are always off-peak.
  assert.equal(isPeakPricing(new Date('2026-10-31T02:00:00Z')), false)
  assert.equal(isPeakPricing(new Date('2026-11-01T07:00:00Z')), false)
})

test('cost estimation uses the published flash rates and marks the tier', () => {
  const peak = estimateCallCost(call({ at: Date.parse('2026-10-27T02:00:00Z') }))
  assert.equal(peak.priced, true)
  assert.equal(peak.tier, 'peak')
  assert.equal(peak.priceKey, 'deepseek-flash')
  assert.equal(Number(peak.usd.toFixed(6)), 0.3)

  const offPeak = estimateCallCost(call({ at: Date.parse('2026-10-27T12:00:00Z') }))
  assert.equal(offPeak.tier, 'off_peak')
  assert.equal(Number(offPeak.usd.toFixed(6)), 0.15)

  const cacheOnly = estimateCallCost(
    call({ at: Date.parse('2026-10-27T02:00:00Z'), inputTokens: 0, cacheReadTokens: 1_000_000 }),
  )
  assert.equal(Number(cacheOnly.usd.toFixed(6)), 0.006)

  const outputOnly = estimateCallCost(
    call({ at: Date.parse('2026-10-27T02:00:00Z'), inputTokens: 0, outputTokens: 1_000_000 }),
  )
  assert.equal(Number(outputOnly.usd.toFixed(6)), 1.2)
})

test('an unknown model is reported as unpriced instead of being guessed', () => {
  const result = estimateCallCost(call({ model: 'some-other-model' }))
  assert.equal(result.priced, false)
  assert.equal(result.usd, 0)
  assert.match(result.basis, /no price entry/)

  const aggregate = estimateCost([call(), call({ model: 'some-other-model' })])
  assert.equal(aggregate.pricedCalls, 1)
  assert.equal(aggregate.unpricedCalls, 1)
  assert.deepEqual(aggregate.unpricedModels, ['some-other-model'])
  assert.equal(aggregate.currency, 'USD')
  assert.equal(aggregate.estimated, true)
})

test('legacy and dated model ids resolve to a published price entry', () => {
  assert.equal(resolveModelPrice('deepseek-chat')?.key, 'deepseek-flash')
  assert.equal(resolveModelPrice('deepseek-v4-flash')?.key, 'deepseek-flash')
  assert.equal(resolveModelPrice('deepseek-v4-pro-0813')?.key, 'deepseek-v4-pro')
  assert.equal(resolveModelPrice('nope'), undefined)
})

test('token totals treat cache counts as disjoint from input', () => {
  const totals = sumTokens([
    call({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 2 }),
    call({ inputTokens: 1, outputTokens: 1, status: 'error' }),
  ])
  assert.equal(totals.billedInputTokens, 10 + 7 + 3 + 1)
  assert.equal(totals.totalTokens, 10 + 7 + 3 + 1 + 5 + 1)
  assert.equal(totals.failedCalls, 1)
  assert.equal(totals.cacheHitRatio, 7 / 21)
})

test('aggregation splits by model and buckets records in the configured zone', () => {
  const now = new Date('2026-10-27T12:00:00Z')
  const range = resolveRange({ range: '24h', now, zone: 'Asia/Shanghai' })
  const records = [
    call({ at: Date.parse('2026-10-27T01:00:00Z'), inputTokens: 100, outputTokens: 10 }),
    call({ at: Date.parse('2026-10-27T02:00:00Z'), model: 'deepseek-v4-pro', inputTokens: 5 }),
    call({ at: Date.parse('2026-10-20T02:00:00Z'), inputTokens: 999 }),
  ]
  const aggregate = aggregateUsage(records, { ...range, zone: 'Asia/Shanghai' })
  assert.equal(aggregate.totals.calls, 2)
  assert.equal(aggregate.source, 'harness-observed')
  assert.equal(aggregate.totals.inputTokens, 105)
  assert.equal(aggregate.buckets.length, 24)
  assert.equal(
    aggregate.buckets.reduce((sum, bucket) => sum + bucket.calls, 0),
    2,
  )
  assert.equal(aggregate.byModel.length, 2)
  assert.equal(aggregate.byModel[0].model, 'deepseek-flash')
  assert.equal(aggregate.cost.estimated, true)
})

test('daily aggregation uses half-open day bounds', () => {
  const zone = 'Asia/Shanghai'
  const dayStart = zonedStartOfDay(new Date('2026-10-27T12:00:00Z'), zone)
  const dayEnd = nextDayStart(dayStart, zone)
  const records = [
    call({ at: dayStart.getTime(), inputTokens: 10 }),
    call({ at: dayEnd.getTime() - 1, inputTokens: 20 }),
    call({ at: dayEnd.getTime(), inputTokens: 40 }),
  ]
  const day = aggregateDay(records, { zone, now: new Date(), prices: null, dayStart, dayEnd })
  assert.equal(day.calls, 2)
  assert.equal(day.totalTokens, 30)
})

test('balance deltas separate spend from top-ups', () => {
  const history = [
    { at: 1_000, totals: { CNY: 100 } },
    { at: 2_000, totals: { CNY: 95 } },
    { at: 3_000, totals: { CNY: 195 } },
    { at: 4_000, totals: { CNY: 190 } },
  ]
  const result = deriveBalanceDeltas(history, { from: 0, to: 5_000, currency: 'CNY' })
  assert.equal(result.spent, 10)
  assert.equal(result.added, 100)
  assert.equal(result.snapshots, 4)
  assert.equal(result.source, 'derived-from-official-balance')
  assert.equal(result.movements.length, 3)
  assert.equal(result.movements[0].kind, 'spend')
})

test('balance deltas ignore currencies that are not present', () => {
  const result = deriveBalanceDeltas([{ at: 1, totals: { USD: 10 } }, { at: 2, totals: { USD: 4 } }], {
    from: 0,
    to: 10,
    currency: 'CNY',
  })
  assert.equal(result.spent, 0)
  assert.equal(result.snapshots, 2)
})

test('call records are validated strictly before they can reach statistics', () => {
  assert.equal(validateCallRecord(null), undefined)
  assert.equal(validateCallRecord({}), undefined)
  assert.equal(validateCallRecord({ at: Date.now(), model: '' }), undefined)
  assert.equal(validateCallRecord({ at: 'x', model: 'deepseek-flash' }), undefined)
  const bad = validateCallRecord({
    at: Date.now(),
    model: 'deepseek-flash',
    inputTokens: -5,
    outputTokens: 'many',
    status: 'weird',
    reasoningTokens: 999,
  })
  assert.equal(bad.inputTokens, 0)
  assert.equal(bad.outputTokens, 0)
  assert.equal(bad.status, 'ok')
  assert.equal(bad.reasoningTokens, 0, 'reasoning is clamped to output tokens')
  assert.equal(bad.provider, 'unknown')
})
