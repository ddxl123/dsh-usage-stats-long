/**
 * The usage fold: one durable session log into exact, attributable model calls.
 *
 * ## Why the log is the source of truth
 *
 * DSH records provider-reported accounting on exactly two durable events:
 * `assistant/message` (the agent loop's own calls, with the exact token
 * counters the provider returned) and `compaction/summary` (the compaction
 * model's call). Nothing else in a session log carries usage; the auxiliary
 * title and web-search routes never write usage at all. Reading those events is
 * therefore not an estimate — it is the same number the provider billed.
 *
 * This module deliberately does **not** estimate tokens from text. Estimation
 * exists in the harness for context-pressure display (`ctx.tokenMeter`), where
 * an approximation is the point; a usage report must never mix the two.
 *
 * ## Accuracy rules implemented here
 *
 * 1. **Attribution.** A call is attributed to the `provider`/`model` its own
 *    assistant message records, falling back to the newest `request/context`
 *    (or `request/header`) route in force at that sequence number. Session
 *    logs written before route events existed still attribute correctly.
 * 2. **One call per step.** A step that succeeds writes one usage-bearing
 *    `assistant/message`. Retried attempts write `assistant/attempt` (no
 *    usage) plus a final usage-bearing message for the attempt that settled,
 *    so summing usage-bearing messages never double-bills a retry.
 * 3. **Forked logs.** A forked or resumed session stores an inherited event
 *    prefix it did not pay for again. Everything before the last
 *    `session/end-seed` boundary is excluded from turns, steps and calls, so a
 *    fork does not double-count its parent's spend.
 * 4. **Derived totals are labelled.** A provider may omit `totalTokens`;
 *    totals are then derived from the parts and flagged through
 *    `totalDerived`, never silently presented as provider-exact.
 *
 * @module dsh-usage-stats-long/core/fold
 */

import { forEachLogEvent, projectNameOf } from './reader.js'
import { addInto, count, normalizeUsage, promptTokens, zeroTotals } from './token-math.js'

/**
 * @typedef {import('./types.js').SessionReport} SessionReport
 * @typedef {import('./types.js').UsageCall} UsageCall
 * @typedef {import('./core/types.js').TokenTotals} TokenTotals
 */

/**
 * @typedef {object} SessionLogFileLike
 * @property {string} sessionId
 * @property {string} projectDir
 * @property {string} cwd
 * @property {string} file
 * @property {number} logVersion
 * @property {number} bytes
 * @property {number} mtimeMs
 */

/**
 * Fold one session log into an exact usage report.
 *
 * @param {SessionLogFileLike} log discovered log file.
 * @param {object} [options] fold options.
 * @param {string} [options.project] display project name override.
 * @param {AbortSignal} [options.signal] cooperative cancellation.
 * @returns {Promise<SessionReport>} the session's report, including every call detail.
 */
export async function foldSessionLog(log, options = {}) {
  /** @type {string[]} */
  const warnings = []
  /** @type {UsageCall[]} */
  const calls = []
  /** @type {any} */
  let header
  /** @type {string | undefined} */
  let title
  let maxTime = 0
  let ownedTurns = 0
  let ownedSteps = 0
  let inheritedEventCount = 0
  // A session log that contains a fork-inherited prefix replays its parent's
  // events, and those events were already billed to the parent. Its own work
  // starts after the last `session/end-seed` boundary, so counting is disabled
  // until that boundary is seen.
  let inInheritedRegion = false
  let sawSeedBoundary = false
  /** @type {{ turn: number, step: number } | undefined} */
  let lastTurn
  let sawTurnStart = false
  let sawStepStart = false
  let peakPromptTokens = 0
  /** @type {number | undefined} */
  let contextWindow
  const totals = zeroTotals()
  /** @type {Map<number, { turn: number, step: number, calls: number, tokens: TokenTotals }>} */
  const turns = new Map()
  /** Newest route in force, rebuilt from route events so legacy logs still attribute. */
  /** @type {{ provider: string, model: string, contextWindow?: number, reasoningEffort?: string } | undefined} */
  let route

  const stats = await forEachLogEvent(log, (event) => {
    const type = event.type
    if (typeof event.time === 'number' && event.time > maxTime) maxTime = event.time
    if (type === 'session') {
      if (header === undefined) {
        header = event
        // Counting stays off for a seeded log until its seed boundary appears.
        inInheritedRegion = event.isSeeded === true
      }
      if (typeof event.createdAt === 'number') maxTime = Math.max(maxTime, event.createdAt)
      return
    }
    if (type === 'session/end-seed') {
      // Everything appended after the LAST seed boundary is this lifecycle's
      // own work; anything before it was inherited from a parent log.
      sawSeedBoundary = true
      inInheritedRegion = false
      inheritedEventCount = typeof event.seq === 'number' ? event.seq + 1 : inheritedEventCount
      return
    }
    if (type === 'session/title') {
      title = readTitle(event) ?? title
      return
    }
    if (type === 'request/header') {
      const config = event.data?.header?.config
      if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
        route = {
          provider: config.provider,
          model: config.model,
          contextWindow: typeof config.contextWindow === 'number' ? config.contextWindow : route?.contextWindow,
          reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined,
        }
      }
      return
    }
    if (type === 'request/context') {
      const provider = event.data?.provider
      const model = event.data?.model
      if (typeof provider === 'string' && typeof model === 'string') {
        const window = event.data?.contextWindow
        route = {
          provider,
          model,
          contextWindow: typeof window === 'number' ? window : undefined,
          reasoningEffort: route?.reasoningEffort,
        }
      }
      return
    }
    // Everything below contributes to usage and must respect the seed region.
    // The boundary event is the only signal that ends it: a seeded log replays
    // its parent's `turn/start` events too, so treating one as the boundary
    // would resume counting in the middle of the inherited prefix — the exact
    // double-billing this rule exists to prevent.
    if (inInheritedRegion) return
    if (type === 'turn/start') {
      const turn = event.data?.turn
      if (typeof turn === 'number' && turn !== lastTurn?.turn) {
        ownedTurns += 1
        lastTurn = { turn, step: 0 }
        sawTurnStart = true
      }
      return
    }
    if (type === 'step/start') {
      const turn = event.data?.turn
      const step = event.data?.step
      if (typeof turn === 'number' && typeof step === 'number') {
        if (lastTurn === undefined || lastTurn.turn !== turn || lastTurn.step !== step) ownedSteps += 1
        lastTurn = { turn, step }
        sawStepStart = true
      }
      return
    }
    if (type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage === undefined || usage === null) return
      const turn = typeof event.data?.turn === 'number' ? event.data.turn : (lastTurn?.turn ?? 0)
      const step = typeof event.data?.step === 'number' ? event.data.step : (lastTurn?.step ?? 0)
      const source = event.data?.message?.source
      const attributed = source && typeof source.provider === 'string' && typeof source.model === 'string'
        ? { provider: source.provider, model: source.model }
        : route
      const tokens = normalizeUsage(usage)
      const call = /** @type {UsageCall} */ ({
        sessionId: log.sessionId,
        seq: typeof event.seq === 'number' ? event.seq : 0,
        time: typeof event.time === 'number' ? event.time : 0,
        turn,
        step,
        provider: attributed?.provider ?? '(unknown)',
        model: attributed?.model ?? '(unknown)',
        kind: 'turn',
        tokens,
        promptTokens: promptTokens(tokens),
      })
      if (route?.contextWindow !== undefined) call.contextWindow = route.contextWindow
      if (route?.reasoningEffort !== undefined) call.reasoningEffort = route.reasoningEffort
      if (event.data?.interrupted === true) call.interrupted = true
      calls.push(call)
      addInto(totals, tokens)
      if (call.promptTokens > peakPromptTokens) peakPromptTokens = call.promptTokens
      if (route?.contextWindow !== undefined) contextWindow = route.contextWindow
      const bucket = turns.get(turn)
      if (bucket === undefined) {
        turns.set(turn, { turn, step, calls: 1, tokens: { ...tokens } })
      } else {
        bucket.calls += 1
        bucket.step = step
        addInto(bucket.tokens, tokens)
      }
      return
    }
    if (type === 'compaction/summary') {
      const usage = event.data?.usage
      if (usage === undefined || usage === null) return
      const tokens = normalizeUsage(usage)
      const call = /** @type {UsageCall} */ ({
        sessionId: log.sessionId,
        seq: typeof event.seq === 'number' ? event.seq : 0,
        time: typeof event.time === 'number' ? event.time : 0,
        turn: lastTurn?.turn ?? 0,
        step: lastTurn?.step ?? 0,
        provider: typeof event.data?.provider === 'string' ? event.data.provider : (route?.provider ?? '(unknown)'),
        model: typeof event.data?.model === 'string' ? event.data.model : (route?.model ?? '(unknown)'),
        kind: 'compaction',
        tokens,
        promptTokens: promptTokens(tokens),
      })
      if (typeof event.data?.compactionId === 'string') call.compactionId = event.data.compactionId
      calls.push(call)
      addInto(totals, tokens)
      if (call.promptTokens > peakPromptTokens) peakPromptTokens = call.promptTokens
    }
  })

  warnings.push(...stats.warnings)
  if (header === undefined) warnings.push(`${log.file}: no session header; skipped`)
  if (!sawSeedBoundary && !sawTurnStart && calls.length > 0) {
    // Defensive: a v0 log has no seed boundary at all. Counting turn/start
    // events is already exact there, so nothing to correct.
  }
  // A session header's own `cwd` is authoritative. The decoded directory name is
  // a fallback for legacy headers that omitted it, and it is only trusted when it
  // came out absolute: the encoding replaces separators with `-`, so a relative
  // result would be a plausible-looking wrong answer rather than an obvious one.
  const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0
    ? header.cwd
    : (log.cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(log.cwd) ? log.cwd : null)
  const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : log.mtimeMs
  const delegationDepth = typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0
  const isSubagent = header?.origin === 'subagent' || delegationDepth > 0

  /** @type {SessionReport} */
  const report = {
    sessionId: typeof header?.id === 'string' ? header.id : log.sessionId,
    cwd,
    // The project label follows the authoritative `cwd` resolved above, not the
    // encoded directory name: for a legacy header the two disagree.
    project: options.project ?? projectNameOf(cwd),
    createdAt,
    updatedAt: maxTime > 0 ? maxTime : undefined,
    kind: isSubagent ? 'subagent' : 'session',
    isSubagent,
    seeded: header?.isSeeded === true,
    delegationDepth,
    logVersion: log.logVersion,
    source: log.file,
    bytes: log.bytes,
    inheritedEventCount,
    turns: ownedTurns,
    steps: ownedSteps,
    calls: calls.length,
    peakPromptTokens,
    tokens: totals,
    turnRollup: [...turns.values()].sort((a, b) => a.turn - b.turn),
    callDetails: calls.sort((a, b) => a.seq - b.seq),
    warnings,
  }
  if (title !== undefined && title.length > 0) report.title = title
  if (typeof header?.agentPreset === 'string') report.agentPreset = header.agentPreset
  if (typeof header?.parentSession === 'string') report.parentSession = header.parentSession
  if (contextWindow !== undefined) report.contextWindow = contextWindow
  if (!sawStepStart && ownedSteps === 0 && calls.length > 0) {
    // A log whose step events were pruned still has exact per-turn records.
    report.steps = new Set(calls.map((call) => `${call.turn}:${call.step}`)).size
  }
  return report
}

/**
 * Read the title text out of a `session/title` event.
 *
 * The event has carried the title both as a plain string and as a snapshot
 * object across format versions, so both shapes are accepted.
 *
 * @param {any} event a `session/title` event.
 * @returns {string | undefined} the title, when present and non-empty.
 */
function readTitle(event) {
  const data = event?.data
  if (typeof data === 'string') return data
  if (data === null || typeof data !== 'object') return undefined
  for (const key of ['title', 'text', 'value']) {
    const candidate = data[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  const snapshot = data.title
  if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.text === 'string') {
    return snapshot.text
  }
  return undefined
}

/**
 * Sum the billed total of a call list.
 *
 * @param {readonly UsageCall[]} calls calls to fold.
 * @returns {TokenTotals} the sum.
 */
export function totalsOfCalls(calls) {
  const totals = zeroTotals()
  for (const call of calls) addInto(totals, call.tokens)
  return totals
}

/** Exposed so the aggregator can reuse the same coercion for external input. */
export { count }
