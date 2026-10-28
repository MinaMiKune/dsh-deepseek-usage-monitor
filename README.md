# DeepSeek Usage Monitor · DSH 插件

在 DeepSeek Harness（DSH）Web 界面左侧栏提供一个入口，展示 **DeepSeek 官方账户余额** 与 **Harness 实际观测到的 Token 用量**，并提供 Agent 工具、阈值告警、本地持久化与数据来源标注。

插件包名：`@local/dsh-deepseek-usage-monitor`
形态：一个 DSH bundle（Host 半 + 浏览器半 + 左栏槽位注册 + Agent 工具 + 已鉴权的 `/api` 路由）。

**仓库**：<https://github.com/MinaMiKune/dsh-deepseek-usage-monitor>（私有）
**打包下载**：[v1.0.0 Release](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/releases/tag/v1.0.0) 中的 `dsh-deepseek-usage-monitor-v1.0.0.zip`

从仓库获取：

```bash
git clone https://github.com/MinaMiKune/dsh-deepseek-usage-monitor.git
```

---

## 1. 环境要求

| 项 | 要求 |
|---|---|
| DSH | 0.2.x（已在 `0.2.1-rc.3` 上安装、加载并实测） |
| 运行时 | Node.js ≥ 20（实测 v24.20.0）；插件为纯 ESM，无第三方依赖、无构建步骤 |
| 测试 | 默认隔离模式 Node ≥ 20；`npm run test:sandbox` 需要 Node ≥ 22（`--test-isolation`） |
| 操作系统 | 任意 DSH 支持的平台（实测 Windows；路径逻辑使用 Node `path`） |
| 可选 | 一个 DeepSeek **API Key**（`sk-…`），仅在使用 `/user/balance` 端点时需要 |
| 可选 | 已登录的 DeepSeek 账户（DSH 设置 → 账户），用于账户钱包余额 |

插件**不需要** `pnpm install` 额外依赖，也不依赖 `@deepseek-ai/*` 运行时包：安装后由 DSH 的 Client Modules 直接加载。

## 2. 安装

在 DSH 中通过 Plugin Manager 安装本地目录包：

```text
plugin_manager install_bundle  target = D:\...\deepseek-usage-monitor
```

或使用 DSH CLI/桌面端“添加插件 → 本地目录”指向本目录。安装会：

1. 在 profile（如 `~/.dsh/profiles/desktop`）中登记依赖并链接本目录；
2. 读取 `cordis.patch.yml`，插入 Loader 条目 `deepseek-usage-monitor`；
3. Host 半激活：注册工具、注册 `/api` 路由、挂上 `llm/stream` 观测、启动两个轮询器；
4. 浏览器半激活：在 `sidebar.panellist` 注册入口图标，在 `main` 注册同名面板。

安装完成后**刷新页面**，左侧栏出现仪表盘图标。修改源码后需要重新加载该插件（`plugin_manager set_plugin enabled=false` 再 `enabled=true`），HMR 不会自动替换 Host 半的模块。

### 启用 / 停用 / 卸载

| 操作 | 方式 |
|---|---|
| 停用（保留配置与数据） | `plugin_manager set_plugin  target=include:deepseek-usage-monitor  enabled=false` |
| 启用 | 同上，`enabled=true` |
| 卸载 | `plugin_manager remove_bundle  target=@local/dsh-deepseek-usage-monitor` |
| 清理数据 | 删除 `DEEPSEEK_HOME/deepseek-usage-monitor/`（默认 `~/.dsh/deepseek-usage-monitor/`） |

停用/卸载时，插件通过 Cordis effect 依次：中止进行中的余额请求 → 清除两个定时器 → 落盘未写入的观测记录 → 释放工具与路由注册。

## 3. 配置

配置写在 profile 的 `cordis.patch.yml`（用户层，覆盖 bundle 默认值），按 id 覆盖：

```yaml
- id: deepseek-usage-monitor
  name: '@local/dsh-deepseek-usage-monitor'
  config:
    api_key_env: DEEPSEEK_API_KEY   # 凭据引用（推荐）
    balance_source: auto            # auto | api-key | account
    balance_poll_interval: 300      # 秒，30–86400
    usage_poll_interval: 120        # 秒，30–86400（无网络请求）
    request_timeout: 15000          # 毫秒，1000–120000
    max_retries: 2                  # 0–5
    retry_backoff: 1000             # 毫秒，指数退避基数，100–30000
    low_balance_threshold: 10       # 0 表示关闭
    low_balance_currency: CNY
    daily_cost_threshold: 0         # USD，0 表示关闭
    daily_token_threshold: 0        # 0 表示关闭
    alert_cooldown: 3600            # 秒，0–86400
    failure_streak_threshold: 3     # 1–20
    stale_after: 0                  # 秒；0 = 自动（2.5× 余额间隔，最小 600）
    history_retention_days: 30      # 1–365
    timezone: Asia/Shanghai         # 空 = 主机时区
    debug: false
    auto_start: true
    data_dir: ''                    # 空 = $DSH_HOME/deepseek-usage-monitor
    max_call_records: 20000         # 100–200000
    tracked_providers: []           # 空 = 记录所有 provider 路由
    alerts:
      low_balance: true
      daily_cost: true
      daily_token: true
      request_failures: true
      stale_data: true
    price_table: null               # null = 内置官方价格表
```

**单位是字段契约的一部分**：`*_poll_interval`、`alert_cooldown`、`stale_after` 是**秒**，`request_timeout`、`retry_backoff` 是**毫秒**。

### 校验行为

- 启动时逐字段做类型与取值范围校验；非法值**回退到默认值**并记入 `configIssues`（面板底部与 `deepseek_usage` 的 `status` 都会显示），不会被静默截断或忽略。
- 本插件**不导出 Cordis `Config` schema**：profile 安装的插件无法解析 `@deepseek-ai/schemastery`（profile 只包含已安装 bundle），导出 schema 会导致激活失败。因此 Plugins 页面不提供表单式配置，配置通过 `cordis.patch.yml` 完成，校验在上述启动流程中执行。
- 运行期可用 Agent 工具临时覆盖阈值：`deepseek_usage { "action": "set_thresholds", "thresholds": { "low_balance_threshold": 20 } }`（写入状态文件，重启后仍生效；`reset_thresholds` 清除）。

### API Key 配置（三选一，优先级从上到下）

1. **凭据服务**（推荐）：把值存入 DSH credentials，引用名默认 `DEEPSEEK_API_KEY`。插件通过 `ctx.credentials.resolve(ref)` 每次操作前重新解析，因此轮换密钥无需重启。
2. **环境变量**：`DEEPSEEK_API_KEY`（或自定义 `api_key_env`）。
3. **插件配置 `api_key`**：仅用于受控环境，**不推荐**；该值不会被写入状态文件、日志或工具输出。

`balance_source` 决定余额来源：

| 取值 | 行为 |
|---|---|
| `auto`（默认） | 能解析到 API Key → 用 `GET /user/balance`；否则若组合中存在 `ctx.deepseekAccount` → 用已登录账户钱包；都没有 → 明确报 `NOT_CONFIGURED` |
| `api-key` | 只走 API Key 端点 |
| `account` | 只走已登录账户钱包（无该服务时报 `ACCOUNT_UNAVAILABLE`） |

## 4. 启动与使用

安装即自动启动（`auto_start: true`）：余额按 `balance_poll_interval` 轮询，用量按 `usage_poll_interval` 在本地重算（**不发网络请求**）。

### 左栏面板

点击左侧栏仪表盘图标 → 中央面板切换到「DeepSeek 用量监控」：

- **账户余额**：主币种总额、赠送/充值拆分、是否可调用、更新时间与年龄、当前数据是 `实时` / `缓存值` / `未知`、当前走的是 `API Key` 还是 `已登录账户` 路由；有控制台用量链接时会给出。
- **今日**：本地时区当天的调用数、Token、估算费用。
- **账户消费（余额差值）**：由相邻两次官方余额快照的差值推导，覆盖账户全部消费。
- **Token 用量**：时间范围切换（1 小时 / 24 小时 / 7 天 / 30 天 / 自定义）、总量与输入/输出/缓存读取、缓存命中率、桶状趋势图、按模型明细。
- **告警**：活动告警（含数值、阈值、数据时间、次数）与当前阈值一览。
- **数据来源与口径**：底部固定说明每条数据的来源。

面板每 30 秒拉取一次快照；「刷新」按钮触发一次即时余额刷新。界面跟随 DSH 主题 token（`--dsw-alias-*`），中英双语（按 Client locale 服务与浏览器语言自动选择，可手动切换）。

### Agent 工具 `deepseek_usage`

| action | 说明 |
|---|---|
| `status` | 调度器、凭据、采集范围、存储、告警与配置问题 |
| `balance` | 官方余额 + 新鲜度分类（实时 / 缓存 / 未知） |
| `usage` | 指定 `range`（`1h`/`24h`/`7d`/`30d`/`custom` + `start`/`end`）的聚合 |
| `refresh` | `scope`: `balance` / `usage` / `all` |
| `alerts` | 活动/已恢复告警、阈值、最近通知 |
| `set_thresholds` | 持久化运行期阈值覆盖 |
| `reset_thresholds` | 清除覆盖 |
| `clear_history` | 删除本地记录（必须 `confirm: true`） |

工具返回值始终是 lossless JSON（`undefined` 字段在边界被剔除），并同时给出一行人类摘要与结构化 JSON。

### 面板使用的 Host 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/deepseek-usage/snapshot?range=24h[&start&end]` | 面板快照 |
| POST | `/api/deepseek-usage/refresh` | body `{ "scope": "all" }` |

两条路由注册在 **DSH 已鉴权的 `/api` 通道**上（`ctx.connection.fetch.register`），因此沿用浏览器 Cookie 鉴权与 Host/Origin 校验；未认证请求在到达插件代码前就被拒绝。响应 `cache-control: no-store`，且不含任何密钥。

## 5. 指标口径与数据来源

### 5.1 余额（官方，账户级）

| 项 | 内容 |
|---|---|
| 来源 A | `GET {api_base_url}/user/balance`，官方文档 <https://api-docs.deepseek.com/api/get-user-balance> |
| 返回 | `is_available`、`balance_infos[]`：`currency`(CNY/USD)、`total_balance`、`granted_balance`、`topped_up_balance`（金额为字符串） |
| 来源 B | `ctx.deepseekAccount.getBalance()`：DSH 已登录账户的 Platform 钱包（`value` = 充值钱包，`bonusWallets` = 赠送钱包），需已登录 |
| 口径 | 账户**总可用余额**；不是累计消费、充值额、预算或本地估算 |
| 延迟 | 取决于 DeepSeek 平台；插件按配置间隔轮询，并始终展示数据获取时间与年龄 |
| 限制 | 来源 B 不提供 `is_available`，因此该字段显示为“—”（未知），不会伪造 `true` |

**新鲜度三态**（面板与工具都显式区分）：

| 状态 | 判定 | 展示 |
|---|---|---|
| 实时 | 最近一次刷新成功 | `实时` + 时间戳 + 年龄 |
| 缓存值 | 有历史快照但最近刷新失败 | `缓存值` + 明确警告“不是最新余额” |
| 未知 | 从未成功获取 | `未知` + 错误码 |

### 5.2 Token 用量（本地观测，Harness 作用域）

| 项 | 内容 |
|---|---|
| 来源 | `llm/stream` waterfall 中的 `usage` chunk（**供应商返回的真实 Token 统计**） |
| 覆盖 | 仅插件启用期间、经本 Harness 进程 `ctx.llm.stream()` 发出的调用 |
| 字段 | `inputTokens`（未命中缓存的输入）、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens` |
| 口径 | 上述缓存字段与 `inputTokens` **互不重叠**；计费输入 = input + cacheRead + cacheWrite；`reasoningTokens` 已包含在输出中，不重复相加 |
| 粒度 | ≤48 小时按小时桶，>48 小时按天桶；均以配置时区为准 |
| 延迟 | 近实时（每次调用结束即记录，2 秒防抖落盘） |
| 限制 | **不是账户全量用量**：其他工具、其他机器、插件启用前的调用都不在其中 |

### 5.3 费用

| 指标 | 来源 | 标注 |
|---|---|---|
| 账户消费 | 相邻两次官方余额快照的**差值**（下降=消费，上升=充值/赠送） | `source: derived-from-official-balance`，账户级、无法按模型拆分、窗口内首个快照之前的消费不可见 |
| 估算费用 | 内置/自定义价格表 × 本地观测 Token | `estimated: true`，**不是实际扣费金额** |

内置价格表（USD / 1M tokens，取自官方价格页，2026-10-27 抓取）：

| 模型 | 缓存命中（峰/谷） | 缓存未命中（峰/谷） | 输出（峰/谷） |
|---|---|---|---|
| `deepseek-flash` | 0.006 / 0.003 | 0.30 / 0.15 | 1.20 / 0.60 |
| `deepseek-v4-pro` | 0.044 / 0.022 | 1.32 / 0.66 | 3.96 / 1.98 |

- 峰时：UTC 周一至周五 01:00–04:00 与 06:00–10:00；其余为谷时（价格为峰时一半）。
- **中国法定节假日未排除**（无可用节假日日历），因此节假日的工作日峰时会按峰价估算，属**高估**。
- 旧模型别名（`deepseek-chat`、`deepseek-reasoner`、`deepseek-v4-flash` 等）按 Flash 价格；未知模型标记为 `unpriced` 而不是猜价。
- 价格会变；用 `price_table` 覆盖，结构为 `{ "<model>": { peak: {cache_hit,cache_miss,output}, off_peak: {...} } }`。

### 5.4 调用次数与失败

来自本地观测记录：`status: ok|error`、`failureCode`（如 `RATE_LIMIT`、`ABORTED`）、`durationMs`（流开始到结束）。用户取消的流记为 `error/ABORTED`，不会被算作成功。

## 6. 告警

| 类型 | 触发条件 | 数据来源 |
|---|---|---|
| `low_balance` | 指定币种总余额 < `low_balance_threshold`（0 关闭） | 官方余额（仅**成功**响应） |
| `daily_cost` | 当天估算费用 > `daily_cost_threshold` USD | 本地估算 |
| `daily_token` | 当天观测 Token > `daily_token_threshold` | 本地观测 |
| `request_failures` | 连续失败 ≥ `failure_streak_threshold` | 调度器 |
| `stale_data` | 距上次成功超过 `stale_after` | 调度器 |

规则：

- **低余额告警只由成功的官方响应触发**：网络错误、超时、5xx 只会产生 `request_failures`/`stale_data`，绝不会变成“余额不足”。
- 持续满足条件时告警**原地更新**，通知按 `alert_cooldown` 去重；条件消失置为 `resolved`；再次触发时计数重置。
- 告警记录持久化在状态文件中，重启不丢失，冷却位置也不丢。
- 告警内容包含原因、数值、阈值、数据时间与来源路由。
- 通知通道：统一通过 `monitor.subscribe()` 发布 → Host 日志（`[deepseek-usage] ALERT …`）+ 面板告警区 + `alerts` 工具结果。当前 DSH 没有面向插件的通用桌面通知接口，因此以“统一告警接口 + 日志”为默认实现；接入其他通道只需订阅同一接口。

## 7. 数据模型与持久化

位置：`$DSH_HOME/deepseek-usage-monitor/state.json`（可用 `data_dir` 覆盖）。

```jsonc
{
  "version": 1,
  "createdAt": 0,
  "balance": {
    "state": "never|ok|error",
    "snapshot": { "isAvailable": true, "infos": [{ "currency": "CNY", "total": 0, "granted": 0, "toppedUp": 0 }],
                  "fetchedAt": 0, "source": "official-api|official-account", "warnings": [] },
    "error": { "code": "AUTH", "message": "", "at": 0 },
    "lastAttemptAt": 0, "lastSuccessAt": 0, "consecutiveFailures": 0
  },
  "balanceHistory": [{ "at": 0, "totals": { "CNY": 0 }, "isAvailable": true }],
  "calls": [{ "at": 0, "model": "", "provider": "", "inputTokens": 0, "outputTokens": 0,
              "cacheReadTokens": 0, "cacheWriteTokens": 0, "reasoningTokens": 0,
              "status": "ok|error", "failureCode": "", "durationMs": 0 }],
  "alerts": [{ "id": "low_balance:CNY", "type": "low_balance", "severity": "warning|critical",
               "state": "active|resolved", "firstAt": 0, "lastAt": 0, "count": 1,
               "value": 0, "threshold": 0, "dataAt": 0, "source": "" }],
  "events": [{ "at": 0, "kind": "", "code": "", "message": "" }],
  "overrides": { "low_balance_threshold": 20 }
}
```

- 写入：串行化 + 先写 `.tmp` 再 `rename`（原子替换）。
- 读取：校验版本与每条记录的结构，非法记录被丢弃并在 `status.storage.droppedRecords` 中报告；损坏文件被重命名为 `state.json.corrupt-<ts>` 后从空状态启动。
- 保留：`history_retention_days` 天内，且 `calls` ≤ `max_call_records`、余额快照 ≤ 5000、告警 ≤ 200、事件 ≤ 100。
- **不存敏感数据**：无 API Key、无 Authorization 头、无 Prompt/响应正文。

## 8. 安全设计

- 密钥只从 credentials 服务 / 环境变量 / 显式配置读取，**不写入仓库、状态文件、日志或工具输出**。
- 日志层统一脱敏：`Bearer <token>` → `Bearer [redacted]`，`sk-…` → `[redacted-key]`；`Error` 与对象同样经过脱敏。
- 上游响应体永不进入错误消息或日志（只记录状态码与分类码），避免泄露内容。
- 余额请求：15 秒默认超时、最多 5 次重试、指数退避 + 抖动、尊重 `Retry-After`；429/5xx/网络错误可重试，401/403、非法 JSON、超大响应不重试。
- 外发仅限 DeepSeek 官方端点（经 `api_base_url` 配置）与 DSH 自身的账户服务；不向任何第三方上传数据。
- HTTP 路由位于已鉴权的 `/api` 通道；本地状态目录不在沙箱写入范围（属 Host 进程自有数据目录）。

## 9. 测试

```bash
npm test              # 默认隔离：每个测试文件一个子进程（CI 与常规终端）
npm run test:sandbox  # 单进程：当环境禁止 spawn 管道时使用（本机 DSH 沙箱即如此）
```

| 命令 | 展开后的实际命令 | 适用场景 |
|---|---|---|
| `npm test` | `node --test test/*.test.mjs` | GitHub Actions、常规终端；Node 20+ |
| `npm run test:sandbox` | `node --test --test-isolation=none "test/*.test.mjs"` | 禁用 `child_process.spawn` 管道的沙箱环境；需要 Node 22+ 的 `--test-isolation` |

> 本机 DSH 的沙箱禁止 `child_process.spawn` 的管道模式，默认隔离会报 `spawn EPERM`，因此在本机请用 `npm run test:sandbox`（114 项全部通过）。两种模式测试内容完全相同，仅进程隔离方式不同。

当前 **114 个测试全部通过**（`test:sandbox` 本机实测；`test` 由 GitHub Actions 在 Node 20/22/24 上验证），覆盖：

| 文件 | 覆盖内容 |
|---|---|
| `test/api.test.mjs` | 余额响应正常/缺字段/类型错误、401/403、429+Retry-After、5xx、超时、网络错误、非法 JSON、超大响应、重试次数与退避增长、`Retry-After` 解析 |
| `test/account.test.mjs` | 账户钱包映射（充值/赠送/多币种/非法值）、未登录、查询抛错、用量链接、来源优先级、强制 account 但服务缺失 |
| `test/alerts.test.mjs` | 低余额阈值、冷却去重、恢复与再触发、网络错误不触发低余额、失败连击、数据过期、每日费用/Token、开关与零阈值、来源标注 |
| `test/usage.test.mjs` | 时区日/小时边界、半小时偏移时区、DST 日、范围校验、分桶、峰谷价、价格估算、未知模型、Token 口径、按模型聚合、余额差值、记录校验 |
| `test/store.test.mjs` | 持久化往返、原子写、并发写串行化、保留期与上限、损坏文件隔离、非法记录丢弃、清空历史、默认目录 |
| `test/plugin.test.mjs` | 插件挂载、工具/路由/事件注册、余额工具、失败后缓存态、未配置密钥、env/credentials 优先级、调用观测、并发去重、启停与清理、`auto_start`、告警联动、阈值覆盖持久化、清空历史、HTTP 处理器、缺少可选服务仍可挂载、**lossless JSON 回归** |
| `test/client.test.mjs` | 浏览器半注册（左栏 id / 主面板 key / 图标 SVG / 本地化 label）、用真实 Host 快照做整棵组件树渲染冒烟、中英切换 |
| `test/security.test.mjs` | 日志脱敏、失败响应体不外泄、密钥不落盘、重试次数无法被配置成无限、恶意响应不污染统计 |
| `test/json.test.mjs` | lossless JSON 投影（undefined/NaN/循环/Date/Error） |

## 10. 常见故障排查

| 现象 | 原因与处理 |
|---|---|
| 左栏没有图标 | 插件未启用；或安装后未刷新页面。检查 `plugin_manager list_plugins` 中 `include:deepseek-usage-monitor` 的 `fiberPhase` 是否为 `active` |
| 面板显示“无法读取监控数据” | `/api` 路由未注册（`connection` 服务缺失）或浏览器未登录（Cookie 失效，刷新页面重新换取） |
| 余额显示“未配置 API Key” | 既没有可解析的 API Key，也没有已登录账户。设置 `DEEPSEEK_API_KEY`、通过 credentials 存储，或在 DSH 设置中登录账户 |
| 余额显示“缓存值” | 最近一次刷新失败：看 `balance.error.code`。`AUTH` = 密钥无效/无权；`RATE_LIMIT` = 触发限流（已按 `Retry-After` 退避）；`TIMEOUT`/`NETWORK` = 网络；`ACCOUNT_SIGNED_OUT` = 账户登录失效 |
| 余额来源显示“已登录账户” | 当前 profile 通过 `deepseek-account` provider 调用模型，且未配置 API Key（`balance_source: auto` 的正常行为） |
| 用量为 0 | 插件启用后才开始记录；且只统计本 Harness 进程的调用。可先用一次普通对话再查看 |
| 估算费用为 0 但有用量 | 模型不在价格表中（`unpricedModels` 会列出），用 `price_table` 补充 |
| 告警重复出现 | 冷却时间过短：调大 `alert_cooldown`；同一告警在冷却内只更新不重复通知 |
| 改了源码但行为没变 | Host 半不会热替换：`set_plugin enabled=false` 再 `enabled=true`，或重启 DSH |
| 配置不生效 | 看面板底部“配置问题”或 `deepseek_usage status` 的 `configIssues`：字段被判定非法时已回退默认值 |

## 11. 真实接口能力与已知限制

**已核实可用**

- `GET /user/balance`：官方文档存在，字段 `is_available` / `balance_infos[].{currency,total_balance,granted_balance,topped_up_balance}`；实测可用（API Key 无效时返回 401）。
- `ctx.deepseekAccount.getBalance()`：Host 服务，返回账户充值钱包与赠送钱包；**已在本机实测成功**，读到真实余额 CNY 4.80413。
- `llm/stream` 的 `usage` chunk：真实供应商 Token 统计；**已在本机实测**（捕获到 40 次调用、13.69M tokens，含 99.7% 缓存命中）。

**官方不提供（因此插件不实现、也不模拟）**

- **用量统计 / 账单明细 / 按模型用量 API**：DeepSeek 公开 API 参考仅包含 Chat Completions、Responses、FIM、List Models、Get User Balance、Files、Search & Fetch，**没有** usage/billing 端点。插件不会抓取控制台、不做模拟登录，也不会伪造数据；用量只能来自本地观测，账户级消费只能由余额差值推导。
- 因此“按模型、按调用次数”的官方统计不存在；这些指标全部标注为 `harness-observed`。

**其它限制**

- 无 Cordis `Config` schema（原因见 §3），Plugins 页面没有表单配置。
- 面板的**视觉呈现未在真实浏览器中逐项验收**：已验证浏览器半被加载、两个槽位注册成功（`Slots.listSubTree` 可见 `deepseek-usage` 占位）、组件树在真实 Host 快照下无异常渲染；像素级外观、滚动与深色模式需用户目视确认。
- 峰谷定价未排除中国法定节假日（高估）。
- 单进程作用域：多实例 DSH 各自独立存储，不做跨进程同步。
- 历史与趋势来自本地记录，插件停用期间的调用不会被补记。
- 自定义范围上限 366 天；任何聚合的分桶上限 400。
- 告警无桌面通知通道，默认落到日志/面板/工具结果。

**后续扩展建议**

- 接入 DSH 的统一通知/事件接口后，把 `monitor.subscribe()` 接到桌面通知。
- 用 `ctx.storageDomain` + zod 替代 JSON 文件（需要 zod 依赖时再迁移）。
- 若 DeepSeek 未来开放 usage/billing API，可在 `lib/deepseek-api.js` 旁新增 provider，并将 `sources.usage.kind` 从 `official-unavailable` 切换为 `official`。
- 为价格表增加节假日日历（可配置的 holiday 列表）。
- 增加“按 session 维度”的用量视图（可复用 `sessionId` 观测字段，但需评估隐私与存储量）。

## 12. 文件清单

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch`、`dsh.client`、`exports['./client']`、`exports['./locale/*.json']`、`exports['./icon']` |
| `cordis.patch.yml` | Loader 插入行与默认配置（无密钥） |
| `index.js` | Host 入口：配置校验、装配、生命周期、`llm/stream` 观测、工具与路由注册、清理 |
| `client.js` | 浏览器半：左栏入口 + 主面板面板（React，无 JSX），主题 token 样式，中英双语 |
| `lib/config.js` | 默认值、逐字段校验、`configIssues`、价格表解析 |
| `lib/log.js` | 带标签与脱敏的日志 |
| `lib/time.js` | 时区日/小时边界、范围解析、分桶、峰谷判定 |
| `lib/deepseek-api.js` | `/user/balance` 客户端：超时、重试、退避、错误分类、响应校验 |
| `lib/account.js` | 已登录账户钱包余额（官方 Host 服务）映射与错误 |
| `lib/usage.js` | 本地记录校验、Token 聚合、按模型/分桶、余额差值推导 |
| `lib/pricing.js` | 内置价格表、模型别名、费用估算 |
| `lib/alerts.js` | 五类阈值告警、冷却去重、恢复、来源标注 |
| `lib/scheduler.js` | 独立轮询器：幂等启动、重叠保护、暂停/恢复、停止清理、失败退避 |
| `lib/store.js` | 状态文件：原子写、串行化、损坏隔离、保留期、记录校验 |
| `lib/service.js` | 服务编排：余额刷新、用量记录、快照/状态/告警查询、阈值覆盖 |
| `lib/tools.js` | Agent 工具 `deepseek_usage` 定义与渲染 |
| `lib/http.js` | `/api/deepseek-usage/*` 处理器与注册 |
| `lib/capture.js` | `llm/stream` 包装：只读 usage/finish，不改写数据流 |
| `lib/json.js` | lossless JSON 投影（边界清洗） |
| `locale/en.json`、`locale/zh.json` | Plugin Manager / Settings 的标题与描述 |
| `icon.svg` | 插件图标（原始绘制，611 字节） |
| `test/*.test.mjs` | 上述测试套件 |

## 13. 数据来源速查

| 界面上看到的 | 字段 | 含义 |
|---|---|---|
| `实时` / `缓存值` / `未知` | `balance.isLive` / `isCached` / `isUnknown` | 官方余额的新鲜度 |
| `API Key` / `已登录账户` | `balance.source` = `official-api` / `official-account` | 余额来自哪条官方通道 |
| `本地观测` | `usage.source` = `harness-observed` | 仅本进程观测到的 Token |
| `账户消费（余额差值）` | `usage.accountSpend.source` = `derived-from-official-balance` | 官方余额差值推导的账户级消费 |
| `估算` | `usage.costEstimate.estimated` = `true` | 价格表 × 观测 Token，非实际扣费 |
| `数据更新于 …` + 年龄 | `balance.fetchedAt` / `ageSeconds` | 数据真实获取时间，绝不冒充“现在” |
