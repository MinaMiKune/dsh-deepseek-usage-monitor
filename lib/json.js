/**
 * Lossless-JSON projection for values that cross a model or wire boundary.
 *
 * Cordis validates tool results and Web responses as lossless JSON: `undefined`,
 * `NaN`, `Infinity`, functions, and cycles are all rejected. Plugin internals
 * legitimately carry optional fields as `undefined`, so the boundary converts
 * once instead of relying on every producer to omit them — a missing optional
 * field must degrade to "absent", never to a failed monitoring call.
 */

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function toJsonValue(value) {
  return /** @type {T} */ (convert(value, new WeakSet()))
}

/**
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function convert(value, seen) {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return Number.isFinite(Number(value)) ? Number(value) : null
  if (type === 'function' || type === 'symbol') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) {
    return value.map((entry) => convert(entry, seen))
  }
  if (type === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value)
    if (seen.has(object)) return '[circular]'
    seen.add(object)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, entry] of Object.entries(object)) {
      if (entry === undefined) continue
      if (typeof entry === 'function' || typeof entry === 'symbol') continue
      out[key] = convert(entry, seen)
    }
    seen.delete(object)
    return out
  }
  return null
}
