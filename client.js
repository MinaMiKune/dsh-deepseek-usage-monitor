window.__ModuleLoader__.load({
  id: '@local/dsh-deepseek-usage-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    // ------------------------------------------------------------------ i18n
    // Visible text lives here and is selected through the Client locale
    // service (falling back to the browser language). Alert text is composed
    // from the structured alert record so the Host never has to guess a locale.
    const DICT = {
      zh: {
        title: 'DeepSeek 用量监控',
        subtitle: '官方账户余额 + Harness 实际观测 Token 用量',
        refresh: '刷新',
        refreshing: '刷新中…',
        loading: '加载中…',
        retry: '重试',
        rangeLabel: '时间范围',
        ranges: { '1h': '1 小时', '24h': '24 小时', '7d': '7 天', '30d': '30 天', custom: '自定义' },
        start: '开始',
        end: '结束',
        balance: '账户余额',
        officialBalance: '官方接口',
        today: '今日（本地日）',
        tokens: 'Token 用量',
        calls: '调用次数',
        cost: '估算费用',
        accountSpend: '账户消费（余额差值）',
        estimated: '估算',
        official: '官方',
        observed: '本地观测',
        cached: '缓存值',
        live: '实时',
        unknown: '未知',
        stale: '数据可能已过期',
        granted: '赠送余额',
        toppedUp: '充值余额',
        total: '总余额',
        available: '可调用',
        unavailable: '不可调用',
        updatedAt: '数据更新时间',
        source: '数据来源',
        ageSeconds: '距今',
        seconds: '秒',
        balanceUnknown: '尚未成功获取官方余额',
        balanceUnconfigured: '未配置 API Key',
        balanceCached: '上次刷新失败，以下为缓存值，不是最新余额',
        input: '输入',
        output: '输出',
        cacheHit: '缓存命中',
        cacheRead: '缓存读取',
        cacheHitRatio: '缓存命中率',
        modelBreakdown: '按模型',
        model: '模型',
        provider: '提供方',
        trend: '趋势',
        noData: '该范围内没有本地记录',
        granularityHour: '按小时',
        granularityDay: '按天',
        timeZone: '时区',
        alerts: '告警',
        noAlerts: '当前没有活动告警',
        accountRoute: '已登录账户',
        apiKeyRoute: 'API Key',
        officialUsagePage: '官方用量页（控制台）',
        thresholds: '阈值',
        lowBalance: '低余额',
        dailyCost: '每日估算费用',
        dailyTokens: '每日 Token',
        requestFailures: '连续失败',
        staleData: '数据过期',
        cooldown: '冷却',
        sources: '数据来源与口径',
        sourceBalance: 'GET /user/balance（官方，账户级）',
        sourceUsage: 'DeepSeek 未公开用量统计 API；此为 Harness 观测值',
        sourceSpend: '由相邻官方余额快照差值推导，覆盖账户全部消费',
        sourceCost: '按价格表与观测 Token 估算，非实际扣费',
        disabled: '未启用',
        enabled: '已启用',
        scheduler: '调度',
        pollerBalance: '余额轮询',
        pollerUsage: '用量刷新',
        credentials: '凭据',
        configured: '已配置',
        notConfigured: '未配置',
        storage: '存储',
        records: '条记录',
        configIssues: '配置问题',
        disclaimer:
          '余额来自 DeepSeek 官方接口；Token 与费用仅覆盖本 Harness 进程观测到的调用，不等于账户全部用量。',
        alertText: {
          low_balance: '余额低于阈值',
          daily_cost: '今日估算费用超阈值',
          daily_token: '今日观测 Token 超阈值',
          request_failures: '余额刷新连续失败',
          stale_data: '余额数据长时间未更新',
        },
        value: '当前值',
        threshold: '阈值',
        dataTime: '数据时间',
        refreshFailed: '刷新失败',
        lastError: '最近错误',
        perModel: '模型明细',
        totalTokens: '合计 Token',
        snapshotFailed: '无法读取监控数据',
      },
      en: {
        title: 'DeepSeek Usage Monitor',
        subtitle: 'Official account balance plus Harness-observed token usage',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        loading: 'Loading…',
        retry: 'Retry',
        rangeLabel: 'Range',
        ranges: { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days', custom: 'Custom' },
        start: 'Start',
        end: 'End',
        balance: 'Account balance',
        officialBalance: 'Official API',
        today: 'Today (local day)',
        tokens: 'Tokens',
        calls: 'Calls',
        cost: 'Estimated cost',
        accountSpend: 'Account spend (balance delta)',
        estimated: 'estimate',
        official: 'official',
        observed: 'observed locally',
        cached: 'cached',
        live: 'live',
        unknown: 'unknown',
        stale: 'data may be stale',
        granted: 'Granted',
        toppedUp: 'Topped up',
        total: 'Total',
        available: 'Usable',
        unavailable: 'Not usable',
        updatedAt: 'Data timestamp',
        source: 'Source',
        ageSeconds: 'age',
        seconds: 's',
        balanceUnknown: 'No successful balance read yet',
        balanceUnconfigured: 'No API key configured',
        balanceCached: 'The last refresh failed; this is a cached value, not the current balance',
        input: 'Input',
        output: 'Output',
        cacheHit: 'Cache hit',
        cacheRead: 'Cache read',
        cacheHitRatio: 'Cache hit ratio',
        modelBreakdown: 'By model',
        model: 'Model',
        provider: 'Provider',
        trend: 'Trend',
        noData: 'No local records in this range',
        granularityHour: 'hourly',
        granularityDay: 'daily',
        timeZone: 'time zone',
        alerts: 'Alerts',
        noAlerts: 'No active alerts',
        accountRoute: 'Signed-in account',
        apiKeyRoute: 'API key',
        officialUsagePage: 'Official usage page (console)',
        thresholds: 'Thresholds',
        lowBalance: 'Low balance',
        dailyCost: 'Daily estimated cost',
        dailyTokens: 'Daily tokens',
        requestFailures: 'Failure streak',
        staleData: 'Stale data',
        cooldown: 'Cooldown',
        sources: 'Sources and definitions',
        sourceBalance: 'GET /user/balance (official, account-wide)',
        sourceUsage: 'DeepSeek publishes no usage API; these are Harness observations',
        sourceSpend: 'Inferred from consecutive official balance snapshots; account-wide',
        sourceCost: 'Price table × observed tokens; not a billed amount',
        disabled: 'disabled',
        enabled: 'enabled',
        scheduler: 'Scheduler',
        pollerBalance: 'Balance poll',
        pollerUsage: 'Usage refresh',
        credentials: 'Credential',
        configured: 'configured',
        notConfigured: 'not configured',
        storage: 'Storage',
        records: 'records',
        configIssues: 'Configuration issues',
        disclaimer:
          'Balance comes from the official DeepSeek API. Tokens and cost cover only calls observed by this Harness process and are not the account total.',
        alertText: {
          low_balance: 'Balance below threshold',
          daily_cost: 'Estimated daily cost above threshold',
          daily_token: 'Observed daily tokens above threshold',
          request_failures: 'Repeated balance refresh failures',
          stale_data: 'Balance data has not updated',
        },
        value: 'value',
        threshold: 'threshold',
        dataTime: 'data time',
        refreshFailed: 'Refresh failed',
        lastError: 'Last error',
        perModel: 'Per-model detail',
        totalTokens: 'Total tokens',
        snapshotFailed: 'Could not load monitor data',
      },
    }

    function detectLang(ctx) {
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale && typeof locale.getLocale === 'function') {
          const snapshot = locale.getLocale()
          const id = snapshot && (snapshot.locale || snapshot.id || snapshot.language)
          if (typeof id === 'string' && id !== '') return id.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
        }
      } catch (error) {
        /* fall through */
      }
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
          return navigator.language.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
        }
      } catch (error) {
        /* fall through */
      }
      return 'zh'
    }

    // --------------------------------------------------------------- helpers
    const numberFormat = new Intl.NumberFormat()
    const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

    function formatInt(value) {
      return typeof value === 'number' && Number.isFinite(value) ? numberFormat.format(Math.round(value)) : '—'
    }
    // Exact digits below ten thousand; compact notation above, where the long
    // form stops being readable. Large-number compaction is locale-aware.
    function formatCompact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (Math.abs(value) < 10_000) return numberFormat.format(Math.round(value))
      return compactFormat.format(value)
    }
    function formatAmount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value >= 100 ? value.toFixed(2) : value.toFixed(value >= 1 ? 2 : 4)
    }
    function formatTime(ms, lang) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      try {
        return new Date(ms).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
      } catch (error) {
        return new Date(ms).toISOString()
      }
    }
    function formatDuration(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—'
      if (seconds < 90) return Math.round(seconds) + 's'
      if (seconds < 5400) return Math.round(seconds / 60) + 'm'
      if (seconds < 172800) return (seconds / 3600).toFixed(1) + 'h'
      return (seconds / 86400).toFixed(1) + 'd'
    }

    async function fetchSnapshot(range, custom) {
      const params = new URLSearchParams({ range })
      if (range === 'custom' && custom && custom.start && custom.end) {
        params.set('start', custom.start)
        params.set('end', custom.end)
      }
      return requestJson('/api/deepseek-usage/snapshot?' + params.toString(), { method: 'GET' })
    }

    async function requestJson(url, init) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), 15000) : null
      try {
        const response = await fetch(url, {
          method: init.method,
          headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
          body: init.body,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        })
        const text = await response.text()
        let payload
        try {
          payload = text ? JSON.parse(text) : null
        } catch (error) {
          throw new Error('HTTP ' + response.status + ': response was not JSON')
        }
        if (!response.ok || !payload || payload.ok !== true) {
          const detail = payload && payload.error ? payload.error.message || payload.error.code : 'HTTP ' + response.status
          throw new Error(detail)
        }
        return payload
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    // ----------------------------------------------------------------- style
    const CSS = `
.dsum-root { display: flex; flex-direction: column; gap: 16px; box-sizing: border-box;
  height: 100%; overflow: auto; padding: 24px 28px 40px; background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.dsum-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dsum-title { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: 0.2px; }
.dsum-sub { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsum-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsum-tabs { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); }
.dsum-tab { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px;
  padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.dsum-tab[data-active="true"] { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,0.18); }
.dsum-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 7px; cursor: pointer; }
.dsum-btn:disabled { opacity: 0.55; cursor: default; }
.dsum-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsum-custom { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px;
  color: var(--dsw-alias-label-secondary); }
.dsum-custom input { font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsum-grid { display: grid; grid-template-columns: minmax(260px, 1.15fr) minmax(240px, 1fr); gap: 14px; }
@media (max-width: 720px) { .dsum-grid { grid-template-columns: 1fr; } }
.dsum-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1);
  padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dsum-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsum-card-title { font-size: 13px; font-weight: 600; }
.dsum-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsum-badge[data-kind="ok"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dsum-badge[data-kind="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dsum-badge[data-kind="error"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsum-balance { font-size: 26px; font-weight: 650; letter-spacing: 0.3px; font-variant-numeric: tabular-nums; }
.dsum-balance small { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary); margin-left: 6px; }
.dsum-rows { display: flex; flex-direction: column; gap: 4px; }
.dsum-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsum-row > span:first-child { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsum-row > span:last-child { font-variant-numeric: tabular-nums; }
.dsum-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.dsum-metric { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-2); }
.dsum-metric-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsum-metric-value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsum-section { display: flex; flex-direction: column; gap: 10px; }
.dsum-section-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.dsum-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsum-error { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 10px 12px;
  color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dsum-warn { border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: 10px; padding: 10px 12px;
  color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
.dsum-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dsum-table th, .dsum-table td { text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsum-table th { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.dsum-table th:first-child, .dsum-table td:first-child { text-align: left; }
.dsum-table td { font-variant-numeric: tabular-nums; }
.dsum-chart { display: flex; align-items: flex-end; gap: 2px; height: 64px; padding: 4px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsum-bar { flex: 1 1 auto; min-width: 1px; border-radius: 2px 2px 0 0; background: var(--dsw-alias-brand-primary); opacity: 0.85; }
.dsum-bar:hover { opacity: 1; }
.dsum-alert { border: 1px solid var(--dsw-alias-border-l1); border-left-width: 3px; border-radius: 8px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 2px; background: var(--dsw-alias-bg-layer-2); }
.dsum-alert[data-severity="critical"] { border-left-color: var(--dsw-alias-state-error-primary); }
.dsum-alert[data-severity="warning"] { border-left-color: var(--dsw-alias-state-warn-primary); }
.dsum-alert-title { font-size: 12px; font-weight: 600; }
.dsum-alert-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsum-footer { margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 11px; display: flex; flex-direction: column; gap: 4px; }
.dsum-footer code { font-size: 11px; }
.dsum-inline { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
`

    // -------------------------------------------------------------- components
    function Panel(props) {
      const ctx = props.ctx
      const [lang, setLang] = useState(() => detectLang(ctx))
      const t = DICT[lang] || DICT.zh
      const [range, setRange] = useState('24h')
      const [custom, setCustom] = useState(() => {
        const now = Date.now()
        return { start: toLocalInput(now - 24 * 3600 * 1000), end: toLocalInput(now) }
      })
      const [state, setState] = useState({ loading: true, refreshing: false, error: null, data: null })
      const [appliedCustom, setAppliedCustom] = useState(null)

      const load = useCallback(
        async (silent) => {
          if (!silent) setState((prev) => ({ ...prev, loading: prev.data === null, error: null }))
          try {
            const payload = await fetchSnapshot(range, appliedCustom)
            setState((prev) => ({ ...prev, loading: false, error: null, data: payload.snapshot }))
          } catch (error) {
            setState((prev) => ({ ...prev, loading: false, error: error instanceof Error ? error.message : String(error) }))
          }
        },
        [range, appliedCustom],
      )

      useEffect(() => {
        let alive = true
        setState((prev) => ({ ...prev, loading: true }))
        fetchSnapshot(range, appliedCustom)
          .then((payload) => {
            if (!alive) return
            setState((prev) => ({ ...prev, loading: false, error: null, data: payload.snapshot }))
          })
          .catch((error) => {
            if (!alive) return
            setState((prev) => ({ ...prev, loading: false, error: error instanceof Error ? error.message : String(error) }))
          })
        return () => {
          alive = false
        }
      }, [range, appliedCustom])

      useEffect(() => {
        const timer = setInterval(() => {
          load(true)
        }, 30000)
        return () => clearInterval(timer)
      }, [load])

      const refresh = useCallback(async () => {
        setState((prev) => ({ ...prev, refreshing: true, error: null }))
        try {
          await requestJson('/api/deepseek-usage/refresh', {
            method: 'POST',
            body: JSON.stringify({ scope: 'all' }),
          })
        } catch (error) {
          setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : String(error) }))
        }
        setState((prev) => ({ ...prev, refreshing: false }))
        await load(true)
      }, [load])

      const data = state.data
      return h(
        'div',
        { className: 'dsum-root' },
        h('style', { key: 'style' }, CSS),
        h(
          'div',
          { className: 'dsum-head', key: 'head' },
          h(
            'div',
            null,
            h('h1', { className: 'dsum-title' }, t.title),
            h('p', { className: 'dsum-sub' }, t.subtitle),
          ),
          h(
            'div',
            { className: 'dsum-actions' },
            h(
              'div',
              { className: 'dsum-tabs', role: 'tablist', 'aria-label': t.rangeLabel },
              ['1h', '24h', '7d', '30d', 'custom'].map((value) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    className: 'dsum-tab',
                    role: 'tab',
                    'aria-selected': range === value,
                    'data-active': String(range === value),
                    onClick: () => {
                      setRange(value)
                      if (value !== 'custom') setAppliedCustom(null)
                      else setAppliedCustom({ start: fromLocalInput(custom.start), end: fromLocalInput(custom.end) })
                    },
                  },
                  t.ranges[value],
                ),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsum-btn',
                onClick: refresh,
                disabled: state.refreshing,
              },
              state.refreshing ? t.refreshing : t.refresh,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsum-btn',
                title: lang === 'zh' ? 'Switch to English' : '切换到中文',
                onClick: () => setLang(lang === 'zh' ? 'en' : 'zh'),
              },
              lang === 'zh' ? 'EN' : '中文',
            ),
          ),
        ),
        range === 'custom'
          ? h(
              'div',
              { className: 'dsum-custom', key: 'custom' },
              h('label', null, t.start + ': '),
              h('input', {
                type: 'datetime-local',
                value: custom.start,
                onChange: (event) => setCustom({ ...custom, start: event.target.value }),
              }),
              h('label', null, t.end + ': '),
              h('input', {
                type: 'datetime-local',
                value: custom.end,
                onChange: (event) => setCustom({ ...custom, end: event.target.value }),
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsum-btn',
                  onClick: () => setAppliedCustom({ start: fromLocalInput(custom.start), end: fromLocalInput(custom.end) }),
                },
                t.refresh,
              ),
            )
          : null,
        state.error ? h('div', { className: 'dsum-error', key: 'error' }, t.snapshotFailed + ': ' + state.error) : null,
        state.loading && !data ? h('div', { className: 'dsum-muted' }, t.loading) : null,
        data ? h(BalanceCard, { key: 'balance', balance: data.balance, t, lang }) : null,
        data ? h(UsageCards, { key: 'usage', data, t, lang }) : null,
        data ? h(AlertSection, { key: 'alerts', alerts: data.alerts, t, lang }) : null,
        data ? h(SourcesFooter, { key: 'footer', data, t, lang }) : null,
      )
    }

    function BalanceCard({ balance, t, lang }) {
      const infos = Array.isArray(balance.infos) ? balance.infos : []
      const primary = infos[0]
      const badgeKind = balance.isLive ? 'ok' : balance.isCached ? 'warn' : 'error'
      const badgeText = balance.isLive ? t.live : balance.isCached ? t.cached : t.unknown
      const routeBadge =
        balance.source === 'official-account'
          ? t.accountRoute
          : balance.source === 'official-api'
            ? t.apiKeyRoute
            : t.officialBalance
      return h(
        'section',
        { className: 'dsum-card' },
        h(
          'div',
          { className: 'dsum-card-head' },
          h('span', { className: 'dsum-card-title' }, t.balance),
          h(
            'span',
            { className: 'dsum-inline' },
            h('span', { className: 'dsum-badge', 'data-kind': badgeKind }, badgeText),
            h('span', { className: 'dsum-badge' }, routeBadge),
          ),
        ),
        balance.isCached
          ? h('div', { className: 'dsum-warn' }, t.balanceCached)
          : null,
        balance.state === 'never'
          ? h('div', { className: 'dsum-muted' }, t.balanceUnknown)
          : null,
        balance.error && balance.error.code === 'NOT_CONFIGURED'
          ? h('div', { className: 'dsum-muted' }, t.balanceUnconfigured + ': ' + (balance.error.message || ''))
          : null,
        primary
          ? h(
              'div',
              { className: 'dsum-balance' },
              formatAmount(primary.total),
              h('small', null, primary.currency),
            )
          : null,
        infos.length > 0
          ? h(
              'div',
              { className: 'dsum-rows' },
              infos.map((info) =>
                h(
                  'div',
                  { className: 'dsum-row', key: info.currency },
                  h('span', null, info.currency + ' · ' + t.total),
                  h(
                    'span',
                    null,
                    formatAmount(info.total) +
                      '  (' +
                      t.granted +
                      ' ' +
                      (info.granted === null ? '—' : formatAmount(info.granted)) +
                      ' / ' +
                      t.toppedUp +
                      ' ' +
                      (info.toppedUp === null ? '—' : formatAmount(info.toppedUp)) +
                      ')',
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dsum-rows' },
          h(
            'div',
            { className: 'dsum-row' },
            h('span', null, t.available),
            h('span', null, balance.isAvailable === null ? '—' : balance.isAvailable ? t.available : t.unavailable),
          ),
          h(
            'div',
            { className: 'dsum-row' },
            h('span', null, t.updatedAt),
            h('span', null, formatTime(balance.fetchedAt, lang) + (balance.ageSeconds !== null ? '  (' + formatDuration(balance.ageSeconds) + ')' : '')),
          ),
          h(
            'div',
            { className: 'dsum-row' },
            h('span', null, t.pollerBalance),
            h(
              'span',
              null,
              balance.scheduler.enabled
                ? (balance.scheduler.paused ? 'paused' : 'on') + ' · ' + balance.scheduler.intervalSeconds + 's'
                : t.disabled,
            ),
          ),
          balance.error && balance.error.code !== 'NOT_CONFIGURED'
            ? h(
                'div',
                { className: 'dsum-row' },
                h('span', null, t.lastError),
                h('span', null, balance.error.code + (balance.error.status ? ' (HTTP ' + balance.error.status + ')' : '')),
              )
            : null,
        ),
        balance.warnings && balance.warnings.length > 0
          ? h('div', { className: 'dsum-muted' }, balance.warnings.join('; '))
          : null,
        balance.usageUrl
          ? h(
              'div',
              { className: 'dsum-muted' },
              h(
                'a',
                { href: balance.usageUrl, target: '_blank', rel: 'noreferrer noopener' },
                t.officialUsagePage,
              ),
            )
          : null,
      )
    }

    function UsageCards({ data, t, lang }) {
      const usage = data.usage
      const today = data.today
      const totals = usage.totals
      const buckets = Array.isArray(usage.buckets) ? usage.buckets : []
      const maxTokens = buckets.reduce((max, bucket) => Math.max(max, bucket.totalTokens || 0), 0)
      return h(
        'div',
        { className: 'dsum-section' },
        h(
          'div',
          { className: 'dsum-grid' },
          h(
            'section',
            { className: 'dsum-card' },
            h(
              'div',
              { className: 'dsum-card-head' },
              h('span', { className: 'dsum-card-title' }, t.today),
              h('span', { className: 'dsum-badge' }, t.observed),
            ),
            h(
              'div',
              { className: 'dsum-metrics' },
              metric(t.tokens, formatCompact(today.totalTokens), t),
              metric(t.calls, formatInt(today.calls), t),
              metric(t.estimated + ' USD', formatAmount(today.estimatedUsd), t),
            ),
            h(
              'div',
              { className: 'dsum-muted' },
              t.timeZone + ': ' + usage.timeZone + ' · ' + (usage.granularity === 'hour' ? t.granularityHour : t.granularityDay),
            ),
          ),
          h(
            'section',
            { className: 'dsum-card' },
            h(
              'div',
              { className: 'dsum-card-head' },
              h('span', { className: 'dsum-card-title' }, t.balance === '' ? '' : t.accountSpend),
              h('span', { className: 'dsum-badge' }, t.official),
            ),
            h(
              'div',
              { className: 'dsum-balance' },
              formatAmount(usage.accountSpend.spent),
              h('small', null, usage.accountSpend.currency),
            ),
            h(
              'div',
              { className: 'dsum-rows' },
              h(
                'div',
                { className: 'dsum-row' },
                h('span', null, t.granted + ' / +'),
                h('span', null, formatAmount(usage.accountSpend.added) + ' ' + usage.accountSpend.currency),
              ),
              h(
                'div',
                { className: 'dsum-row' },
                h('span', null, 'snapshots'),
                h('span', null, formatInt(usage.accountSpend.snapshots)),
              ),
            ),
            h('div', { className: 'dsum-muted' }, t.sourceSpend),
          ),
        ),
        h(
          'section',
          { className: 'dsum-card' },
          h(
            'div',
            { className: 'dsum-card-head' },
            h('span', { className: 'dsum-card-title' }, t.tokens + ' · ' + t.ranges[usage.range]),
            h('span', { className: 'dsum-badge' }, t.observed),
          ),
          h(
            'div',
            { className: 'dsum-metrics' },
            metric(t.totalTokens, formatCompact(totals.totalTokens), t),
            metric(t.calls, formatInt(totals.calls), t),
            metric(t.input, formatCompact(totals.inputTokens), t),
            metric(t.output, formatCompact(totals.outputTokens), t),
            metric(t.cacheRead, formatCompact(totals.cacheReadTokens), t),
            metric(t.cacheHitRatio, (totals.cacheHitRatio * 100).toFixed(1) + '%', t),
          ),
          buckets.length > 0
            ? h(
                'div',
                { className: 'dsum-chart', title: t.trend },
                buckets.map((bucket) =>
                  h('div', {
                    key: bucket.key,
                    className: 'dsum-bar',
                    style: {
                      height: maxTokens > 0 ? Math.max(2, Math.round(((bucket.totalTokens || 0) / maxTokens) * 60)) + 'px' : '2px',
                    },
                    title: bucket.key + ' · ' + formatInt(bucket.totalTokens) + ' tokens · ' + formatInt(bucket.calls) + ' calls',
                  }),
                ),
              )
            : h('div', { className: 'dsum-muted' }, t.noData),
          h(
            'div',
            { className: 'dsum-muted' },
            t.estimated +
              ' USD ' +
              formatAmount(usage.cost.usd) +
              ' · ' +
              (usage.cost.unpricedCalls > 0 ? usage.cost.unpricedCalls + ' unpriced' : 'all priced') +
              ' · ' +
              usage.timeZone +
              ' · ' +
              (usage.granularity === 'hour' ? t.granularityHour : t.granularityDay),
          ),
        ),
        usage.byModel.length > 0
          ? h(
              'section',
              { className: 'dsum-card' },
              h('div', { className: 'dsum-card-head' }, h('span', { className: 'dsum-card-title' }, t.perModel)),
              h(
                'table',
                { className: 'dsum-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, t.model),
                    h('th', null, t.calls),
                    h('th', null, t.input),
                    h('th', null, t.output),
                    h('th', null, t.cacheRead),
                    h('th', null, t.totalTokens),
                    h('th', null, t.estimated + ' USD'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  usage.byModel.map((row) =>
                    h(
                      'tr',
                      { key: row.provider + '/' + row.model },
                      h('td', null, row.model + (row.provider ? '  ·  ' + row.provider : '')),
                      h('td', null, formatInt(row.calls)),
                      h('td', null, formatCompact(row.inputTokens)),
                      h('td', null, formatCompact(row.outputTokens)),
                      h('td', null, formatCompact(row.cacheReadTokens)),
                      h('td', null, formatCompact(row.totalTokens)),
                      h('td', null, row.priced ? formatAmount(row.estimatedUsd) : '—'),
                    ),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    function metric(label, value, t) {
      return h(
        'div',
        { className: 'dsum-metric' },
        h('div', { className: 'dsum-metric-label' }, label),
        h('div', { className: 'dsum-metric-value' }, value),
      )
    }

    function AlertSection({ alerts, t, lang }) {
      const active = alerts.active || []
      const thresholds = alerts.thresholds || {}
      return h(
        'section',
        { className: 'dsum-card' },
        h(
          'div',
          { className: 'dsum-card-head' },
          h('span', { className: 'dsum-card-title' }, t.alerts),
          h('span', { className: 'dsum-badge' }, active.length + ' active'),
        ),
        active.length === 0
          ? h('div', { className: 'dsum-muted' }, t.noAlerts)
          : h(
              'div',
              { className: 'dsum-section' },
              active.map((alert) =>
                h(
                  'div',
                  { key: alert.id, className: 'dsum-alert', 'data-severity': alert.severity },
                  h('div', { className: 'dsum-alert-title' }, (t.alertText && t.alertText[alert.type]) || alert.type),
                  h(
                    'div',
                    { className: 'dsum-alert-meta' },
                    t.value + ': ' + formatAmount(alert.value) + ' · ' + t.threshold + ': ' +
                      formatAmount(alert.threshold) + ' · ' + t.dataTime + ': ' + formatTime(alert.dataAt, lang) +
                      ' · ×' + alert.count,
                  ),
                  h('div', { className: 'dsum-muted' }, alert.message),
                ),
              ),
            ),
        h(
          'div',
          { className: 'dsum-rows' },
          thresholdRow(t.lowBalance, thresholds.lowBalance, (value) => formatAmount(value.threshold) + ' ' + value.currency, t),
          thresholdRow(t.dailyCost, thresholds.dailyCostUsd, (value) => formatAmount(value.threshold) + ' USD', t),
          thresholdRow(t.dailyTokens, thresholds.dailyTokens, (value) => formatInt(value.threshold), t),
          thresholdRow(t.requestFailures, thresholds.requestFailures, (value) => String(value.threshold), t),
          h(
            'div',
            { className: 'dsum-row' },
            h('span', null, t.staleData),
            h(
              'span',
              null,
              (thresholds.staleEnabled ? t.enabled : t.disabled) + ' · ' + formatDuration(thresholds.staleAfterSeconds) +
                ' · ' + t.cooldown + ' ' + formatDuration(thresholds.cooldownSeconds),
            ),
          ),
        ),
      )
    }

    function thresholdRow(label, value, formatter, t) {
      if (!value) return null
      return h(
        'div',
        { className: 'dsum-row' },
        h('span', null, label),
        h('span', null, (value.enabled ? t.enabled : t.disabled) + ' · ' + (value.threshold > 0 ? formatter(value) : '—')),
      )
    }

    function SourcesFooter({ data, t, lang }) {
      const status = data.status
      const sources = data.sources
      const issues = data.configIssues || []
      return h(
        'footer',
        { className: 'dsum-footer' },
        h('div', null, t.disclaimer),
        h('div', null, '• ' + t.sourceBalance + ' — ' + sources.balance.docs),
        h('div', null, '• ' + t.sourceUsage),
        h('div', null, '• ' + t.sourceSpend),
        h('div', null, '• ' + t.sourceCost + ' — ' + sources.costEstimate.source),
        h(
          'div',
          null,
          '• ' + t.scheduler + ': ' + t.pollerBalance + ' ' + status.schedulers.balance.intervalSeconds + 's · ' +
            t.pollerUsage + ' ' + status.schedulers.usage.intervalSeconds + 's · ' + t.timeZone + ' ' + status.timeZone,
        ),
        h(
          'div',
          null,
          '• ' + t.credentials + ': ' + (status.credentials.configured ? t.configured + ' (' + status.credentials.source + ')' : t.notConfigured) +
            ' · ' + t.storage + ': ' + status.storage.callRecords + ' ' + t.records,
        ),
        issues.length > 0
          ? h(
              'div',
              { className: 'dsum-warn' },
              t.configIssues + ': ' + issues.map((issue) => issue.field + ' (' + issue.used + ')').join('; '),
            )
          : null,
      )
    }

    function toLocalInput(ms) {
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return (
        date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
      )
    }

    function fromLocalInput(value) {
      if (typeof value !== 'string' || value === '') return null
      const parsed = new Date(value)
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
    }

    // ---------------------------------------------------------------- plugin
    /** Sidebar rail icon: a gauge needle over a balance line. */
    function DeepSeekUsageIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      const active = Boolean(props && props.active)
      const stroke = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M2.5 12.5a5.5 5.5 0 0 1 11 0', stroke, strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M8 12.5 10.8 8', stroke, strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 12.5, r: 1.2, fill: stroke }),
        h('path', { d: 'M2.5 14.5h11', stroke, strokeWidth: 1.1, strokeLinecap: 'round', opacity: 0.5 }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The sidebar cell addresses the same id the main panel registers under,
        // so the icon alone switches the central column to this panel.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'deepseek-usage',
              order: 20,
              label: () => (detectLang(ctx) === 'zh' ? 'DeepSeek 用量' : 'DeepSeek usage'),
            },
            DeepSeekUsageIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'deepseek-usage',
            },
            function DeepSeekUsagePanel() {
              return h(Panel, { ctx })
            },
          ),
        )
      },
    }
  },
})
