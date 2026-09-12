/**
 * Shared data contracts for the usage statistics engine.
 *
 * These are plain-data shapes only: every value crossing a boundary between
 * modules, the model-facing tool, the CLI and the dashboard is one of them, so
 * no live Cordis, Session or LLM object is ever retained or serialized.
 *
 * @module dsh-usage-stats-long/core/types
 */

/**
 * One provider usage record as stored on a session event.
 * @typedef {object} RawUsage
 * @property {number} [inputTokens] uncached prompt tokens.
 * @property {number} [outputTokens] completion tokens, reasoning included.
 * @property {number} [totalTokens] provider-exact full-call total.
 * @property {number} [cacheReadTokens] prompt tokens served from cache.
 * @property {number} [cacheWriteTokens] prompt tokens written to cache.
 * @property {number} [reasoningTokens] reasoning subset of the output.
 */

/**
 * Canonical totals used by every surface of this project.
 * @typedef {object} TokenTotals
 * @property {number} inputTokens uncached prompt tokens.
 * @property {number} outputTokens completion tokens.
 * @property {number} cacheReadTokens prompt tokens read from cache.
 * @property {number} cacheWriteTokens prompt tokens written to cache.
 * @property {number} reasoningTokens reasoning subset of `outputTokens`.
 * @property {number} totalTokens billed total for the scope.
 * @property {boolean} totalDerived true when any call's total was derived rather than reported.
 */

/**
 * How one model call entered the log.
 * @typedef {'turn' | 'compaction'} CallKind
 */

/**
 * One billed model call reconstructed from a durable session log.
 * @typedef {object} UsageCall
 * @property {string} sessionId owning session.
 * @property {number} seq the `assistant/message` event sequence number.
 * @property {number} time Unix epoch milliseconds of that event.
 * @property {number} turn turn index within the session.
 * @property {number} step step index within the turn.
 * @property {string} provider provider route that served the call.
 * @property {string} model provider-owned model id.
 * @property {CallKind} kind what produced the call.
 * @property {TokenTotals} tokens canonical totals for this one call.
 * @property {number} promptTokens derived prompt size, cached shares included.
 * @property {number} [contextWindow] advertised capacity of the route, when known.
 * @property {string} [reasoningEffort] requested reasoning effort, when known.
 * @property {boolean} [interrupted] the turn was cancelled mid-stream.
 * @property {string} [compactionId] owning compaction, for `compaction` calls.
 */

/**
 * Per-model rollup.
 * @typedef {object} ModelRollup
 * @property {string} provider provider route.
 * @property {string} model provider-owned model id.
 * @property {number} calls billed calls attributed to this route.
 * @property {number} sessions distinct sessions that used this route.
 * @property {number} inputTokens uncached prompt tokens.
 * @property {number} outputTokens completion tokens.
 * @property {number} cacheReadTokens cached prompt tokens.
 * @property {number} cacheWriteTokens prompt tokens written to cache.
 * @property {number} reasoningTokens reasoning subset.
 * @property {number} totalTokens billed total.
 * @property {number} promptTokens prompt tokens, cached shares included.
 * @property {number} [cacheHitRate] cached share of prompt tokens.
 * @property {number} [costUsd] estimated cost when the model is priced.
 */

/**
 * Per-project rollup (one project is one session working directory).
 * @typedef {object} ProjectRollup
 * @property {string} project display name of the project.
 * @property {string | null} cwd absolute working directory, when the log recorded one.
 * @property {number} sessions distinct sessions.
 * @property {number} calls billed calls.
 * @property {TokenTotals} tokens totals.
 * @property {number} [costUsd] estimated cost when every model involved is priced.
 */

/**
 * Session-level rollup with its full call detail.
 * @typedef {object} SessionReport
 * @property {string} sessionId session id.
 * @property {string} [title] latest folded session title, when the log has one.
 * @property {string | null} cwd working directory recorded in the session header.
 * @property {string} [project] display name derived from `cwd`.
 * @property {number} createdAt Unix epoch milliseconds when the session was created.
 * @property {number} [updatedAt] timestamp of the newest event seen.
 * @property {string} [agentPreset] agent preset the session was composed from.
 * @property {'session' | 'subagent'} kind top-level session or subagent child.
 * @property {boolean} isSubagent true for a subagent child session.
 * @property {boolean} seeded true when the log carries a fork-inherited prefix.
 * @property {number} delegationDepth delegation depth, 0 for a top-level session.
 * @property {string} [parentSession] parent session id for a seeded or subagent child.
 * @property {number} logVersion physical session log version that was read.
 * @property {string} source absolute path of the log file that was read.
 * @property {number} bytes compressed size of that log file.
 * @property {number} inheritedEventCount fork-inherited event prefix length.
 * @property {number} turns turns observed in the owned (non-inherited) region.
 * @property {number} steps steps observed in the owned region.
 * @property {number} calls billed calls found in the owned region.
 * @property {number} [contextWindow] newest advertised route capacity.
 * @property {number} peakPromptTokens largest single prompt billed in this session.
 * @property {TokenTotals} tokens session totals.
 * @property {number} [costUsd] estimated cost when every model involved is priced.
 * @property {Array<{ turn: number, step: number, calls: number, tokens: TokenTotals }>} turnRollup per-turn totals.
 * @property {UsageCall[]} callDetails every billed call, oldest first.
 * @property {string[]} warnings non-fatal problems found while reading this log.
 */

/**
 * One bucket of a time series.
 * @typedef {object} SeriesBucket
 * @property {string} key bucket key (`YYYY-MM-DD`, `YYYY-MM-DDTHH`, or `YYYY-MM`).
 * @property {string} granularity bucket granularity.
 * @property {number} start Unix epoch milliseconds of the bucket start.
 * @property {number} calls billed calls in the bucket.
 * @property {number} sessions distinct sessions active in the bucket.
 * @property {TokenTotals} tokens totals for the bucket.
 */

/**
 * Applied filters, echoed back so every report is self-describing.
 * @typedef {object} AppliedFilters
 * @property {string[]} sessionIds explicit session id allow-list.
 * @property {string[]} excludeSessionIds explicit session id deny-list.
 * @property {string[]} models `provider/model` or bare `model` allow-list.
 * @property {string[]} providers provider allow-list.
 * @property {string[]} projects project-name allow-list.
 * @property {string[]} cwd working-directory allow-list.
 * @property {string[]} kinds `session` / `subagent` allow-list.
 * @property {number} [since] inclusive lower bound on call time.
 * @property {number} [until] inclusive upper bound on call time.
 * @property {string[]} agentPresets agent-preset allow-list.
 * @property {string} [search] case-insensitive substring matched against id, title, cwd and preset.
 * @property {number} [minTokens] drop sessions whose billed total is below this.
 */

/**
 * One complete report.
 * @typedef {object} UsageReport
 * @property {object} meta report metadata.
 * @property {number} meta.generatedAt Unix epoch milliseconds of report generation.
 * @property {string} meta.sessionsRoot directory the logs were read from.
 * @property {number} meta.logsScanned number of log files discovered.
 * @property {number} meta.logsRead number of logs actually parsed.
 * @property {number} meta.logsSkipped logs excluded before parsing.
 * @property {number} meta.bytesRead compressed bytes read.
 * @property {number} meta.elapsedMs wall time spent building the report.
 * @property {AppliedFilters} filters filters that produced this report.
 * @property {SessionReport[]} sessions matching sessions, newest first.
 * @property {UsageCall[]} calls matching calls, oldest first.
 * @property {TokenTotals} totals totals across all matching calls.
 * @property {object} summary headline figures.
 * @property {number} summary.sessions matching session count.
 * @property {number} summary.calls billed call count.
 * @property {number} summary.turns turn count.
 * @property {number} summary.steps step count.
 * @property {number} summary.models distinct model routes.
 * @property {number} summary.projects distinct projects.
 * @property {number} summary.subagentSessions subagent child sessions.
 * @property {number} summary.subagentTokens billed total spent by subagent children.
 * @property {number} summary.firstCallAt earliest matching call.
 * @property {number} summary.lastCallAt latest matching call.
 * @property {number} [summary.costUsd] estimated cost when every model involved is priced.
 * @property {boolean} summary.costComplete false when at least one model has no price.
 * @property {number} summary.peakPromptTokens largest single prompt in scope.
 * @property {ModelRollup[]} models per-model rollups, heaviest first.
 * @property {ProjectRollup[]} projects per-project rollups, heaviest first.
 * @property {SeriesBucket[]} series time series at the requested granularity.
 * @property {string} granularity granularity actually used.
 * @property {string[]} warnings non-fatal problems encountered while reading logs.
 */

/**
 * Per-million-token rates for one model route.
 * @typedef {object} ModelPrice
 * @property {number} [input] USD per million uncached prompt tokens.
 * @property {number} [output] USD per million completion tokens.
 * @property {number} [cacheRead] USD per million cached prompt tokens.
 * @property {number} [cacheWrite] USD per million cache-write tokens.
 */

/**
 * A price book keyed by `provider/model`, bare `model`, or `*`.
 * @typedef {Record<string, ModelPrice>} PriceBook
 */

export {}
