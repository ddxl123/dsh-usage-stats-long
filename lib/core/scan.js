/**
 * The scan orchestrator: filesystem corpus in, one complete report out.
 *
 * This is the only module that touches both the logs and the aggregation, so it
 * owns the decision of what a report contains: which logs were inspected, which
 * were skipped and why, which filters were applied, and how much call detail
 * the caller asked for.
 *
 * @module dsh-usage-stats-long/core/scan
 */

import { foldSessionLog } from './fold.js'
import { projectNameOf, discoverSessionLogs, resolveSessionsRoot } from './reader.js'
import { applyFilters, compileFilters, emptyFilters, meetsMinTokens, sessionMatches } from './filters.js'
import { GRANULARITIES, buildSeries, chooseGranularity, rollupModels, rollupProjects, summarize } from './aggregate.js'
import { normalizePriceBook } from './pricing.js'

/**
 * @typedef {import('./types.js').UsageReport} UsageReport
 * @typedef {import('./types.js').SessionReport} SessionReport
 * @typedef {import('./types.js').UsageCall} UsageCall
 * @typedef {import('./types.js').PriceBook} PriceBook
 */

/** How much per-call detail a report should carry. */
export const DETAIL_LEVELS = /** @type {const} */ (['full', 'turns', 'none'])

/**
 * Fold many logs with bounded concurrency.
 *
 * Reading is CPU- and IO-bound but mostly independent; a small fixed pool keeps
 * a large corpus from opening hundreds of files at once while still using more
 * than one core.
 *
 * @param {import('./reader.js').SessionLogFile[]} logs logs to fold.
 * @param {object} [options] fold options.
 * @param {number} [options.concurrency] maximum logs folded at once.
 * @param {(done: number, total: number, session: SessionReport) => void} [options.onSession] progress callback.
 * @returns {Promise<SessionReport[]>} folded sessions, in discovery order.
 */
export async function foldLogs(logs, options = {}) {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, logs.length || 1))
  const signal = options.signal
  /** @type {SessionReport[]} */
  const results = new Array(logs.length)
  let cursor = 0
  let done = 0
  /**
   * One worker: claim the next index, fold it, record it.
   * @returns {Promise<void>} resolves when the queue is drained.
   */
  async function worker() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= logs.length) return
      const log = logs[index]
      let report
      try {
        report = await foldSessionLog(log, { signal })
      } catch (error) {
        report = failedSession(log, error)
      }
      // Yield between logs so a long scan never blocks the event loop for the
      // whole corpus: this code runs inside a live harness, next to an agent.
      await Promise.resolve()
      results[index] = report
      done += 1
      options.onSession?.(done, logs.length, report)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

/**
 * Represent a log that could not be folded without losing the session identity.
 *
 * @param {import('./reader.js').SessionLogFile} log the failing log.
 * @param {unknown} error the thrown value.
 * @returns {SessionReport} an empty session carrying the failure as a warning.
 */
function failedSession(log, error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    sessionId: log.sessionId,
    cwd: log.cwd.length > 0 ? log.cwd : null,
    project: projectNameOf(log.cwd.length > 0 ? log.cwd : null),
    createdAt: log.mtimeMs,
    kind: 'session',
    isSubagent: false,
    seeded: false,
    delegationDepth: 0,
    logVersion: log.logVersion,
    source: log.file,
    bytes: log.bytes,
    inheritedEventCount: 0,
    turns: 0,
    steps: 0,
    calls: 0,
    peakPromptTokens: 0,
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      totalDerived: false,
    },
    turnRollup: [],
    callDetails: [],
    warnings: [`cannot fold ${log.file}: ${message}`],
  }
}

/**
 * Build one complete usage report from the session corpus.
 *
 * @param {object} [options] scan options.
 * @param {string} [options.sessionsRoot] sessions root override.
 * @param {any} [options.filters] loose filter input.
 * @param {PriceBook | any} [options.prices] validated price book, or loose input to normalize.
 * @param {'full' | 'turns' | 'none'} [options.detail] per-call detail to retain.
 * @param {'auto' | 'hour' | 'day' | 'week' | 'month'} [options.granularity] series granularity.
 * @param {number} [options.concurrency] logs folded concurrently.
 * @param {number} [options.maxSessions] keep only the N heaviest matching sessions.
 * @param {number} [options.maxCalls] keep only the N heaviest calls in `report.calls`.
 * @param {number} [options.now] reference instant for relative filters.
 * @param {AbortSignal} [options.signal] cooperative cancellation.
 * @param {SessionReport[]} [options.prefetchedSessions] already-folded sessions, when a caller supplies its own cache.
 * @param {ReturnType<typeof discoverSessionLogs>} [options.prefetchedDiscovery] an already-performed discovery pass.
 * @param {(progress: { phase: string, done: number, total: number }) => void} [options.onProgress] progress sink.
 * @returns {Promise<UsageReport>} the report.
 */
export async function buildReport(options = {}) {
  const startedAt = Date.now()
  const granularity = options.granularity ?? 'auto'
  if (!GRANULARITIES.includes(granularity) && granularity !== 'auto') {
    throw new Error(`granularity must be auto, ${GRANULARITIES.join(', ')}`)
  }
  const detail = options.detail ?? 'full'
  if (!DETAIL_LEVELS.includes(detail)) throw new Error(`detail must be ${DETAIL_LEVELS.join(', ')}`)

  const { filters, warnings: filterWarnings } = compileFilters(options.filters ?? {}, { now: options.now })
  const priceBook = options.prices === undefined ? {} : normalizePriceBook(options.prices)

  const root = resolveSessionsRoot(options.sessionsRoot)
  const discovery = options.prefetchedDiscovery ?? discoverSessionLogs({ sessionsRoot: options.sessionsRoot })
  /** @type {string[]} */
  const warnings = [...filterWarnings, ...discovery.warnings]
  options.onProgress?.({ phase: 'discover', done: discovery.files.length, total: discovery.files.length })

  const folded = options.prefetchedSessions ?? await foldLogs(discovery.files, {
    concurrency: options.concurrency,
    signal: options.signal,
    onSession: (done, total) => options.onProgress?.({ phase: 'read', done, total }),
  })
  for (const session of folded) {
    for (const warning of session.warnings) warnings.push(warning)
  }

  /** @type {SessionReport[]} */
  let sessions = []
  for (const session of folded) {
    const filtered = applyFilters(session, filters)
    if (filtered === undefined) continue
    if (!meetsMinTokens(filtered, filters)) continue
    sessions.push(filtered)
  }
  sessions.sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens)
  const matchingSessions = sessions.length
  if (options.maxSessions !== undefined && sessions.length > options.maxSessions) {
    sessions = sessions.slice(0, options.maxSessions)
  }

  options.onProgress?.({ phase: 'aggregate', done: 0, total: sessions.length })
  /** @type {UsageCall[]} */
  const allCalls = []
  for (const session of sessions) {
    for (const call of session.callDetails) allCalls.push(call)
  }
  allCalls.sort((a, b) => a.time - b.time || a.seq - b.seq)

  const { summary, totals } = summarize(sessions, allCalls, priceBook)
  const models = rollupModels(sessions, priceBook)
  const projects = rollupProjects(sessions, priceBook)
  const spanMs = summary.lastCallAt > summary.firstCallAt ? summary.lastCallAt - summary.firstCallAt : 0
  const usedGranularity = chooseGranularity(allCalls, spanMs, granularity)
  const series = buildSeries(allCalls, usedGranularity)

  let calls = allCalls
  if (options.maxCalls !== undefined && calls.length > options.maxCalls) {
    calls = [...allCalls].sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens).slice(0, options.maxCalls)
    calls.sort((a, b) => a.time - b.time || a.seq - b.seq)
    warnings.push(`call list truncated to the ${options.maxCalls} heaviest calls`)
  }

  if (detail !== 'full') {
    sessions = sessions.map((session) => ({ ...session, callDetails: [] }))
    if (detail === 'none') {
      sessions = sessions.map((session) => ({ ...session, turnRollup: [] }))
    }
  }

  return {
    meta: {
      generatedAt: Date.now(),
      sessionsRoot: root,
      logsScanned: discovery.files.length,
      logsRead: discovery.files.length,
      logsSkipped: 0,
      bytesRead: discovery.files.reduce((sum, file) => sum + file.bytes, 0),
      elapsedMs: Date.now() - startedAt,
      matchingSessions,
    },
    filters,
    sessions,
    calls,
    totals,
    summary,
    models,
    projects,
    series,
    granularity: usedGranularity,
    warnings,
  }
}

/**
 * List every session in the corpus, including ones that spent nothing.
 *
 * This is the discovery surface: it answers "which sessions exist and what can
 * I filter by", which a statistics report deliberately does not (a report only
 * contains sessions that actually spent tokens in scope).
 *
 * @param {object} [options] catalog options.
 * @param {string} [options.sessionsRoot] sessions root override.
 * @param {any} [options.filters] loose filter input applied to session metadata.
 * @param {number} [options.concurrency] logs folded concurrently.
 * @param {AbortSignal} [options.signal] cooperative cancellation.
 * @param {number} [options.now] reference instant for relative filters.
 * @returns {Promise<{ root: string, sessions: SessionReport[], warnings: string[] }>} the catalog.
 */
export async function listSessions(options = {}) {
  const { filters, warnings: filterWarnings } = compileFilters(options.filters ?? {}, { now: options.now })
  const discovery = discoverSessionLogs({ sessionsRoot: options.sessionsRoot })
  const folded = await foldLogs(discovery.files, { concurrency: options.concurrency, signal: options.signal })
  /** @type {SessionReport[]} */
  const sessions = []
  for (const session of folded) {
    // The catalog reuses the session-level clauses but ignores spend thresholds,
    // so a session with zero usage is still visible and selectable.
    const metadataFilters = { ...filters, minTokens: undefined }
    if (!sessionMatches(session, metadataFilters)) continue
    const filtered = applyFilters(session, metadataFilters)
    sessions.push(filtered ?? session)
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt || a.sessionId.localeCompare(b.sessionId))
  const warnings = [...filterWarnings, ...discovery.warnings]
  for (const session of folded) {
    for (const warning of session.warnings) warnings.push(warning)
  }
  return { root: discovery.root, sessions, warnings }
}

/** Re-exported so a caller can build an empty filter record without importing two modules. */
export { emptyFilters }
