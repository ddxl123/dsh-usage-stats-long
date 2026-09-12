/**
 * Token arithmetic tests.
 *
 * These lock the counter semantics every other surface depends on: what counts
 * as a prompt token, when a total is derived, and that a missing provider field
 * never becomes `NaN` in a reported number.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  addInto,
  count,
  deriveRates,
  normalizeUsage,
  priceOf,
  promptTokens,
  sumTotals,
  zeroTotals,
} from '../lib/core/token-math.js'

describe('count', () => {
  it('accepts non-negative finite numbers and floors them', () => {
    assert.equal(count(12), 12)
    assert.equal(count(12.9), 12)
    assert.equal(count(0), 0)
  })

  it('treats absent, negative and non-finite values as zero rather than propagating them', () => {
    assert.equal(count(undefined), 0)
    assert.equal(count(null), 0)
    assert.equal(count(-5), 0)
    assert.equal(count(Number.NaN), 0)
    assert.equal(count(Number.POSITIVE_INFINITY), 0)
    assert.equal(count('123'), 0)
  })
})

describe('normalizeUsage', () => {
  it('keeps cached prompt shares separate from uncached input', () => {
    const totals = normalizeUsage({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 20, totalTokens: 1070 })
    assert.deepEqual(
      { ...totals },
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: 50,
        reasoningTokens: 0,
        totalTokens: 1070,
        totalDerived: false,
      },
    )
    assert.equal(promptTokens(totals), 1050)
  })

  it('derives the total from every prompt share plus the output when the provider omitted one', () => {
    const totals = normalizeUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 })
    assert.equal(totals.totalTokens, 115)
    assert.equal(totals.totalDerived, true)
  })

  it('does not add reasoning tokens on top of the output, because the provider already includes them', () => {
    const totals = normalizeUsage({ inputTokens: 1, outputTokens: 10, reasoningTokens: 8, totalTokens: 11 })
    assert.equal(totals.reasoningTokens, 8)
    assert.equal(totals.totalTokens, 11)
  })

  it('survives an empty or missing usage object', () => {
    assert.deepEqual({ ...normalizeUsage(undefined) }, { ...zeroTotals(), totalDerived: true })
    assert.equal(normalizeUsage({}).totalTokens, 0)
  })
})

describe('accumulation', () => {
  it('sums several totals without losing a category', () => {
    const sum = sumTotals([
      normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1, totalTokens: 10 }),
      normalizeUsage({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }),
    ])
    assert.deepEqual(
      { ...sum },
      {
        inputTokens: 11,
        outputTokens: 22,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        reasoningTokens: 1,
        totalTokens: 40,
        // Both providers reported an exact total, so the sum is provider-exact.
        totalDerived: false,
      },
    )
  })

  it('flags the sum as derived when any contributor was derived', () => {
    const sum = zeroTotals()
    addInto(sum, normalizeUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }))
    addInto(sum, normalizeUsage({ inputTokens: 1, outputTokens: 1 }))
    assert.equal(sum.totalDerived, true)
    assert.equal(sum.totalTokens, 4)
  })
})

describe('deriveRates', () => {
  it('reports the cached share of prompt tokens', () => {
    const rates = deriveRates(normalizeUsage({ inputTokens: 250, cacheReadTokens: 750, outputTokens: 5, totalTokens: 1005 }))
    assert.equal(rates.promptTokens, 1000)
    assert.equal(rates.cacheHitRate, 0.75)
  })

  it('omits the rate instead of reporting a meaningless zero for an empty scope', () => {
    const rates = deriveRates(zeroTotals())
    assert.equal(rates.cacheHitRate, undefined)
    assert.equal(rates.promptTokens, 0)
  })
})

describe('priceOf', () => {
  it('prices each counter at its own rate', () => {
    const totals = normalizeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, totalTokens: 4_000_000 })
    const cost = priceOf(totals, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 })
    assert.equal(cost, 3.6)
  })

  it('falls back to the input rate for cache writes when no write rate is configured', () => {
    const totals = normalizeUsage({ cacheWriteTokens: 1_000_000, totalTokens: 1_000_000 })
    assert.equal(priceOf(totals, { input: 3, output: 1 }), 3)
  })

  it('returns undefined rather than zero for an unpriced route', () => {
    assert.equal(priceOf(zeroTotals(), undefined), undefined)
  })
})
