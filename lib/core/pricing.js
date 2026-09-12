/**
 * The price book: optional, explicit, user-owned.
 *
 * This project refuses to invent money. Providers change prices, cache and
 * reasoning rates differ per route, and a wrong price is worse than no price —
 * so the shipped book is empty by default and every cost figure this project
 * prints is derived from rates the user supplied. Any model missing from the
 * book is reported as unpriced rather than priced at zero.
 *
 * @module dsh-usage-stats-long/core/pricing
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { priceOf } from './token-math.js'

/**
 * @typedef {import('./types.js').PriceBook} PriceBook
 * @typedef {import('./types.js').ModelPrice} ModelPrice
 * @typedef {import('./types.js').TokenTotals} TokenTotals
 */

/**
 * A price book that prices nothing.
 *
 * @returns {PriceBook} an empty book.
 */
export function emptyPriceBook() {
  return {}
}

/**
 * Validate and freeze one price book.
 *
 * Accepted entry keys are `provider/model`, a bare `model`, or `*`. Every rate
 * must be a finite, non-negative number of USD per million tokens; a typo in a
 * price file fails loudly here instead of quietly producing a wrong total.
 *
 * @param {unknown} input candidate book.
 * @returns {PriceBook} a validated, frozen book.
 * @throws {Error} when an entry is not a valid price.
 */
export function normalizePriceBook(input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('price book must be an object keyed by "provider/model", "model", or "*"')
  }
  /** @type {PriceBook} */
  const book = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`price for "${key}" must be an object of per-million-token rates`)
    }
    /** @type {ModelPrice} */
    const price = {}
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const rate = /** @type {any} */ (value)[field]
      if (rate === undefined || rate === null) continue
      const numeric = typeof rate === 'number' ? rate : Number(rate)
      if (!Number.isFinite(numeric) || numeric < 0) {
        throw new Error(`price.${field} for "${key}" must be a non-negative number of USD per million tokens`)
      }
      /** @type {any} */ (price)[field] = numeric
    }
    if (Object.keys(price).length === 0) {
      throw new Error(`price for "${key}" declares no rates; expected input/output/cacheRead/cacheWrite`)
    }
    book[key] = price
  }
  return Object.freeze(book)
}

/**
 * Load a price book from a JSON file.
 *
 * The file may be either a bare book (`{ "provider/model": { ... } }`) or an
 * object with a `prices` key, which is the shape `prices.example.json` ships.
 *
 * @param {string} path path to the JSON file.
 * @returns {PriceBook} the normalized book.
 * @throws {Error} when the file is missing or invalid.
 */
export function loadPriceBookFile(path) {
  const absolute = resolve(path)
  let text
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    throw new Error(`cannot read price book ${absolute}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`price book ${absolute} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body = parsed !== null && typeof parsed === 'object' && 'prices' in parsed ? parsed.prices : parsed
  return normalizePriceBook(body)
}

/**
 * Resolve the price for one route from a book.
 *
 * Precedence is most specific first: exact `provider/model`, then bare `model`,
 * then the `*` catch-all. Returning `undefined` is a meaningful answer — it
 * means "this cost cannot be computed", which callers surface instead of zero.
 *
 * @param {PriceBook} book the price book.
 * @param {string} provider provider route.
 * @param {string} model model id.
 * @returns {ModelPrice | undefined} the applicable price, when any.
 */
export function resolvePrice(book, provider, model) {
  if (book === undefined || book === null) return undefined
  return book[`${provider}/${model}`] ?? book[model] ?? book['*']
}

/**
 * Price one totals object, reporting whether the route was priced at all.
 *
 * @param {TokenTotals} totals tokens to price.
 * @param {PriceBook} book the price book.
 * @param {string} provider provider route.
 * @param {string} model model id.
 * @returns {{ costUsd?: number, priced: boolean }} the cost and whether it is complete.
 */
export function priceTotals(totals, book, provider, model) {
  const price = resolvePrice(book, provider, model)
  const costUsd = priceOf(totals, price)
  return costUsd === undefined ? { priced: false } : { costUsd, priced: true }
}

/**
 * Price a whole collection of route-keyed totals.
 *
 * @param {Map<string, { provider: string, model: string, tokens: TokenTotals }>} byRoute totals per route.
 * @param {PriceBook} book the price book.
 * @returns {{ costUsd?: number, complete: boolean, unpricedModels: string[] }} the aggregate.
 */
export function priceRoutes(byRoute, book) {
  let costUsd = 0
  let complete = true
  /** @type {string[]} */
  const unpricedModels = []
  for (const entry of byRoute.values()) {
    const price = resolvePrice(book, entry.provider, entry.model)
    if (price === undefined) {
      complete = false
      unpricedModels.push(`${entry.provider}/${entry.model}`)
      continue
    }
    costUsd += priceOf(entry.tokens, price) ?? 0
  }
  unpricedModels.sort()
  /** @type {{ costUsd?: number, complete: boolean, unpricedModels: string[] }} */
  const result = { complete, unpricedModels }
  if (unpricedModels.length < byRoute.size) result.costUsd = costUsd
  return result
}
