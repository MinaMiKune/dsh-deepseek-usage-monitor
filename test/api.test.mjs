import test from 'node:test'
import assert from 'node:assert/strict'
import {
  API_ERROR_CODES,
  BalanceApiError,
  backoffDelay,
  fetchBalance,
  parseAmount,
  parseBalancePayload,
  parseRetryAfter,
} from '../lib/deepseek-api.js'

/** The documented success shape from the official API reference. */
const SUCCESS_BODY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    { currency: 'USD', total_balance: '5.50', granted_balance: '0.00', topped_up_balance: '5.50' },
  ],
}

/**
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string> }} [init]
 */
function jsonResponse(body, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

/** Records calls and replays a scripted list of outcomes. */
function scriptedFetch(outcomes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]
    if (typeof next === 'function') return next(url, init)
    return next
  }
  return { fetchImpl, calls }
}

/**
 * A fetch that never answers on its own and rejects when aborted.
 *
 * `AbortSignal.timeout()` arms an UNREF'd timer, so it cannot keep the event
 * loop alive by itself: on Node 20 and 22 the loop drained before the deadline
 * fired and node:test reported "Promise resolution is still pending". The
 * ref'd keep-alive below holds the loop open until the abort arrives, then is
 * cleared. (Node 24 passed by luck; the fixture must not depend on that.)
 */
function hangingFetch(url, init) {
  return new Promise((resolve, reject) => {
    const signal = init?.signal
    if (!signal) {
      reject(new Error('hangingFetch requires an abort signal'))
      return
    }
    const keepAlive = setTimeout(() => undefined, 60_000)
    const onAbort = () => {
      clearTimeout(keepAlive)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

const baseOptions = {
  apiKey: 'test-key-not-a-real-secret',
  baseUrl: 'https://api.deepseek.com',
  maxRetries: 0,
  timeoutMs: 2_000,
}

test('parses the documented balance payload', () => {
  const parsed = parseBalancePayload(SUCCESS_BODY)
  assert.equal(parsed.isAvailable, true)
  assert.equal(parsed.infos.length, 2)
  assert.deepEqual(parsed.infos[0], { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 })
  assert.equal(parsed.infos[1].total, 5.5)
  assert.deepEqual(parsed.warnings, [])
})

test('rejects a payload whose required fields are missing or mistyped', () => {
  assert.throws(() => parseBalancePayload({}), /is_available/)
  assert.throws(() => parseBalancePayload({ is_available: 'yes', balance_infos: [] }), /is_available/)
  assert.throws(() => parseBalancePayload({ is_available: true }), /balance_infos/)
  assert.throws(() => parseBalancePayload({ is_available: true, balance_infos: [] }), /balance_infos/)
  assert.throws(() => parseBalancePayload({ is_available: true, balance_infos: [{ currency: 'CNY' }] }), /no usable balance_infos/)
  assert.throws(() => parseBalancePayload(null), /root/)
  assert.throws(() => parseBalancePayload([]), /root/)
})

test('an unparsable amount cannot be read as a balance', () => {
  const parsed = parseBalancePayload({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: 'not-a-number', granted_balance: '0', topped_up_balance: '0' },
      { currency: 'USD', total_balance: '1.00', granted_balance: '', topped_up_balance: '-4' },
    ],
  })
  assert.equal(parsed.infos.length, 1)
  assert.equal(parsed.infos[0].currency, 'USD')
  assert.equal(parsed.infos[0].total, 1)
  assert.equal(parsed.infos[0].granted, null)
  assert.equal(parsed.infos[0].toppedUp, null)
  assert.equal(parsed.warnings.length, 3)
})

test('parseAmount accepts numeric strings only when finite and non-negative', () => {
  assert.equal(parseAmount('12.5'), 12.5)
  assert.equal(parseAmount(0), 0)
  assert.equal(parseAmount('-1'), undefined)
  assert.equal(parseAmount('abc'), undefined)
  assert.equal(parseAmount(''), undefined)
  assert.equal(parseAmount(null), undefined)
})

test('fetchBalance returns a normalized snapshot for a successful response', async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(SUCCESS_BODY)])
  const result = await fetchBalance({ ...baseOptions, fetchImpl, now: () => new Date(1_700_000_000_000) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(calls[0].init.method, 'GET')
  assert.match(calls[0].init.headers.authorization, /^Bearer test-key/)
  assert.equal(result.isAvailable, true)
  assert.equal(result.source, 'official-api')
  assert.equal(result.fetchedAt, 1_700_000_000_000)
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.infos.map((info) => info.currency), ['CNY', 'USD'])
})

test('a missing API key fails before any request is made', async () => {
  let called = false
  await assert.rejects(
    fetchBalance({
      ...baseOptions,
      apiKey: null,
      fetchImpl: async () => {
        called = true
        return jsonResponse(SUCCESS_BODY)
      },
    }),
    (error) => error instanceof BalanceApiError && error.code === API_ERROR_CODES.NOT_CONFIGURED,
  )
  assert.equal(called, false)
})

test('HTTP 401 is classified as AUTH and is not retried', async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse({ error: 'bad key' }, { status: 401 })])
  await assert.rejects(fetchBalance({ ...baseOptions, maxRetries: 3, fetchImpl }), (error) => {
    assert.equal(error.code, API_ERROR_CODES.AUTH)
    assert.equal(error.status, 401)
    assert.equal(error.retryable, false)
    return true
  })
  assert.equal(calls.length, 1, 'an authentication failure must not be retried')
})

test('HTTP 500 is retried up to max_retries and then reported', async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse({}, { status: 503 })])
  const delays = []
  await assert.rejects(
    fetchBalance({
      ...baseOptions,
      maxRetries: 2,
      fetchImpl,
      sleep: async (ms) => {
        delays.push(ms)
      },
      random: () => 1,
    }),
    (error) => error.code === API_ERROR_CODES.SERVER && error.attempts === 3,
  )
  assert.equal(calls.length, 3)
  assert.equal(delays.length, 2)
  assert.ok(delays[1] > delays[0], `expected growing backoff, got ${delays.join(',')}`)
})

test('HTTP 429 honours Retry-After and succeeds on the retry', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }),
    jsonResponse(SUCCESS_BODY),
  ])
  const delays = []
  const result = await fetchBalance({
    ...baseOptions,
    maxRetries: 2,
    fetchImpl,
    sleep: async (ms) => {
      delays.push(ms)
    },
    random: () => 0,
  })
  assert.equal(calls.length, 2)
  assert.equal(result.attempts, 2)
  assert.ok(delays[0] >= 2_000, `Retry-After must be honoured, got ${delays[0]}`)
})

test('a network failure is classified and retried', async () => {
  const networkError = Object.assign(new Error('connect ECONNREFUSED'), {
    name: 'TypeError',
    cause: { code: 'ECONNREFUSED' },
  })
  const { fetchImpl, calls } = scriptedFetch([
    async () => {
      throw networkError
    },
    jsonResponse(SUCCESS_BODY),
  ])
  const result = await fetchBalance({ ...baseOptions, maxRetries: 1, fetchImpl, sleep: async () => {} })
  assert.equal(calls.length, 2)
  assert.equal(result.attempts, 2)
})

test('a timeout is classified as TIMEOUT, not as a balance problem', async () => {
  await assert.rejects(
    fetchBalance({ ...baseOptions, timeoutMs: 30, maxRetries: 0, fetchImpl: hangingFetch, sleep: async () => {} }),
    (error) => error.code === API_ERROR_CODES.TIMEOUT,
  )
})

test('a timeout during retries stops after max_retries', async () => {
  let calls = 0
  await assert.rejects(
    fetchBalance({
      ...baseOptions,
      timeoutMs: 20,
      maxRetries: 2,
      fetchImpl: async (...args) => {
        calls += 1
        return hangingFetch(...args)
      },
      sleep: async () => {},
    }),
    (error) => error.code === API_ERROR_CODES.TIMEOUT && error.attempts === 3,
  )
  assert.equal(calls, 3)
})

test('cancellation by the caller is reported as ABORTED', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    fetchBalance({ ...baseOptions, signal: controller.signal, fetchImpl: hangingFetch }),
    (error) => error.code === API_ERROR_CODES.ABORTED,
  )
})

test('a malformed JSON body is rejected as INVALID_RESPONSE and not retried', async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse('<html>gateway</html>')])
  await assert.rejects(fetchBalance({ ...baseOptions, maxRetries: 2, fetchImpl, sleep: async () => {} }), (error) => {
    assert.equal(error.code, API_ERROR_CODES.INVALID_RESPONSE)
    assert.equal(error.retryable, false)
    return true
  })
  assert.equal(calls.length, 1)
})

test('an oversized body is refused instead of parsed', async () => {
  await assert.rejects(
    fetchBalance({
      ...baseOptions,
      fetchImpl: async () => jsonResponse('x'.repeat(300 * 1024)),
    }),
    (error) => error.code === API_ERROR_CODES.INVALID_RESPONSE,
  )
})

test('backoff grows exponentially with jitter and never exceeds the cap', () => {
  assert.equal(backoffDelay(1_000, 1, () => 1), 1_000)
  assert.equal(backoffDelay(1_000, 2, () => 1), 2_000)
  assert.equal(backoffDelay(1_000, 3, () => 1), 4_000)
  assert.equal(backoffDelay(1_000, 10, () => 1), 60_000)
  assert.equal(backoffDelay(1_000, 2, () => 0), 1_000)
})

test('Retry-After accepts seconds or an HTTP date', () => {
  const now = new Date('2026-10-27T00:00:00Z')
  assert.equal(parseRetryAfter('3', now), 3_000)
  assert.equal(parseRetryAfter('Wed, 27 Oct 2026 00:00:10 GMT', now), 10_000)
  assert.equal(parseRetryAfter('nonsense', now), undefined)
  assert.equal(parseRetryAfter(null, now), undefined)
  assert.equal(parseRetryAfter('9999', now), 300_000)
})
