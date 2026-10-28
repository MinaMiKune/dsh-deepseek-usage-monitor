import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createLogger, redact } from '../lib/log.js'
import { normalizeConfig } from '../lib/config.js'
import { setup } from '../index.js'
import { createFakeCtx, createServiceRecorder } from './fake-ctx.mjs'

const TEST_TMP = path.join(import.meta.dirname, '.tmp')
const SECRET = 'sk-abcdef0123456789abcdef0123456789'

test.after(async () => {
  await rm(TEST_TMP, { recursive: true, force: true })
})

test('the logger redacts bearer tokens and api-key-shaped strings', () => {
  assert.equal(redact('Authorization: Bearer abc123def456'), 'Authorization: Bearer [redacted]')
  assert.equal(redact(`key is ${SECRET} ok`), 'key is [redacted-key] ok')
  assert.equal(redact('nothing secret here'), 'nothing secret here')
})

test('logging an object that contains the key cannot leak it', () => {
  const lines = []
  const logger = createLogger({
    debug: true,
    sink: { log: (...args) => lines.push(args.join(' ')), warn: (...args) => lines.push(args.join(' ')), error: (...args) => lines.push(args.join(' ')) },
  })
  logger.info('attempt', { authorization: `Bearer ${SECRET}`, apiKey: SECRET })
  logger.warn('failure', new Error(`request failed with ${SECRET}`))
  logger.debug('debug', SECRET)
  const joined = lines.join('\n')
  assert.equal(joined.includes(SECRET), false)
  assert.match(joined, /\[redacted/)
})

test('a failed balance response body never reaches the error message or the log', async () => {
  await mkdir(TEST_TMP, { recursive: true })
  const dir = await mkdtemp(path.join(TEST_TMP, 'security-'))
  const lines = []
  const sink = { log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) }
  const recorder = createServiceRecorder()
  const ctx = createFakeCtx({ services: { tools: recorder.toolsService, connection: recorder.connectionService } })
  const runtime = setup({
    ctx,
    rawConfig: { auto_start: false, debug: true },
    dir,
    env: { DEEPSEEK_API_KEY: SECRET },
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: `internal detail ${SECRET} from upstream` } }), { status: 500 }),
    sleep: async () => {},
    loggerSink: sink,
  })
  await runtime.ready
  await runtime.monitor.refreshBalance({ reason: 'security' })
  const balance = runtime.monitor.getBalance()
  assert.equal(balance.state, 'error')
  assert.equal(JSON.stringify(balance).includes(SECRET), false, 'the tool output must not carry the key')
  assert.equal(JSON.stringify(balance).includes('internal detail'), false, 'the upstream body must not be surfaced')
  assert.equal(lines.join('\n').includes(SECRET), false)
  await runtime.dispose()
  await ctx.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('the API key is never written to the state file', async () => {
  await mkdir(TEST_TMP, { recursive: true })
  const dir = await mkdtemp(path.join(TEST_TMP, 'security-'))
  const recorder = createServiceRecorder()
  const ctx = createFakeCtx({ services: { tools: recorder.toolsService, connection: recorder.connectionService } })
  const runtime = setup({
    ctx,
    rawConfig: { auto_start: false, api_key: SECRET },
    dir,
    env: {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00', granted_balance: '0', topped_up_balance: '1.00' }] }),
        { status: 200 },
      ),
    sleep: async () => {},
    loggerSink: { log() {}, warn() {}, error() {} },
  })
  await runtime.ready
  await runtime.monitor.refreshBalance({ reason: 'security' })
  await runtime.monitor.flush()
  const state = await readFile(path.join(dir, 'state.json'), 'utf8')
  assert.equal(state.includes(SECRET), false)
  assert.equal(state.includes('authorization'), false)
  const status = await runtime.monitor.getStatus()
  assert.equal(JSON.stringify(status).includes(SECRET), false)
  assert.equal(status.credentials.configured, true)
  await runtime.dispose()
  await ctx.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a misconfigured retry count cannot become an unbounded loop', () => {
  const { config, issues } = normalizeConfig({ max_retries: 10_000 })
  assert.equal(config.maxRetries, 2)
  assert.equal(issues[0].field, 'max_retries')
  assert.equal(normalizeConfig({ max_retries: -3 }).config.maxRetries, 2)
  assert.equal(normalizeConfig({ max_retries: 5 }).config.maxRetries, 5)
})

test('a hostile payload cannot pollute the local statistics', async () => {
  await mkdir(TEST_TMP, { recursive: true })
  const dir = await mkdtemp(path.join(TEST_TMP, 'security-'))
  const recorder = createServiceRecorder()
  const ctx = createFakeCtx({ services: { tools: recorder.toolsService, connection: recorder.connectionService } })
  const runtime = setup({
    ctx,
    rawConfig: { auto_start: false },
    dir,
    env: { DEEPSEEK_API_KEY: SECRET },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          is_available: 'yes',
          balance_infos: [{ currency: 'CNY', total_balance: 'NaN' }],
          calls: [{ model: 'injected', inputTokens: 999_999 }],
        }),
        { status: 200 },
      ),
    sleep: async () => {},
    loggerSink: { log() {}, warn() {}, error() {} },
  })
  await runtime.ready
  await runtime.monitor.refreshBalance({ reason: 'security' })
  const balance = runtime.monitor.getBalance()
  assert.equal(balance.state, 'error')
  assert.equal(balance.error.code, 'INVALID_RESPONSE')
  assert.deepEqual(balance.infos, [])
  const usage = runtime.monitor.getUsage({ range: '24h' })
  assert.equal(usage.totals.calls, 0, 'an upstream payload cannot create local call records')
  await runtime.dispose()
  await ctx.dispose()
  await rm(dir, { recursive: true, force: true })
})
