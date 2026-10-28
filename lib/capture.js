/**
 * `llm/stream` capture.
 *
 * The waterfall wraps every provider attempt, so the numbers recorded here are
 * the token counts the provider itself reported in the terminal `usage` chunk —
 * never an estimate from character counts. The wrapper only reads
 * `provider`, `model`, `purpose`, the streamed chunks, and their timing: it
 * never reads, stores, or logs messages, prompts, tool arguments, or response
 * text.
 *
 * A waterfall listener must return an iterable synchronously and must not break
 * the call when it fails, so the wrapper is built to pass chunks through
 * unchanged and to contain its own errors.
 */

/**
 * @param {{
 *   monitor: { recordCall: (record: Record<string, unknown>) => unknown },
 *   logger?: { debug?: Function, warn?: Function },
 *   now?: () => number,
 * }} options
 */
export function createLlmCapture({ monitor, logger, now = Date.now }) {
  return {
    /**
     * @param {{ provider?: unknown, model?: unknown, purpose?: unknown }} options
     * @param {() => AsyncIterable<any>} next
     * @returns {AsyncIterable<any>}
     */
    wrap(options, next) {
      /** @type {Record<string, unknown>} */
      const meta = {
        provider: typeof options?.provider === 'string' && options.provider !== '' ? options.provider : 'unknown',
        model: typeof options?.model === 'string' && options.model !== '' ? options.model : 'unknown',
        ...(typeof options?.purpose === 'string' ? { purpose: options.purpose } : {}),
      }
      const startedAt = now()
      const iterable = next()

      async function* passthrough() {
        /** @type {Record<string, number> | null} */
        let usage = null
        let status = 'ok'
        /** @type {string | undefined} */
        let failureCode
        try {
          for await (const chunk of iterable) {
            if (chunk && typeof chunk === 'object') {
              if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
                usage = {
                  inputTokens: numberOrZero(chunk.usage.inputTokens),
                  outputTokens: numberOrZero(chunk.usage.outputTokens),
                  cacheReadTokens: numberOrZero(chunk.usage.cacheReadTokens),
                  cacheWriteTokens: numberOrZero(chunk.usage.cacheWriteTokens),
                  reasoningTokens: numberOrZero(chunk.usage.reasoningTokens),
                }
              } else if (chunk.type === 'finish') {
                const reason = chunk.reason
                if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
                  status = 'error'
                  failureCode = typeof reason.failure?.code === 'string' ? reason.failure.code : reason.kind === 'aborted' ? 'ABORTED' : 'ERROR'
                }
              }
            }
            yield chunk
          }
        } catch (error) {
          status = 'error'
          failureCode = typeof (/** @type {any} */ (error)?.code) === 'string' ? /** @type {any} */ (error).code : 'STREAM_ERROR'
          throw error
        } finally {
          try {
            monitor.recordCall({
              at: startedAt,
              ...meta,
              status,
              ...(failureCode ? { failureCode } : {}),
              durationMs: Math.max(0, now() - startedAt),
              ...(usage ?? {}),
            })
          } catch (error) {
            logger?.warn?.('failed to record an observed model call', error instanceof Error ? error.message : String(error))
          }
        }
      }

      return passthrough()
    },
  }
}

/** @param {unknown} value */
function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}
