/**
 * Token arithmetic for provider-reported usage records.
 *
 * DeepSeek Harness records one {@link TokenUsage} object per successful model
 * call on the `assistant/message` session event. This module owns the only
 * place where those raw counters are interpreted, so every surface (tool, CLI,
 * dashboard, HTML export) reports identical numbers.
 *
 * @module dsh-usage-stats-long/core/token-math
 */

/** @typedef {import('./types.js').RawUsage} RawUsage */
/** @typedef {import('./types.js').TokenTotals} TokenTotals */

/**
 * Coerce an unknown provider counter into a non-negative safe integer.
 *
 * Providers omit optional counters instead of sending null, but a malformed
 * or truncated log line must never turn into `NaN` in a reported total, so
 * every read goes through this guard.
 *
 * @param {unknown} value candidate counter.
 * @returns {number} a non-negative safe integer, or 0.
 */
export function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

/**
 * Normalize one provider usage record into this project's canonical fields.
 *
 * Counter semantics, measured against every session log this project has been
 * validated on (see `docs/accuracy.md`):
 *
 * - `inputTokens` is the **uncached** prompt share.
 * - `cacheReadTokens` / `cacheWriteTokens` are prompt shares the provider
 *   billed as cache hits / cache writes, kept separate from `inputTokens`.
 * - `outputTokens` is the full completion, already including
 *   `reasoningTokens` (reasoning is reported as a subset, never additive).
 * - `totalTokens` is the provider's exact full-call total when it reported
 *   one; otherwise it is derived as every prompt share plus the output.
 *
 * @param {RawUsage} [usage] raw usage object from a session event.
 * @param {{ turn?: number, step?: number }} [where] legacy context, used only for diagnostics.
 * @returns {TokenTotals} canonical totals.
 */
export function normalizeUsage(usage, where = {}) {
  void where
  const inputTokens = count(usage?.inputTokens)
  const outputTokens = count(usage?.outputTokens)
  const cacheReadTokens = count(usage?.cacheReadTokens)
  const cacheWriteTokens = count(usage?.cacheWriteTokens)
  const reasoningTokens = count(usage?.reasoningTokens)
  const derived = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  const reported = typeof usage?.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
    ? Math.floor(usage.totalTokens)
    : undefined
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: reported === undefined ? derived : reported,
    /** True when the provider did not report an exact full-call total. */
    totalDerived: reported === undefined,
  }
}

/**
 * Prompt size billed for one call: every prompt share, cached or not.
 *
 * @param {TokenTotals} totals one call's totals.
 * @returns {number} prompt tokens.
 */
export function promptTokens(totals) {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
}

/**
 * Accumulate one call into a running sum, in place.
 *
 * @param {TokenTotals} target running sum.
 * @param {TokenTotals} value one call's totals.
 * @returns {TokenTotals} the mutated `target`, for chaining.
 */
export function addInto(target, value) {
  target.inputTokens += value.inputTokens
  target.outputTokens += value.outputTokens
  target.cacheReadTokens += value.cacheReadTokens
  target.cacheWriteTokens += value.cacheWriteTokens
  target.reasoningTokens += value.reasoningTokens
  target.totalTokens += value.totalTokens
  target.totalDerived = target.totalDerived || value.totalDerived
  return target
}

/**
 * Create a zeroed totals object.
 *
 * @returns {TokenTotals} zeroed totals.
 */
export function zeroTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalDerived: false,
  }
}

/**
 * Sum a list of totals into a fresh object.
 *
 * @param {readonly TokenTotals[]} list totals to fold.
 * @returns {TokenTotals} the sum.
 */
export function sumTotals(list) {
  const out = zeroTotals()
  for (const item of list) addInto(out, item)
  return out
}

/**
 * Derive the reported rates that make a total auditable.
 *
 * `cacheHitRate` is the share of billed prompt tokens served from cache — the
 * single number that explains most cost differences between sessions. It is
 * `undefined` when no prompt tokens were billed at all, so a caller never
 * renders a meaningless `0%` for an empty scope.
 *
 * @param {TokenTotals} totals any totals object.
 * @returns {{ promptTokens: number, cacheHitRate?: number, reasoningShare?: number, outputShare?: number }} derived rates.
 */
export function deriveRates(totals) {
  const prompt = promptTokens(totals)
  const out = { promptTokens: prompt }
  if (prompt > 0) out.cacheHitRate = totals.cacheReadTokens / prompt
  if (totals.totalTokens > 0) {
    out.outputShare = totals.outputTokens / totals.totalTokens
    if (totals.reasoningTokens > 0) out.reasoningShare = totals.reasoningTokens / totals.outputTokens
  }
  return out
}

/**
 * Estimate cost in USD from a configurable price book.
 *
 * Nothing is invented: a model with no entry in the price book contributes
 * nothing and is reported through `unpricedModels`, so a dollar figure is
 * either derived from the user's own prices or clearly incomplete.
 *
 * @param {TokenTotals} totals tokens to price.
 * @param {import('./types.js').ModelPrice | undefined} price per-million-token rates.
 * @returns {number | undefined} USD cost, or undefined when unpriced.
 */
export function priceOf(totals, price) {
  if (!price) return undefined
  const perMillion = (tokens, rate) => (tokens * (typeof rate === 'number' ? rate : 0)) / 1_000_000
  return (
    perMillion(totals.inputTokens, price.input)
    + perMillion(totals.cacheReadTokens, price.cacheRead)
    + perMillion(totals.cacheWriteTokens, price.cacheWrite ?? price.input)
    + perMillion(totals.outputTokens, price.output)
  )
}
