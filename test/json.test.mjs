import test from 'node:test'
import assert from 'node:assert/strict'
import { toJsonValue } from '../lib/json.js'

test('undefined members are dropped and undefined array items become null', () => {
  const value = toJsonValue({ a: 1, b: undefined, c: [1, undefined, 'x'] })
  assert.deepEqual(value, { a: 1, c: [1, null, 'x'] })
})

test('non-finite numbers become null and non-data members are dropped', () => {
  const value = toJsonValue({ nan: Number.NaN, inf: Number.POSITIVE_INFINITY, fn: () => 1, big: 10n, sym: Symbol('x') })
  assert.deepEqual(value, { nan: null, inf: null, big: 10 })
})

test('dates become ISO strings and errors become plain objects', () => {
  const value = toJsonValue({ at: new Date('2026-10-27T00:00:00Z'), error: new Error('boom') })
  assert.equal(value.at, '2026-10-27T00:00:00.000Z')
  assert.deepEqual(value.error, { name: 'Error', message: 'boom' })
})

test('cycles are replaced instead of throwing', () => {
  const node = { name: 'root' }
  node.self = node
  const value = toJsonValue(node)
  assert.equal(value.name, 'root')
  assert.equal(value.self, '[circular]')
})

test('the result always survives a JSON round-trip unchanged', () => {
  const value = toJsonValue({
    a: undefined,
    nested: { b: undefined, c: Number.NaN, d: [undefined, { e: undefined, f: 2 }] },
    when: new Date('2026-01-01T00:00:00Z'),
  })
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})
