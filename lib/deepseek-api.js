/**
 * Minimal DeepSeek API client for the one officially documented account
 * endpoint: `GET /user/balance`.
 *
 * Verified against https://api-docs.deepseek.com/api/get-user-balance:
 * the response is `{ is_available: boolean, balance_infos: [{ currency,
 * total_balance, granted_balance, topped_up_balance }] }` with amounts encoded
 * as strings and currency limited to CNY or USD.
 *
 * DeepSeek publishes no usage, billing-detail, or call-statistics endpoint; this
 * module therefore never fabricates one. Everything else the plugin reports is
 * derived from local observation and is labelled as such.
 */

/** Maximum accepted balance response body size. */
const MAX_BODY_BYTES = 256 * 1024

/** Stable, machine-routable error codes. */
export const API_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER: 'SERVER',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  CLIENT: 'CLIENT',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  ABORTED: 'ABORTED',
})

/** Failure taxonomy with retryability and a user-facing explanation. */
const TAXONOMY = Object.freeze({
  NOT_CONFIGURED: { retryable: false, hint: 'No API key was configured for this plugin.' },
  AUTH: { retryable: false, hint: 'The API key is invalid, revoked, or lacks permission for this endpoint.' },
  RATE_LIMIT: { retryable: true, hint: 'The API rate limit was hit; retried after the advertised delay.' },
  SERVER: { retryable: true, hint: 'DeepSeek returned a server error.' },
  TIMEOUT: { retryable: true, hint: 'The request exceeded the configured timeout.' },
  NETWORK: { retryable: true, hint: 'The request failed before a response arrived (DNS, TCP, TLS, proxy).' },
  CLIENT: { retryable: false, hint: 'The request was rejected by the endpoint.' },
  INVALID_RESPONSE: { retryable: false, hint: 'The response did not match the documented balance schema.' },
  ABORTED: { retryable: false, hint: 'The request was cancelled.' },
})

/** Error raised for every balance failure, with classification attached. */
export class BalanceApiError extends Error {
  /**
   * @param {keyof typeof API_ERROR_CODES} code
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean, retryAfterMs?: number, attempts?: number, cause?: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BalanceApiError'
    this.code = code
    this.status = details.status
    this.retryable = details.retryable ?? TAXONOMY[code]?.retryable ?? false
    this.retryAfterMs = details.retryAfterMs
    this.attempts = details.attempts ?? 0
    this.hint = TAXONOMY[code]?.hint ?? ''
    if (details.cause !== undefined) this.cause = details.cause
  }
}

/**
 * Parse a documented amount string.
 * @param {unknown} value
 * @returns {number | undefined} finite non-negative amount, or undefined.
 */
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Validate and normalize a `/user/balance` payload.
 * @param {unknown} payload
 * @returns {{ isAvailable: boolean, infos: { currency: string, total: number, granted: number | null, toppedUp: number | null }[], warnings: string[] }}
 */
export function parseBalancePayload(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new BalanceApiError(API_ERROR_CODES.INVALID_RESPONSE, 'response root is not a JSON object')
  }
  const record = /** @type {Record<string, unknown>} */ (payload)
  if (typeof record.is_available !== 'boolean') {
    throw new BalanceApiError(API_ERROR_CODES.INVALID_RESPONSE, 'response field "is_available" is missing or not a boolean')
  }
  if (!Array.isArray(record.balance_infos) || record.balance_infos.length === 0) {
    throw new BalanceApiError(API_ERROR_CODES.INVALID_RESPONSE, 'response field "balance_infos" is missing or empty')
  }

  const warnings = []
  const infos = []
  for (const [index, raw] of record.balance_infos.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      warnings.push(`balance_infos[${index}] is not an object and was skipped`)
      continue
    }
    const entry = /** @type {Record<string, unknown>} */ (raw)
    if (typeof entry.currency !== 'string' || !/^[A-Z]{3}$/.test(entry.currency.trim())) {
      warnings.push(`balance_infos[${index}].currency is invalid and the entry was skipped`)
      continue
    }
    const total = parseAmount(entry.total_balance)
    if (total === undefined) {
      warnings.push(`balance_infos[${index}].total_balance is invalid and the entry was skipped`)
      continue
    }
    const granted = parseAmount(entry.granted_balance)
    const toppedUp = parseAmount(entry.topped_up_balance)
    if (granted === undefined) warnings.push(`balance_infos[${index}].granted_balance is invalid; reported as null`)
    if (toppedUp === undefined) warnings.push(`balance_infos[${index}].topped_up_balance is invalid; reported as null`)
    infos.push({ currency: entry.currency.trim(), total, granted: granted ?? null, toppedUp: toppedUp ?? null })
  }

  if (infos.length === 0) {
    throw new BalanceApiError(API_ERROR_CODES.INVALID_RESPONSE, 'no usable balance_infos entry in the response')
  }

  return { isAvailable: record.is_available, infos, warnings }
}

/**
 * Parse a Retry-After header (seconds or HTTP date) into milliseconds.
 * @param {string | null} header
 * @param {Date} now
 * @returns {number | undefined}
 */
export function parseRetryAfter(header, now = new Date()) {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, 300_000)
  const date = new Date(trimmed)
  if (Number.isFinite(date.getTime())) return Math.max(0, Math.min(date.getTime() - now.getTime(), 300_000))
  return undefined
}

/**
 * Map a non-2xx status to a classified error.
 * @param {number} status
 * @param {string | null} retryAfter
 * @param {Date} now
 */
function classifyStatus(status, retryAfter, now) {
  if (status === 401 || status === 403) {
    return new BalanceApiError(API_ERROR_CODES.AUTH, `credentials rejected with HTTP ${status}`, { status })
  }
  if (status === 429) {
    return new BalanceApiError(API_ERROR_CODES.RATE_LIMIT, 'rate limited with HTTP 429', {
      status,
      retryAfterMs: parseRetryAfter(retryAfter, now),
    })
  }
  if (status >= 500) {
    return new BalanceApiError(API_ERROR_CODES.SERVER, `server error with HTTP ${status}`, { status })
  }
  return new BalanceApiError(API_ERROR_CODES.CLIENT, `request rejected with HTTP ${status}`, { status })
}

/** Default sleep implementation. @param {number} ms */
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fetch the account balance with timeout, bounded retries, and exponential
 * backoff with full jitter.
 *
 * @param {{
 *   apiKey: string | null,
 *   baseUrl: string,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   backoffBaseMs?: number,
 *   signal?: AbortSignal,
 *   logger?: { debug: Function, warn: Function },
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   now?: () => Date,
 * }} options
 * @returns {Promise<{ isAvailable: boolean, infos: Array<{currency: string, total: number, granted: number | null, toppedUp: number | null}>, fetchedAt: number, source: string, endpoint: string, warnings: string[], attempts: number, durationMs: number }>}
 */
export async function fetchBalance(options) {
  const {
    apiKey,
    baseUrl,
    timeoutMs = 15_000,
    maxRetries = 2,
    backoffBaseMs = 1_000,
    signal,
    logger,
    fetchImpl = globalThis.fetch,
    sleep = sleepDefault,
    random = Math.random,
    now = () => new Date(),
  } = options

  if (!apiKey) {
    throw new BalanceApiError(API_ERROR_CODES.NOT_CONFIGURED, 'no DeepSeek API key is available')
  }
  if (typeof fetchImpl !== 'function') {
    throw new BalanceApiError(API_ERROR_CODES.NETWORK, 'this runtime provides no fetch implementation')
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/user/balance`
  const attemptsAllowed = Math.max(0, Math.min(5, Math.trunc(maxRetries))) + 1
  const startedAt = now().getTime()
  let lastError

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    if (signal?.aborted) {
      throw new BalanceApiError(API_ERROR_CODES.ABORTED, 'balance request cancelled before dispatch', { attempts: attempt - 1 })
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': 'dsh-deepseek-usage-monitor/1.0',
        },
        signal: combined,
        redirect: 'error',
      })
    } catch (cause) {
      if (signal?.aborted) {
        throw new BalanceApiError(API_ERROR_CODES.ABORTED, 'balance request cancelled', { attempts: attempt, cause })
      }
      if (timeoutSignal.aborted) {
        lastError = new BalanceApiError(API_ERROR_CODES.TIMEOUT, `request timed out after ${timeoutMs} ms`, { attempts: attempt, cause })
      } else {
        lastError = new BalanceApiError(API_ERROR_CODES.NETWORK, describeFetchFailure(cause), { attempts: attempt, cause })
      }
      logger?.debug('balance attempt failed', attempt, lastError.code)
      if (!lastError.retryable || attempt === attemptsAllowed) throw lastError
      await sleep(backoffDelay(backoffBaseMs, attempt, random, undefined))
      continue
    }

    const retryAfter = response.headers?.get?.('retry-after') ?? null
    if (!response.ok) {
      lastError = classifyStatus(response.status, retryAfter, now())
      lastError.attempts = attempt
      logger?.debug('balance attempt rejected', attempt, response.status)
      // Drain the body without exposing it: only its length is relevant.
      try {
        await response.arrayBuffer()
      } catch {
        /* ignore */
      }
      if (!lastError.retryable || attempt === attemptsAllowed) throw lastError
      await sleep(backoffDelay(backoffBaseMs, attempt, random, lastError.retryAfterMs))
      continue
    }

    const declaredLength = Number(response.headers?.get?.('content-length') ?? NaN)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw new BalanceApiError(API_ERROR_CODES.INVALID_RESPONSE, 'balance response body is unexpectedly large', { status: response.status, attempts: attempt })
    }

    let text
    try {
      text = await response.text()
    } catch (cause) {
      if (timeoutSignal.aborted) {
        lastError = new BalanceApiError(API_ERROR_CODES.TIMEOUT, `response body timed out after ${timeoutMs} ms`, { attempts: attempt, cause })
      } else {
        lastError = new BalanceApiError(API_ERROR_CODES.NETWORK, 'failed while reading the response body', { attempts: attempt, cause })
      }
      if (!lastError.retryable || attempt === attemptsAllowed) throw lastError
      await sleep(backoffDelay(backoffBaseMs, attempt, random, undefined))
      continue
    }
    if (text.length > MAX_BODY_BYTES) {
      throw new BalanceApiError(API_ERROR_CODES.INVALID_RESPONSE, 'balance response body is unexpectedly large', { status: response.status, attempts: attempt })
    }

    let payload
    try {
      payload = JSON.parse(text)
    } catch (cause) {
      throw new BalanceApiError(API_ERROR_CODES.INVALID_RESPONSE, 'balance response is not valid JSON', { status: response.status, attempts: attempt, cause })
    }

    const parsed = parseBalancePayload(payload)
    const finishedAt = now().getTime()
    return {
      ...parsed,
      fetchedAt: finishedAt,
      source: 'official-api',
      endpoint,
      attempts: attempt,
      durationMs: finishedAt - startedAt,
    }
  }

  throw lastError ?? new BalanceApiError(API_ERROR_CODES.NETWORK, 'balance request failed without a classified error')
}

/**
 * Exponential backoff with full jitter, honouring a server-provided delay.
 * @param {number} baseMs
 * @param {number} attempt 1-based
 * @param {() => number} random
 * @param {number | undefined} retryAfterMs
 * @returns {number}
 */
export function backoffDelay(baseMs, attempt, random = Math.random, retryAfterMs = undefined) {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 60_000)
  const jittered = Math.round(exponential * (0.5 + random() * 0.5))
  return Math.max(jittered, retryAfterMs ?? 0)
}

/**
 * Reduce a fetch rejection to a short, non-sensitive description.
 * @param {unknown} cause
 * @returns {string}
 */
function describeFetchFailure(cause) {
  if (cause instanceof Error) {
    const code = /** @type {{ cause?: { code?: string } }} */ (cause).cause?.code
    if (typeof code === 'string') return `network request failed (${code})`
    return `network request failed (${cause.name})`
  }
  return 'network request failed'
}
