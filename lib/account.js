/**
 * Balance from the Harness's own signed-in DeepSeek account.
 *
 * Why this exists: a Harness profile can route model calls through the
 * `deepseek-account` provider, which bills the signed-in DeepSeek account and
 * holds no API key at all. Without this source the balance card would stay
 * empty on exactly the deployment whose spending it should explain.
 *
 * The data is still official — `ctx.deepseekAccount.getBalance()` queries the
 * DeepSeek Platform wallet for the stored grant; nothing is scraped and no
 * password is involved. It is reported under a different source label than the
 * API-key endpoint because it is a different authorization path, and it needs
 * `AccountClientMetadata` (version, locale, timezone) supplied by the caller.
 *
 * Response contract (verified through Cordis inspection):
 *   { status: 'ready', value: AccountWallet[], bonusWallets: AccountWallet[] }
 *   | { status: 'failed' }
 * where AccountWallet = { currency: 'CNY' | 'USD', balance: string }.
 */

import { parseAmount } from './deepseek-api.js'

/** Error raised by the account balance source. */
export class AccountApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'AccountApiError'
    this.code = code
    this.retryable = false
    this.hint =
      code === 'ACCOUNT_SIGNED_OUT'
        ? 'Sign in to DeepSeek from Settings → Account, or configure an API key instead.'
        : code === 'ACCOUNT_FAILED'
          ? 'The DeepSeek Platform wallet query failed; it will be retried on the next poll.'
          : 'The signed-in account returned an unusable balance payload.'
    if (details.cause !== undefined) this.cause = details.cause
  }
}

/**
 * Build the client metadata the account service requires.
 * @param {{ version?: string, locale?: string, now?: Date }} [options]
 */
export function accountClientMetadata({ version = '1.0.0', locale = 'en', now = new Date() } = {}) {
  return {
    version,
    locale,
    // Positive seconds east of UTC, the inverse of Date#getTimezoneOffset.
    timezoneOffsetSeconds: -now.getTimezoneOffset() * 60,
  }
}

/**
 * Convert the wallet payload into the plugin's balance-info shape.
 *
 * `value` holds recharge wallets and `bonusWallets` holds granted credit, so a
 * currency's total is their sum, `toppedUp` is the recharge part, and `granted`
 * is the bonus part. The API-key endpoint reports the same three numbers; only
 * the encoding differs.
 *
 * @param {{ status: string, value?: ReadonlyArray<{ currency: string, balance: string }>, bonusWallets?: ReadonlyArray<{ currency: string, balance: string }> }} details
 */
export function mapAccountWallets(details) {
  if (!details || typeof details !== 'object') {
    throw new AccountApiError('INVALID_RESPONSE', 'the account balance payload is not an object')
  }
  if (details.status === 'failed') {
    throw new AccountApiError('ACCOUNT_FAILED', 'the DeepSeek Platform balance query failed')
  }
  if (details.status !== 'ready') {
    throw new AccountApiError('INVALID_RESPONSE', `unexpected account balance status "${String(details.status)}"`)
  }

  const warnings = []
  /** @type {Map<string, { currency: string, toppedUp: number, granted: number }>} */
  const byCurrency = new Map()

  const read = (wallets, kind) => {
    if (wallets === undefined) return
    if (!Array.isArray(wallets)) {
      warnings.push(`${kind} is not an array and was ignored`)
      return
    }
    for (const wallet of wallets) {
      if (!wallet || typeof wallet !== 'object') {
        warnings.push(`an entry in ${kind} is not an object`)
        continue
      }
      const currency = typeof wallet.currency === 'string' ? wallet.currency.trim().toUpperCase() : ''
      if (!/^[A-Z]{3}$/.test(currency)) {
        warnings.push(`an entry in ${kind} has an invalid currency`)
        continue
      }
      const amount = parseAmount(wallet.balance)
      if (amount === undefined) {
        warnings.push(`an entry in ${kind} for ${currency} has an unparsable amount`)
        continue
      }
      const entry = byCurrency.get(currency) ?? { currency, toppedUp: 0, granted: 0 }
      if (kind === 'bonusWallets') entry.granted += amount
      else entry.toppedUp += amount
      byCurrency.set(currency, entry)
    }
  }

  read(details.value, 'value')
  read(details.bonusWallets, 'bonusWallets')

  const infos = [...byCurrency.values()]
    .map((entry) => ({
      currency: entry.currency,
      // Summed exactly: rounding here would make `total` disagree with the
      // granted/topped-up parts the same payload reports.
      total: entry.toppedUp + entry.granted,
      granted: entry.granted,
      toppedUp: entry.toppedUp,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency))

  if (infos.length === 0) {
    throw new AccountApiError('INVALID_RESPONSE', 'the account balance payload contained no usable wallet')
  }
  return { infos, warnings }
}

/**
 * Query the signed-in account's wallet balance.
 * @param {{
 *   account: { getBalance: (client: any) => Promise<any>, getState?: () => Promise<any> },
 *   now?: () => number,
 *   metadata?: Record<string, unknown>,
 * }} options
 * @returns {Promise<{
 *   isAvailable: boolean | null, infos: Array<{currency: string, total: number, granted: number, toppedUp: number}>,
 *   fetchedAt: number, source: 'official-account', legacySource: string, warnings: string[],
 *   endpoint: string, attempts: number, durationMs: number, usageUrl?: string,
 * }>}
 */
export async function fetchAccountBalance({ account, now = () => Date.now(), metadata }) {
  const started = now()
  let details
  try {
    details = await account.getBalance(metadata ?? accountClientMetadata())
  } catch (cause) {
    throw new AccountApiError('ACCOUNT_FAILED', 'the DeepSeek Platform balance query threw', { cause })
  }
  if (details === null || details === undefined) {
    throw new AccountApiError('ACCOUNT_SIGNED_OUT', 'no DeepSeek account is signed in')
  }
  const { infos, warnings } = mapAccountWallets(details)

  /** @type {string | undefined} */
  let usageUrl
  if (typeof account.getState === 'function') {
    try {
      const state = await account.getState()
      if (state && state.links && typeof state.links.usageUrl === 'string') usageUrl = state.links.usageUrl
    } catch {
      /* the link is optional */
    }
  }

  const finished = now()
  return {
    // The account payload carries no "sufficient for API calls" flag; null means
    // unknown rather than a fabricated true.
    isAvailable: null,
    infos,
    fetchedAt: finished,
    source: 'official-account',
    legacySource: 'signed-in DeepSeek account',
    warnings,
    endpoint: 'ctx.deepseekAccount.getBalance()',
    attempts: 1,
    durationMs: finished - started,
    ...(usageUrl ? { usageUrl } : {}),
  }
}
