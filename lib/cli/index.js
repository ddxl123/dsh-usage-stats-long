/**
 * The `dsh-usage-stats` command line interface.
 *
 * The CLI is a thin shell over the same engine the plugin uses, so a figure
 * printed in a terminal and a figure returned to the model come from one
 * implementation. It never requires the harness to be running: it reads the
 * session corpus directly.
 *
 * @module dsh-usage-stats-long/cli
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildReport,
  compileFilters,
  describeFilters,
  formatDuration,
  formatExact,
  formatPercent,
  formatTime,
  formatTokens,
  formatUsd,
  loadPriceBookFile,
  renderCallLine,
  renderReport,
  renderReportSections,
  renderSessionCatalog,
  resolveSessionsRoot,
  turnRows,
} from '../core/index.js'
import { renderDashboard } from '../core/render-html.js'

/** @typedef {import('../core/types.js').UsageReport} UsageReport */

/** Every filter flag the CLI accepts, mapped to its engine field. */
const FILTER_FLAGS = [
  ['--since', 'since', 'Earliest call time: ISO instant, YYYY-MM-DD, or 24h/7d/2w/3mo'],
  ['--until', 'until', 'Latest call time'],
  ['--session', 'sessionIds', 'Session id or unambiguous prefix (repeatable, comma-separated)'],
  ['--exclude-session', 'excludeSessionIds', 'Session id to exclude'],
  ['--model', 'models', 'Model selector: provider/model, model, provider, or provider/*'],
  ['--provider', 'providers', 'Provider name'],
  ['--project', 'projects', 'Project (working-directory) name'],
  ['--cwd', 'cwd', 'Exact working directory path'],
  ['--kind', 'kinds', 'session | subagent'],
  ['--preset', 'agentPresets', 'Agent preset name'],
  ['--search', 'search', 'Substring matched against id, title, cwd and preset'],
  ['--min-tokens', 'minTokens', 'Drop sessions below this billed total'],
]

/** Usage text, kept next to the flags it documents. */
export const USAGE = `dsh-usage-stats — accurate token usage for DeepSeek Harness sessions

Usage:
  dsh-usage-stats <command> [filters] [options]

Commands:
  summary        Headline totals plus per-model and per-session tables (default)
  models         Per-model rollup
  projects       Per-project rollup
  sessions       Session catalog, including sessions with no recorded usage
  timeline       Time-distributed usage with a terminal bar chart
  turns          Per-turn detail (requires --session)
  calls          The exact per-call ledger
  dashboard      Write a self-contained interactive HTML dashboard
  export         Write the whole report as JSON
  filters        Print the filters that were applied, then exit
  help           Show this text

Filters:
${FILTER_FLAGS.map(([flag, , help]) => `  ${flag.padEnd(18)} ${help}`).join('\n')}

Options:
  --sessions-root <dir>   Session corpus root (default: $DSH_HOME/sessions)
  --prices <file>         JSON price book for cost columns
  --detail <level>        compact | standard | full (default: standard)
  --granularity <size>    auto | hour | day | week | month
  --lang <en|zh>          Label language
  --limit <n>             Row limit for the chosen view
  --out <file>            Write output to a file instead of stdout
  --json                  Emit machine-readable JSON (where supported)
  --no-color              Disable ANSI color
  --quiet                 Suppress the progress line
  -h, --help              Show this text

Examples:
  dsh-usage-stats summary --since 7d
  dsh-usage-stats models --model deepseek-flash --lang zh
  dsh-usage-stats calls --session 45ee17c8 --limit 100
  dsh-usage-stats dashboard --prices ./prices.json --out usage.html
`

/**
 * Parse argv into a command, filter record and options.
 *
 * @param {string[]} argv raw arguments after the executable.
 * @returns {{ command: string, filters: Record<string, any>, options: Record<string, any>, help: boolean }} parsed input.
 * @throws {Error} on an unknown flag or a missing value.
 */
export function parseArgv(argv) {
  const args = [...argv]
  let command = 'summary'
  if (args.length > 0 && !args[0].startsWith('-')) command = args.shift()
  /** @type {Record<string, any>} */
  const filters = {}
  /** @type {Record<string, any>} */
  const options = { help: false, json: false, color: process.stdout.isTTY === true, quiet: false }
  const filterByFlag = new Map(FILTER_FLAGS.map(([flag, field]) => [flag, field]))
  while (args.length > 0) {
    const raw = args.shift()
    if (raw === undefined) break
    if (raw === '-h' || raw === '--help') { options.help = true; continue }
    if (raw === '--json') { options.json = true; continue }
    if (raw === '--no-color') { options.color = false; continue }
    if (raw === '--quiet') { options.quiet = true; continue }
    const equals = raw.indexOf('=')
    const flag = equals > 0 ? raw.slice(0, equals) : raw
    const inlineValue = equals > 0 ? raw.slice(equals + 1) : undefined
    /**
     * @param {string} name flag being read, for the error message.
     * @returns {string} the flag's value.
     */
    const take = (name) => {
      if (inlineValue !== undefined) return inlineValue
      const next = args.shift()
      if (next === undefined) throw new Error(`${name} requires a value`)
      return next
    }
    if (filterByFlag.has(flag)) {
      const field = filterByFlag.get(flag)
      const value = take(flag)
      const repeated = filters[field]
      filters[field] = repeated === undefined
        ? value
        : `${Array.isArray(repeated) ? repeated.join(',') : repeated},${value}`
      continue
    }
    switch (flag) {
      case '--sessions-root': options.sessionsRoot = take(flag); break
      case '--prices': options.prices = take(flag); break
      case '--detail': options.detail = take(flag); break
      case '--granularity': options.granularity = take(flag); break
      case '--lang': options.lang = take(flag); break
      case '--limit': options.limit = Number.parseInt(take(flag), 10); break
      case '--max-sessions': options.maxSessions = Number.parseInt(take(flag), 10); break
      case '--max-calls': options.maxCalls = Number.parseInt(take(flag), 10); break
      case '--max-buckets': options.maxBuckets = Number.parseInt(take(flag), 10); break
      case '--out': options.out = take(flag); break
      case '--order': options.order = take(flag); break
      case '--title': options.title = take(flag); break
      case '--min-tokens': {
        filters.minTokens = Number(take(flag))
        break
      }
      default:
        throw new Error(`unknown option: ${flag}\n\n${USAGE}`)
    }
  }
  return { command, filters, options, help: options.help === true }
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv raw arguments after the executable.
 * @param {object} [io] output sinks, for tests.
 * @param {(text: string) => void} [io.out] stdout writer.
 * @param {(text: string) => void} [io.err] stderr writer.
 * @returns {Promise<number>} the process exit code.
 */
export async function run(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text))
  const err = io.err ?? ((text) => process.stderr.write(text))
  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const { command, filters, options } = parsed
  if (parsed.help || command === 'help') {
    out(USAGE)
    return 0
  }

  // A price book is loaded before the scan so an unreadable file fails loudly
  // instead of silently producing a report with no cost column.
  /** @type {any} */
  let prices
  if (options.prices !== undefined) {
    try {
      prices = loadPriceBookFile(options.prices)
    } catch (error) {
      err(`${error instanceof Error ? error.message : String(error)}\n`)
      return 2
    }
  }

  // The CLI's `--detail` names how much to *show*; the engine's `detail` names
  // how much per-call data to *retain*. They are translated here so a caller
  // never has to know both vocabularies.
  const showDetail = options.detail ?? 'standard'
  if (!['compact', 'standard', 'full'].includes(showDetail)) {
    err(`--detail must be compact, standard or full (got "${showDetail}")\n`)
    return 2
  }
  // `sessions` and `turns` read per-call detail, so they force full retention.
  const retain = command === 'calls' || command === 'sessions' || command === 'turns' || showDetail === 'full'
    ? 'full'
    : showDetail === 'compact' ? 'none' : 'turns'
  /** @type {UsageReport} */
  let report
  try {
    report = await buildReport({
      sessionsRoot: options.sessionsRoot,
      filters,
      prices,
      detail: retain,
      granularity: options.granularity,
      onProgress: options.quiet ? undefined : (progress) => {
        if (progress.phase === 'read' && progress.done === progress.total) {
          err(`read ${progress.total} session log(s)\n`)
        }
      },
    })
  } catch (error) {
    err(`failed to build the usage report: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const sink = (text) => {
    if (options.out === undefined) {
      out(text.endsWith('\n') ? text : `${text}\n`)
      return
    }
    writeFileSync(resolve(options.out), text.endsWith('\n') ? text : `${text}\n`)
    err(`wrote ${resolve(options.out)}\n`)
  }

  switch (command) {
    case 'filters': {
      const { filters: compiled } = compileFilters(filters)
      sink(JSON.stringify({ filters: compiled, sessionsRoot: resolveSessionsRoot(options.sessionsRoot) }, null, 2))
      return 0
    }
    case 'summary': {
      if (options.json) { sink(JSON.stringify(reportJson(report), null, 2)); return 0 }
      sink(renderReport(report, {
        detail: showDetail,
        lang: options.lang,
        maxSessions: options.maxSessions,
        maxCalls: options.maxCalls,
        maxBuckets: options.maxBuckets,
      }))
      return 0
    }
    case 'models': {
      const sections = renderReportSections(report, { detail: 'compact' })
      sink(head(sections, ['models']))
      return 0
    }
    case 'projects': {
      const sections = renderReportSections(report, { detail: 'standard' })
      sink(head(sections, ['projects']))
      return 0
    }
    case 'sessions': {
      sink(renderSessionCatalog(report.sessions, { lang: options.lang, limit: options.limit ?? 100 }))
      return 0
    }
    case 'timeline': {
      sink(renderTimeline(report, { lang: options.lang, limit: options.limit, color: options.color === true }))
      return 0
    }
    case 'turns': {
      if (report.sessions.length === 0) {
        sink('No session matched the filters.\n')
        return 0
      }
      if (report.sessions.length > 1) {
        err(`${report.sessions.length} sessions matched; showing turns for the heaviest. Pass --session to pick one.\n`)
      }
      /** @type {string[]} */
      const lines = []
      for (const session of report.sessions.slice(0, options.limit ?? 5)) {
        lines.push(`# ${session.sessionId} — ${session.title ?? session.project ?? ''}`)
        lines.push('')
        lines.push('| Turn | Steps | Calls | Uncached input | Cache read | Output | Total | Model |')
        lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
        for (const row of turnRows(session)) {
          lines.push(`| ${row.turn} | ${row.steps} | ${row.calls} | ${formatExact(row.tokens.inputTokens)} | ${formatExact(row.tokens.cacheReadTokens)} | ${formatExact(row.tokens.outputTokens)} | ${formatExact(row.tokens.totalTokens)} | ${row.models.join(', ')} |`)
        }
        lines.push('')
      }
      sink(lines.join('\n'))
      return 0
    }
    case 'calls': {
      if (options.json) { sink(JSON.stringify(report.calls, null, 2)); return 0 }
      const limit = options.limit ?? 50
      const ordered = options.order === 'size'
        ? [...report.calls].sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens)
        : report.calls
      /** @type {string[]} */
      const lines = [
        `# Model call ledger`,
        '',
        `- Matching calls: ${formatExact(report.calls.length)} across ${formatExact(report.summary.sessions)} session(s)`,
        `- Total: ${formatExact(report.totals.totalTokens)} tokens (${formatTokens(report.totals.totalTokens)})`,
        `- Showing ${Math.min(limit, ordered.length)} row(s), ordered by ${options.order === 'size' ? 'size' : 'time'}`,
        '',
      ]
      for (const call of ordered.slice(0, limit)) lines.push(`- ${renderCallLine(call)}`)
      if (ordered.length > limit) lines.push('', `> ${formatExact(ordered.length - limit)} further call(s); raise --limit to see them.`)
      sink(lines.join('\n'))
      return 0
    }
    case 'dashboard': {
      const html = renderDashboard(report, {
        title: options.title ?? 'DSH token usage',
        lang: options.lang,
        prices,
        status: {
          sessionsRoot: report.meta.sessionsRoot,
          cachedSessions: 0,
          cacheSize: 0,
          priceBookPath: options.prices ?? null,
        },
      })
      if (options.out === undefined) {
        err('dashboard needs --out <file> (HTML on stdout would be unusable)\n')
        return 2
      }
      sink(html)
      return 0
    }
    case 'export': {
      sink(JSON.stringify(reportJson(report), null, 2))
      return 0
    }
    default:
      err(`unknown command: ${command}\n\n${USAGE}`)
      return 2
  }
}

/**
 * Render selected sections of a report as a standalone document.
 *
 * @param {Array<{ id: string, lines: string[] }>} sections rendered sections.
 * @param {string[]} ids section ids to keep.
 * @returns {string} the document.
 */
function head(sections, ids) {
  const keep = new Set(ids)
  /** @type {string[]} */
  const lines = ['# Token usage report']
  for (const section of sections) {
    if (!keep.has(section.id)) continue
    lines.push('')
    lines.push(`## ${section.title}`, '')
    lines.push(...section.lines)
  }
  return lines.join('\n')
}

/**
 * Render the timeline with a terminal bar chart.
 *
 * @param {UsageReport} report the report.
 * @param {object} options render options.
 * @param {string} [options.lang] label language.
 * @param {number} [options.limit] bucket limit.
 * @param {boolean} [options.color] whether ANSI color is allowed.
 * @returns {string} the rendered timeline.
 */
function renderTimeline(report, options) {
  if (report.series.length === 0) return 'No usage was recorded for this scope.\n'
  const limit = options.limit ?? 40
  const buckets = report.series.length > limit ? report.series.slice(-limit) : report.series
  const max = buckets.reduce((best, bucket) => Math.max(best, bucket.tokens.totalTokens), 0)
  const width = 34
  /** @type {string[]} */
  const lines = [
    `# Timeline (${report.granularity})`,
    '',
    report.series.length > limit ? `> showing the most recent ${limit} of ${report.series.length} buckets` : '',
    '',
  ]
  for (const bucket of buckets) {
    const filled = max > 0 ? Math.max(bucket.tokens.totalTokens > 0 ? 1 : 0, Math.round((bucket.tokens.totalTokens / max) * width)) : 0
    const cacheShare = bucket.tokens.totalTokens > 0 ? bucket.tokens.cacheReadTokens / bucket.tokens.totalTokens : 0
    const cacheWidth = Math.round(filled * cacheShare)
    const bar = options.color === true
      ? `\u001b[32m${'█'.repeat(cacheWidth)}\u001b[0m\u001b[36m${'█'.repeat(Math.max(0, filled - cacheWidth))}\u001b[0m`
      : `${'#'.repeat(cacheWidth)}${'='.repeat(Math.max(0, filled - cacheWidth))}`
    lines.push(`${bucket.key.padEnd(11)} ${bar.padEnd(options.color === true ? width + 17 : width)} ${formatTokens(bucket.tokens.totalTokens).padStart(9)}  ${String(bucket.calls).padStart(5)} calls  ${String(bucket.sessions).padStart(3)} sess`)
  }
  lines.push('')
  lines.push('green/# = cache read   cyan/= = uncached input + output')
  return `${lines.filter((line, index) => !(line === '' && lines[index - 1] === '')).join('\n')}\n`
}

/**
 * Reduce a report to a JSON-friendly shape for `export` and `--json`.
 *
 * @param {UsageReport} report the report.
 * @returns {object} the export payload.
 */
function reportJson(report) {
  return {
    meta: report.meta,
    filters: report.filters,
    summary: report.summary,
    totals: report.totals,
    granularity: report.granularity,
    models: report.models,
    projects: report.projects,
    series: report.series.map((bucket) => ({ key: bucket.key, calls: bucket.calls, sessions: bucket.sessions, tokens: bucket.tokens })),
    sessions: report.sessions.map((session) => ({
      ...session,
      callDetails: undefined,
      callCount: session.callDetails.length,
    })),
    calls: report.calls.map((call) => ({
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
      ...(call.interrupted === true ? { interrupted: true } : {}),
      ...(call.compactionId === undefined ? {} : { compactionId: call.compactionId }),
    })),
    warnings: report.warnings,
    derivedNote: report.totals.totalDerived
      ? 'Some provider totals were absent; those totals are derived from their parts.'
      : undefined,
    costNote: report.summary.costComplete === false
      ? `Cost is incomplete; unpriced models: ${(report.summary.unpricedModels ?? []).join(', ')}`
      : undefined,
    elapsedMs: report.meta.elapsedMs,
    cacheHitRate: report.totals.totalTokens > 0
      ? report.totals.cacheReadTokens / (report.totals.cacheReadTokens + report.totals.inputTokens + report.totals.cacheWriteTokens)
      : undefined,
    describeFilters: describeFilters(report.filters),
  }
}

export default { run, parseArgv, USAGE }
