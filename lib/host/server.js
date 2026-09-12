/**
 * The plugin's own web server.
 *
 * Started with the harness, on its own port, serving the same dashboard the CLI
 * writes. Two design points matter:
 *
 * **It is its own listener, not a route on the harness webserver.** `ctx.webServer`
 * is a single implementation per context and the shipped Web composition already
 * owns it, so a second listener is what "a page of my own, on my own port"
 * actually means. That also keeps the page available in a deployment that mounts
 * no webserver at all.
 *
 * **Binding is asynchronous and load must not block on it.** An unavailable port
 * is a degraded page, never a failed plugin: the caller keeps every other
 * capability, and the reason is recorded and reported through `status()`.
 *
 * @module dsh-usage-stats-long/host/server
 */

import { createServer } from 'node:http'
import { renderDashboard } from '../core/render-html.js'
import { renderReportSections } from '../core/render-text.js'
import { describeError } from '../core/reader.js'

/**
 * @typedef {import('./service.js').UsageStatsService} UsageStatsService
 */

/** Default port. Chosen outside the harness's own 3080 and the common dev ports. */
export const DEFAULT_PORT = 3090

/** Default bind address: loopback only, so the page is never exposed by accident. */
export const DEFAULT_HOST = '127.0.0.1'

/** How many consecutive ports to try when the configured one is taken. */
export const DEFAULT_PORT_ATTEMPTS = 10

/** Default rendered-page reuse window. */
export const DEFAULT_TTL_MS = 10_000

/**
 * Start the dashboard server.
 *
 * @param {UsageStatsService} usageStats the statistics service.
 * @param {object} [options] server options.
 * @param {number} [options.port] first port to try; `0` binds an ephemeral port.
 * @param {string} [options.host] bind address.
 * @param {number} [options.portAttempts] consecutive ports to try before giving up.
 * @param {number} [options.ttlMs] rendered-page reuse window.
 * @param {string} [options.title] document title.
 * @param {() => object} [options.status] provider for the `/healthz` payload.
 * @returns {Promise<import('./types.js').DashboardServer>} the running server handle.
 */
export async function startDashboardServer(usageStats, options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const attempts = Math.max(1, options.portAttempts ?? DEFAULT_PORT_ATTEMPTS)
  const firstPort = options.port ?? DEFAULT_PORT
  const state = { html: '', key: '', builtAt: 0, building: null }

  /**
   * Render the page for one request, reusing a recent build.
   *
   * @param {'dashboard' | 'text'} view which document to produce.
   * @param {'en' | 'zh'} lang label language.
   * @returns {Promise<string>} the document.
   */
  async function page(view, lang) {
    const key = `${view}:${lang}`
    const now = Date.now()
    if (state.html.length > 0 && state.key === key && now - state.builtAt < ttlMs) return state.html
    if (state.building === null) {
      state.building = (async () => {
        try {
          // Full retention: the dashboard's drill-down reads one row per call,
          // and the text view reads per-turn rollups.
          const report = await usageStats.report({ detail: 'full' })
          state.html = view === 'text'
            ? textDocument(report, lang, options.title)
            : renderDashboard(report, {
              title: options.title ?? 'DSH token usage',
              lang,
              prices: usageStats.priceBook,
              status: usageStats.status(),
            })
          state.key = key
          state.builtAt = Date.now()
        } catch (error) {
          const message = describeError(error)
          state.html = errorDocument(message)
          state.key = key
          state.builtAt = Date.now()
        } finally {
          state.building = null
        }
      })()
    }
    await state.building
    return state.html
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  /**
   * Answer one request.
   *
   * @param {import('node:http').IncomingMessage} req the request.
   * @param {import('node:http').ServerResponse} res the response.
   * @returns {Promise<void>} resolves once the response is finished.
   */
  async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (url.pathname === '/healthz') {
        writeJson(res, 200, { ok: true, ...(options.status?.() ?? {}), port: address().port })
        return
      }
      if (url.pathname === '/report.json') {
        const report = await usageStats.report({ detail: 'full' })
        writeJson(res, 200, report)
        return
      }
      if (url.pathname !== '/' && url.pathname !== '/index.html') {
        writeText(res, 404, 'not found\n')
        return
      }
      const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en'
      const view = url.searchParams.get('view') === 'text' ? 'text' : 'dashboard'
      const html = await page(view, lang)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // The document is fully self-contained: inline style and script only.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'",
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(html)
    } catch (error) {
      writeText(res, 500, `usage dashboard failed: ${describeError(error)}\n`)
    }
  }

  const bound = await listen(server, host, firstPort, attempts)
  const port = bound.port

  /**
   * The address the server actually bound.
   *
   * @returns {{ host: string, port: number }} the bound address.
   */
  function address() {
    const value = server.address()
    if (value !== null && typeof value === 'object') return { host, port: value.port }
    return { host, port }
  }

  return {
    host,
    port,
    url: `http://${host}:${port}/`,
    close: () => new Promise((resolvePromise) => {
      // `closeAllConnections` so a hung keep-alive socket cannot delay a reload.
      server.closeAllConnections?.()
      server.close(() => resolvePromise(undefined))
    }),
  }
}

/**
 * Bind a server to the first available port in a window.
 *
 * A busy port is an operational fact, not a programming error: a person running
 * two harnesses should get a second page, not a plugin that refuses to load.
 *
 * @param {import('node:http').Server} server the server to bind.
 * @param {string} host bind address.
 * @param {number} firstPort first port to try; `0` means "any free port".
 * @param {number} attempts how many consecutive ports to try.
 * @returns {Promise<{ port: number, attempts: number }>} the bound port.
 * @throws {Error} when no candidate port could be bound.
 */
function listen(server, host, firstPort, attempts) {
  return new Promise((resolvePromise, rejectPromise) => {
    let tried = 0
    /**
     * Abandon this server object.
     *
     * A `listen` that never bound still leaves a handle behind; releasing it here
     * is what keeps a failed bind from holding the process (and the port) open.
     *
     * @param {Error} error the reason to reject with.
     * @returns {void}
     */
    const giveUp = (error) => {
      server.removeAllListeners('error')
      server.removeAllListeners('listening')
      try {
        server.close()
      } catch {
        // Nothing was bound; there is nothing to release.
      }
      rejectPromise(error)
    }
    /**
     * Try one candidate port.
     *
     * @param {number} port candidate; `0` asks the OS for any free port.
     * @returns {void}
     */
    const attempt = (port) => {
      tried += 1
      const onError = (error) => {
        server.removeListener('listening', onListening)
        const retryable = error.code === 'EADDRINUSE' && firstPort !== 0 && tried < attempts
        if (retryable && port + 1 <= 65_535) {
          attempt(port + 1)
          return
        }
        giveUp(
          error.code === 'EADDRINUSE'
            ? new Error(`no free port in ${firstPort}..${Math.min(firstPort + attempts - 1, 65_535)} on ${host}`)
            : error,
        )
      }
      const onListening = () => {
        server.removeListener('error', onError)
        const value = server.address()
        resolvePromise({ port: value !== null && typeof value === 'object' ? value.port : port, attempts: tried })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      try {
        server.listen(port, host)
      } catch (error) {
        giveUp(error instanceof Error ? error : new Error(String(error)))
      }
    }
    attempt(firstPort)
  })
}

/**
 * Write a JSON response.
 *
 * @param {import('node:http').ServerResponse} res the response.
 * @param {number} status HTTP status.
 * @param {unknown} value value to serialize.
 * @returns {void}
 */
function writeJson(res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * Write a plain-text response.
 *
 * @param {import('node:http').ServerResponse} res the response.
 * @param {number} status HTTP status.
 * @param {string} text body.
 * @returns {void}
 */
function writeText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' })
  res.end(text)
}

/**
 * Render the plain-text report as a minimal HTML page.
 *
 * @param {import('../core/types.js').UsageReport} report the report.
 * @param {'en' | 'zh'} lang label language.
 * @param {string} [title] document title.
 * @returns {string} an HTML document.
 */
function textDocument(report, lang, title) {
  const sections = renderReportSections(report, { detail: 'standard', lang })
  /** @type {string[]} */
  const lines = [`# ${sections[0].t.title}`]
  for (const section of sections) {
    lines.push('', `## ${section.title}`, '', ...section.lines)
  }
  return `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ?? 'DSH token usage')} — text</title>
<style>body{margin:0;background:#0d1117;color:#e6edf3;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}pre{padding:16px 20px;white-space:pre;overflow:auto}</style>
</head><body><pre>${escapeHtml(lines.join('\n'))}</pre></body></html>
`
}

/**
 * Render a minimal error page.
 *
 * @param {string} message failure message.
 * @returns {string} an HTML document.
 */
function errorDocument(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>usage dashboard error</title>
<style>body{margin:0;background:#0d1117;color:#ff7b72;font:13px/1.6 ui-monospace,Menlo,monospace;padding:24px}</style>
</head><body><h1>usage dashboard error</h1><pre>${escapeHtml(message)}</pre></body></html>
`
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
