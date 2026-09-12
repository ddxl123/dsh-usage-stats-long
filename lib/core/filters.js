/**
 * Requirement validation and application for every selectable dimension.
 *
 * One compiler turns loose caller input (model tool arguments, CLI flags, HTTP
 * query strings) into an {@link AppliedFilters} record, and one application
 * step decides which sessions and which individual calls survive it. Keeping
 * both in one module is what makes "the filter I asked for" and "the filter
 * that ran" provably the same thing: the report echoes the compiled record.
 *
 * @module dsh-usage-stats-long/core/filters
 */

import { addInto, zeroTotals } from './token-math.js'

/**
 * @typedef {import('./types.js').AppliedFilters} AppliedFilters
 * @typedef {import('./types.js').SessionReport} SessionReport
 * @typedef {import('./types.js').UsageCall} UsageCall
 */

/** Every session-kind value a caller may select. */
export const SESSION_KINDS = /** @type {const} */ (['session', 'subagent'])

/**
 * An invalid filter value, reported instead of silently widened.
 */
export class FilterError extends Error {
  /**
   * @param {string} message what was wrong.
   * @param {string} field the offending filter field.
   */
  constructor(message, field) {
    super(message)
    this.name = 'FilterError'
    /** @type {string} */
    this.field = field
  }
}

/** @returns {AppliedFilters} an empty, fully-explicit filter record. */
export function emptyFilters() {
  return {
    sessionIds: [],
    excludeSessionIds: [],
    models: [],
    providers: [],
    projects: [],
    cwd: [],
    kinds: [],
    agentPresets: [],
  }
}

/**
 * Accept a comma-separated string or an array and normalize it to a string list.
 *
 * @param {unknown} value caller input.
 * @param {string} field field name used in errors.
 * @returns {string[]} trimmed, non-empty entries.
 */
export function toStringList(value, field) {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  /** @type {string[]} */
  const out = []
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new FilterError(`${field} entries must be strings`, field)
    }
    for (const part of entry.split(',')) {
      const trimmed = part.trim()
      if (trimmed.length > 0) out.push(trimmed)
    }
  }
  return [...new Set(out)]
}

/**
 * Parse one instant from a number, an ISO date, `YYYY-MM-DD`, or a relative span.
 *
 * Relative spans (`7d`, `24h`, `90m`, `2w`) are resolved against `now`, which
 * is what a caller means by "the last week" far more often than an absolute
 * timestamp. A bare `YYYY-MM-DD` means local midnight; `until` therefore needs
 * the end of its day, which {@link compileFilters} handles.
 *
 * @param {unknown} value caller input.
 * @param {string} field field name used in errors.
 * @param {number} now reference instant for relative spans.
 * @param {'since' | 'until'} role which bound this value is.
 * @returns {number | undefined} epoch milliseconds, or undefined when absent.
 */
export function parseInstant(value, field, now, role) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FilterError(`${field} must be a finite timestamp`, field)
    return Math.floor(value)
  }
  if (typeof value !== 'string') throw new FilterError(`${field} must be a string or number`, field)
  const text = value.trim()
  if (text.length === 0) return undefined
  const relative = /^(\d+)\s*(m|h|d|w|mo)$/i.exec(text)
  if (relative) {
    const amount = Number.parseInt(relative[1], 10)
    const unit = relative[2].toLowerCase()
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 2_592_000_000 }[unit]
    if (unitMs === undefined) throw new FilterError(`${field} has an unknown unit: ${text}`, field)
    return now - amount * unitMs
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])]
    const start = new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
    if (!Number.isFinite(start)) throw new FilterError(`${field} is not a valid date: ${text}`, field)
    // An `until` date is inclusive of the whole local day it names.
    return role === 'until' ? start + 86_400_000 - 1 : start
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) {
    throw new FilterError(`${field} is not a recognizable instant: ${text}`, field)
  }
  return parsed
}

/**
 * Compile loose caller input into an explicit, validated filter record.
 *
 * @param {any} input loose filter input.
 * @param {object} [options] compile options.
 * @param {number} [options.now] reference instant for relative spans.
 * @returns {{ filters: AppliedFilters, warnings: string[] }} the compiled record.
 * @throws {FilterError} when a value cannot be interpreted.
 */
export function compileFilters(input = {}, options = {}) {
  const now = options.now ?? Date.now()
  const source = input ?? {}
  /** @type {string[]} */
  const warnings = []
  /** @type {AppliedFilters} */
  const filters = {
    sessionIds: toStringList(source.sessionIds ?? source.sessionId, 'sessionIds'),
    excludeSessionIds: toStringList(source.excludeSessionIds, 'excludeSessionIds'),
    models: toStringList(source.models ?? source.model, 'models'),
    providers: toStringList(source.providers ?? source.provider, 'providers'),
    projects: toStringList(source.projects ?? source.project, 'projects'),
    cwd: toStringList(source.cwd, 'cwd'),
    kinds: toStringList(source.kinds ?? source.kind, 'kinds'),
    agentPresets: toStringList(source.agentPresets ?? source.agentPreset, 'agentPresets'),
  }
  for (const kind of filters.kinds) {
    if (!SESSION_KINDS.includes(/** @type {any} */ (kind))) {
      throw new FilterError(`kinds must be one of ${SESSION_KINDS.join(', ')}`, 'kinds')
    }
  }
  const since = parseInstant(source.since, 'since', now, 'since')
  const until = parseInstant(source.until, 'until', now, 'until')
  if (since !== undefined) filters.since = since
  if (until !== undefined) filters.until = until
  if (since !== undefined && until !== undefined && since > until) {
    throw new FilterError('since must not be later than until', 'since')
  }
  if (source.search !== undefined && source.search !== null && source.search !== '') {
    if (typeof source.search !== 'string') throw new FilterError('search must be a string', 'search')
    filters.search = source.search.trim()
  }
  if (source.minTokens !== undefined && source.minTokens !== null && source.minTokens !== '') {
    const minTokens = typeof source.minTokens === 'number' ? source.minTokens : Number(source.minTokens)
    if (!Number.isFinite(minTokens) || minTokens < 0) {
      throw new FilterError('minTokens must be a non-negative number', 'minTokens')
    }
    filters.minTokens = minTokens
  }
  if (filters.sessionIds.length > 0 && filters.excludeSessionIds.length > 0) {
    warnings.push('sessionIds and excludeSessionIds are both set; the allow-list is applied first')
  }
  return { filters, warnings }
}

/**
 * Does one call survive the time window?
 *
 * @param {UsageCall} call candidate call.
 * @param {AppliedFilters} filters compiled filters.
 * @returns {boolean} true when the call is inside the window.
 */
export function callInWindow(call, filters) {
  if (filters.since !== undefined && call.time < filters.since) return false
  if (filters.until !== undefined && call.time > filters.until) return false
  return true
}

/**
 * Match a `provider/model` pair against selector entries.
 *
 * A selector matches on the full `provider/model`, on the bare model id, or on
 * the bare provider name, so `deepseek-chat`, `deepseek-official/deepseek-chat`
 * and `deepseek-official` all select the routes a caller means.
 *
 * @param {string} provider call provider.
 * @param {string} model call model.
 * @param {readonly string[]} selectors compiled selectors.
 * @returns {boolean} true when at least one selector matches.
 */
export function matchesModelSelector(provider, model, selectors) {
  if (selectors.length === 0) return true
  for (const selector of selectors) {
    if (selector === provider) return true
    if (selector === model) return true
    if (selector === `${provider}/${model}`) return true
    if (selector.endsWith('/*') && selector.slice(0, -2) === provider) return true
  }
  return false
}

/**
 * Does one call survive the model/provider clauses?
 *
 * @param {UsageCall} call candidate call.
 * @param {AppliedFilters} filters compiled filters.
 * @returns {boolean} true when the call's route is selected.
 */
export function callMatchesRoute(call, filters) {
  if (filters.providers.length > 0 && !filters.providers.includes(call.provider)) return false
  return matchesModelSelector(call.provider, call.model, filters.models)
}

/**
 * Does one session survive the session-level clauses?
 *
 * @param {SessionReport} session candidate session.
 * @param {AppliedFilters} filters compiled filters.
 * @returns {boolean} true when the session is selected.
 */
export function sessionMatches(session, filters) {
  if (filters.sessionIds.length > 0 && !matchesSessionId(session.sessionId, filters.sessionIds)) return false
  if (filters.excludeSessionIds.includes(session.sessionId)) return false
  if (filters.kinds.length > 0 && !filters.kinds.includes(session.kind)) return false
  if (filters.projects.length > 0 && !filters.projects.includes(session.project ?? '')) return false
  if (filters.cwd.length > 0 && !filters.cwd.includes(session.cwd ?? '')) return false
  if (filters.agentPresets.length > 0 && !filters.agentPresets.includes(session.agentPreset ?? '')) return false
  if (filters.search !== undefined) {
    const haystack = [
      session.sessionId,
      session.title ?? '',
      session.cwd ?? '',
      session.project ?? '',
      session.agentPreset ?? '',
    ].join('\n').toLowerCase()
    if (!haystack.includes(filters.search.toLowerCase())) return false
  }
  return true
}

/**
 * Match a session id against explicit selectors that may be prefixes.
 *
 * A person reads a session id off a report as the part that distinguishes it,
 * so `--session 45ee17c8` must select `session-45ee17c8-eb03-43c9-…`. The
 * `session-` prefix is optional on both sides. Prefer {@link resolveSessionSelectors}
 * when ambiguity must be reported rather than silently widened.
 *
 * @param {string} sessionId the session's own id.
 * @param {readonly string[]} selectors caller selectors.
 * @returns {boolean} true when a selector identifies this session.
 */
export function matchesSessionId(sessionId, selectors) {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  for (const selector of selectors) {
    if (selector === sessionId) return true
    const needle = selector.startsWith('session-') ? selector.slice('session-'.length) : selector
    if (needle.length === 0) continue
    if (bare.startsWith(needle)) return true
  }
  return false
}

/**
 * Detect a selector that identifies more than one session.
 *
 * A prefix that matches several sessions is an ambiguous question, not a broad
 * one: answering it by summing unrelated sessions would be a plausible-looking
 * wrong number, so the caller reports it instead.
 *
 * @param {readonly SessionReport[]} sessions every known session.
 * @param {readonly string[]} selectors caller selectors.
 * @returns {Array<{ selector: string, matches: string[] }>} the ambiguous selectors.
 */
export function resolveSessionSelectors(sessions, selectors) {
  /** @type {Array<{ selector: string, matches: string[] }>} */
  const ambiguous = []
  for (const selector of selectors) {
    if (sessions.some((session) => session.sessionId === selector)) continue
    const matches = sessions.filter((session) => matchesSessionId(session.sessionId, [selector])).map((session) => session.sessionId)
    if (matches.length > 1) ambiguous.push({ selector, matches })
  }
  return ambiguous
}

/**
 * Apply every filter to one session, returning it with only matching calls.
 *
 * A session is dropped when it has no call left after filtering, because a
 * statistics report is about spend: a selected-by-metadata session that spent
 * nothing in the window would contribute a zero row and nothing else. Session
 * *discovery* is a separate concern, served by the session catalog.
 *
 * @param {SessionReport} session candidate session.
 * @param {AppliedFilters} filters compiled filters.
 * @returns {SessionReport | undefined} a filtered copy, or undefined when excluded.
 */
export function applyFilters(session, filters) {
  if (!sessionMatches(session, filters)) return undefined
  const calls = session.callDetails.filter(
    (call) => callInWindow(call, filters) && callMatchesRoute(call, filters),
  )
  if (calls.length === 0) return undefined
  if (calls.length === session.callDetails.length && !sessionHasWindowSensitiveFields(session, filters)) {
    return session
  }
  return withCalls(session, calls)
}

/**
 * Would dropping any call change a session-level derived field?
 *
 * @param {SessionReport} session candidate session.
 * @param {AppliedFilters} filters compiled filters.
 * @returns {boolean} true when the session must be recomputed from its calls.
 */
function sessionHasWindowSensitiveFields(session, filters) {
  return filters.since !== undefined || filters.until !== undefined
    || filters.models.length > 0 || filters.providers.length > 0
}

/**
 * Rebuild every derived field of a session from a restricted call list.
 *
 * @param {SessionReport} session source session.
 * @param {UsageCall[]} calls the surviving calls.
 * @returns {SessionReport} a new session record carrying only those calls.
 */
export function withCalls(session, calls) {
  const tokens = zeroTotals()
  let peakPromptTokens = 0
  /** @type {Map<number, { turn: number, step: number, calls: number, tokens: import('./types.js').TokenTotals }>} */
  const turns = new Map()
  for (const call of calls) {
    addInto(tokens, call.tokens)
    if (call.promptTokens > peakPromptTokens) peakPromptTokens = call.promptTokens
    const bucket = turns.get(call.turn)
    if (bucket === undefined) {
      turns.set(call.turn, { turn: call.turn, step: call.step, calls: 1, tokens: { ...call.tokens } })
    } else {
      bucket.calls += 1
      bucket.step = call.step
      addInto(bucket.tokens, call.tokens)
    }
  }
  return {
    ...session,
    calls: calls.length,
    tokens,
    peakPromptTokens,
    turnRollup: [...turns.values()].sort((a, b) => a.turn - b.turn),
    callDetails: calls,
  }
}

/**
 * Does one session survive the post-aggregation `minTokens` clause?
 *
 * Applied after route and window filtering so the threshold means "spend that
 * actually counted", not a raw lifetime total.
 *
 * @param {SessionReport} session filtered session.
 * @param {AppliedFilters} filters compiled filters.
 * @returns {boolean} true when the session meets the threshold.
 */
export function meetsMinTokens(session, filters) {
  if (filters.minTokens === undefined) return true
  return session.tokens.totalTokens >= filters.minTokens
}
