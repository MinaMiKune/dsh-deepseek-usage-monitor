# DeepSeek Usage Monitor

[![tests](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/actions/workflows/test.yml/badge.svg)](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/MinaMiKune/dsh-deepseek-usage-monitor?label=release)](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/releases)
[![license](https://img.shields.io/github/license/MinaMiKune/dsh-deepseek-usage-monitor)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![DSH](https://img.shields.io/badge/DSH-0.2.x-blue)

A [DeepSeek Harness](https://deepseek-harness.github.io/) (DSH) plugin that puts a sidebar entry in the Web UI showing the **official DeepSeek account balance** next to the **token usage this Harness actually observed**, with configurable threshold alerts.

[简体中文](README.md) · **English**

> Third-party community plugin, not affiliated with DeepSeek. It calls the public API and DSH's own services only — no console scraping, no simulated login.

---

## Why

DSH tells you what one conversation cost. It does not answer: **how much balance is left, how much was used today, and am I about to run out?** Those three numbers come from completely different sources and are easy to conflate. This plugin keeps them apart and **labels every number with its origin**.

| Question | Source | Trust level |
|---|---|---|
| Balance left | DeepSeek official endpoint | Official, account-wide |
| Tokens used today | `usage` chunk observed by this Harness | Real counts, **this process only** |
| Money spent by the account | Delta between two official balance snapshots | Official derivation, account-wide, not per-model |
| Cost per model | Local records × price table | **Estimate**, not a billed amount |

## Data provenance

| UI element | Source | Field marker |
|---|---|---|
| Balance value | `GET {api_base_url}/user/balance` ([docs](https://api-docs.deepseek.com/api/get-user-balance)) | `balance.source: "official-api"` |
| Balance value | `ctx.deepseekAccount.getBalance()` (signed-in account wallet) | `balance.source: "official-account"` |
| `live` / `cached` / `unknown` | Result of the latest refresh | `isLive` / `isCached` / `isUnknown` |
| Token usage | `llm/stream` `usage` chunk | `usage.source: "harness-observed"` |
| Account spend | Official balance snapshot deltas | `accountSpend.source: "derived-from-official-balance"` |
| Estimated cost | Price table × observed tokens | `costEstimate.estimated: true` |

**Rule:** official balance, locally observed usage, estimated cost and balance deltas are **never summed together**, and local observations are never presented as account-wide usage.

## Requirements

| Item | Requirement |
|---|---|
| DSH | `0.2.x` (installed, loaded and exercised on `0.2.1-rc.3`) |
| Node.js | runtime ≥ 20; `npm run test:sandbox` needs ≥ 22 |
| Dependencies | **none** — plain ESM, no build step, no third-party packages |
| Optional | a DeepSeek API key, only for the `/user/balance` route |
| Optional | a signed-in DeepSeek account (DSH Settings → Account) for the wallet balance |

## Install

```bash
git clone https://github.com/MinaMiKune/dsh-deepseek-usage-monitor.git
```

Then install that directory in DSH (Plugin Manager → add plugin → local directory, or the agent tool):

```text
plugin_manager install_bundle  target = <cloned directory>
```

The [v1.0.0 release](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/releases) ships `dsh-deepseek-usage-monitor-v1.0.0.zip` if you prefer a packaged copy. Refresh the page afterwards; a gauge icon appears in the sidebar.

| Action | Command |
|---|---|
| Disable (keeps data) | `plugin_manager set_plugin  target=include:deepseek-usage-monitor  enabled=false` |
| Enable | same, `enabled=true` |
| Uninstall | `plugin_manager remove_bundle  target=@local/dsh-deepseek-usage-monitor` |
| Delete data | remove `~/.dsh/deepseek-usage-monitor/` (or your `data_dir`) |

> The Host half does not hot-reload: after editing source, toggle the entry or restart DSH.

## Configuration

Override the bundle defaults from the profile's `cordis.patch.yml`:

```yaml
- id: deepseek-usage-monitor
  name: '@local/dsh-deepseek-usage-monitor'
  config:
    balance_source: auto
    low_balance_threshold: 20
    timezone: Asia/Shanghai
```

| Field | Default | Unit / range | Meaning |
|---|---|---|---|
| `api_key` | `null` | — | Literal key; discouraged |
| `api_key_env` | `DEEPSEEK_API_KEY` | variable name | Resolved via `ctx.credentials`, then env |
| `api_base_url` | `https://api.deepseek.com` | http(s) URL | Balance endpoint base |
| `balance_source` | `auto` | `auto` / `api-key` / `account` | Which official route supplies the balance |
| `balance_poll_interval` | `300` | seconds, 30–86400 | Balance poll interval |
| `usage_poll_interval` | `120` | seconds, 30–86400 | Local re-aggregation; **no network I/O** |
| `request_timeout` | `15000` | ms, 1000–120000 | Per-attempt timeout |
| `max_retries` | `2` | 0–5 | Retries after the first attempt |
| `retry_backoff` | `1000` | ms, 100–30000 | Exponential backoff base (jittered, honours `Retry-After`) |
| `low_balance_threshold` | `10` | ≥ 0, `0` disables | Low-balance alert |
| `low_balance_currency` | `CNY` | ISO-4217 | Currency compared |
| `daily_cost_threshold` | `0` | USD, `0` disables | Daily estimated-cost alert |
| `daily_token_threshold` | `0` | integer, `0` disables | Daily observed-token alert |
| `alert_cooldown` | `3600` | seconds, 0–86400 | Repeat-notification cooldown |
| `failure_streak_threshold` | `3` | 1–20 | Consecutive failures before alerting |
| `stale_after` | `0` (auto) | seconds, 0–86400 | Staleness limit; `0` = 2.5× balance interval (min 600) |
| `history_retention_days` | `30` | 1–365 | Local retention |
| `timezone` | `''` (host zone) | IANA name | Aggregation and display timezone |
| `debug` | `false` | bool | Verbose logs (still redacted) |
| `auto_start` | `true` | bool | Start pollers on activation |
| `data_dir` | `''` | path | State directory; empty = `$DSH_HOME/deepseek-usage-monitor` |
| `max_call_records` | `20000` | 100–200000 | Local record cap |
| `tracked_providers` | `[]` | provider names | Empty = record every route |
| `alerts` | all `true` | five booleans | Per-type switches |
| `price_table` | `null` | object | `null` = built-in official price table |

Units are part of the contract: `*_poll_interval`, `alert_cooldown`, `stale_after` are **seconds**; `request_timeout`, `retry_backoff` are **milliseconds**.

Invalid values fall back to the default and are reported in `configIssues` (panel footer and `deepseek_usage status`) — never silently ignored. The bundle deliberately exports no Cordis `Config` schema: a profile-installed plugin cannot resolve `@deepseek-ai/schemastery`, so a schema export would break activation. Thresholds can be overridden at runtime with `deepseek_usage { "action": "set_thresholds", "thresholds": { "low_balance_threshold": 20 } }`.

### Credentials

1. **DSH credentials service** (recommended): reference `DEEPSEEK_API_KEY`, re-resolved per operation, so rotation needs no restart.
2. **Environment variable** `DEEPSEEK_API_KEY` (or a custom `api_key_env`).
3. **Config `api_key`**: controlled environments only; never written to state, logs, or tool output.

`balance_source: auto` uses the API key when one resolves, otherwise the signed-in account wallet, otherwise reports `NOT_CONFIGURED`. Many profiles bill through the `deepseek-account` provider and hold no API key at all — `auto` then lands on the wallet of the account that actually pays.

## Using it

**Sidebar panel** — balances (per currency, granted/topped-up split, freshness state, which official route produced it), today's calls/tokens/estimated cost, account spend derived from balance deltas, token usage with range switching (1h/24h/7d/30d/custom), hourly/daily buckets, per-model table, active alerts and thresholds. The panel polls a snapshot every 30 seconds and follows DSH theme tokens; UI text is Chinese/English.

**Agent tool `deepseek_usage`** — actions: `status`, `balance`, `usage` (`range`, `start`, `end`), `refresh` (`scope`: balance/usage/all), `alerts`, `set_thresholds`, `reset_thresholds`, `clear_history` (requires `confirm: true`). Results are always lossless JSON plus a one-line summary, produced by the same service methods the panel uses.

**Host routes** (registered on DSH's authenticated `/api` channel, so the browser cookie and Host/Origin checks apply before plugin code runs):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/deepseek-usage/snapshot?range=24h[&start&end]` | Panel snapshot |
| POST | `/api/deepseek-usage/refresh` | Body `{ "scope": "all" }` |

## Metric definitions

**Balance** is the account's total available balance — not cumulative spend, not top-ups, not a budget, not an estimate. Every value carries its fetch timestamp and age. The account route has no `is_available` flag, so that field shows `—` (unknown) rather than a fabricated `true`.

| Freshness | Condition | Shown as |
|---|---|---|
| live | latest refresh succeeded | `live` + timestamp + age |
| cached | a snapshot exists but the last refresh failed | `cached` + explicit warning |
| unknown | never fetched successfully | `unknown` + error code |

**Tokens** come from the provider's `usage` chunk (real counts, not character heuristics):

```text
billed input = inputTokens (uncached) + cacheReadTokens + cacheWriteTokens
total tokens = billed input + outputTokens
cache hit rate = cacheReadTokens / billed input
reasoningTokens ⊂ outputTokens   (never added twice)
```

Scope: only calls routed through `ctx.llm.stream()` in this process while the plugin is active. Other tools, other machines, and calls made before activation are invisible. Buckets are hourly up to 48 hours, daily above that, in the configured timezone.

**Cost**: the account-spend figure is a derivation from official balance deltas (account-wide, not attributable to a model, blind before the first snapshot in the window). The per-model figure is an **estimate** from the price table and observed tokens. The built-in table (USD per 1M tokens, [official pricing](https://api-docs.deepseek.com/quick_start/pricing), retrieved 2026-10-27):

| Model | Cache hit (peak/off-peak) | Cache miss (peak/off-peak) | Output (peak/off-peak) |
|---|---|---|---|
| `deepseek-flash` | 0.006 / 0.003 | 0.30 / 0.15 | 1.20 / 0.60 |
| `deepseek-v4-pro` | 0.044 / 0.022 | 1.32 / 0.66 | 3.96 / 1.98 |

Peak hours are 01:00–04:00 and 06:00–10:00 UTC on weekdays. **Chinese public holidays are not excluded** (no calendar is available), so a weekday holiday is priced at the peak rate — an overestimate. Legacy model ids map to the Flash price; unknown models are marked `unpriced` instead of guessed. Override with `price_table`.

## Alerts

`low_balance`, `daily_cost`, `daily_token`, `request_failures`, `stale_data` — each switchable, each with a threshold.

- A low-balance alert is raised **only from a successful official response**. Network errors, timeouts and 5xx become `request_failures`/`stale_data`, never "balance is low".
- While a condition holds, the alert is updated in place and re-notified at most once per `alert_cooldown`; clearing it marks it `resolved`; re-triggering restarts the count.
- Alerts persist in the state file, including their cooldown position.
- Delivery: `monitor.subscribe()` → Host log (`[deepseek-usage] ALERT …`) + panel alert area + `alerts` tool result. DSH has no generic plugin desktop-notification channel yet, so the unified interface plus logging is the default; another channel only needs to subscribe.

## Tests

```bash
npm test              # default isolation: one child process per test file (CI)
npm run test:sandbox  # single process, for sandboxes that forbid spawn pipes
```

114 tests, green on Node 20/22/24 in CI. Coverage spans the balance client (401/403, 429 + `Retry-After`, 5xx, timeout, malformed and oversized bodies, backoff growth), account wallet mapping, alert thresholds/cooldown/recovery, timezone and DST bucketing, peak pricing, token accounting, persistence (atomic writes, concurrency, retention, corruption quarantine), plugin wiring (tool/route/event registration, credential precedence, concurrent-refresh dedupe, lifecycle cleanup, lossless-JSON regression), client slot registration with a real Host snapshot, and security (log redaction, no key on disk, hostile payloads, bounded retries).

Each test file owns `test/.tmp/<name>-<pid>`; sharing one scratch root let parallel files delete each other's directories.

## Known limitations

- **DeepSeek publishes no usage, billing or per-model statistics API.** The public API reference lists Chat Completions, Responses, FIM, List Models, Get User Balance, Files, Search & Fetch only. The plugin therefore does not scrape the console, simulate a login, or invent numbers; usage comes from local observation and account spend from balance deltas.
- `GET /user/balance`: fields verified against the official documentation; success/failure/401/429 paths are covered by mocks. No API key was available in the development environment, so **no successful production call was made**.
- `ctx.deepseekAccount.getBalance()` and the `llm/stream` `usage` chunk were exercised against the real environment.
- The panel's pixel-level appearance was not individually verified; the client half loads, both slots register, and the component tree renders against a real Host snapshot without errors.
- No Cordis `Config` schema (see above), so there is no form-based settings page.
- Peak/off-peak pricing does not exclude Chinese public holidays.
- Single-process scope: separate DSH instances keep separate state; calls made while the plugin is disabled are not backfilled.
- Custom ranges are capped at 366 days and any aggregation at 400 buckets.

## License

[MIT](LICENSE) © 2026 MinaMiKune · Please file [issues](https://github.com/MinaMiKune/dsh-deepseek-usage-monitor/issues) for bugs or suggestions.
