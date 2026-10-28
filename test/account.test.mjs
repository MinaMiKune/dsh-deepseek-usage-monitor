import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  AccountApiError,
  accountClientMetadata,
  fetchAccountBalance,
  mapAccountWallets,
} from '../lib/account.js'
import { normalizeConfig } from '../lib/config.js'
import { setup } from '../index.js'
import { createFakeCtx, createServiceRecorder } from './fake-ctx.mjs'

const TEST_TMP = path.join(import.meta.dirname, '.tmp')
const created = []

test.after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

test('wallet mapping splits recharge and granted credit per currency', () => {
  const result = mapAccountWallets({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '40.00' }],
    bonusWallets: [{ currency: 'CNY', balance: '2.50' }],
  })
  assert.deepEqual(result.infos, [{ currency: 'CNY', total: 42.5, granted: 2.5, toppedUp: 40 }])
  assert.deepEqual(result.warnings, [])
})

test('multiple wallets of one currency are summed', () => {
  const result = mapAccountWallets({
    status: 'ready',
    value: [
      { currency: 'USD', balance: '1.00' },
      { currency: 'USD', balance: '2.00' },
      { currency: 'CNY', balance: '5.00' },
    ],
    bonusWallets: [
      { currency: 'CNY', balance: '1.00' },
      { currency: 'CNY', balance: '0.50' },
    ],
  })
  assert.deepEqual(result.infos, [
    { currency: 'CNY', total: 6.5, granted: 1.5, toppedUp: 5 },
    { currency: 'USD', total: 3, granted: 0, toppedUp: 3 },
  ])
})

test('unusable wallets are reported and never counted as zero balance', () => {
  const result = mapAccountWallets({
    status: 'ready',
    value: [{ currency: 'CNY', balance: 'nope' }, { currency: 'XYZ' }, null],
    bonusWallets: [{ currency: 'CNY', balance: '1' }],
  })
  assert.deepEqual(result.infos, [{ currency: 'CNY', total: 1, granted: 1, toppedUp: 0 }])
  assert.equal(result.warnings.length, 3)
})

test('an empty or failed payload throws instead of pretending a zero balance', () => {
  assert.throws(() => mapAccountWallets({ status: 'ready', value: [], bonusWallets: [] }), /no usable wallet/)
  assert.throws(() => mapAccountWallets({ status: 'failed' }), (error) => error.code === 'ACCOUNT_FAILED')
  assert.throws(() => mapAccountWallets({ status: 'weird' }), /unexpected account balance status/)
  assert.throws(() => mapAccountWallets(null), /not an object/)
})

test('a signed-out account is reported as such', async () => {
  await assert.rejects(
    fetchAccountBalance({ account: { getBalance: async () => null } }),
    (error) => error instanceof AccountApiError && error.code === 'ACCOUNT_SIGNED_OUT',
  )
})

test('a throwing account query is classified as a failure, not a low balance', async () => {
  await assert.rejects(
    fetchAccountBalance({
      account: {
        getBalance: async () => {
          throw new Error('network down')
        },
      },
    }),
    (error) => error.code === 'ACCOUNT_FAILED' && error.retryable === false,
  )
})

test('the account payload becomes a snapshot with its own source and usage link', async () => {
  const snapshot = await fetchAccountBalance({
    account: {
      getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '12.00' }], bonusWallets: [] }),
      getState: async () => ({ links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }),
    },
    now: () => 1_000,
  })
  assert.equal(snapshot.source, 'official-account')
  assert.equal(snapshot.isAvailable, null, 'the account payload has no "sufficient for API calls" flag')
  assert.equal(snapshot.infos[0].total, 12)
  assert.equal(snapshot.usageUrl, 'https://platform.deepseek.com/usage')
  assert.equal(snapshot.fetchedAt, 1_000)
  assert.match(snapshot.endpoint, /deepseekAccount/)
})

test('client metadata carries the timezone offset in seconds east of UTC', () => {
  const metadata = accountClientMetadata({ version: '9.9.9', locale: 'zh', now: new Date('2026-10-27T00:00:00Z') })
  assert.equal(metadata.version, '9.9.9')
  assert.equal(metadata.locale, 'zh')
  assert.equal(typeof metadata.timezoneOffsetSeconds, 'number')
})

/**
 * Mount the plugin with an optional fake DeepSeek account service.
 * @param {{ config?: Record<string, unknown>, withKey?: boolean, account?: any }} [options]
 */
async function mount(options = {}) {
  await mkdir(TEST_TMP, { recursive: true })
  const dir = await mkdtemp(path.join(TEST_TMP, 'account-'))
  created.push(dir)
  const recorder = createServiceRecorder()
  const services = { tools: recorder.toolsService, connection: recorder.connectionService }
  if (options.account) services.deepseekAccount = options.account
  const ctx = createFakeCtx({ services })
  const fetchCalls = []
  const runtime = setup({
    ctx,
    rawConfig: { auto_start: false, ...(options.config ?? {}) },
    dir,
    env: options.withKey === false ? {} : { DEEPSEEK_API_KEY: 'sk-test-key-not-a-real-secret' },
    fetchImpl: async () => {
      fetchCalls.push(1)
      return new Response(
        JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '99.00', granted_balance: '0', topped_up_balance: '99.00' }] }),
        { status: 200 },
      )
    },
    sleep: async () => {},
    loggerSink: { log() {}, warn() {}, error() {} },
  })
  await runtime.ready
  return { runtime, ctx, fetchCalls, dir }
}

const READY_ACCOUNT = {
  getBalance: async () => ({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '40.00' }],
    bonusWallets: [{ currency: 'CNY', balance: '2.00' }],
  }),
  getState: async () => ({ links: { usageUrl: 'https://platform.deepseek.com/usage' } }),
}

test('without an API key the signed-in account supplies the official balance', async () => {
  const { runtime, fetchCalls, ctx } = await mount({ withKey: false, account: READY_ACCOUNT })
  const result = await runtime.tool.execute({ action: 'refresh', scope: 'balance' })
  assert.equal(result.balance.ok, true)
  assert.equal(fetchCalls.length, 0, 'the API-key endpoint is not called')
  const view = runtime.monitor.getBalance()
  assert.equal(view.source, 'official-account')
  assert.equal(view.isLive, true)
  assert.equal(view.infos[0].total, 42)
  assert.equal(view.infos[0].toppedUp, 40)
  assert.equal(view.infos[0].granted, 2)
  assert.equal(view.usageUrl, 'https://platform.deepseek.com/usage')
  assert.match(view.providerLabel, /account/i)
  await ctx.dispose()
})

test('auto prefers an API key when one is configured', async () => {
  const { runtime, fetchCalls, ctx } = await mount({ account: READY_ACCOUNT })
  await runtime.monitor.refreshBalance({ reason: 'test' })
  assert.equal(fetchCalls.length, 1, 'the API-key endpoint wins under auto')
  assert.equal(runtime.monitor.getBalance().source, 'official-api')
  await ctx.dispose()
})

test('balance_source can force the account route even when a key exists', async () => {
  const { runtime, fetchCalls, ctx } = await mount({ config: { balance_source: 'account' }, account: READY_ACCOUNT })
  await runtime.monitor.refreshBalance({ reason: 'test' })
  assert.equal(fetchCalls.length, 0)
  assert.equal(runtime.monitor.getBalance().source, 'official-account')
  await ctx.dispose()
})

test('forcing the account route without the service reports a clear code', async () => {
  const { runtime, ctx } = await mount({ config: { balance_source: 'account' } })
  const result = await runtime.monitor.refreshBalance({ reason: 'test' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ACCOUNT_UNAVAILABLE')
  assert.equal(runtime.monitor.getBalance().state, 'error')
  await ctx.dispose()
})

test('a signed-out account does not produce a balance or a low-balance alert', async () => {
  const { runtime, ctx } = await mount({
    withKey: false,
    config: { low_balance_threshold: 10, failure_streak_threshold: 1 },
    account: { getBalance: async () => null },
  })
  const result = await runtime.monitor.refreshBalance({ reason: 'test' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ACCOUNT_SIGNED_OUT')
  const view = runtime.monitor.getBalance()
  assert.equal(view.isUnknown, true)
  assert.equal(view.isCached, false)
  assert.deepEqual(view.infos, [])
  const active = runtime.monitor.getAlerts().active.map((alert) => alert.type)
  assert.equal(active.includes('low_balance'), false)
  assert.ok(active.includes('request_failures'))
  await ctx.dispose()
})

test('balance_source is validated like every other field', () => {
  assert.equal(normalizeConfig({}).config.balanceSource, 'auto')
  assert.equal(normalizeConfig({ balance_source: 'API_KEY' }).config.balanceSource, 'api-key')
  assert.equal(normalizeConfig({ balance_source: 'account' }).config.balanceSource, 'account')
  const invalid = normalizeConfig({ balance_source: 'telepathy' })
  assert.equal(invalid.config.balanceSource, 'auto')
  assert.equal(invalid.issues[0].field, 'balance_source')
})
