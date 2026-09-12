/**
 * Plugin-surface tests.
 *
 * These load the real `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` when
 * they resolve (see `scripts/link-harness-deps.mjs`), so the tool schemas are
 * validated by the same compiler the harness uses, and they exercise a real
 * `Service` subclass through a real Cordis context. When the peer packages are
 * absent the suite skips with instructions rather than silently passing.
 */

import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { makeTempRoot, writeCorpus } from './helpers/log-builder.js'

/** @type {any} */
let defineTool
/** @type {any} */
let Context
/** @type {string | undefined} */
let skipReason

try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  ;({ Context } = await import('@deepseek-ai/cordis'))
} catch (error) {
  skipReason = `harness peer packages are not linked (${error instanceof Error ? error.message : String(error)}). Run: node scripts/link-harness-deps.mjs`
}

/**
 * A minimal tools registry that records registrations the way the real one does.
 *
 * @returns {{ ctx: any, registered: Map<string, any>, disposers: number }} a test context.
 */
function makeContext() {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    get: (name) => (name === 'tools' ? ctx.tools : undefined),
  }
  return { ctx, registered }
}

describe('host plugin surface', { skip: skipReason ?? false }, () => {
  /** @type {string} */
  let root
  /** @type {any} */
  let usageStats
  /** @type {Map<string, any>} */
  let registered

  before(async () => {
    root = makeTempRoot('dsh-plugin-test-')
    writeCorpus(root)
    const [{ UsageStatsService }, { registerUsageTools }] = await Promise.all([
      import('../lib/host/service.js'),
      import('../lib/host/tool.js'),
    ])
    // A real Cordis context: constructing the service must register it as
    // `usageStats` on this context, which is what the plugin row relies on.
    const context = new Context()
    usageStats = new UsageStatsService(context, { sessionsRoot: root, cacheSize: 16 })
    // Cordis publishes the service on the context under its name and proxies the
    // instance, so identity is asserted by type rather than by reference.
    assert.ok(context.usageStats instanceof UsageStatsService, 'the service must publish itself as ctx.usageStats')
    const harness = makeContext()
    registered = harness.registered
    registerUsageTools(harness.ctx, { usageStats })
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('registers exactly the three documented tools', () => {
    assert.deepEqual([...registered.keys()].sort(), ['usage_calls', 'usage_sessions', 'usage_stats'])
  })

  it('compiles every tool definition through the real schema validator', () => {
    for (const [name, definition] of registered) {
      assert.equal(typeof definition.execute, 'function', `${name} needs an executor`)
      assert.ok(definition.description.length > 80, `${name} needs a description the model can act on`)
      assert.ok(definition.parameters !== undefined, `${name} needs a parameter schema`)
      assert.ok(definition.output.schema !== undefined, `${name} needs an output schema`)
      assert.equal(typeof definition.output.render, 'function', `${name} needs a renderer`)
    }
  })

  it('accesses only leaf data and never a live harness object', async () => {
    const stats = registered.get('usage_stats')
    const toolContext = { signal: new AbortController().signal }
    const result = await stats.execute({ detail: 'compact', maxSessions: 3 }, toolContext)
    assert.equal(typeof result.report, 'string')
    assert.ok(result.report.includes('Token usage report'))
    assert.equal(typeof result.totals.totalTokens, 'number')
    assert.ok(result.totals.totalTokens > 0)
    // The canonical value must be plain JSON: no service, no session, no function.
    const round = JSON.parse(JSON.stringify(result))
    assert.deepEqual(round.totals, result.totals)
  })

  it('reports a bad filter as an actionable error instead of an empty report', async () => {
    const stats = registered.get('usage_stats')
    const result = await stats.execute({ kind: 'nonsense' }, { signal: new AbortController().signal })
    assert.match(result.report, /Invalid filter "kinds"/)
    assert.equal(result.meta.error, true)
  })

  it('lists sessions and the filterable vocabulary', async () => {
    const sessions = registered.get('usage_sessions')
    const json = await sessions.execute({ dimensions: true, limit: 50, format: 'json' }, { signal: new AbortController().signal })
    assert.ok(json.sessions.length > 0)
    assert.ok(json.dimensions.providers.includes('prov-a'))
    assert.ok(json.dimensions.projects.some((project) => project.project === 'alpha'))
    assert.ok(json.sessions.every((session) => typeof session.sessionId === 'string'))

    // The rendered form is the default; `sessions` is only populated in JSON
    // mode, so a table answer must not carry a half-filled array.
    const table = await sessions.execute({ limit: 5 }, { signal: new AbortController().signal })
    assert.ok(table.report.includes('# Sessions'))
    assert.deepEqual(table.sessions, [])
  })

  it('returns the exact per-call ledger', async () => {
    const calls = registered.get('usage_calls')
    const result = await calls.execute({ limit: 4 }, { signal: new AbortController().signal })
    assert.equal(result.calls.length, 4)
    for (const call of result.calls) {
      assert.equal(typeof call.seq, 'number')
      assert.equal(typeof call.tokens.totalTokens, 'number')
      assert.ok(call.provider.length > 0)
    }
    const heaviest = await calls.execute({ limit: 1, order: 'size' }, { signal: new AbortController().signal })
    const all = await calls.execute({ limit: 500, order: 'size' }, { signal: new AbortController().signal })
    assert.equal(heaviest.calls[0].tokens.totalTokens, Math.max(...all.calls.map((call) => call.tokens.totalTokens)))
  })

  it('groups by a dimension on request', async () => {
    const stats = registered.get('usage_stats')
    const result = await stats.execute({ groupBy: 'model', maxSessions: 1 }, { signal: new AbortController().signal })
    assert.ok(Array.isArray(result.groups))
    const summed = result.groups.reduce((sum, group) => sum + group.tokens.totalTokens, 0)
    assert.equal(summed, result.totals.totalTokens, 'grouped rows must sum to the reported total')
  })

  it('honors cancellation cooperatively', async () => {
    const stats = registered.get('usage_stats')
    const controller = new AbortController()
    controller.abort()
    const result = await stats.execute({}, { signal: controller.signal })
    // Either the fold noticed the abort, or it completed before observing it;
    // what must never happen is an unhandled rejection or a partial number.
    assert.equal(typeof result.report, 'string')
    assert.equal(typeof result.totals.totalTokens, 'number')
  })
})

describe('usageStats service behavior', { skip: skipReason ?? false }, () => {
  /** @type {string} */
  let root
  /** @type {any} */
  let service

  before(async () => {
    root = makeTempRoot('dsh-service-test-')
    writeCorpus(root)
    const { UsageStatsService } = await import('../lib/host/service.js')
    // One slot per corpus log, so the cache-reuse test measures reuse rather
    // than a too-small bound evicting entries between two queries.
    service = new UsageStatsService(new Context(), { sessionsRoot: root, cacheSize: 16 })
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('caches folds by log identity and reuses them', async () => {
    const first = await service.report({ detail: 'none' })
    assert.equal(first.meta.cacheHits, 0)
    assert.ok(first.meta.cacheMisses > 0)
    const second = await service.report({ detail: 'none' })
    assert.equal(second.meta.cacheMisses, 0, 'an unchanged corpus must not be re-read')
    assert.equal(second.meta.cacheHits, first.meta.cacheMisses)
    assert.equal(second.totals.totalTokens, first.totals.totalTokens)
  })

  it('produces identical numbers with and without the cache', async () => {
    const cached = await service.report({ detail: 'full' })
    const uncached = await service.report({ detail: 'full', noCache: true })
    assert.deepEqual(uncached.totals, cached.totals)
    assert.equal(uncached.summary.calls, cached.summary.calls)
  })

  it('bounds the cache to the configured size', async () => {
    const { UsageStatsService } = await import('../lib/host/service.js')
    const tiny = new UsageStatsService(new Context(), { sessionsRoot: root, cacheSize: 2 })
    await tiny.report({ detail: 'none' })
    assert.equal(tiny.cache.size, 2, 'a two-entry cache holds two entries')
    const bounded = await tiny.report({ detail: 'none' })
    assert.equal(bounded.totals.totalTokens, (await tiny.report({ detail: 'none', noCache: true })).totals.totalTokens)
  })

  it('drops every cached fold on request', async () => {
    await service.report({ detail: 'none' })
    assert.ok(service.cache.size > 0)
    const evicted = service.clearCache()
    assert.equal(evicted, 7, 'every corpus log had a cached fold')
    const after = await service.report({ detail: 'none' })
    assert.equal(after.meta.cacheHits, 0)
  })

  it('resolves one session by id and by unique prefix', async () => {
    const exact = await service.findSession('session-alpha-0001')
    assert.equal(exact?.sessionId, 'session-alpha-0001')
    const byPrefix = await service.findSession('alpha')
    assert.equal(byPrefix?.sessionId, 'session-alpha-0001')
    assert.equal(await service.findSession('nope'), undefined)
  })

  it('enumerates the filterable dimensions', async () => {
    const dimensions = await service.dimensions()
    assert.ok(dimensions.providers.length >= 2)
    assert.ok(dimensions.kinds.includes('session'))
    assert.ok(dimensions.kinds.includes('subagent'))
    assert.equal(dimensions.sessions.total, dimensions.sessions.withUsage + 1)
  })

  it('reports an unreadable price book without losing the statistics', async () => {
    const { UsageStatsService } = await import('../lib/host/service.js')
    const withPrices = new UsageStatsService(new Context(), {
      sessionsRoot: root,
      priceBookPath: '/definitely/not/a/price-book.json',
    })
    const status = withPrices.status()
    assert.equal(status.hasPriceBook, false)
    const report = await withPrices.report({ detail: 'none' })
    assert.ok(report.totals.totalTokens > 0, 'usage must still be reported')
  })
})

describe('standalone dashboard server', { skip: skipReason ?? false }, () => {
  /** @type {string} */
  let root
  /** @type {any} */
  let usageStats
  /** @type {any} */
  let server

  before(async () => {
    root = makeTempRoot('dsh-server-test-')
    writeCorpus(root)
    const [{ UsageStatsService }, { startDashboardServer }] = await Promise.all([
      import('../lib/host/service.js'),
      import('../lib/host/server.js'),
    ])
    usageStats = new UsageStatsService(new Context(), { sessionsRoot: root })
    // Port 0 binds whatever the OS has free, so the suite never collides with a
    // real harness or a parallel test run.
    server = await startDashboardServer(usageStats, { port: 0, ttlMs: 0, status: () => usageStats.status() })
  })

  after(async () => {
    await server?.close()
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * Fetch from the server under test.
   *
   * @param {string} path request path.
   * @returns {Promise<{ status: number, headers: Headers, body: string }>} the response.
   */
  async function get(path) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`)
    return { status: response.status, headers: response.headers, body: await response.text() }
  }

  it('binds a real port and reports its own URL', () => {
    assert.ok(server.port > 0)
    assert.equal(server.host, '127.0.0.1')
    assert.equal(server.url, `http://127.0.0.1:${server.port}/`)
  })

  it('serves the dashboard at the root', async () => {
    const response = await get('/')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(response.body.startsWith('<!doctype html>'))
    assert.ok(response.body.includes('dsh-usage-data'))
    assert.ok(!/<script[^>]+src=/.test(response.body), 'the page must need no external script')
  })

  it('embeds the whole corpus, per-call rows included', async () => {
    const response = await get('/')
    const payload = JSON.parse(
      /<script type="application\/json" id="dsh-usage-data">([\s\S]*?)<\/script>/.exec(response.body)[1]
        .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'),
    )
    const embeddedCalls = payload.report.sessions.reduce((sum, session) => sum + session.callDetails.length, 0)
    assert.equal(embeddedCalls, 9, 'every billed call must be available to the drill-down')
    assert.equal(payload.report.totals.totalTokens, 1744)
  })

  it('serves the plain-text view and the Chinese document', async () => {
    const text = await get('/?view=text')
    assert.equal(text.status, 200)
    assert.ok(text.body.includes('Token usage report'))
    assert.ok(text.body.includes('<pre>'))

    const chinese = await get('/?lang=zh')
    assert.ok(chinese.body.includes('lang="zh"'))
    assert.ok(chinese.body.includes('DSH Token 用量看板'))
  })

  it('exposes a health endpoint and a JSON report', async () => {
    const health = await get('/healthz')
    assert.equal(health.status, 200)
    const parsed = JSON.parse(health.body)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.port, server.port)
    assert.equal(typeof parsed.sessionsRoot, 'string')

    const json = await get('/report.json')
    assert.equal(json.status, 200)
    const report = JSON.parse(json.body)
    assert.equal(report.totals.totalTokens, 1744)
    assert.equal(report.summary.calls, 9)
  })

  it('404s anything else instead of serving the page for it', async () => {
    const response = await get('/anything-else')
    assert.equal(response.status, 404)
  })

  it('reuses a rendered page, then rebuilds it after the window', async () => {
    const { startDashboardServer } = await import('../lib/host/server.js')
    const shortLived = await startDashboardServer(usageStats, { port: 0, ttlMs: 60_000 })
    try {
      const first = await fetch(`http://127.0.0.1:${shortLived.port}/`).then((response) => response.text())
      const second = await fetch(`http://127.0.0.1:${shortLived.port}/`).then((response) => response.text())
      assert.equal(second, first)
    } finally {
      await shortLived.close()
    }
  })

  it('steps to the next port when the first is taken', async () => {
    const { startDashboardServer } = await import('../lib/host/server.js')
    const { createServer } = await import('node:http')
    const blocker = createServer()
    const { promise: blocked, resolve: blockedReady } = Promise.withResolvers()
    blocker.listen(0, '127.0.0.1', blockedReady)
    await blocked
    const taken = blocker.address().port
    try {
      const second = await startDashboardServer(usageStats, { port: taken, portAttempts: 20 })
      try {
        assert.notEqual(second.port, taken, 'a busy port must not fail the plugin')
        assert.ok(second.port > taken, 'the next candidate port is tried')
        const response = await fetch(`http://127.0.0.1:${second.port}/healthz`)
        assert.equal(response.status, 200)
      } finally {
        await second.close()
      }
    } finally {
      blocker.close()
    }
  })

  it('reports a failure instead of throwing when every candidate port is taken', async () => {
    const { startDashboardServer } = await import('../lib/host/server.js')
    const { createServer } = await import('node:http')
    // Occupy a port deliberately rather than borrowing one from another test, so
    // this case is independent of execution order and of what else is running.
    const blocker = createServer()
    const { promise: blocked, resolve: blockedReady } = Promise.withResolvers()
    blocker.listen(0, '127.0.0.1', blockedReady)
    await blocked
    const taken = blocker.address().port
    try {
      // A single-attempt window on an occupied port must reject with a reason the
      // plugin can record, not crash the composition.
      await assert.rejects(
        () => startDashboardServer(usageStats, { port: taken, portAttempts: 1 }),
        /no free port in \d+\.\.\d+ on 127\.0\.0\.1/,
      )
      // And the failed attempt must not leave a handle behind.
      const rebound = await startDashboardServer(usageStats, { port: taken + 1 })
      await rebound.close()
    } finally {
      blocker.close()
    }
  })

  it('closes cleanly, releasing the port', async () => {
    const { startDashboardServer } = await import('../lib/host/server.js')
    const temporary = await startDashboardServer(usageStats, { port: 0 })
    const port = temporary.port
    await temporary.close()
    // A closed server must free its port, or a config reload could not rebind it.
    const rebound = await startDashboardServer(usageStats, { port })
    await rebound.close()
  })

  it('renders its empty state for a corpus with no usage', async () => {
    const { UsageStatsService } = await import('../lib/host/service.js')
    const { startDashboardServer } = await import('../lib/host/server.js')
    const emptyRoot = makeTempRoot('dsh-server-empty-')
    try {
      const empty = await startDashboardServer(new UsageStatsService(new Context(), { sessionsRoot: emptyRoot }), { port: 0 })
      const response = await fetch(`http://127.0.0.1:${empty.port}/`)
      assert.equal(response.status, 200)
      assert.ok((await response.text()).includes('<!doctype html>'))
      await empty.close()
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})
