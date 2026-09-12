/**
 * The `usageStats` service: a cached, cancellable front door to the engine.
 *
 * Folding a session log is the expensive part of a report, and a session log
 * only changes when a turn is appended. This service therefore caches **per
 * session log**, keyed by path, byte size and modification time, and rebuilds
 * reports from cached folds. A repeated question about an unchanged corpus
 * costs no disk IO, and a live session invalidates exactly its own entry.
 *
 * @module dsh-usage-stats-long/host/service
 */

import { Service } from '@deepseek-ai/cordis'
import {
  buildReport,
  discoverSessionLogs,
  emptyPriceBook,
  foldLogs,
  listSessions,
  loadPriceBookFile,
  normalizePriceBook,
  resolveSessionsRoot,
  sessionMatches,
} from '../core/index.js'

/**
 * @typedef {import('../core/types.js').UsageReport} UsageReport
 * @typedef {import('../core/types.js').SessionReport} SessionReport
 * @typedef {import('../core/types.js').PriceBook} PriceBook
 */

/** Default number of folded sessions retained between queries. */
export const DEFAULT_CACHE_SIZE = 256

/**
 * One cached fold plus the file identity that produced it.
 * @typedef {object} CacheEntry
 * @property {number} size compressed size at fold time.
 * @property {number} mtimeMs modification time at fold time.
 * @property {SessionReport} report the folded session.
 */

/**
 * Usage statistics over the local DSH session corpus.
 *
 * @example
 * const report = await ctx.usageStats.report({ filters: { models: ['deepseek-flash'] } })
 */
export class UsageStatsService extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx owning context.
   * @param {object} [config] resolved plugin configuration.
   * @param {string} [config.sessionsRoot] sessions root override.
   * @param {string} [config.priceBookPath] JSON price book to load and watch.
   * @param {number} [config.cacheSize] folded sessions retained between queries.
   */
  constructor(ctx, config = {}) {
    super(ctx, 'usageStats')
    /** @type {string} */
    this.sessionsRoot = resolveSessionsRoot(config.sessionsRoot)
    /** @type {number} */
    this.cacheSize = Math.max(0, config.cacheSize ?? DEFAULT_CACHE_SIZE)
    /** @type {Map<string, CacheEntry>} */
    this.cache = new Map()
    /** @type {PriceBook} */
    this.priceBook = emptyPriceBook()
    /** @type {string | undefined} */
    this.priceBookPath = config.priceBookPath
    this.reloadPrices()
  }

  /**
   * Reload the configured price book from disk.
   *
   * A missing or invalid book is reported as a returned error rather than
   * thrown, because a deployment that has not configured prices must still be
   * able to read its token statistics.
   *
   * @returns {{ ok: true, prices: number } | { ok: false, error: string }} the result.
   */
  reloadPrices() {
    if (this.priceBookPath === undefined || this.priceBookPath.length === 0) {
      this.priceBook = emptyPriceBook()
      return { ok: true, prices: 0 }
    }
    try {
      this.priceBook = loadPriceBookFile(this.priceBookPath)
      return { ok: true, prices: Object.keys(this.priceBook).length }
    } catch (error) {
      this.priceBook = emptyPriceBook()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Build a report, reusing cached folds for logs that did not change.
   *
   * @param {object} [options] report options.
   * @param {any} [options.filters] loose filter input.
   * @param {PriceBook | any} [options.prices] price book override; defaults to the configured one.
   * @param {'full' | 'turns' | 'none'} [options.detail] per-call detail to retain.
   * @param {'auto' | 'hour' | 'day' | 'week' | 'month'} [options.granularity] series granularity.
   * @param {number} [options.maxSessions] keep only the N heaviest sessions.
   * @param {number} [options.maxCalls] keep only the N heaviest calls.
   * @param {AbortSignal} [options.signal] cooperative cancellation.
   * @param {boolean} [options.noCache] bypass the fold cache entirely.
   * @returns {Promise<UsageReport>} the report.
   */
  async report(options = {}) {
    const startedAt = Date.now()
    const filters = options.filters ?? {}
    const prices = options.prices === undefined ? this.priceBook : options.prices
    const useCache = options.noCache !== true
    const discovery = discoverSessionLogs({ sessionsRoot: options.sessionsRoot ?? this.sessionsRoot })

    /** @type {SessionReport[]} */
    const folded = []
    /** @type {import('../core/reader.js').SessionLogFile[]} */
    const uncached = []
    let cacheHits = 0
    for (const log of discovery.files) {
      const cached = useCache ? this.cache.get(log.file) : undefined
      if (cached !== undefined && cached.size === log.bytes && cached.mtimeMs === log.mtimeMs) {
        folded.push(cached.report)
        cacheHits += 1
        continue
      }
      uncached.push(log)
    }
    const freshlyFolded = await foldLogs(uncached, { signal: options.signal })
    for (let index = 0; index < uncached.length; index += 1) {
      const log = uncached[index]
      const report = freshlyFolded[index]
      if (useCache && this.cacheSize > 0) this.remember(log, report)
      folded.push(report)
    }

    // Reports are rebuilt from the cache-aware fold set through the same
    // aggregation the standalone engine uses, so cached and uncached answers are
    // identical by construction.
    const report = await buildReport({
      sessionsRoot: options.sessionsRoot ?? this.sessionsRoot,
      filters,
      prices,
      detail: options.detail,
      granularity: options.granularity,
      maxSessions: options.maxSessions,
      maxCalls: options.maxCalls,
      signal: options.signal,
      prefetchedSessions: folded,
      prefetchedDiscovery: discovery,
    })
    report.meta.elapsedMs = Date.now() - startedAt
    report.meta.cacheHits = cacheHits
    report.meta.cacheMisses = uncached.length
    return report
  }

  /**
   * Store one fold in the bounded cache, evicting the oldest entry when full.
   *
   * @param {import('../core/reader.js').SessionLogFile} log the log that was folded.
   * @param {SessionReport} report the fold result.
   * @returns {void}
   */
  remember(log, report) {
    this.cache.set(log.file, { size: log.bytes, mtimeMs: log.mtimeMs, report })
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next()
      if (oldest.done === true) break
      this.cache.delete(oldest.value)
    }
  }

  /**
   * List the session catalog without requiring a price book or spend threshold.
   *
   * @param {object} [options] catalog options.
   * @param {any} [options.filters] loose filter input.
   * @param {AbortSignal} [options.signal] cooperative cancellation.
   * @returns {Promise<{ root: string, sessions: SessionReport[], warnings: string[] }>} the catalog.
   */
  async sessions(options = {}) {
    return listSessions({
      sessionsRoot: options.sessionsRoot ?? this.sessionsRoot,
      filters: options.filters,
      signal: options.signal,
      now: options.now,
    })
  }

  /**
   * Resolve one session id or unique id prefix to a single session.
   *
   * @param {string} idOrPrefix exact id or unique suffix/stem.
   * @param {object} [options] lookup options.
   * @param {AbortSignal} [options.signal] cooperative cancellation.
   * @returns {Promise<SessionReport | undefined>} the matching session, when exactly one matches.
   * @throws {Error} when the prefix is ambiguous.
   */
  async findSession(idOrPrefix, options = {}) {
    const { sessions } = await this.sessions({ signal: options.signal })
    const exact = sessions.find((session) => session.sessionId === idOrPrefix)
    if (exact !== undefined) return exact
    const needle = idOrPrefix.replace(/^session-/, '')
    const matches = sessions.filter((session) => session.sessionId.replace(/^session-/, '').startsWith(needle))
    if (matches.length === 0) return undefined
    if (matches.length > 1) {
      throw new Error(`session prefix "${idOrPrefix}" is ambiguous: ${matches.length} sessions match`)
    }
    return matches[0]
  }

  /**
   * Describe which dimensions the corpus currently offers for filtering.
   *
   * A filter UI needs the vocabulary before it needs the numbers, so this
   * returns the distinct values actually present rather than a static list.
   *
   * @param {object} [options] options.
   * @param {AbortSignal} [options.signal] cooperative cancellation.
   * @returns {Promise<{ models: any[], providers: string[], projects: any[], kinds: string[], agentPresets: string[], sessions: { total: number, withUsage: number, subagents: number } }>} the catalog dimensions.
   */
  async dimensions(options = {}) {
    const { sessions } = await this.sessions({ signal: options.signal })
    /** @type {Map<string, { provider: string, model: string, calls: number, sessions: Set<string>, totalTokens: number }>} */
    const models = new Map()
    /** @type {Map<string, { project: string, sessions: number, totalTokens: number }>} */
    const projects = new Map()
    /** @type {Set<string>} */
    const providers = new Set()
    /** @type {Set<string>} */
    const kinds = new Set()
    /** @type {Set<string>} */
    const presets = new Set()
    let withUsage = 0
    let subagents = 0
    for (const session of sessions) {
      kinds.add(session.kind)
      if (session.agentPreset !== undefined) presets.add(session.agentPreset)
      if (session.isSubagent) subagents += 1
      if (session.calls > 0) withUsage += 1
      const projectKey = session.project ?? '(unknown)'
      const project = projects.get(projectKey) ?? { project: projectKey, sessions: 0, totalTokens: 0 }
      project.sessions += 1
      project.totalTokens += session.tokens.totalTokens
      projects.set(projectKey, project)
      for (const call of session.callDetails) {
        providers.add(call.provider)
        const key = `${call.provider}/${call.model}`
        const entry = models.get(key) ?? { provider: call.provider, model: call.model, calls: 0, sessions: new Set(), totalTokens: 0 }
        entry.calls += 1
        entry.sessions.add(session.sessionId)
        entry.totalTokens += call.tokens.totalTokens
        models.set(key, entry)
      }
    }
    return {
      models: [...models.values()]
        .map((entry) => ({ provider: entry.provider, model: entry.model, calls: entry.calls, sessions: entry.sessions.size, totalTokens: entry.totalTokens }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
      providers: [...providers].sort(),
      projects: [...projects.values()].sort((a, b) => b.totalTokens - a.totalTokens),
      kinds: [...kinds].sort(),
      agentPresets: [...presets].sort(),
      sessions: { total: sessions.length, withUsage, subagents },
    }
  }

  /**
   * Build the compact, model-facing text answer for one question.
   *
   * @param {object} [options] report options plus rendering options.
   * @returns {Promise<{ text: string, report: UsageReport }>} the rendered answer and its data.
   */
  async answer(options = {}) {
    const report = await this.report(options)
    const { renderReport } = await import('../core/render-text.js')
    const text = renderReport(report, {
      detail: options.renderDetail ?? 'standard',
      lang: options.lang,
      maxSessions: options.maxSessions,
      maxCalls: options.maxCalls,
      maxBuckets: options.maxBuckets,
    })
    return { text, report }
  }

  /**
   * Drop every cached fold, forcing the next query to reread the corpus.
   *
   * @returns {number} entries evicted.
   */
  clearCache() {
    const size = this.cache.size
    this.cache.clear()
    return size
  }

  /**
   * Report this service's own state, for diagnostics and the tool's `status` view.
   *
   * @returns {object} a plain-data status snapshot.
   */
  status() {
    return {
      sessionsRoot: this.sessionsRoot,
      cachedSessions: this.cache.size,
      cacheSize: this.cacheSize,
      priceBookPath: this.priceBookPath ?? null,
      pricedModels: Object.keys(this.priceBook).length,
      hasPriceBook: Object.keys(this.priceBook).length > 0,
    }
  }
}

export default UsageStatsService

/** Re-exported so a caller can validate a price book without importing the core. */
export { normalizePriceBook, sessionMatches }
