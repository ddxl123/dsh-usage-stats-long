/**
 * The host-independent usage statistics engine.
 *
 * Nothing in this module tree imports Cordis, a DSH service, or any live
 * session object: the engine reads durable session logs from disk and returns
 * plain data. That is what lets the same code back the model-facing tool, the
 * CLI, the MCP server, and the browser dashboard, and it is why the numbers
 * cannot drift between them.
 *
 * @module dsh-usage-stats-long/core
 */

export {
  resolveSessionsRoot,
  discoverSessionLogs,
  forEachLogEvent,
  readLogLines,
  decodeLogText,
  splitZstdFrames,
  describeError,
  decodeProjectDir,
  projectNameOf,
  expandHome,
} from './reader.js'
export { foldSessionLog, totalsOfCalls } from './fold.js'
export { buildReport, listSessions, foldLogs, DETAIL_LEVELS } from './scan.js'
export {
  compileFilters,
  emptyFilters,
  applyFilters,
  sessionMatches,
  matchesSessionId,
  resolveSessionSelectors,
  callMatchesRoute,
  callInWindow,
  matchesModelSelector,
  parseInstant,
  toStringList,
  withCalls,
  FilterError,
  SESSION_KINDS,
} from './filters.js'
export {
  GRANULARITIES,
  buildSeries,
  bucketKey,
  chooseGranularity,
  floorTo,
  rollupModels,
  rollupProjects,
  summarize,
  turnRows,
} from './aggregate.js'
export {
  addInto,
  count,
  deriveRates,
  normalizeUsage,
  priceOf,
  promptTokens,
  sumTotals,
  zeroTotals,
} from './token-math.js'
export { emptyPriceBook, loadPriceBookFile, normalizePriceBook, priceRoutes, priceTotals, resolvePrice } from './pricing.js'
export { renderReport, renderReportSections, renderStatus, renderSessionCatalog, renderCallLine, describeFilters } from './render-text.js'
export {
  formatAge,
  formatDate,
  formatDuration,
  formatExact,
  formatPercent,
  formatTime,
  formatTokens,
  formatUsd,
} from './format.js'
