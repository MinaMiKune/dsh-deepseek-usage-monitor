import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { StateStore, coerceState, emptyState, defaultDataDir } from '../lib/store.js'

/** Temp root kept inside the package so no test writes outside the project. */
const TEST_TMP = path.join(import.meta.dirname, '.tmp')

const created = []

/** @param {Partial<Record<string, unknown>>} [overrides] */
async function tempStore(overrides = {}) {
  await mkdir(TEST_TMP, { recursive: true })
  const dir = await mkdtemp(path.join(TEST_TMP, 'store-'))
  created.push(dir)
  const store = new StateStore({
    dir,
    retentionDays: overrides.retentionDays ?? 30,
    maxCallRecords: overrides.maxCallRecords ?? 100,
  })
  return { dir, store }
}

test.after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

function record(at, model = 'deepseek-flash') {
  return {
    at,
    model,
    provider: 'deepseek-official',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    status: 'ok',
    durationMs: 100,
  }
}

test('state persists across store instances', async () => {
  const { dir, store } = await tempStore()
  const loaded = await store.load()
  assert.equal(loaded.loaded, false)
  await store.update((state) => {
    state.calls.push(record(Date.now()))
    state.balance.snapshot = {
      isAvailable: true,
      infos: [{ currency: 'CNY', total: 12.5, granted: 0, toppedUp: 12.5 }],
      fetchedAt: Date.now(),
      source: 'official-api',
      warnings: [],
    }
    state.balance.state = 'ok'
    state.balance.lastSuccessAt = Date.now()
  })

  const reopened = new StateStore({ dir, retentionDays: 30, maxCallRecords: 100 })
  await reopened.load()
  assert.equal(reopened.state.calls.length, 1)
  assert.equal(reopened.state.calls[0].inputTokens, 10)
  assert.equal(reopened.state.balance.snapshot.infos[0].total, 12.5)
  assert.equal(reopened.state.version, 1)
})

test('writes are atomic and leave no temporary file behind', async () => {
  const { dir, store } = await tempStore()
  await store.load()
  await store.update((state) => {
    state.calls.push(record(Date.now()))
  })
  const files = await readdir(dir)
  assert.deepEqual(files, ['state.json'])
  const body = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(body.calls.length, 1)
})

test('concurrent updates are serialized instead of losing records', async () => {
  const { store } = await tempStore()
  await store.load()
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.update((state) => {
        state.calls.push(record(Date.now() + index))
      }),
    ),
  )
  assert.equal(store.state.calls.length, 20)
})

test('retention drops records older than the window and caps the list', async () => {
  const { store } = await tempStore({ retentionDays: 1, maxCallRecords: 5 })
  await store.load()
  const now = Date.now()
  await store.update((state) => {
    state.calls.push(record(now - 3 * 24 * 3600_000), record(now - 2 * 24 * 3600_000))
    for (let index = 0; index < 8; index += 1) state.calls.push(record(now - index * 1_000))
    state.balanceHistory.push({ at: now - 5 * 24 * 3600_000, totals: { CNY: 1 }, isAvailable: true })
    state.balanceHistory.push({ at: now, totals: { CNY: 2 }, isAvailable: true })
  })
  assert.equal(store.state.calls.length, 5, 'old records dropped and the cap enforced')
  assert.equal(store.state.balanceHistory.length, 1)
})

test('a corrupt state file is quarantined and replaced', async () => {
  const { dir, store } = await tempStore()
  await store.load()
  await writeFile(path.join(dir, 'state.json'), '{ this is not json', 'utf8')
  const reopened = new StateStore({ dir, retentionDays: 30, maxCallRecords: 100 })
  const result = await reopened.load()
  assert.equal(result.loaded, true)
  assert.deepEqual(reopened.state.calls, [])
  const files = await readdir(dir)
  const quarantine = files.find((file) => file.startsWith('state.json.corrupt-'))
  assert.ok(quarantine, `expected a quarantined file, saw ${files.join(',')}`)
  assert.equal(await readFile(path.join(dir, quarantine), 'utf8'), '{ this is not json')
})

test('malformed persisted records are dropped, not trusted', async () => {
  const { dir, store } = await tempStore()
  await store.load()
  await writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({
      version: 1,
      createdAt: 1,
      balance: { state: 'ok', snapshot: { isAvailable: true, infos: [{ currency: 'CNY', total: 'NaN' }] } },
      calls: [
        { at: Date.now(), model: 'deepseek-flash', inputTokens: 10, status: 'ok' },
        { at: 'not-a-number', model: 'deepseek-flash' },
        { model: 'missing-time' },
        'nonsense',
      ],
      balanceHistory: [
        { at: Date.now() - 2_000, totals: { CNY: 'x' } },
        { at: Date.now() - 1_000, totals: { CNY: 3 } },
      ],
      alerts: [{ id: 'a', type: 'low_balance' }, {}],
      events: [{ at: 1, kind: 'x' }, 'bad'],
      overrides: { low_balance_threshold: 5, nonsense: 'text' },
    }),
    'utf8',
  )
  const reopened = new StateStore({ dir, retentionDays: 30, maxCallRecords: 100 })
  const result = await reopened.load()
  assert.equal(reopened.state.calls.length, 1)
  assert.equal(reopened.state.balanceHistory.length, 1)
  assert.equal(reopened.state.alerts.length, 1)
  assert.equal(reopened.state.events.length, 1)
  assert.deepEqual(reopened.state.overrides, { low_balance_threshold: 5 })
  assert.equal(reopened.state.balance.state, 'never', 'a snapshot without usable entries is not adopted')
  assert.ok(result.dropped.length > 0)
})

test('coerceState never trusts a mismatched version silently', () => {
  const { state, dropped } = coerceState(emptyState())
  assert.equal(state.version, 1)
  const mismatched = coerceState({ ...emptyState(), version: 99 })
  assert.equal(mismatched.state.version, 1)
  assert.ok(mismatched.dropped.some((entry) => entry.includes('version')))
})

test('clearHistory empties the record sets but keeps configuration overrides', async () => {
  const { store } = await tempStore()
  await store.load()
  await store.update((state) => {
    state.calls.push(record(Date.now()))
    state.alerts.push({
      id: 'low_balance:CNY',
      type: 'low_balance',
      severity: 'warning',
      state: 'active',
      firstAt: 1,
      lastAt: 1,
      count: 1,
      message: 'm',
      value: 1,
      threshold: 2,
      dataAt: 1,
      source: 'official-api',
    })
    state.overrides = { low_balance_threshold: 3 }
  })
  const removed = await store.clearHistory()
  assert.equal(removed.calls, 1)
  assert.equal(store.state.calls.length, 0)
  assert.equal(store.state.alerts.length, 0)
  assert.deepEqual(store.state.overrides, { low_balance_threshold: 3 })
})

test('defaultDataDir stays inside DSH_HOME when it is set', () => {
  assert.equal(defaultDataDir({ DSH_HOME: 'C:\\custom\\dsh' }), path.join('C:\\custom\\dsh', 'deepseek-usage-monitor'))
  assert.match(defaultDataDir({}), /\.dsh[\\/]deepseek-usage-monitor$/)
})

test('the state file is not created until the first write', async () => {
  const { dir, store } = await tempStore()
  await store.load()
  await assert.rejects(stat(path.join(dir, 'state.json')), /ENOENT/)
})
