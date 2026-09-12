/**
 * Model-facing text rendering of a usage report.
 *
 * A tool result and a terminal both need the same thing: the numbers a person
 * would have computed by hand, laid out so they can be checked. Every table
 * here is derived only from the report, so a rendered table and the JSON the
 * dashboard consumes can never disagree.
 *
 * @module dsh-usage-stats-long/core/render-text
 */

import { deriveRates } from './token-math.js'
import {
  formatDuration,
  formatExact,
  formatPercent,
  formatTime,
  formatTokens,
  formatUsd,
  markdownRow,
  truncate,
} from './format.js'
import { turnRows } from './aggregate.js'

/**
 * @typedef {import('./types.js').UsageReport} UsageReport
 * @typedef {import('./types.js').SessionReport} SessionReport
 * @typedef {import('./types.js').UsageCall} UsageCall
 */

/**
 * Column labels, so one renderer serves both shipped languages.
 * @type {Record<'en' | 'zh', Record<string, string>>}
 */
const LABELS = {
  en: {
    title: 'Token usage report',
    scope: 'Scope',
    generated: 'Generated',
    root: 'Sessions root',
    logs: 'Logs scanned',
    elapsed: 'Scan time',
    filters: 'Filters',
    noFilters: '(none — every session in the corpus)',
    warnings: 'Warnings',
    headline: 'Headline',
    sessions: 'Sessions',
    calls: 'Billed model calls',
    turns: 'Turns',
    steps: 'Steps',
    models: 'Model routes',
    projects: 'Projects',
    window: 'Window',
    uncachedInput: 'Uncached input',
    cacheRead: 'Cache read',
    cacheWrite: 'Cache write',
    output: 'Output',
    reasoning: 'Reasoning (in output)',
    prompt: 'Prompt tokens',
    total: 'Total tokens',
    cacheHitRate: 'Cache hit rate',
    estimatedCost: 'Estimated cost',
    peakPrompt: 'Largest single prompt',
    subagent: 'Subagent children',
    subagentTokens: 'Subagent spend',
    byModel: 'By model',
    byProject: 'By project',
    bySession: 'By session',
    timeline: 'Timeline',
    turnDetail: 'Turn detail',
    callDetail: 'Call detail',
    provider: 'Provider',
    model: 'Model',
    callsShort: 'Calls',
    sessionsShort: 'Sess',
    cacheReadShort: 'Cache read',
    cacheWriteShort: 'Cache write',
    totalShort: 'Total',
    cost: 'Cost',
    project: 'Project',
    session: 'Session',
    title2: 'Title',
    kind: 'Kind',
    peak: 'Peak prompt',
    updated: 'Last call',
    bucket: 'Bucket',
    turn: 'Turn',
    stepsShort: 'Steps',
    seq: 'seq',
    turnStep: 'turn/step',
    interrupted: 'interrupted',
    compaction: 'compaction',
    noRows: 'No usage was recorded for this scope.',
    truncation: 'Report was truncated to fit the requested limit.',
    derivedNote: 'Some provider totals were absent and are derived from their parts (marked *).',
    unpricedNote: 'Cost is incomplete: no price is configured for',
    detailNote: 'Call detail is listed oldest first; `usage_stats` detail=full returns every call.',
  },
  zh: {
    title: 'Token 用量报告',
    scope: '统计范围',
    generated: '生成时间',
    root: '会话目录',
    logs: '扫描日志',
    elapsed: '扫描耗时',
    filters: '筛选条件',
    noFilters: '（无 —— 语料库中的全部会话）',
    warnings: '警告',
    headline: '总体概况',
    sessions: '会话数',
    calls: '计费模型调用',
    turns: '轮次',
    steps: '步数',
    models: '模型路由',
    projects: '项目数',
    window: '时间范围',
    uncachedInput: '未命中缓存输入',
    cacheRead: '缓存读取',
    cacheWrite: '缓存写入',
    output: '输出',
    reasoning: '推理（含在输出内）',
    prompt: '提示词 tokens',
    total: '总 tokens',
    cacheHitRate: '缓存命中率',
    estimatedCost: '预估费用',
    peakPrompt: '单次最大提示词',
    subagent: '子代理会话',
    subagentTokens: '子代理消耗',
    byModel: '按模型',
    byProject: '按项目',
    bySession: '按会话',
    timeline: '时间分布',
    turnDetail: '轮次明细',
    callDetail: '调用明细',
    provider: '提供方',
    model: '模型',
    callsShort: '调用',
    sessionsShort: '会话',
    cacheReadShort: '缓存读',
    cacheWriteShort: '缓存写',
    totalShort: '合计',
    cost: '费用',
    project: '项目',
    session: '会话',
    title2: '标题',
    kind: '类型',
    peak: '峰值提示',
    updated: '最近调用',
    bucket: '时间桶',
    turn: '轮次',
    stepsShort: '步数',
    seq: '序号',
    turnStep: '轮/步',
    interrupted: '被中断',
    compaction: '压缩',
    noRows: '该范围内没有记录到用量。',
    truncation: '报告已按请求的上限截断。',
    derivedNote: '部分提供方未返回总计，已由分项推导（标 *）。',
    unpricedNote: '费用不完整：以下模型未配置价格',
    detailNote: '调用明细按时间从早到晚列出；usage_stats detail=full 返回全部调用。',
  },
}

/**
 * Render a complete report as compact markdown.
 *
 * @param {UsageReport} report the report to render.
 * @param {object} [options] render options.
 * @param {'compact' | 'standard' | 'full'} [options.detail] how much to include.
 * @param {'en' | 'zh'} [options.lang] label language.
 * @param {number} [options.maxSessions] session rows to list.
 * @param {number} [options.maxCalls] call rows to list.
 * @param {number} [options.maxBuckets] timeline rows to list.
 * @returns {string} the rendered report.
 */
export function renderReport(report, options = {}) {
  const sections = renderReportSections(report, options)
  const keep = options.sections === undefined || options.sections.length === 0
    ? undefined
    : new Set(options.sections)
  /** @type {string[]} */
  const lines = [`# ${sections[0].t.title}`]
  for (const section of sections) {
    if (keep !== undefined && !keep.has(section.id)) continue
    lines.push('')
    lines.push(`## ${section.title}`, '')
    lines.push(...section.lines)
  }
  return lines.join('\n')
}

/**
 * Render every section of a report separately.
 *
 * Sections exist so a caller can answer a narrow question without paying for a
 * whole report: the model tool keeps the sections a caller asked for, and the
 * dashboard reuses the same lines for its text export.
 *
 * @param {UsageReport} report the report to render.
 * @param {object} [options] render options.
 * @param {'compact' | 'standard' | 'full'} [options.detail] how much to include.
 * @param {'en' | 'zh'} [options.lang] label language.
 * @param {number} [options.maxSessions] session rows to list.
 * @param {number} [options.maxCalls] call rows to list.
 * @param {number} [options.maxBuckets] timeline rows to list.
 * @param {object} [options.status] service status to append as a diagnostics section.
 * @returns {Array<{ id: string, title: string, lines: string[], t: Record<string, string> }>} one entry per section.
 */
export function renderReportSections(report, options = {}) {
  const detail = options.detail ?? 'standard'
  const lang = options.lang === 'zh' ? 'zh' : 'en'
  const t = LABELS[lang]
  const maxSessions = options.maxSessions ?? (detail === 'compact' ? 10 : 25)
  const maxCalls = options.maxCalls ?? (detail === 'full' ? 200 : 30)
  const maxBuckets = options.maxBuckets ?? 31
  /** @type {Array<{ id: string, title: string, lines: string[], t: Record<string, string> }>} */
  const sections = []
  // Section lines exclude their own heading so that a caller rendering one
  // section (`head()`) and a caller rendering all of them produce the same
  // document rather than a duplicated heading.
  const push = (id, title, lines) => sections.push({ id, title, lines, t })

  push('meta', t.generated, renderMeta(report, t))

  if (report.summary.calls === 0) {
    push('empty', t.headline, [t.noRows])
    if (report.warnings.length > 0) push('warnings', t.warnings, renderWarnings(report, t))
    return sections
  }

  push('headline', t.headline, renderSummary(report, t))
  push('models', t.byModel, renderModels(report, t))
  if (detail !== 'compact') {
    push('projects', t.byProject, renderProjects(report, t))
    push('timeline', `${t.timeline} (${report.granularity})`, renderTimeline(report, t, maxBuckets))
  }
  push('sessions', t.bySession, renderSessions(report, t, maxSessions))
  if (detail !== 'compact') push('turns', t.turnDetail, renderTurns(report, t))
  push('calls', t.callDetail, renderCalls(report, t, maxCalls))
  if (report.summary.costComplete === false) {
    push('cost', t.estimatedCost, [`> ${t.unpricedNote}: ${(report.summary.unpricedModels ?? []).join(', ') || '(unknown)'}`])
  }
  if (options.status !== undefined) push('status', 'Service status', renderStatus(options.status, report))
  if (report.warnings.length > 0) push('warnings', t.warnings, renderWarnings(report, t))
  return sections
}

/**
 * Render the engine's own provenance and cache state.
 *
 * @param {object} status service status snapshot.
 * @param {UsageReport} report the report the status belongs to.
 * @returns {string[]} markdown lines.
 */
export function renderStatus(status, report) {
  const lines = []
  lines.push(`- sessionsRoot: \`${status.sessionsRoot ?? report.meta.sessionsRoot}\``)
  lines.push(`- logsScanned: ${formatExact(report.meta.logsScanned)} · bytesRead: ${formatExact(report.meta.bytesRead)}`)
  lines.push(`- cache: ${formatExact(status.cachedSessions ?? 0)}/${formatExact(status.cacheSize ?? 0)} folded sessions retained`)
  if (report.meta.cacheHits !== undefined) {
    lines.push(`- this query: ${formatExact(report.meta.cacheHits)} cache hit(s), ${formatExact(report.meta.cacheMisses ?? 0)} re-read`)
  }
  lines.push(`- priceBookPath: ${status.priceBookPath === null || status.priceBookPath === undefined ? '(none configured — costs are omitted, never guessed)' : `\`${status.priceBookPath}\``}`)
  if (status.priceError !== undefined) lines.push(`- priceBookError: ${status.priceError}`)
  if (report.warnings.length > 0) lines.push(`- warnings: ${formatExact(report.warnings.length)}`)
  return lines
}

/**
 * Render the report's provenance block.
 *
 * @param {UsageReport} report the report.
 * @param {Record<string, string>} t labels.
 * @returns {string[]} markdown lines.
 */
function renderMeta(report, t) {
  const lines = []
  lines.push(`- ${t.generated}: ${formatTime(report.meta.generatedAt)}`)
  lines.push(`- ${t.root}: \`${report.meta.sessionsRoot}\``)
  lines.push(`- ${t.logs}: ${formatExact(report.meta.logsScanned)} (${(report.meta.bytesRead / 1_048_576).toFixed(1)} MiB, ${formatDuration(report.meta.elapsedMs)})`)
  lines.push(`- ${t.filters}: ${describeFilters(report.filters, t)}`)
  return lines
}

/**
 * Render the headline figures.
 *
 * @param {UsageReport} report the report.
 * @param {Record<string, string>} t labels.
 * @returns {string[]} markdown lines.
 */
function renderSummary(report, t) {
  const { summary, totals } = report
  const rates = deriveRates(totals)
  const star = totals.totalDerived ? ' *' : ''
  const lines = []
  lines.push(`| ${t.sessions} | ${t.calls} | ${t.turns} | ${t.steps} | ${t.models} | ${t.projects} |`)
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: |')
  lines.push(markdownRow([
    formatExact(summary.sessions),
    formatExact(summary.calls),
    formatExact(summary.turns),
    formatExact(summary.steps),
    formatExact(summary.models),
    formatExact(summary.projects),
  ]))
  lines.push('')
  lines.push(`| ${t.uncachedInput} | ${t.cacheRead} | ${t.cacheWrite} | ${t.output} | ${t.reasoning} | ${t.prompt} | ${t.total} | ${t.cacheHitRate} |`)
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  lines.push(markdownRow([
    formatExact(totals.inputTokens),
    formatExact(totals.cacheReadTokens),
    formatExact(totals.cacheWriteTokens),
    formatExact(totals.outputTokens),
    formatExact(totals.reasoningTokens),
    formatExact(rates.promptTokens),
    `${formatExact(totals.totalTokens)}${star}`,
    formatPercent(rates.cacheHitRate),
  ]))
  lines.push('')
  lines.push(`- ${t.window}: ${formatTime(summary.firstCallAt)} → ${formatTime(summary.lastCallAt)}`)
  lines.push(`- ${t.peakPrompt}: ${formatExact(summary.peakPromptTokens)} (${formatTokens(summary.peakPromptTokens)})`)
  if (summary.subagentSessions > 0) {
    lines.push(`- ${t.subagent}: ${formatExact(summary.subagentSessions)} · ${t.subagentTokens}: ${formatExact(summary.subagentTokens)}`)
  }
  lines.push(`- ${t.estimatedCost}: ${formatUsd(summary.costUsd)}${summary.costComplete ? '' : ' (partial)'}`)
  if (totals.totalDerived) lines.push(`- ${t.derivedNote}`)
  return lines
}

/**
 * Render the per-model table.
 *
 * @param {UsageReport} report the report.
 * @param {Record<string, string>} t labels.
 * @returns {string[]} markdown lines.
 */
function renderModels(report, t) {
  const lines = []
  lines.push(markdownRow([
    t.provider, t.model, t.callsShort, t.sessionsShort, t.uncachedInput,
    t.cacheReadShort, t.cacheWriteShort, t.output, t.reasoning, t.totalShort, t.cacheHitRate, t.cost,
  ]))
  lines.push(markdownRow(new Array(12).fill('---')))
  for (const model of report.models) {
    lines.push(markdownRow([
      model.provider,
      model.model,
      formatExact(model.calls),
      formatExact(model.sessions),
      formatExact(model.inputTokens),
      formatExact(model.cacheReadTokens),
      formatExact(model.cacheWriteTokens),
      formatExact(model.outputTokens),
      formatExact(model.reasoningTokens),
      formatExact(model.totalTokens),
      formatPercent(model.cacheHitRate),
      formatUsd(model.costUsd),
    ]))
  }
  return lines
}

/**
 * Render the per-project table.
 *
 * @param {UsageReport} report the report.
 * @param {Record<string, string>} t labels.
 * @returns {string[]} markdown lines.
 */
function renderProjects(report, t) {
  const lines = []
  lines.push(markdownRow([t.project, t.sessionsShort, t.callsShort, t.uncachedInput, t.cacheReadShort, t.output, t.totalShort, t.cacheHitRate, t.cost]))
  lines.push(markdownRow(new Array(9).fill('---')))
  for (const project of report.projects) {
    const rates = deriveRates(project.tokens)
    lines.push(markdownRow([
      truncate(project.project, 32),
      formatExact(project.sessions),
      formatExact(project.calls),
      formatExact(project.tokens.inputTokens),
      formatExact(project.tokens.cacheReadTokens),
      formatExact(project.tokens.outputTokens),
      formatExact(project.tokens.totalTokens),
      formatPercent(rates.cacheHitRate),
      formatUsd(project.costUsd),
    ]))
  }
  return lines
}

/**
 * Render the time series.
 *
 * @param {UsageReport} report the report.
 * @param {Record<string, string>} t labels.
 * @param {number} maxBuckets row budget; the most recent buckets are kept.
 * @returns {string[]} markdown lines.
 */
function renderTimeline(report, t, maxBuckets) {
  const lines = []
  const buckets = report.series.length > maxBuckets ? report.series.slice(-maxBuckets) : report.series
  if (report.series.length > maxBuckets) {
    lines.push(`> showing the most recent ${maxBuckets} of ${report.series.length} buckets`)
    lines.push('')
  }
  lines.push(markdownRow([t.bucket, t.callsShort, t.sessionsShort, t.uncachedInput, t.cacheReadShort, t.output, t.totalShort]))
  lines.push(markdownRow(new Array(7).fill('---')))
  for (const bucket of buckets) {
    lines.push(markdownRow([
      bucket.key,
      formatExact(bucket.calls),
      formatExact(bucket.sessions),
      formatExact(bucket.tokens.inputTokens),
      formatExact(bucket.tokens.cacheReadTokens),
      formatExact(bucket.tokens.outputTokens),
      formatExact(bucket.tokens.totalTokens),
    ]))
  }
  return lines
}

/**
 * Render the per-session table.
 *
 * @param {UsageReport} report the report.
 * @param {Record<string, string>} t labels.
 * @param {number} maxSessions row budget.
 * @returns {string[]} markdown lines.
 */
function renderSessions(report, t, maxSessions) {
  const lines = []
  const sessions = report.sessions.slice(0, maxSessions)
  if (report.sessions.length > sessions.length) {
    lines.push(`> showing the ${sessions.length} heaviest of ${report.sessions.length} sessions`)
    lines.push('')
  }
  lines.push(markdownRow([t.session, t.title2, t.project, t.kind, t.callsShort, t.turns, t.uncachedInput, t.cacheReadShort, t.output, t.totalShort, t.peak, t.updated]))
  lines.push(markdownRow(new Array(12).fill('---')))
  for (const session of sessions) {
    lines.push(markdownRow([
      session.sessionId.replace(/^session-/, ''),
      truncate(session.title ?? '-', 40),
      truncate(session.project ?? '-', 24),
      session.kind,
      formatExact(session.calls),
      formatExact(session.turns),
      formatExact(session.tokens.inputTokens),
      formatExact(session.tokens.cacheReadTokens),
      formatExact(session.tokens.outputTokens),
      formatExact(session.tokens.totalTokens),
      formatExact(session.peakPromptTokens),
      formatTime(session.updatedAt ?? session.createdAt),
    ]))
  }
  return lines
}

/**
 * Render per-turn detail for each session in scope.
 *
 * @param {UsageReport} report the report.
 * @param {Record<string, string>} t labels.
 * @returns {string[]} markdown lines.
 */
function renderTurns(report, t) {
  const lines = []
  let emitted = 0
  for (const session of report.sessions) {
    const rows = turnRows(session)
    if (rows.length === 0) continue
    lines.push(`### ${session.sessionId.replace(/^session-/, '')} — ${truncate(session.title ?? session.project ?? '', 60)}`)
    lines.push('')
    lines.push(markdownRow([t.turn, t.stepsShort, t.callsShort, t.uncachedInput, t.cacheReadShort, t.output, t.totalShort, t.model]))
    lines.push(markdownRow(new Array(8).fill('---')))
    for (const row of rows) {
      lines.push(markdownRow([
        formatExact(row.turn),
        formatExact(row.steps),
        formatExact(row.calls),
        formatExact(row.tokens.inputTokens),
        formatExact(row.tokens.cacheReadTokens),
        formatExact(row.tokens.outputTokens),
        formatExact(row.tokens.totalTokens),
        row.models.join(', '),
      ]))
    }
    lines.push('')
    emitted += 1
  }
  if (emitted === 0) lines.push(t.noRows)
  return lines
}

/**
 * Render individual model calls.
 *
 * @param {UsageReport} report the report.
 * @param {Record<string, string>} t labels.
 * @param {number} maxCalls row budget.
 * @returns {string[]} markdown lines.
 */
function renderCalls(report, t, maxCalls) {
  const lines = []
  lines.push(`> ${t.detailNote}`)
  lines.push('')
  const calls = report.calls.slice(0, maxCalls)
  if (report.calls.length > calls.length) {
    lines.push(`> ${t.truncation} (${calls.length} of ${report.calls.length})`)
    lines.push('')
  }
  lines.push(markdownRow([t.updated, t.session, t.seq, t.turnStep, t.provider, t.model, t.uncachedInput, t.cacheReadShort, t.cacheWriteShort, t.output, t.reasoning, t.totalShort]))
  lines.push(markdownRow(new Array(12).fill('---')))
  for (const call of calls) {
    lines.push(markdownRow([
      formatTime(call.time),
      call.sessionId.replace(/^session-/, '').slice(0, 12),
      formatExact(call.seq),
      `${call.turn}/${call.step}`,
      call.provider,
      call.model,
      formatExact(call.tokens.inputTokens),
      formatExact(call.tokens.cacheReadTokens),
      formatExact(call.tokens.cacheWriteTokens),
      formatExact(call.tokens.outputTokens),
      formatExact(call.tokens.reasoningTokens),
      `${formatExact(call.tokens.totalTokens)}${call.tokens.totalDerived ? ' *' : ''}${call.interrupted ? ` (${t.interrupted})` : ''}${call.kind === 'compaction' ? ` (${t.compaction})` : ''}`,
    ]))
  }
  return lines
}

/**
 * Render read warnings.
 *
 * @param {UsageReport} report the report.
 * @param {Record<string, string>} t labels.
 * @returns {string[]} markdown lines.
 */
function renderWarnings(report, t) {
  const lines = []
  const shown = report.warnings.slice(0, 20)
  for (const warning of shown) lines.push(`- ${warning}`)
  if (report.warnings.length > shown.length) {
    lines.push(`- … ${report.warnings.length - shown.length} more`)
  }
  return lines
}

/**
 * Describe the filters that produced a report in one line.
 *
 * @param {import('./types.js').AppliedFilters} filters compiled filters.
 * @param {Record<string, string>} t labels.
 * @returns {string} a human description.
 */
export function describeFilters(filters, t = LABELS.en) {
  /** @type {string[]} */
  const parts = []
  if (filters.sessionIds.length > 0) parts.push(`sessionIds=${filters.sessionIds.join('|')}`)
  if (filters.excludeSessionIds.length > 0) parts.push(`excludeSessionIds=${filters.excludeSessionIds.join('|')}`)
  if (filters.models.length > 0) parts.push(`models=${filters.models.join('|')}`)
  if (filters.providers.length > 0) parts.push(`providers=${filters.providers.join('|')}`)
  if (filters.projects.length > 0) parts.push(`projects=${filters.projects.join('|')}`)
  if (filters.cwd.length > 0) parts.push(`cwd=${filters.cwd.join('|')}`)
  if (filters.kinds.length > 0) parts.push(`kinds=${filters.kinds.join('|')}`)
  if (filters.agentPresets.length > 0) parts.push(`agentPresets=${filters.agentPresets.join('|')}`)
  if (filters.since !== undefined) parts.push(`since=${formatTime(filters.since)}`)
  if (filters.until !== undefined) parts.push(`until=${formatTime(filters.until)}`)
  if (filters.search !== undefined) parts.push(`search=${filters.search}`)
  if (filters.minTokens !== undefined) parts.push(`minTokens=${filters.minTokens}`)
  return parts.length === 0 ? t.noFilters : parts.join(', ')
}

/**
 * Render just the session catalog as a table.
 *
 * @param {readonly SessionReport[]} sessions sessions to list.
 * @param {object} [options] render options.
 * @param {'en' | 'zh'} [options.lang] label language.
 * @param {number} [options.limit] row budget.
 * @returns {string} markdown.
 */
export function renderSessionCatalog(sessions, options = {}) {
  const t = LABELS[options.lang === 'zh' ? 'zh' : 'en']
  const limit = options.limit ?? 100
  const lines = [`# ${options.lang === 'zh' ? '会话目录' : 'Session catalog'}`, '']
  if (sessions.length === 0) {
    lines.push(t.noRows)
    return lines.join('\n')
  }
  const shown = sessions.slice(0, limit)
  lines.push(`> ${shown.length} / ${sessions.length}`)
  lines.push('')
  lines.push(markdownRow([t.session, t.title2, t.project, t.kind, t.models, t.callsShort, t.turns, t.totalShort, t.peak, t.updated]))
  lines.push(markdownRow(new Array(10).fill('---')))
  for (const session of shown) {
    const models = [...new Set(session.callDetails.map((call) => call.model))]
    lines.push(markdownRow([
      session.sessionId.replace(/^session-/, ''),
      truncate(session.title ?? '-', 40),
      truncate(session.project ?? '-', 24),
      session.kind,
      models.join(', ') || '-',
      formatExact(session.calls),
      formatExact(session.turns),
      formatExact(session.tokens.totalTokens),
      formatExact(session.peakPromptTokens),
      formatTime(session.updatedAt ?? session.createdAt),
    ]))
  }
  return lines.join('\n')
}

/**
 * Render one call as a single-line detail string, for drill-down output.
 *
 * @param {UsageCall} call the call.
 * @returns {string} a compact description.
 */
export function renderCallLine(call) {
  const parts = [
    formatTime(call.time),
    `seq=${call.seq}`,
    `turn=${call.turn}`,
    `step=${call.step}`,
    `${call.provider}/${call.model}`,
    `in=${call.tokens.inputTokens}`,
    `cacheRead=${call.tokens.cacheReadTokens}`,
    `cacheWrite=${call.tokens.cacheWriteTokens}`,
    `out=${call.tokens.outputTokens}`,
    `total=${call.tokens.totalTokens}${call.tokens.totalDerived ? '*' : ''}`,
  ]
  if (call.kind === 'compaction') parts.push('kind=compaction')
  if (call.interrupted) parts.push('interrupted')
  return parts.join(' · ')
}
