/**
 * Aggregation: filtered sessions into every reported rollup.
 *
 * Everything here is a pure function of already-folded session reports, so the
 * same numbers reach the model tool, the CLI and the dashboard, and a test can
 * assert a rollup without touching the filesystem.
 *
 * @module dsh-usage-stats-long/core/aggregate
 */

import { deriveRates, promptTokens, zeroTotals, addInto } from './token-math.js'
import { priceRoutes } from './pricing.js'

/**
 * @typedef {import('./types.js').SessionReport} SessionReport
 * @typedef {import('./types.js').UsageCall} UsageCall
 * @typedef {import('./types.js').ModelRollup} ModelRollup
 * @typedef {import('./types.js').ProjectRollup} ProjectRollup
 * @typedef {import('./types.js').SeriesBucket} SeriesBucket
 * @typedef {import('./types.js').PriceBook} PriceBook
 */

/** Supported time-series granularities, coarsest last. */
export const GRANULARITIES = /** @type {const} */ (['hour', 'day', 'week', 'month'])

/**
 * Floor one instant to the start of its bucket in local time.
 *
 * Local time is deliberate: a person reads "yesterday" in their own zone, and
 * every timestamp in the log is UTC milliseconds.
 *
 * @param {number} time epoch milliseconds.
 * @param {'hour' | 'day' | 'week' | 'month'} granularity bucket size.
 * @returns {number} epoch milliseconds of the bucket start.
 */
export function floorTo(time, granularity) {
  const date = new Date(time)
  switch (granularity) {
    case 'hour':
      date.setMinutes(0, 0, 0)
      return date.getTime()
    case 'day':
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    case 'week': {
      date.setHours(0, 0, 0, 0)
      // ISO weeks start on Monday; JS getDay() is Sunday-based.
      const weekday = (date.getDay() + 6) % 7
      date.setDate(date.getDate() - weekday)
      return date.getTime()
    }
    case 'month':
      date.setHours(0, 0, 0, 0)
      date.setDate(1)
      return date.getTime()
    default:
      return time
  }
}

/**
 * Render one bucket start as its canonical key.
 *
 * @param {number} start epoch milliseconds of the bucket start.
 * @param {'hour' | 'day' | 'week' | 'month'} granularity bucket size.
 * @returns {string} `YYYY-MM-DDTHH`, `YYYY-MM-DD`, or `YYYY-MM`.
 */
export function bucketKey(start, granularity) {
  const date = new Date(start)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  if (granularity === 'month') return `${year}-${month}`
  if (granularity === 'hour') return `${year}-${month}-${day}T${String(date.getHours()).padStart(2, '0')}`
  return `${year}-${month}-${day}`
}

/**
 * Choose a granularity that keeps a series readable.
 *
 * @param {readonly UsageCall[]} calls calls in scope.
 * @param {number} spanMs covered time span in milliseconds.
 * @param {'auto' | 'hour' | 'day' | 'week' | 'month'} requested caller preference.
 * @returns {'hour' | 'day' | 'week' | 'month'} the granularity to use.
 */
export function chooseGranularity(calls, spanMs, requested) {
  if (requested !== 'auto') return requested
  if (calls.length === 0) return 'day'
  if (spanMs <= 2 * 86_400_000) return 'hour'
  if (spanMs <= 62 * 86_400_000) return 'day'
  if (spanMs <= 400 * 86_400_000) return 'week'
  return 'month'
}

/**
 * Build per-model rollups.
 *
 * @param {readonly SessionReport[]} sessions filtered sessions.
 * @param {PriceBook} priceBook the price book.
 * @returns {ModelRollup[]} rollups, heaviest billed total first.
 */
export function rollupModels(sessions, priceBook = {}) {
  /** @type {Map<string, { rollup: ModelRollup, sessions: Set<string>, tokens: any }>} */
  const map = new Map()
  for (const session of sessions) {
    for (const call of session.callDetails) {
      const key = `${call.provider}/${call.model}`
      let entry = map.get(key)
      if (entry === undefined) {
        entry = {
          rollup: {
            provider: call.provider,
            model: call.model,
            calls: 0,
            sessions: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            promptTokens: 0,
          },
          sessions: new Set(),
          tokens: zeroTotals(),
        }
        map.set(key, entry)
      }
      entry.rollup.calls += 1
      entry.sessions.add(session.sessionId)
      addInto(entry.tokens, call.tokens)
    }
  }
  /** @type {ModelRollup[]} */
  const out = []
  for (const entry of map.values()) {
    const rates = deriveRates(entry.tokens)
    const rollup = entry.rollup
    rollup.sessions = entry.sessions.size
    rollup.inputTokens = entry.tokens.inputTokens
    rollup.outputTokens = entry.tokens.outputTokens
    rollup.cacheReadTokens = entry.tokens.cacheReadTokens
    rollup.cacheWriteTokens = entry.tokens.cacheWriteTokens
    rollup.reasoningTokens = entry.tokens.reasoningTokens
    rollup.totalTokens = entry.tokens.totalTokens
    rollup.promptTokens = rates.promptTokens
    if (rates.cacheHitRate !== undefined) rollup.cacheHitRate = rates.cacheHitRate
    const routeKey = new Map([[`${rollup.provider}/${rollup.model}`, {
      provider: rollup.provider,
      model: rollup.model,
      tokens: entry.tokens,
    }]])
    const priced = priceRoutes(routeKey, priceBook)
    if (priced.costUsd !== undefined) rollup.costUsd = priced.costUsd
    out.push(rollup)
  }
  out.sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
  return out
}

/**
 * Build per-project rollups.
 *
 * @param {readonly SessionReport[]} sessions filtered sessions.
 * @param {PriceBook} priceBook the price book.
 * @returns {ProjectRollup[]} rollups, heaviest first.
 */
export function rollupProjects(sessions, priceBook = {}) {
  /** @type {Map<string, { project: string, cwd: string | null, sessions: Set<string>, calls: number, tokens: any, routes: Map<string, any> }>} */
  const map = new Map()
  for (const session of sessions) {
    const project = session.project ?? '(unknown)'
    let entry = map.get(project)
    if (entry === undefined) {
      entry = {
        project,
        cwd: session.cwd ?? null,
        sessions: new Set(),
        calls: 0,
        tokens: zeroTotals(),
        routes: new Map(),
      }
      map.set(project, entry)
    }
    entry.sessions.add(session.sessionId)
    for (const call of session.callDetails) {
      entry.calls += 1
      addInto(entry.tokens, call.tokens)
      const routeKey = `${call.provider}/${call.model}`
      let route = entry.routes.get(routeKey)
      if (route === undefined) {
        route = { provider: call.provider, model: call.model, tokens: zeroTotals() }
        entry.routes.set(routeKey, route)
      }
      addInto(route.tokens, call.tokens)
    }
  }
  /** @type {ProjectRollup[]} */
  const out = []
  for (const entry of map.values()) {
    /** @type {ProjectRollup} */
    const rollup = {
      project: entry.project,
      cwd: entry.cwd,
      sessions: entry.sessions.size,
      calls: entry.calls,
      tokens: entry.tokens,
    }
    const priced = priceRoutes(entry.routes, priceBook)
    if (priced.costUsd !== undefined) rollup.costUsd = priced.costUsd
    out.push(rollup)
  }
  out.sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens || a.project.localeCompare(b.project))
  return out
}

/**
 * Build the time series.
 *
 * @param {readonly UsageCall[]} calls calls in scope.
 * @param {'hour' | 'day' | 'week' | 'month'} granularity bucket size.
 * @returns {SeriesBucket[]} buckets in ascending time order, gaps included as zero rows.
 */
export function buildSeries(calls, granularity) {
  if (calls.length === 0) return []
  const stepMs = { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 0 }[granularity]
  /** @type {Map<number, { tokens: any, calls: number, sessions: Set<string> }>} */
  const buckets = new Map()
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const call of calls) {
    const start = floorTo(call.time, granularity)
    let bucket = buckets.get(start)
    if (bucket === undefined) {
      bucket = { tokens: zeroTotals(), calls: 0, sessions: new Set() }
      buckets.set(start, bucket)
    }
    bucket.calls += 1
    bucket.sessions.add(call.sessionId)
    addInto(bucket.tokens, call.tokens)
    if (start < min) min = start
    if (start > max) max = start
  }
  /** @type {number[]} */
  const keys = []
  if (granularity === 'month') {
    const cursor = new Date(min)
    cursor.setDate(1)
    cursor.setHours(0, 0, 0, 0)
    while (cursor.getTime() <= max) {
      keys.push(cursor.getTime())
      cursor.setMonth(cursor.getMonth() + 1)
    }
  } else {
    for (let cursor = min; cursor <= max; cursor += stepMs) keys.push(cursor)
  }
  /** @type {SeriesBucket[]} */
  const out = []
  for (const start of keys) {
    const bucket = buckets.get(start)
    out.push({
      key: bucketKey(start, granularity),
      granularity,
      start,
      calls: bucket?.calls ?? 0,
      sessions: bucket?.sessions.size ?? 0,
      tokens: bucket?.tokens ?? zeroTotals(),
    })
  }
  return out
}

/**
 * Compute the headline summary for one filtered scope.
 *
 * @param {readonly SessionReport[]} sessions filtered sessions.
 * @param {readonly UsageCall[]} calls filtered calls.
 * @param {PriceBook} priceBook the price book.
 * @returns {object} the summary block of a report.
 */
export function summarize(sessions, calls, priceBook = {}) {
  const totals = zeroTotals()
  let peakPromptTokens = 0
  let firstCallAt = Number.POSITIVE_INFINITY
  let lastCallAt = Number.NEGATIVE_INFINITY
  /** @type {Set<string>} */
  const modelRoutes = new Set()
  /** @type {Set<string>} */
  const projects = new Set()
  let subagentSessions = 0
  let subagentTokens = 0
  let turnCount = 0
  let stepCount = 0
  for (const session of sessions) {
    turnCount += session.turns
    stepCount += session.steps
    projects.add(session.project ?? '(unknown)')
    if (session.isSubagent) {
      subagentSessions += 1
      subagentTokens += session.tokens.totalTokens
    }
    for (const call of session.callDetails) {
      addInto(totals, call.tokens)
      modelRoutes.add(`${call.provider}/${call.model}`)
      if (call.promptTokens > peakPromptTokens) peakPromptTokens = call.promptTokens
      if (call.time < firstCallAt) firstCallAt = call.time
      if (call.time > lastCallAt) lastCallAt = call.time
    }
  }
  /** @type {Map<string, any>} */
  const byRoute = new Map()
  for (const call of calls) {
    const key = `${call.provider}/${call.model}`
    let entry = byRoute.get(key)
    if (entry === undefined) {
      entry = { provider: call.provider, model: call.model, tokens: zeroTotals() }
      byRoute.set(key, entry)
    }
    addInto(entry.tokens, call.tokens)
  }
  const priced = priceRoutes(byRoute, priceBook)
  const summary = {
    sessions: sessions.length,
    calls: calls.length,
    turns: turnCount,
    steps: stepCount,
    models: modelRoutes.size,
    projects: projects.size,
    subagentSessions,
    subagentTokens,
    firstCallAt: Number.isFinite(firstCallAt) ? firstCallAt : 0,
    lastCallAt: Number.isFinite(lastCallAt) ? lastCallAt : 0,
    costComplete: priced.complete,
    peakPromptTokens,
  }
  if (priced.costUsd !== undefined) summary.costUsd = priced.costUsd
  if (priced.unpricedModels.length > 0) summary.unpricedModels = priced.unpricedModels
  summary.promptTokens = promptTokens(totals)
  return { summary, totals }
}

/**
 * Group per-turn figures for one session, ready for a detail view.
 *
 * @param {SessionReport} session a filtered session.
 * @returns {Array<{ turn: number, steps: number, calls: number, tokens: import('./types.js').TokenTotals, models: string[] }>} turn rows.
 */
export function turnRows(session) {
  /** @type {Map<number, { turn: number, steps: Set<number>, calls: number, tokens: any, models: Set<string> }>} */
  const map = new Map()
  for (const call of session.callDetails) {
    let entry = map.get(call.turn)
    if (entry === undefined) {
      entry = { turn: call.turn, steps: new Set(), calls: 0, tokens: zeroTotals(), models: new Set() }
      map.set(call.turn, entry)
    }
    entry.steps.add(call.step)
    entry.calls += 1
    entry.models.add(`${call.provider}/${call.model}`)
    addInto(entry.tokens, call.tokens)
  }
  return [...map.values()]
    .sort((a, b) => a.turn - b.turn)
    .map((entry) => ({
      turn: entry.turn,
      steps: entry.steps.size,
      calls: entry.calls,
      tokens: entry.tokens,
      models: [...entry.models].sort(),
    }))
}
