/**
 * Locale-aware rendering helpers shared by every human-facing surface.
 *
 * @module dsh-usage-stats-long/core/format
 */

/**
 * Render a token count so it is readable at a glance without losing precision.
 *
 * Below 10,000 the exact number is shown; above it the count is compacted to
 * `116.98M`-style text. The compact form is presentation only — every reported
 * table also carries exact integers for the fields a reader must total.
 *
 * @param {number} value token count.
 * @returns {string} human-readable count.
 */
export function formatTokens(value) {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value)
  if (Math.abs(rounded) >= 1_000_000) return `${(rounded / 1_000_000).toFixed(2)}M`
  if (Math.abs(rounded) >= 10_000) return `${(rounded / 1000).toFixed(1)}K`
  return new Intl.NumberFormat('en-US').format(rounded)
}

/**
 * Add thousands separators to an exact integer.
 *
 * @param {number} value number to format.
 * @returns {string} grouped digits.
 */
export function formatExact(value) {
  if (!Number.isFinite(value)) return '0'
  return new Intl.NumberFormat('en-US').format(Math.round(value))
}

/**
 * Render a ratio as a percentage.
 *
 * @param {number | undefined} ratio value between 0 and 1.
 * @param {number} [digits] fraction digits.
 * @returns {string} like `93.4%`, or `-` when the ratio is undefined.
 */
export function formatPercent(ratio, digits = 1) {
  if (ratio === undefined || !Number.isFinite(ratio)) return '-'
  return `${(ratio * 100).toFixed(digits)}%`
}

/**
 * Render a USD amount.
 *
 * @param {number | undefined} value USD amount.
 * @returns {string} like `$12.3456`, or `-` when unknown.
 */
export function formatUsd(value) {
  if (value === undefined || !Number.isFinite(value)) return '-'
  if (value === 0) return '$0.0000'
  if (Math.abs(value) < 0.01) return `$${value.toFixed(6)}`
  return `$${value.toFixed(4)}`
}

/**
 * Render an instant as a compact local timestamp.
 *
 * @param {number} time epoch milliseconds.
 * @param {string} [timeZone] IANA zone; defaults to the process zone.
 * @returns {string} `YYYY-MM-DD HH:mm`.
 */
export function formatTime(time, timeZone) {
  if (!Number.isFinite(time) || time === 0) return '-'
  const parts = dateParts(time, timeZone)
  return `${parts.date} ${parts.time}`
}

/**
 * Render an instant as a local date.
 *
 * @param {number} time epoch milliseconds.
 * @param {string} [timeZone] IANA zone; defaults to the process zone.
 * @returns {string} `YYYY-MM-DD`.
 */
export function formatDate(time, timeZone) {
  if (!Number.isFinite(time) || time === 0) return '-'
  return dateParts(time, timeZone).date
}

/**
 * Render a coarse relative age, for a "last active" column.
 *
 * @param {number} time epoch milliseconds.
 * @param {number} [now] reference instant.
 * @returns {string} like `3h ago`.
 */
export function formatAge(time, now = Date.now()) {
  if (!Number.isFinite(time) || time === 0) return '-'
  const delta = Math.max(0, now - time)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 60) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

/**
 * Render a duration in milliseconds.
 *
 * @param {number} ms duration.
 * @returns {string} like `1.4s` or `12m 03s`.
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

/**
 * Split an instant into local date and time strings.
 *
 * @param {number} time epoch milliseconds.
 * @param {string} [timeZone] IANA zone.
 * @returns {{ date: string, time: string }} the parts.
 */
function dateParts(time, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(new Date(time))
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00'
  const hour = get('hour') === '24' ? '00' : get('hour')
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` }
}

/**
 * Render one row of a markdown table, escaping pipes in cell values.
 *
 * @param {readonly (string | number)[]} cells cell values.
 * @returns {string} a table row.
 */
export function markdownRow(cells) {
  return `| ${cells.map((cell) => String(cell).replaceAll('|', '\\|')).join(' | ')} |`
}

/**
 * Shorten an id-like string for a table while keeping it recognizable.
 *
 * @param {string} value full value.
 * @param {number} [keep] characters to keep from the start.
 * @returns {string} the shortened value.
 */
export function shortId(value, keep = 18) {
  if (value.length <= keep + 4) return value
  return `${value.slice(0, keep)}…`
}

/**
 * Truncate free text to a column budget.
 *
 * @param {string | undefined} value text to truncate.
 * @param {number} max maximum characters.
 * @returns {string} the truncated text.
 */
export function truncate(value, max) {
  if (value === undefined || value === null) return ''
  const text = String(value).replaceAll('\n', ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}
