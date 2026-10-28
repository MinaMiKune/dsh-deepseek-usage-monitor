import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setup } from '../index.js'
import { createFakeCtx, createServiceRecorder } from './fake-ctx.mjs'

const TEST_TMP = path.join(import.meta.dirname, '.tmp')
const created = []
const cleanups = []

test.after(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      /* ignore */
    }
  }
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

const BALANCE_BODY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '8.50', granted_balance: '0.00', topped_up_balance: '8.50' },
  ],
}

/**
 * @param {{
 *   config?: Record<string, unknown>,
 *   fetchImpl?: any,
 *   withTools?: boolean,
 *   withConnection?: boolean,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 */
async function mount(options = {}) {
  await mkdir(TEST_TMP, { recursive: true })
  const dir = await mkdtemp(path.join(TEST_TMP, 'plugin-'))
  created.push(dir)

  const recorder = createServiceRecorder()
  const logs = []
  const sink = {
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  }
  /** @type {Record<string, any>} */
  const services = {}
  if (options.withTools !== false) services.tools = recorder.toolsService
  if (options.withConnection !== false) services.connection = recorder.connectionService

  const ctx = createFakeCtx({ services })
  const fetchCalls = []
  const fetchImpl =
    options.fetchImpl ??
    (async (url, init) => {
      fetchCalls.push({ url, init })
      return new Response(JSON.stringify(BALANCE_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

  let now = Date.parse('2026-10-27T04:00:00Z')
  const runtime = setup({
    ctx,
    rawConfig: options.config ?? {},
    dir,
    clock: { now: () => now },
    fetchImpl,
    env: { DEEPSEEK_API_KEY: 'sk-test-key-not-a-real-secret', ...(options.env ?? {}) },
    sleep: async () => {},
    random: () => 1,
    loggerSink: sink,
  })
  cleanups.push(async () => {
    await runtime.dispose()
    await ctx.dispose()
  })
  await runtime.ready
  await new Promise((resolve) => setImmediate(resolve))

  return {
    ctx,
    runtime,
    dir,
    logs,
    recorder,
    fetchCalls,
    setNow(value) {
      now = value
    },
    advance(ms) {
      now += ms
    },
    get now() {
      return now
    },
  }
}

test('mounting registers the tool, the two Web routes, and the stream capture', async () => {
  const { runtime, recorder, ctx } = await mount()
  assert.ok(recorder.tools.has('deepseek_usage'))
  assert.deepEqual([...recorder.routes.keys()].sort(), [
    '/api/deepseek-usage/refresh',
    '/api/deepseek-usage/snapshot',
  ])
  assert.equal(ctx.listenerCount('llm/stream'), 1)
  assert.equal(runtime.config.maxRetries, 2)
  assert.equal(runtime.initError, null)
})

test('the balance tool returns the official snapshot with a live classification', async () => {
  const { runtime, fetchCalls } = await mount({ config: { auto_start: false } })
  const refreshed = await runtime.tool.execute({ action: 'refresh', scope: 'balance' }, { signal: undefined })
  assert.equal(refreshed.balance.ok, true)
  const result = await runtime.tool.execute({ action: 'balance' }, { signal: undefined })
  assert.equal(result.balance.isLive, true)
  assert.equal(result.balance.isCached, false)
  assert.equal(result.balance.infos[0].total, 8.5)
  assert.equal(result.balance.infos[0].currency, 'CNY')
  assert.equal(fetchCalls.length, 1)
  assert.match(fetchCalls[0].url, /\/user\/balance$/)
  assert.equal(result.balance.source, 'official-api')
})

test('a failing balance refresh keeps the cached value but marks it as not live', async () => {
  let fail = false
  const { runtime } = await mount({
    config: { auto_start: false },
    fetchImpl: async () => {
      if (fail) {
        return new Response('{"error":"nope"}', { status: 401, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(BALANCE_BODY), { status: 200 })
    },
  })
  await runtime.monitor.refreshBalance({ reason: 'seed' })
  const ok = await runtime.tool.execute({ action: 'balance' })
  assert.equal(ok.balance.isLive, true)
  fail = true
  const result = await runtime.tool.execute({ action: 'refresh', scope: 'balance' })
  assert.equal(result.balance.ok, false)
  assert.equal(result.balance.error.code, 'AUTH')
  const view = runtime.monitor.getBalance()
  assert.equal(view.state, 'error')
  assert.equal(view.isCached, true, 'the previous snapshot is still cached')
  assert.equal(view.isLive, false, 'but it is never presented as the current balance')
  assert.equal(view.error.code, 'AUTH')
})

test('an unconfigured key is reported without pretending a balance exists', async () => {
  const { runtime, fetchCalls } = await mount({ config: { auto_start: false, api_key_env: 'SOME_UNSET_VARIABLE' } })
  await runtime.monitor.refreshBalance({ reason: 'test' })
  const result = await runtime.tool.execute({ action: 'balance' })
  assert.equal(result.balance.isUnknown, true)
  assert.equal(result.balance.error.code, 'NOT_CONFIGURED')
  assert.equal(fetchCalls.length, 0)
  assert.equal(result.balance.consecutiveFailures, 0, 'a setup problem is not a transient failure streak')
})

test('the configured environment variable supplies the key', async () => {
  const { runtime, fetchCalls } = await mount({
    config: { api_key_env: 'MY_DEEPSEEK_KEY' },
    env: { MY_DEEPSEEK_KEY: 'sk-from-env-123456' },
  })
  await runtime.tool.execute({ action: 'balance' })
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].init.headers.authorization, 'Bearer sk-from-env-123456')
})

test('the credentials service is preferred and resolved per operation', async () => {
  let current = 'sk-first-111111'
  const { ctx, runtime } = await mount({ config: { api_key_env: 'DSH_KEY' }, env: { DSH_KEY: 'sk-env-should-lose' } })
  ctx.services.credentials = {
    async resolve(ref) {
      return ref === 'DSH_KEY' ? { value: current, source: 'stored' } : undefined
    },
    async describe() {
      return { configured: true, writable: true }
    },
  }
  await runtime.tool.execute({ action: 'balance' })
  current = 'sk-second-222222'
  await runtime.tool.execute({ action: 'refresh', scope: 'balance' })
  const status = await runtime.monitor.credentialStatus()
  assert.equal(status.configured, true)
  assert.equal(status.source, 'credentials')
  assert.equal(status.service.configured, true)
})

test('observed model calls are recorded from provider usage chunks only', async () => {
  const { runtime, ctx } = await mount()
  const listener = ctx.registeredListeners.find((entry) => entry.name === 'llm/stream').listener

  async function drive(chunks, options) {
    const iterable = listener(
      { provider: 'deepseek-official', model: 'deepseek-flash', ...options },
      () =>
        (async function* () {
          for (const chunk of chunks) yield chunk
        })(),
    )
    const seen = []
    for await (const chunk of iterable) seen.push(chunk)
    return seen
  }

  const seen = await drive([
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(seen.length, 3, 'chunks pass through unchanged')

  await drive([
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'x' } } },
  ])

  const usage = runtime.monitor.getUsage({ range: '24h' })
  assert.equal(usage.totals.calls, 2)
  assert.equal(usage.totals.failedCalls, 1)
  assert.equal(usage.totals.inputTokens, 107)
  assert.equal(usage.totals.outputTokens, 23)
  assert.equal(usage.totals.cacheReadTokens, 30)
  assert.equal(usage.totals.totalTokens, 107 + 30 + 23)
  assert.equal(usage.byModel[0].model, 'deepseek-flash')
  assert.equal(usage.source, 'harness-observed')
})

test('a stream failure is recorded and does not break the provider call', async () => {
  const { runtime, ctx } = await mount()
  const listener = ctx.registeredListeners.find((entry) => entry.name === 'llm/stream').listener
  const iterable = listener({ provider: 'deepseek-official', model: 'deepseek-flash' }, () =>
    (async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      throw Object.assign(new Error('boom'), { code: 'TIMEOUT' })
    })(),
  )
  await assert.rejects(async () => {
    for await (const chunk of iterable) void chunk
  }, /boom/)
  const usage = runtime.monitor.getUsage({ range: '24h' })
  assert.equal(usage.totals.calls, 1)
  assert.equal(usage.totals.failedCalls, 1)
})

test('concurrent refreshes share one request instead of issuing duplicates', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let calls = 0
  const { runtime } = await mount({
    fetchImpl: async () => {
      calls += 1
      await gate
      return new Response(JSON.stringify(BALANCE_BODY), { status: 200 })
    },
  })
  const first = runtime.monitor.refreshBalance({ reason: 'first' })
  const second = runtime.monitor.refreshBalance({ reason: 'second' })
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
})

test('pollers start, pause, resume, and stop without leaving timers behind', async () => {
  const { runtime, ctx } = await mount({ config: { auto_start: true, balance_poll_interval: 60 } })
  const balance = runtime.monitor.balancePoller
  assert.equal(balance.enabled, true)
  assert.equal(balance.paused, false)

  assert.equal(balance.pause(), true)
  assert.equal(balance.timer, null)
  assert.equal(balance.pause(), false, 'pause is idempotent')
  assert.equal(balance.resume(), true)

  await ctx.dispose()
  assert.equal(balance.enabled, false)
  assert.equal(balance.timer, null)
  assert.equal(balance.inFlight, false)
  assert.equal(runtime.monitor.usagePoller.enabled, false)
})

test('auto_start false leaves the schedulers idle but manual refresh still works', async () => {
  const { runtime, fetchCalls } = await mount({ config: { auto_start: false } })
  assert.equal(runtime.monitor.balancePoller.enabled, false)
  assert.equal(fetchCalls.length, 0)
  const result = await runtime.tool.execute({ action: 'refresh', scope: 'balance' })
  assert.equal(result.balance.ok, true)
  assert.equal(fetchCalls.length, 1)
})

test('repeated failures raise a request-failure alert instead of a balance alert', async () => {
  const { runtime, advance } = await mount({
    config: { failure_streak_threshold: 2, alert_cooldown: 0 },
    fetchImpl: async () => new Response('{}', { status: 503 }),
  })
  await runtime.tool.execute({ action: 'refresh', scope: 'balance' })
  advance(1_000)
  await runtime.tool.execute({ action: 'refresh', scope: 'balance' })
  const alerts = runtime.monitor.getAlerts()
  const active = alerts.active.map((alert) => alert.type)
  assert.ok(active.includes('request_failures'))
  assert.equal(active.includes('low_balance'), false, 'a failing refresh must never be reported as low balance')
})

test('a low balance alert is raised from a successful official snapshot', async () => {
  const { runtime } = await mount({ config: { low_balance_threshold: 10, low_balance_currency: 'CNY' } })
  await runtime.tool.execute({ action: 'refresh', scope: 'balance' })
  const alerts = runtime.monitor.getAlerts()
  const low = alerts.active.find((alert) => alert.type === 'low_balance')
  assert.ok(low)
  assert.equal(low.value, 8.5)
  assert.equal(low.threshold, 10)
  assert.equal(low.source, 'official-api')
})

test('runtime threshold overrides are validated, persisted, and resettable', async () => {
  const { runtime, dir } = await mount()
  const applied = await runtime.tool.execute({
    action: 'set_thresholds',
    thresholds: { low_balance_threshold: 20, daily_token_threshold: 5000, alert_cooldown: -1, nonsense: 1 },
  })
  assert.deepEqual(applied.result.applied, { low_balance_threshold: 20, daily_token_threshold: 5000 })
  assert.equal(applied.result.rejected.length, 2)
  assert.equal(runtime.monitor.getAlerts().thresholds.lowBalance.threshold, 20)

  await runtime.monitor.flush()
  const persisted = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(persisted.overrides.low_balance_threshold, 20)

  const reset = await runtime.tool.execute({ action: 'reset_thresholds' })
  assert.equal(reset.result.effective.lowBalance.threshold, 10)
})

test('clearing history requires explicit confirmation', async () => {
  const { runtime } = await mount()
  await assert.rejects(runtime.tool.execute({ action: 'clear_history' }), /confirm/)
  await runtime.monitor.recordCall({ model: 'deepseek-flash', inputTokens: 5, status: 'ok' })
  assert.equal(runtime.monitor.getUsage({ range: '24h' }).totals.calls, 1)
  const cleared = await runtime.tool.execute({ action: 'clear_history', confirm: true })
  assert.equal(cleared.removed.calls, 1)
  assert.equal(runtime.monitor.getUsage({ range: '24h' }).totals.calls, 0)
})

test('the Web snapshot handler serves the same data as the tool', async () => {
  const { runtime, recorder } = await mount({ config: { auto_start: false } })
  await runtime.monitor.refreshBalance({ reason: 'test' })
  const snapshotRoute = recorder.routes.get('/api/deepseek-usage/snapshot')
  const response = await snapshotRoute.fetch(new Request('http://127.0.0.1/api/deepseek-usage/snapshot?range=24h'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.snapshot.balance.source, 'official-api')
  assert.equal(body.snapshot.usage.source, 'harness-observed')
  assert.equal(body.snapshot.sources.usage.kind, 'official-unavailable')
  assert.equal(body.snapshot.sources.balance.kind, 'official')
  assert.equal(response.headers.get('cache-control'), 'no-store')

  const invalid = await snapshotRoute.fetch(new Request('http://127.0.0.1/api/deepseek-usage/snapshot?range=99d'))
  assert.equal(invalid.status, 400)
  const invalidBody = await invalid.json()
  assert.equal(invalidBody.error.code, 'INVALID_RANGE')
})

test('the refresh handler validates its body and scope', async () => {
  const { runtime, recorder } = await mount()
  const refreshRoute = recorder.routes.get('/api/deepseek-usage/refresh')
  const ok = await refreshRoute.fetch(
    new Request('http://127.0.0.1/api/deepseek-usage/refresh', {
      method: 'POST',
      body: JSON.stringify({ scope: 'balance' }),
    }),
  )
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.ok, true)
  assert.equal(body.balanceView.isLive, true)

  const badScope = await refreshRoute.fetch(
    new Request('http://127.0.0.1/api/deepseek-usage/refresh', { method: 'POST', body: JSON.stringify({ scope: 'x' }) }),
  )
  assert.equal(badScope.status, 400)

  const badBody = await refreshRoute.fetch(
    new Request('http://127.0.0.1/api/deepseek-usage/refresh', { method: 'POST', body: '{not json' }),
  )
  assert.equal(badBody.status, 400)
})

test('the plugin still mounts without tools or a connection service', async () => {
  const { runtime, recorder } = await mount({ withTools: false, withConnection: false })
  assert.equal(recorder.tools.size, 0)
  assert.equal(recorder.routes.size, 0)
  // The capture and the state machine still work.
  await runtime.monitor.recordCall({ model: 'deepseek-flash', inputTokens: 3, status: 'ok' })
  assert.equal(runtime.monitor.getUsage({ range: '24h' }).totals.calls, 1)
})

test('every tool result is lossless JSON, including the failure path', async () => {
  // A failing refresh used to leak `undefined` optional fields, which the tool
  // registry rejects as "value is not lossless JSON".
  const { runtime } = await mount({
    config: { auto_start: false },
    fetchImpl: async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    },
  })
  const failures = await runtime.tool.execute({ action: 'refresh', scope: 'balance' })
  assert.equal(failures.balance.ok, false)

  const calls = [
    { action: 'status' },
    { action: 'balance' },
    { action: 'usage', range: '24h' },
    { action: 'usage', range: 'custom', start: '2026-10-20T00:00:00Z', end: '2026-10-22T00:00:00Z' },
    { action: 'alerts' },
    { action: 'refresh', scope: 'balance' },
    { action: 'set_thresholds', thresholds: { low_balance_threshold: 5 } },
    { action: 'reset_thresholds' },
  ]
  for (const args of calls) {
    const value = await runtime.tool.execute(args)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `action ${args.action} must round-trip`)
    assert.equal(JSON.stringify(value).includes('undefined'), false)
  }
})

test('official usage, local usage, and derived spend stay separate', async () => {
  let call = 0
  const totals = ['100.00', '92.50']
  const { runtime, advance } = await mount({
    config: { auto_start: false, low_balance_currency: 'CNY' },
    fetchImpl: async () => {
      const total = totals[Math.min(call, totals.length - 1)]
      call += 1
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '0', topped_up_balance: total }],
        }),
        { status: 200 },
      )
    },
  })
  await runtime.monitor.refreshBalance({ reason: 'seed' })
  advance(60_000)
  await runtime.monitor.refreshBalance({ reason: 'later' })

  await runtime.monitor.recordCall({
    model: 'deepseek-flash',
    inputTokens: 1_000_000,
    outputTokens: 0,
    status: 'ok',
  })
  const usage = runtime.monitor.getUsage({ range: '1h' })

  assert.equal(usage.costEstimate.estimated, true)
  assert.ok(usage.costEstimate.usd > 0)
  assert.equal(usage.accountSpend.source, 'derived-from-official-balance')
  assert.equal(usage.accountSpend.currency, 'CNY')
  assert.equal(usage.accountSpend.snapshots, 2)
  assert.equal(usage.accountSpend.spent, 7.5, 'spend comes from the official balance delta')
  assert.notEqual(usage.costEstimate.usd, usage.accountSpend.spent)
  assert.match(usage.costEstimate.note, /not the billed amount/i)
  // The two figures are reported separately and never summed together.
  assert.equal(usage.totals.totalTokens, 1_000_000)
})
