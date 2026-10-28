/**
 * Cost estimation from the published DeepSeek price list.
 *
 * All figures here are ESTIMATES derived from token counts this plugin observed
 * plus a price table; they are not the account's billed amount. The billed amount
 * is only visible through the balance deduction the DeepSeek platform applies,
 * which this plugin reports separately as a balance delta.
 *
 * Prices are USD per 1,000,000 tokens, taken from
 * https://api-docs.deepseek.com/quick_start/pricing on 2026-10-27. DeepSeek
 * reserves the right to change them; override the table in plugin config when it
 * changes. Peak hours are 01:00-04:00 and 06:00-10:00 UTC on weekdays; Chinese
 * public holidays are NOT excluded because no holiday calendar is available.
 */

import { isPeakPricing } from './time.js'

/** @typedef {{ cacheHit: number, cacheMiss: number, output: number }} PriceTier */

/** @typedef {{ peak: PriceTier, offPeak: PriceTier }} ModelPrice */

/** Price source label surfaced in every cost response. */
export const PRICE_SOURCE = 'DeepSeek official price list (api-docs.deepseek.com/quick_start/pricing), retrieved 2026-10-27'

/** @type {Record<string, ModelPrice>} */
export const BUILTIN_PRICES = Object.freeze({
  'deepseek-flash': Object.freeze({
    peak: Object.freeze({ cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }),
    offPeak: Object.freeze({ cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }),
  }),
  'deepseek-v4-pro': Object.freeze({
    peak: Object.freeze({ cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }),
    offPeak: Object.freeze({ cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }),
  }),
})

/**
 * Legacy model ids still accepted by the API and billed at the Flash price.
 * @type {Record<string, string>}
 */
const ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
})

/**
 * Resolve one model id to a price entry.
 * @param {string} model
 * @param {Record<string, ModelPrice> | null} override
 * @returns {{ key: string, price: ModelPrice } | undefined}
 */
export function resolveModelPrice(model, override = null) {
  const table = override ?? BUILTIN_PRICES
  const direct = table[model]
  if (direct) return { key: model, price: normalizePrice(direct) }
  const alias = ALIASES[model]
  if (alias && table[alias]) return { key: alias, price: normalizePrice(table[alias]) }
  // A dated variant such as `deepseek-v4-pro-0813` still prices as its base model.
  for (const key of Object.keys(table)) {
    if (model.startsWith(`${key}-`)) return { key, price: normalizePrice(table[key]) }
  }
  return undefined
}

/**
 * @param {ModelPrice} price
 * @returns {ModelPrice}
 */
function normalizePrice(price) {
  return {
    peak: price.peak ?? price.offPeak,
    offPeak: price.offPeak ?? price.peak,
  }
}

/**
 * Estimated USD cost of one recorded call.
 *
 * Token fields are disjoint (`inputTokens` is uncached input). DeepSeek publishes
 * no separate cache-write rate, so written cache tokens are priced at the
 * cache-miss rate — an upper bound, stated rather than hidden.
 *
 * @param {{ at: number, model: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} record
 * @param {{ prices?: Record<string, ModelPrice> | null }} [options]
 * @returns {{ usd: number, priced: boolean, priceKey?: string, tier?: 'peak'|'off_peak', basis: string }}
 */
export function estimateCallCost(record, options = {}) {
  const resolved = resolveModelPrice(record.model, options.prices ?? null)
  if (!resolved) {
    return {
      usd: 0,
      priced: false,
      basis: `no price entry for model "${record.model}"; configure price_table to price it`,
    }
  }
  const peak = isPeakPricing(new Date(record.at))
  const tier = resolved.price[peak ? 'peak' : 'offPeak']
  const cacheMissTokens = (record.inputTokens ?? 0) + (record.cacheWriteTokens ?? 0)
  const cacheHitTokens = record.cacheReadTokens ?? 0
  const outputTokens = record.outputTokens ?? 0
  const usd =
    (cacheMissTokens * tier.cacheMiss + cacheHitTokens * tier.cacheHit + outputTokens * tier.output) /
    1_000_000
  return {
    usd,
    priced: true,
    priceKey: resolved.key,
    tier: peak ? 'peak' : 'off_peak',
    basis: `${PRICE_SOURCE}; ${peak ? 'peak' : 'off-peak'} rate`,
  }
}

/**
 * Aggregate estimate across recorded calls.
 * @param {readonly any[]} records
 * @param {{ prices?: Record<string, ModelPrice> | null }} [options]
 * @returns {{ usd: number, pricedCalls: number, unpricedCalls: number, unpricedModels: string[], source: string, currency: 'USD', estimated: true, peakHoursExcludeHolidays: false }}
 */
export function estimateCost(records, options = {}) {
  let usd = 0
  let pricedCalls = 0
  let unpricedCalls = 0
  const unpriced = new Set()
  for (const record of records) {
    const cost = estimateCallCost(record, options)
    if (cost.priced) {
      usd += cost.usd
      pricedCalls += 1
    } else {
      unpricedCalls += 1
      unpriced.add(record.model)
    }
  }
  return {
    usd,
    pricedCalls,
    unpricedCalls,
    unpricedModels: [...unpriced].sort(),
    source: options.prices ? 'plugin price_table override' : PRICE_SOURCE,
    currency: 'USD',
    estimated: true,
    peakHoursExcludeHolidays: false,
  }
}
