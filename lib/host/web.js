/**
 * The plugin's browser surface: one HTTP route on the harness's own webserver.
 *
 * This is deliberately not a client-plugin bundle. A `dsh.client` row has to be
 * a pre-built CJS factory that resolves internal module ids such as
 * `@deepseek-ai/dsh-client-ui-slots` and `react` through the client module
 * table, and those packages are not published as a public authoring contract —
 * hand-writing one would be a bundle pinned to today's internal ids and broken
 * by the next harness upgrade. A route, by contrast, is a documented host
 * extension point (`ctx.webServer.register`) with no version coupling at all.
 *
 * The route serves the same self-contained dashboard the CLI writes, so both
 * surfaces show identical numbers from one renderer.
 *
 * @module dsh-usage-stats-long/host/web
 */

import { renderDashboard } from '../core/render-html.js'
import { renderReportSections } from '../core/render-text.js'
import { describeError } from '../core/reader.js'

/**
 * @typedef {import('./service.js').UsageStatsService} UsageStatsService
 */

/** Default path the route is served at. */
export const DEFAULT_ROUTE_PATH = '/usage'

/** How long a rendered page is reused before it is rebuilt from the corpus. */
export const DEFAULT_TTL_MS = 10_000

/**
 * Register the usage dashboard route when this deployment has a webserver.
 *
 * A deployment without one (headless, TUI, ACP) is not an error: this surface
 * simply does not exist there, and every other capability still works.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx the owning context.
 * @param {UsageStatsService} usageStats the statistics service.
 * @param {object} [options] route options.
 * @param {string} [options.path] URL path to serve.
 * @param {number} [options.ttlMs] rendered-page cache lifetime.
 * @param {string} [options.title] document title.
 * @returns {undefined | { path: string, dispose: () => void }} the registered route, when one was.
 */
export function registerDashboardRoute(ctx, usageStats, options = {}) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return undefined
  const path = normalizePath(options.path ?? DEFAULT_ROUTE_PATH)
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const state = { html: '', builtAt: 0, building: null, error: '' }

  /**
   * Render the page, reusing a recent build when one exists.
   *
   * The corpus changes only when a turn is appended, so a short TTL turns a
   * dashboard refresh into a cache hit while keeping it genuinely live.
   *
   * @param {URL} url the request URL, carrying the display options.
   * @returns {Promise<string>} the HTML document.
   */
  async function page(url) {
    const now = Date.now()
    const wantsText = url.searchParams.get('view') === 'text'
    // A text view and a dashboard view are different documents, so they do not
    // share the cached render.
    const cacheKey = wantsText ? `text:${url.searchParams.get('lang') ?? ''}` : 'dashboard'
    if (state.html.length > 0 && state.key === cacheKey && now - state.builtAt < ttlMs) return state.html
    if (state.building === null) {
      state.building = (async () => {
        try {
          const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en'
          // Full retention is required: the dashboard's drill-down reads one row
          // per call, and the text view reads per-turn rollups.
          const report = await usageStats.report({ detail: 'full' })
          state.html = wantsText
            ? textView(report, lang, options.title)
            : renderDashboard(report, {
              title: options.title ?? 'DSH token usage',
              lang,
              prices: usageStats.priceBook,
              status: usageStats.status(),
            })
          state.key = cacheKey
          state.builtAt = Date.now()
          state.error = ''
        } catch (error) {
          state.error = describeError(error)
          state.html = errorPage(state.error)
          state.key = cacheKey
          state.builtAt = Date.now()
        } finally {
          state.building = null
        }
      })()
    }
    await state.building
    return state.html
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path,
    /**
     * Answer one request for the dashboard.
     *
     * @param {import('node:http').IncomingMessage} req the request.
     * @param {import('node:http').ServerResponse} res the response.
     * @returns {Promise<void>} resolves when the response is finished.
     */
    handler: async (req, res) => {
      const url = new URL(req.url ?? path, 'http://localhost')
      // Only the dashboard itself is served here; anything under the prefix that
      // is clearly a different resource gets a plain 404 rather than the page.
      const relative = url.pathname.slice(path.length)
      if (relative !== '' && relative !== '/') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found\n')
        return
      }
      const html = await page(url)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // The document is fully self-contained: inline style and script only.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'",
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(html)
    },
  })

  return { path, dispose }
}

/**
 * Render the plain-text report as a minimal HTML page, for `?view=text`.
 *
 * @param {import('../core/types.js').UsageReport} report the report.
 * @param {'en' | 'zh'} lang label language.
 * @param {string} [title] document title.
 * @returns {string} an HTML document.
 */
function textView(report, lang, title) {
  const sections = renderReportSections(report, { detail: 'standard', lang })
  /** @type {string[]} */
  const lines = [`# ${sections[0].t.title}`]
  for (const section of sections) {
    lines.push('', `## ${section.title}`, '', ...section.lines)
  }
  const text = lines.join('\n')
  return `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ?? 'DSH token usage')} — text</title>
<style>body{margin:0;background:#0d1117;color:#e6edf3;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}pre{padding:16px 20px;white-space:pre;overflow:auto}</style>
</head><body><pre>${escapeHtml(text)}</pre></body></html>
`
}

/**
 * Render a minimal error page.
 *
 * @param {string} message the failure message.
 * @returns {string} an HTML document.
 */
function errorPage(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>usage dashboard error</title>
<style>body{margin:0;background:#0d1117;color:#ff7b72;font:13px/1.6 ui-monospace,Menlo,monospace;padding:24px}</style>
</head><body><h1>usage dashboard error</h1><pre>${escapeHtml(message)}</pre></body></html>
`
}

/**
 * Normalize a configured route path.
 *
 * @param {string} path caller-supplied path.
 * @returns {string} a leading-slash, no-trailing-slash path.
 */
function normalizePath(path) {
  const trimmed = path.trim()
  if (trimmed.length === 0) return DEFAULT_ROUTE_PATH
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.length > 1 && withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading
}

/**
 * Escape text for HTML inclusion.
 *
 * @param {string} value raw text.
 * @returns {string} escaped text.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
