/**
 * The model-facing tools this bundle registers.
 *
 * Three tools, split by the question a caller is actually asking:
 *
 * - `usage_stats` — how much was spent, aggregated and filterable.
 * - `usage_sessions` — which sessions exist and what can be filtered by.
 * - `usage_calls` — the exact per-call ledger, one row per billed model call.
 *
 * Every number comes from provider-reported usage on durable session events;
 * nothing is estimated from text. When a provider omitted its exact total the
 * row says so instead of quietly presenting a derived number as reported.
 *
 * @module dsh-usage-stats-long/host/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderCallLine, renderReportSections } from '../core/render-text.js'
import { addInto, zeroTotals } from '../core/token-math.js'
import { formatTime, formatExact, formatTokens } from '../core/format.js'
import { FilterError } from '../core/filters.js'
import { describeError } from '../core/reader.js'

/**
 * @typedef {object} ToolContext
 * @property {import('./service.js').UsageStatsService} usageStats the statistics service.
 */

/** Filter parameters shared by every tool, flattened for a flat schema. */
const FILTER_PARAMETERS = {
  since: {
    type: 'string',
    description: 'Earliest call time to include: an ISO instant, "YYYY-MM-DD" (local midnight), or a relative span like "24h", "7d", "2w", "3mo".',
  },
  until: {
    type: 'string',
    description: 'Latest call time to include. Same formats as `since`; a bare date includes that whole day.',
  },
  sessionId: {
    type: 'string',
    description: 'Exact session id, or an unambiguous prefix such as "45ee17c8".',
  },
  excludeSessionIds: {
    type: 'string',
    description: 'Comma-separated session ids to exclude.',
  },
  model: {
    type: 'string',
    description: 'Model selector: "provider/model", a bare model id like "deepseek-flash", a provider name, or "provider/*". Comma-separated for several.',
  },
  provider: {
    type: 'string',
    description: 'Provider name allow-list, comma-separated, for example "deepseek-official".',
  },
  project: {
    type: 'string',
    description: 'Project (working-directory) name allow-list, comma-separated, for example "my-app".',
  },
  cwd: {
    type: 'string',
    description: 'Exact working-directory path allow-list, comma-separated.',
  },
  kind: {
    type: 'string',
    description: 'Session kind filter: "session" for top-level sessions, "subagent" for subagent children, comma-separated for both.',
  },
  agentPreset: {
    type: 'string',
    description: 'Agent-preset name allow-list, comma-separated, for example "standard".',
  },
  search: {
    type: 'string',
    description: 'Case-insensitive substring matched against session id, title, working directory and agent preset.',
  },
  minTokens: {
    type: 'number',
    description: 'Drop sessions whose billed total in scope is below this many tokens.',
  },
}

/** Render options shared by every reporting tool. */
const RENDER_PARAMETERS = {
  lang: {
    type: 'string',
    enum: ['en', 'zh'],
    description: 'Label language for the rendered answer. Defaults to "en".',
  },
  maxSessions: {
    type: 'integer',
    description: 'Maximum session rows to list. Defaults to 25.',
  },
  maxCalls: {
    type: 'integer',
    description: 'Maximum call rows to list. Defaults to 30 (200 for detail=full).',
  },
  maxBuckets: {
    type: 'integer',
    description: 'Maximum timeline rows to list. Defaults to 31.',
  },
}

/**
 * Translate flat tool arguments into the engine's filter record.
 *
 * @param {Record<string, any>} args validated tool arguments.
 * @returns {object} loose filter input for the engine.
 */
function filtersFromArgs(args) {
  /** @type {Record<string, any>} */
  const filters = {}
  for (const key of [
    'since', 'until', 'excludeSessionIds', 'model', 'provider', 'project',
    'cwd', 'kind', 'agentPreset', 'search', 'minTokens',
  ]) {
    if (args[key] !== undefined) filters[key] = args[key]
  }
  if (args.sessionId !== undefined) filters.sessionIds = args.sessionId
  if (args.models !== undefined) filters.models = args.models
  return filters
}

/**
 * Turn a thrown error into a tool result the model can act on.
 *
 * A bad filter is the caller's mistake and must be reported as such, with the
 * offending field named — not as an empty report, which would read as "no usage".
 *
 * @param {unknown} error thrown value.
 * @returns {string} an actionable message.
 */
function explain(error) {
  if (error instanceof FilterError) {
    return `Invalid filter "${error.field}": ${error.message}. Nothing was counted; correct the filter and retry.`
  }
  return `usage statistics failed: ${describeError(error)}`
}

/**
 * Register all three tools on a context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx context exposing `tools`.
 * @param {ToolContext} deps the statistics service to read from.
 * @returns {Array<() => void>} the disposers, one per registered tool.
 */
export function registerUsageTools(ctx, deps) {
  const { usageStats } = deps
  return [
    registerUsageStats(ctx, usageStats),
    registerUsageSessions(ctx, usageStats),
    registerUsageCalls(ctx, usageStats),
  ]
}

/**
 * `usage_stats` — the aggregate report.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx context exposing `tools`.
 * @param {import('./service.js').UsageStatsService} usageStats the statistics service.
 * @returns {() => void} the disposer.
 */
export function registerUsageStats(ctx, usageStats) {
  return ctx.tools.register(defineTool({
    name: 'usage_stats',
    description: [
      'Report accurate, provider-billed token usage across DeepSeek Harness sessions.',
      '',
      'Counts come from the exact usage the model provider returned for each call, as recorded on durable session events — they are not estimated from text. Each call reports uncached input, cache read, cache write, output, the reasoning subset of the output, and the billed total; a total the provider did not report is marked as derived.',
      '',
      'Filter by time window, session, model, provider, project, working directory, session kind, agent preset, or a text search, and group by model, project, session, turn, or day. Use `usage_sessions` first when you need to discover session ids or which models exist.',
      '',
      'Every figure is totals across matching calls; nothing is sampled or approximated.',
    ].join('\n'),
    parameters: {
      ...FILTER_PARAMETERS,
      ...RENDER_PARAMETERS,
      detail: {
        type: 'string',
        enum: ['compact', 'standard', 'full'],
        description: 'How much detail to render: compact (headline, models, sessions), standard (+ projects, timeline, turns), full (+ the per-call ledger). Defaults to "standard".',
      },
      granularity: {
        type: 'string',
        enum: ['auto', 'hour', 'day', 'week', 'month'],
        description: 'Timeline bucket size. "auto" picks one from the covered span.',
      },
      sections: {
        type: 'string',
        description: 'Comma-separated section allow-list to keep the answer small, for example "headline,models". Available: headline, models, projects, timeline, sessions, turns, calls, cost, status.',
      },
      includeStatus: {
        type: 'boolean',
        description: 'Append a diagnostics section: sessions root, bytes scanned, fold-cache state, price-book path.',
      },
      groupBy: {
        type: 'string',
        enum: ['model', 'project', 'session', 'turn', 'day', 'hour', 'week', 'month'],
        description: 'When set, returns machine-readable grouped rows for that dimension in `groups` instead of only the rendered report. "turn" requires a single session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', description: 'Rendered markdown report.' },
          groups: {
            type: 'array',
            description: 'Machine-readable grouped rows, present when `groupBy` was requested.',
            items: { type: 'json' },
          },
          totals: { type: 'json', description: 'Canonical totals across every matching call.' },
          meta: { type: 'json', description: 'Report provenance: logs scanned, bytes read, filters applied, warnings.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      try {
        const detailLevel = args.detail ?? 'standard'
        const report = await usageStats.report({
          filters: filtersFromArgs(args),
          detail: args.includeStatus === true || args.groupBy !== undefined ? 'full' : 'turns',
          granularity: args.granularity,
          signal: exec.signal,
        })
        const status = args.includeStatus === true ? await statusSnapshot(usageStats, report) : undefined
        const sections = renderReportSections(report, {
          detail: detailLevel,
          lang: args.lang,
          maxSessions: args.maxSessions,
          maxCalls: args.maxCalls,
          maxBuckets: args.maxBuckets,
          status,
        })
        const keep = parseSections(args.sections)
        const kept = keep === undefined ? sections : sections.filter((section) => keep.has(section.id))
        /** @type {string[]} */
        const lines = [`# Token usage report`]
        for (const section of kept) {
          lines.push('')
          lines.push(`## ${section.title}`, '')
          lines.push(...section.lines)
        }
        const groups = args.groupBy === undefined ? undefined : await groupRows(usageStats, args)
        return {
          report: lines.join('\n'),
          ...(groups === undefined ? {} : { groups }),
          totals: report.totals,
          meta: {
            sessionsRoot: report.meta.sessionsRoot,
            logsScanned: report.meta.logsScanned,
            bytesRead: report.meta.bytesRead,
            elapsedMs: report.meta.elapsedMs,
            cacheHits: report.meta.cacheHits,
            cacheMisses: report.meta.cacheMisses,
            matchingSessions: report.meta.matchingSessions,
            granularity: report.granularity,
            filters: report.filters,
            warnings: report.warnings.slice(0, 20),
            unpricedModels: report.summary.unpricedModels ?? [],
          },
        }
      } catch (error) {
        return {
          report: explain(error),
          totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, totalDerived: false },
          meta: { error: true, filters: {}, warnings: [] },
        }
      }
    },
  }))
}

/**
 * `usage_sessions` — the session catalog.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx context exposing `tools`.
 * @param {import('./service.js').UsageStatsService} usageStats the statistics service.
 * @returns {() => void} the disposer.
 */
export function registerUsageSessions(ctx, usageStats) {
  return ctx.tools.register(defineTool({
    name: 'usage_sessions',
    description: [
      'List DeepSeek Harness sessions with their metadata, models and billed token totals, so you can pick session ids to filter on.',
      '',
      'This is the discovery tool: it includes sessions that recorded no usage, which a usage report omits. Set `dimensions` to also get every model route, provider, project, session kind and agent preset currently present in the corpus.',
    ].join('\n'),
    parameters: {
      ...FILTER_PARAMETERS,
      limit: { type: 'integer', description: 'Maximum sessions to return. Defaults to 100.' },
      dimensions: { type: 'boolean', description: 'Also return the filterable vocabulary (models, providers, projects, kinds, presets).' },
      format: {
        type: 'string',
        enum: ['table', 'json'],
        description: '"table" renders markdown; "json" returns structured rows in `sessions`. Defaults to "table".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string' },
          sessions: { type: 'array', items: { type: 'json' } },
          dimensions: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      try {
        const { sessions } = await usageStats.sessions({
          filters: filtersFromArgs(args),
          signal: exec.signal,
        })
        const limit = Math.min(args.limit ?? 100, 1000)
        const rows = sessions.map((session) => ({
          sessionId: session.sessionId,
          title: session.title ?? null,
          cwd: session.cwd,
          project: session.project ?? null,
          kind: session.kind,
          agentPreset: session.agentPreset ?? null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt ?? null,
          turns: session.turns,
          steps: session.steps,
          calls: session.calls,
          peakPromptTokens: session.peakPromptTokens,
          tokens: session.tokens,
          models: [...new Set(session.callDetails.map((call) => `${call.provider}/${call.model}`))],
        }))
        /** @type {any} */
        const dimensions = args.dimensions === true
          ? await usageStats.dimensions({ signal: exec.signal })
          : undefined
        const text = args.format === 'json'
          ? JSON.stringify({ count: rows.length, sessions: rows.slice(0, limit), dimensions }, null, 2)
          : renderCatalogText(rows.slice(0, limit), sessions.length, dimensions)
        return {
          report: text,
          sessions: args.format === 'json' ? rows.slice(0, limit) : [],
          ...(dimensions === undefined ? {} : { dimensions }),
        }
      } catch (error) {
        return { report: explain(error), sessions: [] }
      }
    },
  }))
}

/**
 * `usage_calls` — the per-call ledger.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx context exposing `tools`.
 * @param {import('./service.js').UsageStatsService} usageStats the statistics service.
 * @returns {() => void} the disposer.
 */
export function registerUsageCalls(ctx, usageStats) {
  return ctx.tools.register(defineTool({
    name: 'usage_calls',
    description: [
      'Return the exact per-call token ledger: one row per billed model call, with session, event sequence number, turn, step, provider, model and every token counter the provider reported.',
      '',
      'Use this to audit a total, attribute spend to individual steps, or inspect a single session call by call. Totals are the same numbers `usage_stats` aggregates — this tool shows the rows they came from.',
    ].join('\n'),
    parameters: {
      ...FILTER_PARAMETERS,
      limit: { type: 'integer', description: 'Maximum calls to return. Defaults to 50, capped at 5000.' },
      order: {
        type: 'string',
        enum: ['time', 'size'],
        description: '"time" lists oldest first; "size" lists the heaviest calls first. Defaults to "time".',
      },
      includeText: {
        type: 'boolean',
        description: 'Render a compact one-line summary per call instead of a markdown table.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string' },
          calls: { type: 'array', items: { type: 'json' } },
          totals: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      try {
        const report = await usageStats.report({
          filters: filtersFromArgs(args),
          detail: 'full',
          signal: exec.signal,
        })
        const limit = Math.min(args.limit ?? 50, 5000)
        const ordered = args.order === 'size'
          ? [...report.calls].sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens)
          : report.calls
        const rows = ordered.slice(0, limit).map((call) => ({
          sessionId: call.sessionId,
          seq: call.seq,
          time: call.time,
          timeText: formatTime(call.time),
          turn: call.turn,
          step: call.step,
          provider: call.provider,
          model: call.model,
          kind: call.kind,
          tokens: call.tokens,
          promptTokens: call.promptTokens,
          ...(call.contextWindow === undefined ? {} : { contextWindow: call.contextWindow }),
          ...(call.reasoningEffort === undefined ? {} : { reasoningEffort: call.reasoningEffort }),
          ...(call.interrupted === true ? { interrupted: true } : {}),
          ...(call.compactionId === undefined ? {} : { compactionId: call.compactionId }),
        }))
        /** @type {string[]} */
        const lines = [
          `# Model call ledger`,
          '',
          `- Matching calls: ${formatExact(report.calls.length)} across ${formatExact(report.summary.sessions)} session(s)`,
          `- Totals: ${formatExact(report.totals.totalTokens)} tokens (${formatTokens(report.totals.totalTokens)})`,
          `- Showing: ${formatExact(rows.length)} row(s), ordered by ${args.order === 'size' ? 'size' : 'time'}`,
          '',
        ]
        if (args.includeText === true) {
          for (const call of ordered.slice(0, limit)) lines.push(`- ${renderCallLine(call)}`)
        } else {
          lines.push('| Time | Session | seq | turn/step | Provider | Model | Uncached in | Cache read | Cache write | Output | Reasoning | Total |')
          lines.push('| --- | --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
          for (const call of ordered.slice(0, limit)) {
            lines.push([
              formatTime(call.time),
              call.sessionId.replace(/^session-/, '').slice(0, 12),
              String(call.seq),
              `${call.turn}/${call.step}`,
              call.provider,
              call.model,
              formatExact(call.tokens.inputTokens),
              formatExact(call.tokens.cacheReadTokens),
              formatExact(call.tokens.cacheWriteTokens),
              formatExact(call.tokens.outputTokens),
              formatExact(call.tokens.reasoningTokens),
              `${formatExact(call.tokens.totalTokens)}${call.tokens.totalDerived ? ' *' : ''}`,
            ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
          }
          if (report.calls.length > rows.length) {
            lines.push('')
            lines.push(`> ${formatExact(report.calls.length - rows.length)} further call(s) matched; raise \`limit\` to see them.`)
          }
        }
        return { report: lines.join('\n'), calls: rows, totals: report.totals }
      } catch (error) {
        return { report: explain(error), calls: [], totals: {} }
      }
    },
  }))
}

/**
 * Parse a comma-separated section allow-list.
 *
 * @param {string | undefined} value caller input.
 * @returns {Set<string> | undefined} the requested sections, or undefined for "all".
 */
function parseSections(value) {
  if (value === undefined || value.trim().length === 0) return undefined
  const parts = value.split(',').map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0)
  return parts.length === 0 ? undefined : new Set(parts)
}

/**
 * Build the service status snapshot the tool reports.
 *
 * @param {import('./service.js').UsageStatsService} usageStats the statistics service.
 * @param {import('../core/types.js').UsageReport} report the report in flight.
 * @returns {Promise<object>} a plain-data status.
 */
async function statusSnapshot(usageStats, report) {
  const status = usageStats.status()
  const reload = usageStats.reloadPrices()
  return {
    ...status,
    ...(reload.ok === false ? { priceError: reload.error } : {}),
    sessionsRoot: report.meta.sessionsRoot,
  }
}

/**
 * Group the in-scope calls by one dimension, machine-readably.
 *
 * @param {import('./service.js').UsageStatsService} usageStats the statistics service.
 * @param {Record<string, any>} args tool arguments.
 * @returns {Promise<object[]>} grouped rows.
 */
async function groupRows(usageStats, args) {
  const report = await usageStats.report({
    filters: filtersFromArgs(args),
    detail: 'turns',
    granularity: args.granularity,
  })
  const dimension = args.groupBy
  /** @type {Map<string, { key: string, calls: number, sessions: Set<string>, tokens: import('../core/types.js').TokenTotals }>} */
  const groups = new Map()
  for (const call of report.calls) {
    const key = groupKeyFor(call, dimension, report.granularity)
    if (key === undefined) continue
    let entry = groups.get(key)
    if (entry === undefined) {
      entry = { key, calls: 0, sessions: new Set(), tokens: zeroTotals() }
      groups.set(key, entry)
    }
    entry.calls += 1
    entry.sessions.add(call.sessionId)
    addInto(entry.tokens, call.tokens)
  }
  return [...groups.values()]
    .map((entry) => ({ key: entry.key, calls: entry.calls, sessions: entry.sessions.size, tokens: entry.tokens }))
    .sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens)
}

/**
 * Compute one call's bucket key for a requested grouping dimension.
 *
 * @param {import('../core/types.js').UsageCall} call one call.
 * @param {string | undefined} dimension requested dimension.
 * @param {string} seriesGranularity granularity the report chose, for day/hour buckets.
 * @returns {string | undefined} the bucket key, or undefined when the dimension is unknown.
 */
function groupKeyFor(call, dimension, seriesGranularity) {
  switch (dimension) {
    case 'model': return `${call.provider}/${call.model}`
    case 'session': return call.sessionId
    case 'turn': return `${call.sessionId}#turn-${call.turn}`
    case 'day': return formatTime(call.time).slice(0, 10)
    case 'hour': return formatTime(call.time).slice(0, 13)
    case 'week':
    case 'month': {
      void seriesGranularity
      return formatTime(call.time).slice(0, 7)
    }
    default: return undefined
  }
}

/**
 * Render the session catalog as markdown.
 *
 * @param {any[]} rows session rows.
 * @param {number} total sessions matched before the limit.
 * @param {any} [dimensions] filterable vocabulary.
 * @returns {string} markdown.
 */
function renderCatalogText(rows, total, dimensions) {
  /** @type {string[]} */
  const lines = [`# Sessions`, '', `- Matching sessions: ${formatExact(total)}`, `- Showing: ${formatExact(rows.length)}`, '']
  lines.push('| Session | Title | Project | Kind | Models | Calls | Turns | Total tokens | Peak prompt | Last call |')
  lines.push('| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |')
  for (const row of rows) {
    lines.push([
      row.sessionId.replace(/^session-/, '').slice(0, 20),
      (row.title ?? '-').replaceAll('|', '\\|').slice(0, 48),
      (row.project ?? '-').replaceAll('|', '\\|'),
      row.kind,
      row.models.map((model) => model.split('/')[1] ?? model).join(', ') || '-',
      formatExact(row.calls),
      formatExact(row.turns),
      formatExact(row.tokens.totalTokens),
      formatExact(row.peakPromptTokens),
      row.updatedAt === null ? '-' : formatTime(row.updatedAt),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  if (dimensions !== undefined) {
    lines.push('')
    lines.push('## Filterable vocabulary')
    lines.push('')
    lines.push(`- Providers: ${dimensions.providers.join(', ') || '(none)'}`)
    lines.push(`- Models: ${dimensions.models.map((model) => `${model.provider}/${model.model} (${formatExact(model.calls)} calls)`).join(', ') || '(none)'}`)
    lines.push(`- Projects: ${dimensions.projects.map((project) => project.project).join(', ') || '(none)'}`)
    lines.push(`- Kinds: ${dimensions.kinds.join(', ') || '(none)'}`)
    lines.push(`- Agent presets: ${dimensions.agentPresets.join(', ') || '(none)'}`)
    lines.push(`- Sessions: ${formatExact(dimensions.sessions.total)} total, ${formatExact(dimensions.sessions.withUsage)} with usage, ${formatExact(dimensions.sessions.subagents)} subagent children`)
  }
  return lines.join('\n')
}
