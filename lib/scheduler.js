/**
 * Independent pollers for the balance and usage schedulers.
 *
 * Contract enforced here:
 * - `start()` is idempotent: a second call never creates a second timer.
 * - A run that is still in flight is never started again; a manual refresh
 *   while running returns the in-flight promise instead of firing a duplicate
 *   request.
 * - `stop()` clears the timer, aborts the in-flight request, and resolves only
 *   after it settles, so plugin unload leaves no timer or request behind.
 * - After a failure the next attempt is delayed with capped exponential growth
 *   (1x, 2x, 4x, 8x the configured interval) so a persistent failure cannot
 *   turn into a tight retry loop.
 * - `pause()` keeps the state but stops scheduling; `resume()` reschedules.
 */

/**
 * @typedef {object} PollerOptions
 * @property {string} name
 * @property {number} intervalMs
 * @property {(context: { signal: AbortSignal, reason: string, at: number }) => Promise<unknown>} run
 * @property {{ debug?: Function, warn?: Function, error?: Function }} [logger]
 * @property {{ now?: () => number, setTimeout?: Function, clearTimeout?: Function }} [clock]
 * @property {number} [maxBackoffMultiplier]
 */

export class Poller {
  /** @param {PollerOptions} options */
  constructor(options) {
    this.name = options.name
    this.intervalMs = Math.max(1_000, Math.trunc(options.intervalMs))
    this.run = options.run
    this.logger = options.logger
    this.clock = options.clock ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    }
    this.maxBackoffMultiplier = options.maxBackoffMultiplier ?? 8

    this.enabled = false
    this.paused = false
    this.inFlight = false
    this.failures = 0
    /** @type {any} */
    this.timer = null
    this.nextRunAt = null
    this.lastAttemptAt = null
    this.lastSuccessAt = null
    /** @type {{ code: string, message: string, at: number } | null} */
    this.lastError = null
    /** @type {{ controller: AbortController, promise: Promise<unknown> } | null} */
    this.active = null
    this.completedRuns = 0
    this.failedRuns = 0
  }

  /** Activate the poller and run once immediately. */
  start() {
    if (this.enabled) return
    this.enabled = true
    this.paused = false
    this.trigger('start')
  }

  /** Stop scheduling and cancel any in-flight run. */
  async stop() {
    this.enabled = false
    this.paused = false
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
    this.nextRunAt = null
    const active = this.active
    if (active) {
      active.controller.abort()
      try {
        await active.promise
      } catch {
        /* the run reports its own failure */
      }
    }
  }

  /** Stop scheduling further runs without cancelling the current one. */
  pause() {
    if (!this.enabled || this.paused) return false
    this.paused = true
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
    this.nextRunAt = null
    return true
  }

  /** Reschedule after a pause. */
  resume() {
    if (!this.enabled || !this.paused) return false
    this.paused = false
    this.trigger('resume')
    return true
  }

  /**
   * Run immediately, or return the in-flight run when one is active.
   * @param {string} reason
   * @returns {Promise<unknown> | null}
   */
  trigger(reason) {
    if (!this.enabled || this.paused) return null
    if (this.active) {
      this.logger?.debug?.(`${this.name}: ${reason} ignored, a run is already in flight`)
      return this.active.promise
    }
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
    return this.execute(reason)
  }

  /**
   * @param {string} reason
   * @returns {Promise<unknown>}
   */
  execute(reason) {
    const controller = new AbortController()
    const at = this.clock.now()
    this.inFlight = true
    this.lastAttemptAt = at
    this.nextRunAt = null
    const promise = (async () => {
      try {
        const result = await this.run({ signal: controller.signal, reason, at })
        this.failures = 0
        this.completedRuns += 1
        this.lastSuccessAt = this.clock.now()
        this.lastError = null
        return result
      } catch (error) {
        this.failures += 1
        this.failedRuns += 1
        const classified = error instanceof Error ? error : new Error(String(error))
        this.lastError = {
          code: /** @type {any} */ (error)?.code ?? 'ERROR',
          message: classified.message,
          at: this.clock.now(),
        }
        this.logger?.warn?.(`${this.name}: refresh failed (${this.lastError.code}): ${classified.message}`)
        throw error
      } finally {
        this.inFlight = false
        this.active = null
        if (this.enabled && !this.paused) this.scheduleNext()
      }
    })()
    this.active = { controller, promise }
    // The stored promise is observed by stop(); avoid an unhandled rejection
    // when nobody else awaits a scheduled run.
    promise.catch(() => undefined)
    return promise
  }

  /** Schedule the next run according to the current failure count. */
  scheduleNext() {
    if (!this.enabled || this.paused) return
    const multiplier = this.failures === 0 ? 1 : Math.min(2 ** this.failures, this.maxBackoffMultiplier)
    const delay = this.intervalMs * multiplier
    this.nextRunAt = this.clock.now() + delay
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      if (!this.enabled || this.paused) return
      this.execute('interval')
    }, delay)
    this.timer?.unref?.()
  }

  /** Observable scheduler state for the status tool and the panel. */
  status() {
    return {
      name: this.name,
      intervalMs: this.intervalMs,
      intervalSeconds: Math.round(this.intervalMs / 1000),
      enabled: this.enabled,
      paused: this.paused,
      inFlight: this.inFlight,
      nextRunAt: this.nextRunAt,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      consecutiveFailures: this.failures,
      completedRuns: this.completedRuns,
      failedRuns: this.failedRuns,
    }
  }
}
