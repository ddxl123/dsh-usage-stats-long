/**
 * A single-file interactive dashboard for a usage report.
 *
 * The output is one self-contained HTML document with the report embedded as
 * JSON and every interaction implemented in plain inline JavaScript: no CDN, no
 * build step, no network access after the file is written. It opens from
 * `file://`, survives being emailed or committed, and needs no server.
 *
 * All derived rows (model, project, session, turn, call) are computed in the
 * browser from that one embedded report, so a filter can never show a number the
 * engine did not produce.
 *
 * @module dsh-usage-stats-long/core/render-html
 */

import { normalizePriceBook } from './pricing.js'
import { renderReport } from './render-text.js'

/**
 * @typedef {import('./types.js').UsageReport} UsageReport
 */

/**
 * Render a report as a self-contained dashboard document.
 *
 * @param {UsageReport} report the report to embed.
 * @param {object} [options] render options.
 * @param {string} [options.title] document title.
 * @param {string} [options.lang] document language (`en` or `zh`).
 * @param {object} [options.prices] price book to embed, so cost columns can be recomputed client-side.
 * @param {object} [options.status] service status shown in the diagnostics panel.
 * @returns {string} the complete HTML document.
 */
export function renderDashboard(report, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en'
  const title = options.title ?? 'DSH token usage'
  const payload = {
    report: serializeReport(report),
    prices: options.prices === undefined ? {} : normalizePriceBook(options.prices),
    status: options.status ?? null,
    text: renderReport(report, { detail: 'standard', lang }),
    lang,
  }
  const json = JSON.stringify(payload)
    // A `</script>` inside JSON would end the embedding element early.
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="dsh-usage-data">${json}</script>
<script>${DASHBOARD_SCRIPT}</script>
</body>
</html>
`
}

/**
 * Reduce a report to the fields the dashboard needs.
 *
 * Dropping nothing that a view reads but nothing that it does not keeps the
 * document small: a 10,000-call corpus still produces a file measured in a few
 * megabytes rather than tens.
 *
 * @param {UsageReport} report the report.
 * @returns {object} a JSON-safe payload.
 */
function serializeReport(report) {
  return {
    meta: report.meta,
    filters: report.filters,
    summary: report.summary,
    totals: report.totals,
    granularity: report.granularity,
    series: report.series,
    models: report.models,
    projects: report.projects.map((project) => ({ ...project, tokens: project.tokens })),
    warnings: report.warnings,
    sessions: report.sessions.map((session) => ({
      sessionId: session.sessionId,
      title: session.title ?? null,
      cwd: session.cwd,
      project: session.project ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt ?? null,
      agentPreset: session.agentPreset ?? null,
      kind: session.kind,
      isSubagent: session.isSubagent,
      delegationDepth: session.delegationDepth,
      logVersion: session.logVersion,
      turns: session.turns,
      steps: session.steps,
      calls: session.calls,
      peakPromptTokens: session.peakPromptTokens,
      contextWindow: session.contextWindow ?? null,
      tokens: session.tokens,
      callDetails: session.callDetails,
    })),
  }
}

/**
 * Escape text for safe inclusion in HTML.
 *
 * @param {string} value raw text.
 * @returns {string} escaped text.
 */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Dashboard styling: one dark-first sheet, no external font or framework. */
const DASHBOARD_CSS = `
:root {
  color-scheme: dark light;
  --bg: #0d1117; --panel: #161b22; --panel-2: #1c2430; --line: #2b3542;
  --fg: #e6edf3; --muted: #8b949e; --accent: #4c9aff; --accent-2: #7ee787;
  --warn: #f0b849; --bad: #ff7b72; --grid: #21262d;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f8fa; --panel: #ffffff; --panel-2: #f0f3f6; --line: #d0d7de;
    --fg: #1f2328; --muted: #656d76; --accent: #0969da; --accent-2: #1a7f37;
    --warn: #9a6700; --bad: #cf222e; --grid: #eaeef2;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
a { color: var(--accent); }
header {
  padding: 16px 20px 12px; border-bottom: 1px solid var(--line);
  position: sticky; top: 0; background: var(--bg); z-index: 20;
}
h1 { font-size: 17px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 22px 0 8px; color: var(--fg); }
h3 { font-size: 13px; margin: 14px 0 6px; color: var(--muted); font-weight: 600; }
.sub { color: var(--muted); font-size: 12px; }
main { padding: 4px 20px 60px; max-width: 1700px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 10px; margin: 14px 0 4px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.card .v { font-size: 19px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.card .n { color: var(--muted); font-size: 11px; margin-top: 2px; }
.filters {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 12px 0;
}
label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--muted); }
input, select, button {
  background: var(--panel-2); color: var(--fg); border: 1px solid var(--line);
  border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 12px; min-width: 8ch;
}
input[type=search] { min-width: 22ch; }
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { padding: 5px 8px; text-align: left; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th { background: var(--panel-2); color: var(--muted); font-weight: 600; font-size: 11px; position: sticky; top: 0; }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--accent); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: var(--panel-2); }
tr.detail td { background: var(--bg); padding: 0; }
.detail-inner { padding: 10px 12px 14px; }
.wrap { overflow-x: auto; }
.pill { display: inline-block; padding: 1px 6px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); font-size: 11px; color: var(--muted); }
.pill.sub { color: var(--warn); border-color: var(--warn); }
.pill.bad { color: var(--bad); border-color: var(--bad); }
.bar { height: 6px; background: var(--grid); border-radius: 3px; overflow: hidden; min-width: 60px; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.bar.split > i.cache { background: var(--accent-2); }
.tabs { display: flex; gap: 4px; margin: 16px 0 0; flex-wrap: wrap; }
.tabs button { border-radius: 6px 6px 0 0; border-bottom-color: transparent; }
.tabs button[aria-selected=true] { background: var(--panel); color: var(--fg); border-color: var(--line); border-bottom-color: var(--panel); font-weight: 600; }
.tabpanel { border-top: 1px solid var(--line); padding-top: 10px; }
.chart { display: flex; align-items: flex-end; gap: 2px; height: 150px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; overflow-x: auto; }
.chart .col { display: flex; flex-direction: column; justify-content: flex-end; min-width: 6px; flex: 1 0 6px; height: 100%; position: relative; }
.chart .col i { display: block; background: var(--accent); border-radius: 2px 2px 0 0; }
.chart .col i.cache { background: var(--accent-2); }
.chart .col span { position: absolute; top: -14px; font-size: 10px; color: var(--muted); display: none; white-space: nowrap; }
.chart .col:hover span { display: block; }
.chart .col:hover i { outline: 1px solid var(--accent); }
.legend { display: flex; gap: 14px; color: var(--muted); font-size: 11px; margin: 6px 0 0; }
.legend b { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; }
.note { color: var(--muted); font-size: 12px; margin: 6px 0; }
.warnbox { border: 1px solid var(--warn); border-radius: 8px; padding: 8px 12px; margin: 10px 0; color: var(--warn); }
pre.report { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; max-height: 62vh; font-size: 12px; }
code { background: var(--panel-2); padding: 1px 4px; border-radius: 4px; }
.empty { color: var(--muted); padding: 20px; text-align: center; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
details summary { cursor: pointer; color: var(--muted); }
`

/**
 * The dashboard's client script.
 *
 * Kept as a plain string so the emitted document is genuinely one file. It is
 * intentionally dependency-free and side-effect free outside `#app`.
 */
const DASHBOARD_SCRIPT = `
(function () {
  'use strict'
  var payload = JSON.parse(document.getElementById('dsh-usage-data').textContent)
  var report = payload.report
  var prices = payload.prices || {}
  var status = payload.status
  var lang = payload.lang === 'zh' ? 'zh' : 'en'

  var L = lang === 'zh' ? {
    title: 'DSH Token 用量看板', calls: '模型调用', sessions: '会话', turns: '轮次',
    uncached: '未缓存输入', cacheRead: '缓存读取', cacheWrite: '缓存写入', output: '输出',
    reasoning: '推理', total: '合计', prompt: '提示词', cacheRate: '缓存命中率', peak: '最大单次提示',
    from: '开始', to: '结束', model: '模型', provider: '提供方', project: '项目', session: '会话',
    kind: '类型', updated: '最近调用', cost: '费用', tokens: 'tokens', search: '搜索会话/标题/目录',
    all: '全部', apply: '应用', reset: '重置', exports: '导出 JSON', copy: '复制报告',
    overview: '总览', models: '按模型', projects: '按项目', sessionsTab: '按会话', timeline: '时间分布',
    callsTab: '调用明细', text: '文本报告', diagnostics: '诊断', turn: '轮次', steps: '步数',
    seq: '序号', time: '时间', cache: '缓存', uncachedShort: '未缓存', noMatch: '没有匹配的数据。',
    filtered: '筛选后', ofTotal: '（总计', derived: '部分总计由分项推导', unpriced: '以下模型未配置价格，费用不完整',
    warnings: '读取警告', rowLimit: '仅显示前', rows: '行', showAll: '显示全部', sessionDetail: '会话明细',
    cacheHit: '缓存命中', clickHint: '点击行展开明细'
  } : {
    title: 'DSH token usage', calls: 'Model calls', sessions: 'Sessions', turns: 'Turns',
    uncached: 'Uncached input', cacheRead: 'Cache read', cacheWrite: 'Cache write', output: 'Output',
    reasoning: 'Reasoning', total: 'Total', prompt: 'Prompt', cacheRate: 'Cache hit rate', peak: 'Largest prompt',
    from: 'From', to: 'To', model: 'Model', provider: 'Provider', project: 'Project', session: 'Session',
    kind: 'Kind', updated: 'Last call', cost: 'Cost', tokens: 'tokens', search: 'Search id / title / path',
    all: 'All', apply: 'Apply', reset: 'Reset', exports: 'Export JSON', copy: 'Copy report',
    overview: 'Overview', models: 'By model', projects: 'By project', sessionsTab: 'By session', timeline: 'Timeline',
    callsTab: 'Call ledger', text: 'Text report', diagnostics: 'Diagnostics', turn: 'Turn', steps: 'Steps',
    seq: 'seq', time: 'Time', cache: 'Cache', uncachedShort: 'uncached', noMatch: 'No matching data.',
    filtered: 'Filtered', ofTotal: '(of', derived: 'some provider totals were derived from their parts',
    unpriced: 'cost is incomplete; unpriced models', warnings: 'Read warnings', rowLimit: 'showing first', rows: 'rows',
    showAll: 'Show all', sessionDetail: 'Session detail',
    cacheHit: 'Cache hit', clickHint: 'Click a row to expand'
  }

  var state = {
    from: '', to: '', model: '', project: '', kind: '', search: '',
    tab: 'overview', sort: { table: 'sessions', key: 'total', dir: -1 },
    limits: { sessions: 200, calls: 300, models: 50, projects: 50 }
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function num(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0'
    return n.toLocaleString('en-US')
  }
  function tok(n) {
    if (!isFinite(n)) return '0'
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M'
    if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'K'
    return num(n)
  }
  function pct(r) { return (typeof r === 'number' && isFinite(r)) ? (r * 100).toFixed(1) + '%' : '-' }
  function usd(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '-'
    return '$' + v.toFixed(4)
  }
  function dateText(ms) {
    if (!ms) return '-'
    var d = new Date(ms)
    function p(x) { return String(x).padStart(2, '0') }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function dayKey(ms) {
    var d = new Date(ms)
    function p(x) { return String(x).padStart(2, '0') }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }
  function zero() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  }
  function add(t, v) {
    t.inputTokens += v.inputTokens || 0
    t.outputTokens += v.outputTokens || 0
    t.cacheReadTokens += v.cacheReadTokens || 0
    t.cacheWriteTokens += v.cacheWriteTokens || 0
    t.reasoningTokens += v.reasoningTokens || 0
    t.totalTokens += v.totalTokens || 0
    return t
  }
  function priceOf(t, p) {
    if (!p) return undefined
    var m = 1000000
    return (t.inputTokens * (p.input || 0) + t.cacheReadTokens * (p.cacheRead || 0) +
      t.cacheWriteTokens * (p.cacheWrite === undefined ? (p.input || 0) : p.cacheWrite) +
      t.outputTokens * (p.output || 0)) / m
  }
  function priceFor(provider, model) {
    return prices[provider + '/' + model] || prices[model] || prices['*']
  }

  // ── filtering, in the browser, from the embedded exact per-call ledger ──

  function modelMatches(provider, model) {
    if (!state.model) return true
    if (state.model === provider + '/' + model) return true
    if (state.model === model) return true
    if (state.model === provider) return true
    if (state.model.slice(-2) === '/*' && state.model.slice(0, -2) === provider) return true
    return false
  }
  function callIn(call) {
    if (state.from && dayKey(call.time) < state.from) return false
    if (state.to && dayKey(call.time) > state.to) return false
    if (!modelMatches(call.provider, call.model)) return false
    return true
  }
  function sessionMatches(s) {
    if (state.project && s.project !== state.project) return false
    if (state.kind && s.kind !== state.kind) return false
    if (state.search) {
      var hay = (s.sessionId + ' ' + (s.title || '') + ' ' + (s.cwd || '') + ' ' + (s.agentPreset || '')).toLowerCase()
      if (hay.indexOf(state.search.toLowerCase()) < 0) return false
    }
    return true
  }

  function compute() {
    var sessions = []
    var calls = []
    var byModel = {}
    var byProject = {}
    var byDay = {}
    var totals = zero()
    var first = Infinity
    var last = -Infinity
    var peak = 0
    var derived = false
    var unpriced = {}

    for (var i = 0; i < report.sessions.length; i++) {
      var s = report.sessions[i]
      if (!sessionMatches(s)) continue
      var kept = []
      for (var j = 0; j < s.callDetails.length; j++) {
        if (callIn(s.callDetails[j])) kept.push(s.callDetails[j])
      }
      if (kept.length === 0) continue
      var st = zero()
      var sp = 0
      for (var k = 0; k < kept.length; k++) {
        var c = kept[k]
        add(st, c.tokens)
        add(totals, c.tokens)
        calls.push(c)
        if (c.promptTokens > sp) sp = c.promptTokens
        if (c.promptTokens > peak) peak = c.promptTokens
        if (c.time < first) first = c.time
        if (c.time > last) last = c.time
        if (c.tokens.totalDerived) derived = true
        var mk = c.provider + '/' + c.model
        if (!byModel[mk]) byModel[mk] = { key: mk, provider: c.provider, model: c.model, calls: 0, sessions: {}, tokens: zero(), costUsd: 0, costSeen: false }
        byModel[mk].calls++
        byModel[mk].sessions[s.sessionId] = 1
        add(byModel[mk].tokens, c.tokens)
        var pk = s.project || '(unknown)'
        if (!byProject[pk]) byProject[pk] = { key: pk, calls: 0, sessions: {}, tokens: zero(), costUsd: 0, costSeen: false }
        byProject[pk].calls++
        byProject[pk].sessions[s.sessionId] = 1
        add(byProject[pk].tokens, c.tokens)
        var callPrice = priceFor(c.provider, c.model)
        if (callPrice) {
          var callCost = priceOf(c.tokens, callPrice) || 0
          byModel[mk].costUsd += callCost
          byModel[mk].costSeen = true
          byProject[pk].costUsd += callCost
          byProject[pk].costSeen = true
        }
        var dk = dayKey(c.time)
        if (!byDay[dk]) byDay[dk] = { key: dk, calls: 0, sessions: {}, tokens: zero() }
        byDay[dk].calls++
        byDay[dk].sessions[s.sessionId] = 1
        add(byDay[dk].tokens, c.tokens)
        if (!priceFor(c.provider, c.model)) unpriced[mk] = 1
      }
      sessions.push({
        raw: s, calls: kept, tokens: st, peakPromptTokens: sp,
        title: s.title, project: s.project, updatedAt: s.updatedAt || s.createdAt
      })
    }
    // Cost is accumulated per route while the ledger is walked, so a model row, a
    // project row and the grand total are priced from the same tokens rather than
    // from three independent re-derivations.
    function finish(map, withCost) {
      return Object.keys(map).map(function (key) {
        var e = map[key]
        return {
          key: e.key, provider: e.provider, model: e.model, calls: e.calls,
          sessions: Object.keys(e.sessions).length, tokens: e.tokens,
          costUsd: withCost ? (e.costSeen ? e.costUsd : undefined) : undefined
        }
      })
    }
    var models = finish(byModel, true).sort(function (a, b) { return b.tokens.totalTokens - a.tokens.totalTokens })
    var projects = finish(byProject, true)
    var series = Object.keys(byDay).sort().map(function (key) {
      var e = byDay[key]
      return { key: key, calls: e.calls, sessions: Object.keys(e.sessions).length, tokens: e.tokens }
    })
    var sessionsSorted = sessions.slice().sort(function (a, b) { return b.tokens.totalTokens - a.tokens.totalTokens })
    var cost = undefined
    var priced = false
    for (var mi = 0; mi < models.length; mi++) {
      if (typeof models[mi].costUsd === 'number') { cost = (cost || 0) + models[mi].costUsd; priced = true }
    }
    return {
      sessions: sessionsSorted, calls: calls, models: models, projects: projects, series: series,
      totals: totals, peakPromptTokens: peak, firstCallAt: isFinite(first) ? first : 0,
      lastCallAt: isFinite(last) ? last : 0, totalDerived: derived,
      costUsd: priced ? cost : undefined, unpricedModels: Object.keys(unpriced).sort()
    }
  }

  // ── rendering ──

  var app = document.getElementById('app')

  function bar(value, max, cls) {
    var w = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0
    return '<div class="bar"><i class="' + (cls || '') + '" style="width:' + w + '%"></i></div>'
  }

  function cards(d) {
    var cacheRate = d.totals.cacheReadTokens + d.totals.inputTokens + d.totals.cacheWriteTokens > 0
      ? d.totals.cacheReadTokens / (d.totals.cacheReadTokens + d.totals.inputTokens + d.totals.cacheWriteTokens) : undefined
    var items = [
      [L.total, tok(d.totals.totalTokens), num(d.totals.totalTokens) + ' ' + L.tokens],
      [L.calls, num(d.calls.length), num(d.sessions.length) + ' ' + L.sessions],
      [L.uncached, tok(d.totals.inputTokens)],
      [L.cacheRead, tok(d.totals.cacheReadTokens)],
      [L.output, tok(d.totals.outputTokens)],
      [L.reasoning, tok(d.totals.reasoningTokens)],
      [L.cacheRate, pct(cacheRate)],
      [L.peak, tok(d.peakPromptTokens)],
      [L.cost, d.costUsd === undefined ? '-' : usd(d.costUsd), d.costUsd === undefined ? L.unpriced : ''],
      [L.from, dateText(d.firstCallAt), ''],
      [L.to, dateText(d.lastCallAt), '']
    ]
    return '<div class="cards">' + items.map(function (it) {
      return '<div class="card"><div class="k">' + esc(it[0]) + '</div><div class="v">' + esc(it[1]) +
        '</div>' + (it[2] ? '<div class="n">' + esc(it[2]) + '</div>' : '') + '</div>'
    }).join('') + '</div>'
  }

  function filtersUi(d) {
    var models = report.models.map(function (m) { return { v: m.provider + '/' + m.model, l: m.provider + '/' + m.model } })
    var projects = report.projects.map(function (p) { return { v: p.project, l: p.project } })
    function opts(list, selected) {
      return '<option value="">' + L.all + '</option>' + list.map(function (o) {
        return '<option value="' + esc(o.v) + '"' + (o.v === selected ? ' selected' : '') + '>' + esc(o.l) + '</option>'
      }).join('')
    }
    var minTime = d.firstCallAt ? dayKey(d.firstCallAt) : ''
    var maxTime = d.lastCallAt ? dayKey(d.lastCallAt) : ''
    return '<div class="filters">' +
      '<label>' + L.from + '<input type="date" id="f-from" value="' + esc(state.from || minTime) + '" min="' + minTime + '" max="' + maxTime + '"></label>' +
      '<label>' + L.to + '<input type="date" id="f-to" value="' + esc(state.to || maxTime) + '" min="' + minTime + '" max="' + maxTime + '"></label>' +
      '<label>' + L.model + '<select id="f-model">' + opts(models, state.model) + '</select></label>' +
      '<label>' + L.project + '<select id="f-project">' + opts(projects, state.project) + '</select></label>' +
      '<label>' + L.kind + '<select id="f-kind"><option value="">' + L.all + '</option>' +
        '<option value="session"' + (state.kind === 'session' ? ' selected' : '') + '>session</option>' +
        '<option value="subagent"' + (state.kind === 'subagent' ? ' selected' : '') + '>subagent</option></select></label>' +
      '<label>' + L.search + '<input type="search" id="f-search" value="' + esc(state.search) + '"></label>' +
      '<button class="primary" id="f-apply">' + L.apply + '</button>' +
      '<button id="f-reset">' + L.reset + '</button>' +
      '<button id="f-export">' + L.exports + '</button>' +
      '</div>'
  }

  function table(headers, rows, sortKey) {
    var th = headers.map(function (h, i) {
      var cls = (h.num ? 'num ' : '') + (h.sort ? 'sortable' : '')
      return '<th class="' + cls.trim() + '"' + (h.sort ? ' data-sort="' + h.sort + '"' : '') + '>' + esc(h.label) + '</th>'
    }).join('')
    var body = rows.length === 0
      ? '<tr><td colspan="' + headers.length + '"><div class="empty">' + L.noMatch + '</div></td></tr>'
      : rows.join('')
    return '<div class="wrap"><table data-table="' + esc(sortKey || '') + '"><thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table></div>'
  }

  function modelRows(d) {
    var max = d.models.length > 0 ? d.models[0].tokens.totalTokens : 1
    return d.models.slice(0, state.limits.models).map(function (m) {
      var p = m.tokens.cacheReadTokens + m.tokens.inputTokens + m.tokens.cacheWriteTokens
      return '<tr><td>' + esc(m.provider) + '</td><td class="mono">' + esc(m.model) + '</td>' +
        '<td class="num">' + num(m.calls) + '</td><td class="num">' + num(m.sessions) + '</td>' +
        '<td class="num">' + num(m.tokens.inputTokens) + '</td>' +
        '<td class="num">' + num(m.tokens.cacheReadTokens) + '</td>' +
        '<td class="num">' + num(m.tokens.outputTokens) + '</td>' +
        '<td class="num">' + num(m.tokens.reasoningTokens) + '</td>' +
        '<td class="num">' + num(m.tokens.totalTokens) + '</td>' +
        '<td class="num">' + pct(p > 0 ? m.tokens.cacheReadTokens / p : undefined) + '</td>' +
        '<td class="num">' + usd(m.costUsd) + '</td>' +
        '<td>' + bar(m.tokens.totalTokens, max) + '</td></tr>'
    })
  }

  function projectRows(d) {
    var max = d.projects.length > 0 ? d.projects[0].tokens.totalTokens : 1
    return d.projects.slice(0, state.limits.projects).map(function (p) {
      var pr = p.tokens.cacheReadTokens + p.tokens.inputTokens + p.tokens.cacheWriteTokens
      return '<tr><td>' + esc(p.key) + '</td><td class="num">' + num(p.sessions) + '</td>' +
        '<td class="num">' + num(p.calls) + '</td>' +
        '<td class="num">' + num(p.tokens.inputTokens) + '</td>' +
        '<td class="num">' + num(p.tokens.cacheReadTokens) + '</td>' +
        '<td class="num">' + num(p.tokens.outputTokens) + '</td>' +
        '<td class="num">' + num(p.tokens.totalTokens) + '</td>' +
        '<td class="num">' + pct(pr > 0 ? p.tokens.cacheReadTokens / pr : undefined) + '</td>' +
        '<td>' + bar(p.tokens.totalTokens, max) + '</td></tr>'
    })
  }

  function sessionRows(d) {
    var sorted = d.sessions.slice()
    var key = state.sort.table === 'sessions' ? state.sort.key : 'total'
    var dir = state.sort.table === 'sessions' ? state.sort.dir : -1
    sorted.sort(function (a, b) {
      var av, bv
      if (key === 'title') { av = (a.title || '').toLowerCase(); bv = (b.title || '').toLowerCase() }
      else if (key === 'project') { av = a.project || ''; bv = b.project || '' }
      else if (key === 'calls') { av = a.calls.length; bv = b.calls.length }
      else if (key === 'updated') { av = a.updatedAt; bv = b.updatedAt }
      else { av = a.tokens.totalTokens; bv = b.tokens.totalTokens }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
    var max = 1
    for (var i = 0; i < d.sessions.length; i++) if (d.sessions[i].tokens.totalTokens > max) max = d.sessions[i].tokens.totalTokens
    return sorted.slice(0, state.limits.sessions).map(function (s) {
      var r = s.raw
      var models = {}
      for (var j = 0; j < s.calls.length; j++) models[s.calls[j].provider + '/' + s.calls[j].model] = 1
      var modelList = Object.keys(models).join(', ')
      var kindPill = r.kind === 'subagent' ? '<span class="pill sub">subagent</span>' : '<span class="pill">session</span>'
      return '<tr class="clickable" data-session="' + esc(r.sessionId) + '">' +
        '<td class="mono">' + esc(r.sessionId.replace(/^session-/, '').slice(0, 20)) + '</td>' +
        '<td>' + esc((s.title || '-').slice(0, 52)) + '</td>' +
        '<td>' + esc(s.project || '-') + '</td>' +
        '<td>' + kindPill + '</td>' +
        '<td class="mono">' + esc(modelList.slice(0, 40)) + '</td>' +
        '<td class="num">' + num(s.calls.length) + '</td>' +
        '<td class="num">' + num(r.turns) + '</td>' +
        '<td class="num">' + num(s.tokens.inputTokens) + '</td>' +
        '<td class="num">' + num(s.tokens.cacheReadTokens) + '</td>' +
        '<td class="num">' + num(s.tokens.outputTokens) + '</td>' +
        '<td class="num">' + num(s.tokens.totalTokens) + '</td>' +
        '<td class="num">' + num(s.peakPromptTokens) + '</td>' +
        '<td>' + dateText(s.updatedAt) + '</td>' +
        '<td>' + bar(s.tokens.totalTokens, max) + '</td></tr>'
    })
  }

  function callRows(d, limit) {
    var calls = d.calls.slice().sort(function (a, b) { return a.time - b.time || a.seq - b.seq })
    return calls.slice(0, limit).map(function (c) {
      return '<tr><td>' + dateText(c.time) + '</td>' +
        '<td class="mono">' + esc(c.sessionId.replace(/^session-/, '').slice(0, 12)) + '</td>' +
        '<td class="num">' + num(c.seq) + '</td>' +
        '<td>' + c.turn + '/' + c.step + '</td>' +
        '<td>' + esc(c.provider) + '</td>' +
        '<td class="mono">' + esc(c.model) + '</td>' +
        '<td class="num">' + num(c.tokens.inputTokens) + '</td>' +
        '<td class="num">' + num(c.tokens.cacheReadTokens) + '</td>' +
        '<td class="num">' + num(c.tokens.cacheWriteTokens) + '</td>' +
        '<td class="num">' + num(c.tokens.outputTokens) + '</td>' +
        '<td class="num">' + num(c.tokens.reasoningTokens) + '</td>' +
        '<td class="num">' + num(c.tokens.totalTokens) + (c.tokens.totalDerived ? ' *' : '') + '</td>' +
        '<td>' + (c.kind === 'compaction' ? '<span class="pill">compaction</span>' : '') +
        (c.interrupted ? ' <span class="pill bad">interrupted</span>' : '') + '</td></tr>'
    })
  }

  function timeline(d) {
    if (d.series.length === 0) return '<div class="empty">' + L.noMatch + '</div>'
    var max = 1
    for (var i = 0; i < d.series.length; i++) if (d.series[i].tokens.totalTokens > max) max = d.series[i].tokens.totalTokens
    var cols = d.series.map(function (b) {
      var total = b.tokens.totalTokens
      var cache = b.tokens.cacheReadTokens
      var h = Math.max(1, Math.round((total / max) * 100))
      var ch = total > 0 ? Math.round((cache / total) * h) : 0
      return '<div class="col" title="' + esc(b.key + ' · ' + num(total) + ' ' + L.tokens + ' · ' + num(b.calls) + ' ' + L.calls) + '">' +
        '<span>' + esc(b.key) + ': ' + num(total) + '</span>' +
        '<i class="cache" style="height:' + ch + '%"></i>' +
        '<i style="height:' + (h - ch) + '%"></i></div>'
    }).join('')
    return '<div class="chart">' + cols + '</div>' +
      '<div class="legend"><span><b style="background:var(--accent-2)"></b>' + L.cacheRead + '</span>' +
      '<span><b style="background:var(--accent)"></b>' + L.uncached + ' + ' + L.output + '</span></div>'
  }

  function sessionDetail(sessionId) {
    var s = null
    for (var i = 0; i < report.sessions.length; i++) if (report.sessions[i].sessionId === sessionId) { s = report.sessions[i]; break }
    if (!s) return ''
    var turns = {}
    for (var j = 0; j < s.callDetails.length; j++) {
      var c = s.callDetails[j]
      if (!callIn(c)) continue
      if (!turns[c.turn]) turns[c.turn] = { turn: c.turn, steps: {}, calls: 0, tokens: zero(), models: {} }
      turns[c.turn].steps[c.step] = 1
      turns[c.turn].calls++
      add(turns[c.turn].tokens, c.tokens)
      turns[c.turn].models[c.provider + '/' + c.model] = 1
    }
    var keys = Object.keys(turns).map(Number).sort(function (a, b) { return a - b })
    var rows = keys.map(function (t) {
      var e = turns[t]
      return '<tr><td class="num">' + e.turn + '</td><td class="num">' + Object.keys(e.steps).length + '</td>' +
        '<td class="num">' + e.calls + '</td><td class="num">' + num(e.tokens.inputTokens) + '</td>' +
        '<td class="num">' + num(e.tokens.cacheReadTokens) + '</td><td class="num">' + num(e.tokens.outputTokens) + '</td>' +
        '<td class="num">' + num(e.tokens.totalTokens) + '</td><td class="mono">' + esc(Object.keys(e.models).join(', ')) + '</td></tr>'
    })
    return '<div class="detail-inner"><h3>' + L.sessionDetail + ' · ' + esc(s.sessionId) + '</h3>' +
      '<div class="note">' + esc((s.title || '') + ' · ' + (s.cwd || '-')) + ' · log v' + esc(s.logVersion) +
      (s.agentPreset ? ' · preset ' + esc(s.agentPreset) : '') + '</div>' +
      '<table><thead><tr><th class="num">' + L.turn + '</th><th class="num">' + L.steps + '</th><th class="num">' + L.calls +
      '</th><th class="num">' + L.uncached + '</th><th class="num">' + L.cacheRead + '</th><th class="num">' + L.output +
      '</th><th class="num">' + L.total + '</th><th>' + L.model + '</th></tr></thead><tbody>' +
      rows.join('') + '</tbody></table></div>'
  }

  function render() {
    var d = compute()
    var tabs = [
      ['overview', L.overview], ['models', L.models], ['projects', L.projects],
      ['sessionsTab', L.sessionsTab], ['timeline', L.timeline], ['callsTab', L.callsTab],
      ['text', L.text], ['diagnostics', L.diagnostics]
    ]
    var panels = {
      overview: function () {
        return '<h2>' + L.models + '</h2>' + table([
          { label: L.provider }, { label: L.model }, { label: L.calls, num: true }, { label: L.sessions, num: true },
          { label: L.uncached, num: true }, { label: L.cacheRead, num: true }, { label: L.output, num: true },
          { label: L.reasoning, num: true }, { label: L.total, num: true }, { label: L.cacheRate, num: true },
          { label: L.cost, num: true }, { label: '' }
        ], modelRows(d), 'models') +
        '<h2>' + L.sessionsTab + '</h2>' + sessionTable(d)
      },
      models: function () {
        return '<h2>' + L.models + '</h2>' + table([
          { label: L.provider }, { label: L.model }, { label: L.calls, num: true }, { label: L.sessions, num: true },
          { label: L.uncached, num: true }, { label: L.cacheRead, num: true }, { label: L.output, num: true },
          { label: L.reasoning, num: true }, { label: L.total, num: true }, { label: L.cacheRate, num: true },
          { label: L.cost, num: true }, { label: '' }
        ], modelRows(d), 'models')
      },
      projects: function () {
        return '<h2>' + L.projects + '</h2>' + table([
          { label: L.project }, { label: L.sessions, num: true }, { label: L.calls, num: true },
          { label: L.uncached, num: true }, { label: L.cacheRead, num: true }, { label: L.output, num: true },
          { label: L.total, num: true }, { label: L.cacheRate, num: true }, { label: '' }
        ], projectRows(d), 'projects')
      },
      sessionsTab: function () { return '<h2>' + L.sessionsTab + '</h2>' + sessionTable(d) },
      timeline: function () { return '<h2>' + L.timeline + '</h2>' + timeline(d) },
      callsTab: function () {
        return '<h2>' + L.callsTab + '</h2><div class="note">' + L.rowLimit + ' ' + num(Math.min(state.limits.calls, d.calls.length)) +
          ' / ' + num(d.calls.length) + ' ' + L.rows + ' · ' + L.clickHint + '</div>' +
          table([
            { label: L.time }, { label: L.session }, { label: L.seq, num: true }, { label: 'turn/step' },
            { label: L.provider }, { label: L.model }, { label: L.uncached, num: true }, { label: L.cacheRead, num: true },
            { label: L.cacheWrite, num: true }, { label: L.output, num: true }, { label: L.reasoning, num: true },
            { label: L.total, num: true }, { label: '' }
          ], callRows(d, state.limits.calls), 'calls')
      },
      text: function () { return '<h2>' + L.text + '</h2><pre class="report">' + esc(payload.text) + '</pre>' },
      diagnostics: function () {
        return '<h2>' + L.diagnostics + '</h2><pre class="report">' + esc(JSON.stringify({
          status: status, meta: report.meta, filters: report.filters, warnings: report.warnings
        }, null, 2)) + '</pre>'
      }
    }
    var html = '<header><h1>' + esc(L.title) + '</h1><div class="sub">' +
      esc(report.meta.sessionsRoot) + ' · ' + num(report.meta.logsScanned) + ' logs · ' +
      (report.meta.bytesRead / 1048576).toFixed(1) + ' MiB · ' + report.meta.elapsedMs + ' ms · ' +
      dateText(report.meta.generatedAt) + '</div>' +
      (d.totalDerived ? '<div class="note">* ' + L.derived + '</div>' : '') +
      (d.unpricedModels.length > 0 ? '<div class="note">' + L.unpriced + ': ' + esc(d.unpricedModels.join(', ')) + '</div>' : '') +
      (report.warnings.length > 0 ? '<div class="warnbox">' + L.warnings + ': ' + report.warnings.length + '</div>' : '') +
      '</header><main>' +
      filtersUi(d) + cards(d) +
      '<div class="tabs">' + tabs.map(function (t) {
        return '<button data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' + esc(t[1]) + '</button>'
      }).join('') + '</div>' +
      '<div class="tabpanel">' + (panels[state.tab] || panels.overview)() + '</div>' +
      '</main>'
    app.innerHTML = html
    bind(d)
  }

  function sessionTable(d) {
    return '<div class="note">' + L.rowLimit + ' ' + num(Math.min(state.limits.sessions, d.sessions.length)) + ' / ' +
      num(d.sessions.length) + ' ' + L.rows + ' · ' + L.clickHint + '</div>' + table([
      { label: L.session, sort: 'id' }, { label: 'Title', sort: 'title' }, { label: L.project, sort: 'project' },
      { label: L.kind }, { label: L.model }, { label: L.calls, num: true, sort: 'calls' }, { label: L.turns, num: true },
      { label: L.uncached, num: true }, { label: L.cacheRead, num: true }, { label: L.output, num: true },
      { label: L.total, num: true, sort: 'total' }, { label: L.peak, num: true }, { label: L.updated, sort: 'updated' }, { label: '' }
    ], sessionRows(d), 'sessions')
  }

  function bind() {
    var apply = document.getElementById('f-apply')
    if (apply) apply.onclick = function () { readFilters(); render() }
    var reset = document.getElementById('f-reset')
    if (reset) reset.onclick = function () {
      state.from = ''; state.to = ''; state.model = ''; state.project = ''; state.kind = ''; state.search = ''
      render()
    }
    var exportBtn = document.getElementById('f-export')
    if (exportBtn) exportBtn.onclick = function () {
      var blob = new Blob([JSON.stringify(compute(), null, 2)], { type: 'application/json' })
      var a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'dsh-usage-filtered.json'
      a.click()
      URL.revokeObjectURL(a.href)
    }
    var search = document.getElementById('f-search')
    if (search) search.oninput = function () { state.search = search.value; render() }
    ;['f-from', 'f-to', 'f-model', 'f-project', 'f-kind'].forEach(function (id) {
      var el = document.getElementById(id)
      if (el) el.onchange = function () { readFilters(); render() }
    })
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (button) {
      button.onclick = function () { state.tab = button.getAttribute('data-tab'); render() }
    })
    Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
      th.onclick = function () {
        var key = th.getAttribute('data-sort')
        if (state.sort.key === key) state.sort.dir = -state.sort.dir
        else { state.sort.key = key; state.sort.dir = -1 }
        render()
      }
    })
    Array.prototype.forEach.call(document.querySelectorAll('tr.clickable'), function (tr) {
      tr.onclick = function () {
        var next = tr.nextElementSibling
        if (next && next.classList.contains('detail')) { next.remove(); return }
        var row = document.createElement('tr')
        row.className = 'detail'
        var cell = document.createElement('td')
        cell.colSpan = tr.children.length
        cell.innerHTML = sessionDetail(tr.getAttribute('data-session'))
        row.appendChild(cell)
        tr.parentNode.insertBefore(row, tr.nextSibling)
      }
    })
  }

  function readFilters() {
    function val(id) { var el = document.getElementById(id); return el ? el.value : '' }
    state.from = val('f-from'); state.to = val('f-to'); state.model = val('f-model')
    state.project = val('f-project'); state.kind = val('f-kind'); state.search = val('f-search')
  }

  var minT = Infinity, maxT = -Infinity
  for (var i = 0; i < report.sessions.length; i++) {
    for (var j = 0; j < report.sessions[i].callDetails.length; j++) {
      var t = report.sessions[i].callDetails[j].time
      if (t < minT) minT = t
      if (t > maxT) maxT = t
    }
  }
  if (isFinite(minT)) { state.from = dayKey(minT); state.to = dayKey(maxT) }
  render()
})()
`
