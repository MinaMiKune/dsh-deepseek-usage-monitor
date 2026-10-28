/**
 * Timezone-aware range and bucket helpers.
 *
 * Every aggregation boundary is computed in the configured IANA timezone, not
 * in the host's local time, so a "day" in the panel is a calendar day in that
 * zone. No external date library is used: `Intl.DateTimeFormat` supplies the
 * wall-clock parts and the offset is derived from them.
 */

/** Maximum number of buckets any aggregation may produce. */
export const MAX_BUCKETS = 400

/**
 * Validate an IANA timezone name.
 * @param {unknown} zone
 * @returns {string | undefined} the zone when valid.
 */
export function validateTimeZone(zone) {
  if (typeof zone !== 'string' || zone.trim() === '') return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date())
    return zone
  } catch {
    return undefined
  }
}

/**
 * The host process timezone, with a UTC fallback.
 * @returns {string}
 */
export function systemTimeZone() {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    return validateTimeZone(zone) ?? 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Wall-clock parts of one instant in a timezone.
 * @param {Date} date
 * @param {string} zone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function zonedParts(date, zone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  /** @type {Record<string, string>} */
  const parts = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

/**
 * Offset of a timezone at an instant, in milliseconds east of UTC.
 * @param {Date} date
 * @param {string} zone
 * @returns {number}
 */
function offsetAt(date, zone) {
  const parts = zonedParts(date, zone)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  // Intl truncates to whole seconds; compare at second resolution.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * The instant at which a calendar date starts in a timezone.
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {string} zone
 * @returns {Date}
 */
function zonedStartOfCalendarDate(year, month, day, zone) {
  const utcMidnight = Date.UTC(year, month - 1, day)
  let guess = utcMidnight - offsetAt(new Date(utcMidnight), zone)
  const refined = utcMidnight - offsetAt(new Date(guess), zone)
  if (refined !== guess) guess = refined
  return new Date(guess)
}

/**
 * Start of the wall-clock hour containing an instant.
 * @param {Date} date
 * @param {string} zone
 * @returns {Date}
 */
export function zonedStartOfHour(date, zone) {
  const parts = zonedParts(date, zone)
  const dayStart = zonedStartOfCalendarDate(parts.year, parts.month, parts.day, zone)
  return new Date(dayStart.getTime() + parts.hour * 3600_000)
}

/**
 * Start of the calendar day containing an instant.
 * @param {Date} date
 * @param {string} zone
 * @returns {Date}
 */
export function zonedStartOfDay(date, zone) {
  const parts = zonedParts(date, zone)
  return zonedStartOfCalendarDate(parts.year, parts.month, parts.day, zone)
}

/**
 * The next calendar day's start after a day start.
 * @param {Date} dayStart
 * @param {string} zone
 * @returns {Date}
 */
export function nextDayStart(dayStart, zone) {
  const parts = zonedParts(dayStart, zone)
  const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return zonedStartOfCalendarDate(
    calendar.getUTCFullYear(),
    calendar.getUTCMonth() + 1,
    calendar.getUTCDate(),
    zone,
  )
}

/**
 * The next wall-clock hour's start after an hour start.
 * @param {Date} hourStart
 * @param {string} zone
 * @returns {Date}
 */
export function nextHourStart(hourStart, zone) {
  const parts = zonedParts(hourStart, zone)
  const calendar = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour + 1, 0, 0),
  )
  const dayStart = zonedStartOfCalendarDate(
    calendar.getUTCFullYear(),
    calendar.getUTCMonth() + 1,
    calendar.getUTCDate(),
    zone,
  )
  return new Date(dayStart.getTime() + calendar.getUTCHours() * 3600_000)
}

/**
 * `YYYY-MM-DD` of an instant in a timezone.
 * @param {Date} date
 * @param {string} zone
 * @returns {string}
 */
export function dayKey(date, zone) {
  const parts = zonedParts(date, zone)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(
    parts.day,
  ).padStart(2, '0')}`
}

/** Recognised relative ranges, in milliseconds. */
export const RELATIVE_RANGES = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
}

/** @typedef {'1h'|'24h'|'7d'|'30d'|'custom'} RangeName */

/**
 * Resolve a requested range into concrete instants and a bucket granularity.
 *
 * Hourly buckets are used for windows up to 48 hours, daily buckets above that,
 * because the local call log is the only minute-precision source and reading a
 * 30-day window hour by hour would be unreadable. The granularity is reported
 * back so the UI can label it instead of implying finer resolution.
 *
 * @param {{ range?: string, start?: string|number|Date, end?: string|number|Date, now?: Date, zone: string }} input
 * @returns {{ range: RangeName, from: Date, to: Date, bucket: 'hour'|'day', timeZone: string }}
 */
export function resolveRange({ range = '24h', start, end, now = new Date(), zone }) {
  if (range === 'custom') {
    const from = parseInstant(start)
    const to = parseInstant(end)
    if (!from || !to) throw new RangeError('custom range requires a valid start and end')
    if (to.getTime() <= from.getTime()) throw new RangeError('custom range end must be after start')
    const span = to.getTime() - from.getTime()
    if (span > 366 * 24 * 3600_000) throw new RangeError('custom range may not exceed 366 days')
    return {
      range,
      from,
      to,
      bucket: span <= 48 * 3600_000 ? 'hour' : 'day',
      timeZone: zone,
    }
  }
  const span = RELATIVE_RANGES[range]
  if (span === undefined) throw new RangeError(`unsupported range "${String(range)}"`)
  return {
    range: /** @type {RangeName} */ (range),
    from: new Date(now.getTime() - span),
    to: now,
    bucket: span <= 48 * 3600_000 ? 'hour' : 'day',
    timeZone: zone,
  }
}

/**
 * @param {unknown} value
 * @returns {Date | undefined}
 */
export function parseInstant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed
  }
  return undefined
}

/**
 * Build empty buckets covering a resolved range.
 * @param {{ from: Date, to: Date, bucket: 'hour'|'day' }} range
 * @param {string} zone
 * @returns {{ start: number, end: number, key: string }[]}
 */
export function buildBuckets(range, zone) {
  const buckets = []
  let cursor =
    range.bucket === 'hour'
      ? zonedStartOfHour(range.from, zone)
      : zonedStartOfDay(range.from, zone)
  while (cursor.getTime() < range.to.getTime() && buckets.length < MAX_BUCKETS) {
    const next =
      range.bucket === 'hour' ? nextHourStart(cursor, zone) : nextDayStart(cursor, zone)
    buckets.push({ start: cursor.getTime(), end: next.getTime(), key: bucketKey(cursor, zone, range.bucket) })
    cursor = next
  }
  return buckets
}

/**
 * Stable bucket key/label.
 * @param {Date} start
 * @param {string} zone
 * @param {'hour'|'day'} granularity
 * @returns {string}
 */
export function bucketKey(start, zone, granularity) {
  const parts = zonedParts(start, zone)
  const y = String(parts.year).padStart(4, '0')
  const m = String(parts.month).padStart(2, '0')
  const d = String(parts.day).padStart(2, '0')
  if (granularity === 'day') return `${y}-${m}-${d}`
  return `${y}-${m}-${d} ${String(parts.hour).padStart(2, '0')}:00`
}

/**
 * Whether an instant falls in the DeepSeek peak-price window.
 *
 * Published rule: peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through
 * Friday, excluding Chinese public holidays. The holiday calendar is not
 * available programmatically, so holidays are NOT excluded here — an estimate
 * covering a weekday holiday is priced at the peak rate. This function is
 * exported so the limitation is testable and documented rather than hidden.
 * @param {Date} date
 * @returns {boolean}
 */
export function isPeakPricing(date) {
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}
