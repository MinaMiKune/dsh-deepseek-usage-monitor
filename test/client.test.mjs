import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

const TEST_TMP = path.join(import.meta.dirname, '.tmp')

/** The bundle registers itself once per process; capture it on the first import. */
let bundlePromise = null

function loadBundleOnce() {
  if (bundlePromise) return bundlePromise
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(config) {
        captured = config
      },
    },
  }
  bundlePromise = import('../client.js').then(() => {
    if (!captured) throw new Error('client bundle did not register with the module loader')
    return captured
  })
  return bundlePromise
}

/**
 * Load the browser bundle with a captured module-loader call, then build the
 * plugin through a tiny React stand-in. The stand-in cannot reproduce React's
 * scheduling, but calling the components directly still executes every render
 * branch and catches crashes, undefined reads, and bad element shapes.
 */
async function loadClientBundle() {
  const captured = await loadBundleOnce()
  assert.equal(captured.id, '@local/dsh-deepseek-usage-monitor')

  let hookIndex = 0
  const overrides = new Map()
  const React = {
    createElement(tag, props, ...children) {
      return { tag, props: props ?? {}, children }
    },
    useState(initial) {
      const index = hookIndex
      hookIndex += 1
      if (overrides.has(index)) return [overrides.get(index), () => undefined]
      return [typeof initial === 'function' ? initial() : initial, () => undefined]
    },
    useEffect() {
      hookIndex += 1
    },
    useCallback(callback) {
      hookIndex += 1
      return callback
    },
    useMemo(factory) {
      hookIndex += 1
      return factory()
    },
    Fragment: 'fragment',
  }

  const plugin = captured.factory((request) => {
    assert.equal(request, 'react')
    return React
  })

  /**
   * Render an element tree by calling function components with the hook
   * counters reset, mirroring a first React render.
   * @param {any} node
   * @returns {any}
   */
  function render(node) {
    if (Array.isArray(node)) return node.map(render).join('')
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!node || typeof node !== 'object') return ''
    if (typeof node.tag === 'function') {
      hookIndex = 0
      return render(node.tag({ ...node.props, children: node.children }))
    }
    return render(node.children)
  }

  return { plugin, render, overrides, setOverride(index, value) { overrides.set(index, value) } }
}

test.after(async () => {
  await rm(TEST_TMP, { recursive: true, force: true })
})

test('the client bundle registers a sidebar entry and a matching main panel', async () => {
  const { plugin } = await loadClientBundle()
  assert.deepEqual(plugin.inject, ['slots'])

  const registrations = []
  const injectedKeys = []
  const ctx = {
    // Pin the language: the plugin falls back to the ambient `navigator.language`
    // when the locale service is absent, which would make this assertion depend
    // on the machine running the test.
    get: (name) => (name === 'locale' ? { getLocale: () => ({ locale: 'zh-CN' }) } : undefined),
    slots: {
      inject(key, callback) {
        injectedKeys.push(key)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  }
  plugin.apply(ctx)

  assert.deepEqual(injectedKeys.sort(), ['main', 'sidebar.panellist'])
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  const main = registrations.find((entry) => entry.options.name === 'main')
  assert.ok(sidebar, 'a sidebar entry must be registered')
  assert.ok(main, 'a main panel must be registered')
  assert.equal(sidebar.options.id, 'deepseek-usage')
  assert.equal(main.options.key, 'deepseek-usage', 'the panel key must match the sidebar entry id')
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(sidebar.options.label(), 'DeepSeek 用量')

  // The icon renders an SVG that inherits the theme accent when selected.
  const icon = sidebar.component({ size: 18, active: true })
  assert.equal(icon.tag, 'svg')
  assert.equal(icon.props.width, 18)
  assert.equal(icon.children.length, 4)
  assert.ok(JSON.stringify(icon).includes('--dsw-alias-brand-primary'))
  const inactive = sidebar.component({ size: 16, active: false })
  assert.ok(JSON.stringify(inactive).includes('currentColor'))
})

test('the panel renders its loading shell and then a full snapshot without crashing', async () => {
  const { setup } = await import('../index.js')
  const { createFakeCtx, createServiceRecorder } = await import('./fake-ctx.mjs')
  const { plugin, render, setOverride } = await loadClientBundle()

  // Produce a real Host snapshot through the Host half, so the client is
  // exercised against the actual payload contract rather than a hand-written stub.
  await mkdir(TEST_TMP, { recursive: true })
  const dir = await mkdtemp(path.join(TEST_TMP, 'client-'))
  const recorder = createServiceRecorder()
  const ctx = createFakeCtx({ services: { tools: recorder.toolsService, connection: recorder.connectionService } })
  const runtime = setup({
    ctx,
    rawConfig: { auto_start: false, low_balance_threshold: 10 },
    dir,
    env: { DEEPSEEK_API_KEY: 'sk-test-key-not-a-real-secret' },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '42.00', granted_balance: '2.00', topped_up_balance: '40.00' }],
        }),
        { status: 200 },
      ),
    loggerSink: { log() {}, warn() {}, error() {} },
  })
  await runtime.ready
  await runtime.monitor.refreshBalance({ reason: 'test' })
  await runtime.monitor.recordCall({
    at: Date.now(),
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    inputTokens: 1_200,
    outputTokens: 300,
    cacheReadTokens: 800,
    status: 'ok',
    durationMs: 900,
  })
  const snapshot = await runtime.monitor.getSnapshot({ range: '24h' })

  const registrations = []
  const clientCtx = {
    get(name) {
      if (name === 'locale') return { getLocale: () => ({ locale: 'zh' }) }
      return undefined
    },
    slots: {
      inject(key, callback) {
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  }
  plugin.apply(clientCtx)
  const panel = registrations.find((entry) => entry.options.name === 'main').component

  // First render: no data yet (loading shell).
  const loadingTree = render(panel({}))
  assert.ok(loadingTree.includes('DeepSeek 用量监控'))
  assert.ok(loadingTree.includes('加载中'))

  // Second render: inject the real snapshot into the state hook.
  setOverride(3, { loading: false, refreshing: false, error: null, data: snapshot })
  const tree = render(panel({}))
  assert.ok(tree.includes('DeepSeek 用量监控'))
  assert.ok(tree.includes('42.00'), 'the balance amount is rendered')
  assert.ok(tree.includes('CNY'))
  assert.ok(tree.includes('deepseek-flash'), 'the per-model row is rendered')
  assert.ok(tree.includes('1,200'), 'observed input tokens are rendered')
  assert.ok(tree.includes('2,300'), 'the total token figure is rendered')
  assert.ok(tree.includes('余额差值') || tree.includes('账户消费'), 'the derived spend card is labelled')
  assert.ok(tree.includes('官方'), 'official data is labelled as such')
  assert.ok(tree.includes('估算'), 'estimated data is labelled as such')
  assert.ok(tree.toLowerCase().includes('user/balance'), 'the official endpoint is cited')

  await runtime.dispose()
  await ctx.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('the panel localizes to English when the locale service reports en', async () => {
  const { plugin, render } = await loadClientBundle()
  const registrations = []
  const clientCtx = {
    get: (name) => (name === 'locale' ? { getLocale: () => ({ locale: 'en-US' }) } : undefined),
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  }
  plugin.apply(clientCtx)
  const tree = render(registrations.find((entry) => entry.options.name === 'main').component({}))
  assert.ok(tree.includes('DeepSeek Usage Monitor'))
  assert.ok(tree.includes('Loading'))
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(sidebar.options.label(), 'DeepSeek usage')
})
