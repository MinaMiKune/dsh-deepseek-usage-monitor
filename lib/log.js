/**
 * Tagged, secret-redacting logger for the DeepSeek Usage Monitor.
 *
 * The monitor never logs an API key, an Authorization header, a prompt, or a
 * response body. This module additionally redacts any Bearer token and any
 * `sk-` shaped token that reaches a log line, so an accidental string
 * interpolation elsewhere cannot leak a credential.
 */

const REDACTIONS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted-key]'],
]

/** @param {unknown} value */
function formatValue(value) {
  if (typeof value === 'string') return redact(value)
  if (value instanceof Error) return redact(value.stack || `${value.name}: ${value.message}`)
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  try {
    return redact(JSON.stringify(value))
  } catch {
    return '[unserializable]'
  }
}

/**
 * Remove credential-shaped substrings from a string.
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  let out = String(text)
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

/**
 * Create one tagged logger. `debug` lines are dropped unless debugging is on.
 * @param {{ debug?: boolean, sink?: Pick<Console, 'log'|'warn'|'error'> }} [options]
 */
export function createLogger({ debug = false, sink = console } = {}) {
  const prefix = '[deepseek-usage]'
  return {
    debugEnabled: debug,
    /** @param {...unknown} args */
    debug(...args) {
      if (debug) sink.log(prefix, ...args.map(formatValue))
    },
    /** @param {...unknown} args */
    info(...args) {
      sink.log(prefix, ...args.map(formatValue))
    },
    /** @param {...unknown} args */
    warn(...args) {
      sink.warn(prefix, ...args.map(formatValue))
    },
    /** @param {...unknown} args */
    error(...args) {
      sink.error(prefix, ...args.map(formatValue))
    },
  }
}
