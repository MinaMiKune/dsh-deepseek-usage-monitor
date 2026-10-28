# DeepSeek Usage Monitor

[![tests](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/actions/workflows/test.yml/badge.svg)](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/MinaMiKune/dsh-deepseek-usage-monitor?label=release)](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/releases)
[![license](https://img.shields.io/github/license/MinaMiKune/dsh-deepseek-usage-monitor)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![DSH](https://img.shields.io/badge/DSH-0.2.x-blue)

一个 [DeepSeek Harness](https://deepseek-harness.github.io/)（DSH）插件：在左侧栏加一个入口，用**官方接口**显示账户余额，用**本地观测**显示本 Harness 真实消耗的 Token，并给出可配置的阈值告警。

**简体中文** · [English](README.en.md)

> 第三方社区插件，与 DeepSeek 官方无关。它只调用公开 API 与 DSH 自身服务，不抓取控制台、不模拟登录。

---

## 为什么需要它

DSH 能告诉你「这一次对话花了多少 token」，但很少回答三个更重要的问题：**账户里还剩多少钱？今天到底用掉多少？是不是快超了？** 更麻烦的是这三件事的数据来源完全不同，很容易被混为一谈。这个插件把它们分开呈现，并且**每一块数字都标注来源**。

| 你可能想知道 | 数据从哪来 | 可信度 |
|---|---|---|
| 账户还剩多少余额 | DeepSeek 官方接口 | 官方，账户级 |
| 今天/本周用了多少 Token | 本 Harness 拦截到的 `usage` chunk | 真实计数，但**仅限本进程** |
| 账户一共花掉多少钱 | 两次官方余额快照的差值 | 官方推导，账户级，不能按模型拆分 |
| 按模型花了多少 | 本地记录 × 价格表 | **估算**，不是扣费金额 |

## 数据来源一览

这是本插件最重要的一张表——界面上任何一个数字，都能在这里找到出处：

| 界面元素 | 数据来源 | 字段标记 | 说明 |
|---|---|---|---|
| 余额数值 | `GET {api_base_url}/user/balance` | `balance.source: "official-api"` | 官方文档：[Get User Balance](https://api-docs.deepseek.com/api/get-user-balance) |
| 余额数值 | DSH 已登录账户钱包 `ctx.deepseekAccount.getBalance()` | `balance.source: "official-account"` | 同一账户的另一条官方通道，无需 API Key |
| `实时` / `缓存值` / `未知` | 最近一次刷新的结果 | `isLive` / `isCached` / `isUnknown` | 失败时保留旧值但**显式标为缓存** |
| Token 用量 | `llm/stream` 的 `usage` chunk | `usage.source: "harness-observed"` | 供应商返回的真实计数，仅本进程 |
| 账户消费 | 官方余额快照差值 | `accountSpend.source: "derived-from-official-balance"` | 覆盖账户全部消费，无法按模型拆分 |
| 估算费用 | 价格表 × 观测 Token | `costEstimate.estimated: true` | **不是**实际扣费 |
| 调用次数 / 失败数 | 本地调用记录 | `usage.totals.calls` | 仅统计插件启用后本进程的调用 |

**口径铁律**：官方余额、本地观测用量、估算费用、余额差值**四种数字各自独立，永不相加**。本地观测永远不等于账户全量。

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [使用](#使用)
- [指标口径](#指标口径)
- [告警](#告警)
- [架构](#架构)
- [持久化与安全](#持久化与安全)
- [测试与开发](#测试与开发)
- [常见故障排查](#常见故障排查)
- [已知限制](#已知限制)
- [文件结构](#文件结构)
- [许可](#许可)

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | `0.2.x`（已在 `0.2.1-rc.3` 上安装、加载并实测） |
| Node.js | 运行时 ≥ 20；`npm run test:sandbox` 需 ≥ 22 |
| 依赖 | **无**。纯 ESM，无第三方包、无构建步骤 |
| 可选 | DeepSeek API Key（`sk-…`），仅 `GET /user/balance` 路线需要 |
| 可选 | DSH 已登录账户（设置 → 账户），用于账户钱包余额 |

插件不解析 `@deepseek-ai/*` 运行时包：安装后由 DSH 的 Client Modules 直接加载，不需要 `pnpm install`。

## 安装

```bash
git clone https://github.com/MinaMiKune/dsh-deepseek-usage-monitor.git
```

在 DSH 中安装该目录（Plugin Manager → 添加插件 → 本地目录，或 Agent 工具）：

```text
plugin_manager install_bundle  target = <clone 出来的目录>
```

也可以直接下载 [v1.0.0 Release](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/releases) 里的 `dsh-deepseek-usage-monitor-v1.0.0.zip`，解压后安装同一目录。

安装做了什么：

1. 在 profile（如 `~/.dsh/profiles/desktop`）登记依赖并链接本目录；
2. 读取 `cordis.patch.yml`，插入 Loader 条目 `deepseek-usage-monitor`；
3. Host 半激活：注册工具与 `/api` 路由、挂上 `llm/stream` 观测、启动两个轮询器；
4. 浏览器半激活：在 `sidebar.panellist` 注册图标，在 `main` 注册同名面板。

安装后**刷新页面**，左侧栏出现仪表盘图标。

### 启用 / 停用 / 卸载

| 操作 | 命令 |
|---|---|
| 停用（保留数据） | `plugin_manager set_plugin  target=include:deepseek-usage-monitor  enabled=false` |
| 启用 | 同上，`enabled=true` |
| 卸载 | `plugin_manager remove_bundle  target=@local/dsh-deepseek-usage-monitor` |
| 清理数据 | 删除 `~/.dsh/deepseek-usage-monitor/`（或 `data_dir` 指定目录） |

停用或卸载时，插件依次：中止进行中的余额请求 → 清除两个定时器 → 落盘未写入的观测记录 → 释放工具与路由注册。

> **改了源码不会自动生效**：Host 半不参与 HMR，需要 `enabled=false` → `enabled=true` 或重启 DSH。

## 快速开始

1. 安装 + 刷新页面 → 左侧栏出现图标，点击即进入面板。
2. 有余额但显示「未配置」？二选一：
   - DSH 已登录账户 → `balance_source: auto` 会自动走账户钱包，无需任何配置；
   - 想用 API Key → 设置环境变量 `DEEPSEEK_API_KEY`，或存进 DSH credentials。
3. 想让用量出现在面板里，正常对话即可——插件在 `llm/stream` 处被动记录，不发额外请求。

## 配置

写在 profile 的 `cordis.patch.yml`（用户层，覆盖 bundle 默认值）：

```yaml
- id: deepseek-usage-monitor
  name: '@local/dsh-deepseek-usage-monitor'
  config:
    balance_source: auto
    low_balance_threshold: 20
    timezone: Asia/Shanghai
```

### 全部字段

| 字段 | 默认值 | 单位 / 范围 | 说明 |
|---|---|---|---|
| `api_key` | `null` | — | 字面密钥，**不推荐**（优先用下面两项） |
| `api_key_env` | `DEEPSEEK_API_KEY` | 合法变量名 | 经 `ctx.credentials` 解析，其次 `process.env` |
| `api_base_url` | `https://api.deepseek.com` | http(s) URL | 余额端点基址（可指向自建代理） |
| `balance_source` | `auto` | `auto` / `api-key` / `account` | 余额来源策略，见下表 |
| `balance_poll_interval` | `300` | 秒，30–86400 | 余额轮询间隔 |
| `usage_poll_interval` | `120` | 秒，30–86400 | 本地用量重算间隔（**无网络请求**） |
| `request_timeout` | `15000` | 毫秒，1000–120000 | 单次余额请求超时 |
| `max_retries` | `2` | 0–5 | 首次之外的额外重试次数 |
| `retry_backoff` | `1000` | 毫秒，100–30000 | 指数退避基数（带抖动，尊重 `Retry-After`） |
| `low_balance_threshold` | `10` | ≥ 0，`0` 关闭 | 低余额告警阈值 |
| `low_balance_currency` | `CNY` | ISO-4217 | 参与比较的币种 |
| `daily_cost_threshold` | `0` | USD，`0` 关闭 | 当日估算费用告警阈值 |
| `daily_token_threshold` | `0` | 整数，`0` 关闭 | 当日观测 Token 告警阈值 |
| `alert_cooldown` | `3600` | 秒，0–86400 | 同一告警的重复通知冷却 |
| `failure_streak_threshold` | `3` | 1–20 | 连续失败多少次触发告警 |
| `stale_after` | `0`（自动） | 秒，0–86400 | 数据过期阈值；`0` = 2.5×余额间隔（最小 600） |
| `history_retention_days` | `30` | 1–365 | 本地记录保留天数 |
| `timezone` | `''`（主机时区） | IANA 名称 | 统计与展示时区 |
| `debug` | `false` | 布尔 | 详细日志（仍会脱敏） |
| `auto_start` | `true` | 布尔 | 激活时自动启动轮询 |
| `data_dir` | `''` | 路径 | 状态目录；空 = `$DSH_HOME/deepseek-usage-monitor` |
| `max_call_records` | `20000` | 100–200000 | 本地调用记录上限 |
| `tracked_providers` | `[]` | provider 名数组 | 空 = 记录全部路由 |
| `alerts` | 全 `true` | 五个布尔开关 | 分类型启停告警 |
| `price_table` | `null` | 见下 | `null` = 内置官方价格表 |

**单位是契约的一部分**：`*_poll_interval`、`alert_cooldown`、`stale_after` 是**秒**；`request_timeout`、`retry_backoff` 是**毫秒**。

### 校验行为

- 启动时逐字段做类型与范围校验；非法值**回退默认值**并记入 `configIssues`（面板底部与 `deepseek_usage status` 可见），不会静默吞掉。
- 本插件**不导出 Cordis `Config` schema**：profile 安装的插件无法解析 `@deepseek-ai/schemastery`，导出 schema 会导致激活失败。因此 Plugins 页面没有表单配置，配置走 `cordis.patch.yml`，校验在启动流程中完成。
- 运行期可用工具覆盖阈值（写入状态文件，重启仍生效）：
  `deepseek_usage { "action": "set_thresholds", "thresholds": { "low_balance_threshold": 20 } }`

### API Key 与余额来源

密钥优先级（从上到下）：

1. **DSH 凭据服务**（推荐）：引用名默认 `DEEPSEEK_API_KEY`；每次操作前重新解析，轮换密钥无需重启。
2. **环境变量** `DEEPSEEK_API_KEY`（或自定义 `api_key_env`）。
3. **配置项 `api_key`**：仅受控环境使用；该值不会写入状态文件、日志或工具输出。

`balance_source` 决定走哪条官方通道：

| 取值 | 行为 |
|---|---|
| `auto`（默认） | 能解析到 API Key → `/user/balance`；否则若存在 `ctx.deepseekAccount` → 账户钱包；都没有 → 明确报 `NOT_CONFIGURED` |
| `api-key` | 只走 `/user/balance` |
| `account` | 只走已登录账户钱包（服务缺失时报 `ACCOUNT_UNAVAILABLE`） |

> 许多 profile 用 `deepseek-account` provider 调用模型，本身不持有 API Key。此时 `auto` 会自然落到账户钱包——这正是**实际付费的那个账户**。

## 使用

### 左栏面板

点击左侧栏仪表盘图标，中央面板切换到「DeepSeek 用量监控」：

| 区块 | 内容 |
|---|---|
| 账户余额 | 主币种总额、赠送/充值拆分、`is_available`、更新时间与年龄、`实时/缓存值/未知`、当前通道（API Key / 已登录账户）、控制台用量链接 |
| 今日 | 本地时区当天的调用数、Token、估算费用 |
| 账户消费 | 由相邻官方余额快照差值推导的账户级消费（含充值与赠送） |
| Token 用量 | 范围切换（1h / 24h / 7d / 30d / 自定义）、输入/输出/缓存读取、缓存命中率、桶状趋势、按模型明细 |
| 告警 | 活动告警（数值、阈值、数据时间、次数）与阈值一览 |
| 数据来源 | 固定说明每条数据的出处 |

面板每 30 秒拉一次快照；「刷新」触发一次即时余额刷新。样式跟随 DSH 主题 token（`--dsw-alias-*`），中英双语，可手动切换。

### Agent 工具 `deepseek_usage`

| action | 作用 |
|---|---|
| `status` | 调度器、凭据、采集范围、存储、告警与配置问题 |
| `balance` | 官方余额 + 新鲜度分类 |
| `usage` | 指定 `range`（`1h`/`24h`/`7d`/`30d`/`custom` + `start`/`end`）的聚合 |
| `refresh` | `scope`: `balance` / `usage` / `all` |
| `alerts` | 活动/已恢复告警、阈值、最近通知 |
| `set_thresholds` | 持久化运行期阈值覆盖 |
| `reset_thresholds` | 清除覆盖 |
| `clear_history` | 删除本地记录（必须 `confirm: true`） |

返回值始终是 lossless JSON（`undefined` 在边界被剔除），同时给出一行人类摘要与结构化 JSON。工具与面板调用**同一批服务方法**，不存在两套逻辑。

### HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/deepseek-usage/snapshot?range=24h[&start&end]` | 面板快照 |
| POST | `/api/deepseek-usage/refresh` | body `{ "scope": "all" }` |

两条路由注册在 **DSH 已鉴权的 `/api` 通道**（`ctx.connection.fetch.register`），沿用浏览器 Cookie 鉴权与 Host/Origin 校验；未认证请求在进入插件代码前就被拒绝。响应 `cache-control: no-store`，不含任何密钥。

## 指标口径

### 余额（官方，账户级）

- 口径是账户**总可用余额**：不是累计消费、不是充值额、不是预算，也不是本地估算。
- 延迟取决于 DeepSeek 平台；插件按间隔轮询，并**始终展示数据获取时间与年龄**。
- 账户通道不提供 `is_available`，该字段显示「—」（未知），不会伪造成 `true`。

**新鲜度三态**：

| 状态 | 判定 | 展示 |
|---|---|---|
| 实时 | 最近一次刷新成功 | `实时` + 时间戳 + 年龄 |
| 缓存值 | 有历史快照但最近刷新失败 | `缓存值` + 警告「不是最新余额」 |
| 未知 | 从未成功获取 | `未知` + 错误码 |

### Token 用量（本地观测，Harness 作用域）

- 来源：`llm/stream` waterfall 的 `usage` chunk，即**供应商返回的真实计数**，不是字符数换算。
- 覆盖：仅插件启用期间、经本 Harness 进程 `ctx.llm.stream()` 发出的调用。
- 字段与口径（`dsh-llm` 的 `TokenUsage` 语义）：

  ```text
  计费输入 = inputTokens（未命中缓存） + cacheReadTokens + cacheWriteTokens
  总 Token = 计费输入 + outputTokens
  缓存命中率 = cacheReadTokens / 计费输入
  reasoningTokens ⊂ outputTokens（不重复相加）
  ```

- 粒度：≤ 48 小时按小时桶，> 48 小时按天桶，均以配置时区为准。
- 延迟：近实时（调用结束即记录，2 秒防抖落盘）。
- 限制：**不是账户全量**——其他工具、其他机器、插件启用前的调用都不在其中。

### 费用

| 指标 | 算法 | 性质 |
|---|---|---|
| 账户消费 | 相邻两次官方余额快照的差值（降=消费，升=充值/赠送） | 官方推导；账户级；不能按模型拆；窗口首个快照前的消费不可见 |
| 估算费用 | 价格表 × 观测 Token | **估算**；`estimated: true`；不是扣费金额 |

内置价格表（USD / 1M tokens，取自[官方价格页](https://api-docs.deepseek.com/quick_start/pricing)，2026-10-27 抓取）：

| 模型 | 缓存命中（峰/谷） | 缓存未命中（峰/谷） | 输出（峰/谷） |
|---|---|---|---|
| `deepseek-flash` | 0.006 / 0.003 | 0.30 / 0.15 | 1.20 / 0.60 |
| `deepseek-v4-pro` | 0.044 / 0.022 | 1.32 / 0.66 | 3.96 / 1.98 |

- 峰时：UTC 周一至周五 01:00–04:00 与 06:00–10:00；其余为谷时（价格减半）。
- **中国法定节假日未排除**（无可用日历），节假日工作日峰时会按峰价估算，属**高估**。
- 旧模型别名（`deepseek-chat`、`deepseek-reasoner`、`deepseek-v4-flash` 等）按 Flash 价格；未知模型标 `unpriced`，不猜价。
- 价格会变；用 `price_table` 覆盖：

  ```yaml
  price_table:
    my-model:
      peak:     { cache_hit: 0.006, cache_miss: 0.30, output: 1.20 }
      off_peak: { cache_hit: 0.003, cache_miss: 0.15, output: 0.60 }
  ```

### 调用次数与失败

来自本地记录：`status: ok|error`、`failureCode`（如 `RATE_LIMIT`、`ABORTED`）、`durationMs`（流开始到结束）。用户取消的流记为 `error/ABORTED`，不会算作成功。

## 告警

| 类型 | 触发条件 | 数据来源 |
|---|---|---|
| `low_balance` | 指定币种总余额 < `low_balance_threshold`（0 关闭） | 官方余额，**仅成功响应** |
| `daily_cost` | 当天估算费用 > `daily_cost_threshold` USD | 本地估算 |
| `daily_token` | 当天观测 Token > `daily_token_threshold` | 本地观测 |
| `request_failures` | 连续失败 ≥ `failure_streak_threshold` | 调度器 |
| `stale_data` | 距上次成功超过 `stale_after` | 调度器 |

规则：

- **低余额只由成功的官方响应触发**：网络错误、超时、5xx 只会产生 `request_failures` / `stale_data`，绝不会变成「余额不足」。
- 持续满足条件时告警**原地更新**，通知按 `alert_cooldown` 去重；条件消失置为 `resolved`，再次触发时计数重置。
- 告警持久化在状态文件中，重启不丢；冷却位置也不丢。
- 告警内容包含原因、数值、阈值、数据时间与来源通道。
- 通知通道：`monitor.subscribe()` → Host 日志（`[deepseek-usage] ALERT …`）+ 面板告警区 + `alerts` 工具结果。DSH 目前没有面向插件的通用桌面通知接口，因此以「统一告警接口 + 日志」为默认实现；接其他通道只需订阅同一接口。

## 架构

```text
DeepSeek Platform ──GET /user/balance──┐
                                       ├─► lib/account.js ──┐
DSH deepseekAccount ──getBalance()──────┘                    │
                                                            ├─► lib/service.js ──► state.json（原子写）
LLM provider ──usage chunk──► llm/stream 拦截 ──► lib/capture.js ┘        │
                                                                          ├─► deepseek_usage（Agent 工具）
                                                                          ├─► /api/deepseek-usage/*（面板）
                                                                          └─► 告警 → 日志 / 面板 / 工具
```

两个独立轮询器（`lib/scheduler.js`）：余额（网络）与用量（纯本地）互不阻塞；都具备幂等启动、重叠保护、暂停/恢复、停止清理与失败退避。

模块职责：

| 层 | 文件 | 职责 |
|---|---|---|
| 入口 | `index.js` | 配置校验、装配、生命周期、`llm/stream` 观测、工具与路由注册、清理 |
| 浏览器半 | `client.js` | 左栏入口 + 主面板（React，无 JSX），主题 token，中英双语 |
| 外部客户端 | `lib/deepseek-api.js`、`lib/account.js` | 两条官方余额通道：HTTP 客户端（超时/重试/分类/校验）与账户服务映射 |
| 业务 | `lib/service.js`、`lib/usage.js`、`lib/pricing.js`、`lib/alerts.js` | 余额刷新、用量聚合、费用估算、告警 |
| 基础设施 | `lib/config.js`、`lib/store.js`、`lib/scheduler.js`、`lib/time.js`、`lib/json.js`、`lib/log.js` | 配置、持久化、调度、时区、序列化、日志 |
| 适配器 | `lib/tools.js`、`lib/http.js`、`lib/capture.js` | Agent 工具、Host 路由、流观测 |

## 持久化与安全

状态文件：`$DSH_HOME/deepseek-usage-monitor/state.json`（可用 `data_dir` 覆盖）。

```jsonc
{
  "version": 1,
  "balance": { "state": "never|ok|error", "snapshot": { "infos": [], "fetchedAt": 0, "source": "official-api|official-account" },
               "error": null, "lastAttemptAt": 0, "lastSuccessAt": 0, "consecutiveFailures": 0 },
  "balanceHistory": [{ "at": 0, "totals": { "CNY": 0 } }],
  "calls": [{ "at": 0, "model": "", "provider": "", "inputTokens": 0, "outputTokens": 0,
              "cacheReadTokens": 0, "cacheWriteTokens": 0, "status": "ok|error", "durationMs": 0 }],
  "alerts": [{ "id": "low_balance:CNY", "type": "low_balance", "state": "active|resolved", "value": 0, "threshold": 0 }],
  "events": [], "overrides": {}
}
```

- 写入：串行化 + 先写 `.tmp` 再 `rename`（原子替换）。
- 读取：校验版本与每条记录；非法记录丢弃并在 `status.storage.droppedRecords` 报告；损坏文件重命名为 `state.json.corrupt-<ts>` 后从空状态启动。
- 保留：`history_retention_days` 内，且 `calls` ≤ `max_call_records`、余额快照 ≤ 5000、告警 ≤ 200、事件 ≤ 100。
- **不存敏感数据**：无 API Key、无 Authorization 头、无 Prompt/响应正文。

安全要点：

- 密钥只从凭据服务 / 环境变量 / 显式配置读取，**不写入仓库、状态文件、日志或工具输出**。
- 日志统一脱敏：`Bearer <token>` → `Bearer [redacted]`，`sk-…` → `[redacted-key]`；对象与 `Error` 同样处理。
- 上游响应体永不进入错误消息或日志（只记录状态码与分类码）。
- 余额请求：默认 15 秒超时、最多 5 次重试、指数退避 + 抖动、尊重 `Retry-After`；429/5xx/网络错误可重试，401/403、非法 JSON、超大响应不重试。
- 外发仅限 DeepSeek 官方端点（`api_base_url`）与 DSH 账户服务，不向第三方上传任何数据。

## 测试与开发

```bash
npm test              # 默认隔离：每个测试文件一个子进程（CI / 常规终端）
npm run test:sandbox  # 单进程：环境禁止 spawn 管道时使用（本机 DSH 沙箱即如此）
```

| 命令 | 实际执行 | 适用 |
|---|---|---|
| `npm test` | `node --test test/*.test.mjs` | GitHub Actions、常规终端；Node ≥ 20 |
| `npm run test:sandbox` | `node --test --test-isolation=none "test/*.test.mjs"` | 禁用 `spawn` 管道的沙箱；需 Node ≥ 22 |

当前 **114 个测试**，在 Node 20 / 22 / 24 上全部通过（CI 矩阵）。覆盖：

| 文件 | 覆盖内容 |
|---|---|
| `api.test.mjs` | 余额响应正常/缺字段/类型错误、401/403、429+Retry-After、5xx、超时、网络错误、非法/超大响应、重试与退避增长 |
| `account.test.mjs` | 账户钱包映射（充值/赠送/多币种/非法值）、未登录、查询抛错、用量链接、来源优先级 |
| `alerts.test.mjs` | 阈值、冷却去重、恢复与再触发、网络错误不误报、失败连击、数据过期、开关与零阈值、来源标注 |
| `usage.test.mjs` | 时区日/小时边界、半小时偏移、DST 日、范围校验、分桶、峰谷价、估算、Token 口径、余额差值 |
| `store.test.mjs` | 持久化往返、原子写、并发串行化、保留期与上限、损坏隔离、非法记录丢弃、清空历史 |
| `plugin.test.mjs` | 挂载、工具/路由/事件注册、余额与缓存态、凭据优先级、调用观测、并发去重、启停清理、告警联动、阈值覆盖、HTTP 处理器、**lossless JSON 回归** |
| `client.test.mjs` | 左栏/主面板注册、图标 SVG、本地化 label、用真实 Host 快照做整棵组件树渲染冒烟 |
| `security.test.mjs` | 日志脱敏、失败响应体不外泄、密钥不落盘、重试不可被配置成无限、恶意响应不污染统计 |
| `json.test.mjs` | lossless JSON 投影（undefined/NaN/循环/Date/Error） |

测试文件各自独占 `test/.tmp/<name>-<pid>`：`node --test` 并行跑文件，共享临时目录会互相删除。

## 常见故障排查

| 现象 | 原因与处理 |
|---|---|
| 左栏没有图标 | 插件未启用，或安装后未刷新页面。查 `plugin_manager list_plugins` 中该条目的 `fiberPhase` 是否为 `active` |
| 面板显示「无法读取监控数据」 | `/api` 路由未注册（无 `connection` 服务）或浏览器未登录（刷新页面重新换取 Cookie） |
| 余额显示「未配置 API Key」 | 既无可用 API Key，也无已登录账户。设置 `DEEPSEEK_API_KEY`、存入 credentials，或在 DSH 设置中登录 |
| 余额显示「缓存值」 | 最近一次刷新失败：看 `balance.error.code`。`AUTH` 密钥无效/无权；`RATE_LIMIT` 已按 `Retry-After` 退避；`TIMEOUT`/`NETWORK` 网络问题；`ACCOUNT_SIGNED_OUT` 登录失效 |
| 余额来源是「已登录账户」 | 当前 profile 用 `deepseek-account` 且未配 API Key，属 `auto` 的正常行为 |
| 用量为 0 | 插件启用后才记录，且只统计本进程。先正常对话一次再看 |
| 有用量但估算费用为 0 | 模型不在价格表中（`unpricedModels` 会列出），用 `price_table` 补充 |
| 告警重复出现 | 冷却太短：调大 `alert_cooldown`；冷却内同一告警只更新不重复通知 |
| 改了源码但行为没变 | Host 半不热替换：`enabled=false` → `enabled=true`，或重启 DSH |
| 配置不生效 | 看面板底部「配置问题」或 `deepseek_usage status` 的 `configIssues`：非法字段已回退默认值 |

## 已知限制

**官方不提供（因此不实现、也不模拟）**

- **用量统计 / 账单明细 / 按模型用量 API**：DeepSeek 公开 API 参考只有 Chat Completions、Responses、FIM、List Models、Get User Balance、Files、Search & Fetch，**没有** usage/billing 端点。插件不抓取控制台、不做模拟登录、不伪造数据；用量只能来自本地观测，账户级消费只能由余额差值推导。因此「按模型、按调用次数」的官方统计并不存在，相关指标一律标注 `harness-observed`。

**接口验证边界（诚实说明）**

- `GET /user/balance`：字段与行为按官方文档核对，成功/失败/401/429 **由 Mock 覆盖**；开发环境没有可用 API Key，故**未对生产端点做成功调用**。
- `ctx.deepseekAccount.getBalance()`：**已在真实环境实测成功**（具体金额不在文档中复述）。
- `llm/stream` 的 `usage` chunk：**已在本机实测**，输入/输出/缓存读取均为真实返回值。
- 面板的**像素级外观未逐项验收**：已确认浏览器半加载、两个槽位注册成功、组件树在真实 Host 快照下无异常渲染；滚动、深色模式等需目视确认。

**其它**

- 无 Cordis `Config` schema（原因见[配置](#配置)），Plugins 页面没有表单。
- 峰谷定价未排除中国法定节假日（会高估）。
- 单进程作用域：多实例 DSH 各自独立存储，无跨进程同步。
- 插件停用期间的调用不会补记。
- 自定义范围上限 366 天；任何聚合的分桶上限 400。
- 告警无桌面通知通道，默认落日志 / 面板 / 工具结果。

**后续方向**

- 接入 DSH 统一通知接口，把 `monitor.subscribe()` 接到桌面通知。
- 若官方开放 usage/billing API，在 `lib/deepseek-api.js` 旁新增 provider，并把 `sources.usage.kind` 从 `official-unavailable` 切为 `official`。
- 价格表增加节假日日历；增量清理与压缩历史。

## 文件结构

```text
deepseek-usage-monitor/
├── package.json          # bundle 清单：dsh.bundle.patch、dsh.client、exports
├── cordis.patch.yml      # Loader 插入行（含默认配置，无密钥）
├── index.js              # Host 入口：校验 / 装配 / 生命周期 / 工具 / 路由
├── client.js             # 浏览器半：左栏入口 + 主面板
├── lib/                  # 15 个业务与基础设施模块（见架构表）
├── locale/{en,zh}.json   # Plugin Manager 显示用的标题与描述
├── icon.svg              # 插件图标
└── test/                 # 9 套测试 + 假 ctx
```

## 许可

[MIT](LICENSE) © 2026 MinaMiKune

问题与建议请提 [Issue](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/issues)。
