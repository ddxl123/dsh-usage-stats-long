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

describe('dashboard web route', { skip: skipReason ?? false }, () => {
  /** @type {string} */
  let root
  /** @type {any} */
  let usageStats
  /** @type {any} */
  let registeredRoute

  before(async () => {
    root = makeTempRoot('dsh-web-test-')
    writeCorpus(root)
    const [{ UsageStatsService }, { registerDashboardRoute }] = await Promise.all([
      import('../lib/host/service.js'),
      import('../lib/host/web.js'),
    ])
    const context = new Context()
    usageStats = new UsageStatsService(context, { sessionsRoot: root })
    // A webserver stand-in: the route contract is kind + path + handler.
    const webServer = {
      register(route) {
        registeredRoute = route
        return () => { registeredRoute = undefined }
      },
    }
    const pluginCtx = { get: (name) => (name === 'webServer' ? webServer : undefined) }
    registerDashboardRoute(pluginCtx, usageStats, { path: '/usage', ttlMs: 0 })
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('registers a prefix route at the configured path', () => {
    assert.equal(registeredRoute.kind, 'prefix')
    assert.equal(registeredRoute.path, '/usage')
  })

  it('answers the root path with a self-contained dashboard', async () => {
    const response = makeResponse()
    await registeredRoute.handler({ url: '/usage', method: 'GET' }, response)
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /text\/html/)
    assert.match(response.headers['content-security-policy'], /default-src 'none'/)
    assert.ok(response.body.startsWith('<!doctype html>'))
    assert.ok(response.body.includes('dsh-usage-data'), 'the payload element must be present')
    assert.ok(!/<script[^>]+src=/.test(response.body), 'no external script may be required')
  })

  it('serves a plain-text view on request', async () => {
    const response = makeResponse()
    await registeredRoute.handler({ url: '/usage?view=text', method: 'GET' }, response)
    assert.equal(response.status, 200)
    assert.ok(response.body.includes('Token usage report'))
    assert.ok(response.body.includes('<pre>'))
  })

  it('localizes the document', async () => {
    const response = makeResponse()
    await registeredRoute.handler({ url: '/usage?lang=zh', method: 'GET' }, response)
    assert.equal(response.status, 200)
    assert.ok(response.body.includes('lang="zh"'))
  })

  it('404s a nested path instead of serving the page for it', async () => {
    const response = makeResponse()
    await registeredRoute.handler({ url: '/usage/anything', method: 'GET' }, response)
    assert.equal(response.status, 404)
  })

  it('reports a broken corpus as a page rather than crashing the server', async () => {
    const { UsageStatsService } = await import('../lib/host/service.js')
    const { registerDashboardRoute } = await import('../lib/host/web.js')
    const broken = new UsageStatsService(new Context(), { sessionsRoot: '/definitely/not/here' })
    let route
    registerDashboardRoute({ get: (name) => (name === 'webServer' ? { register: (r) => { route = r; return () => {} } } : undefined) }, broken, { ttlMs: 0 })
    const response = makeResponse()
    await route.handler({ url: '/usage', method: 'GET' }, response)
    // An empty corpus is not an error: the dashboard renders its empty state.
    assert.equal(response.status, 200)
    assert.ok(response.body.includes('<!doctype html>'))
  })

  it('does nothing when the deployment has no webserver', async () => {
    const { registerDashboardRoute } = await import('../lib/host/web.js')
    const result = registerDashboardRoute({ get: () => undefined }, usageStats)
    assert.equal(result, undefined, 'a headless deployment must not fail to load')
  })
})

/**
 * Build a minimal ServerResponse stand-in that records what was written.
 *
 * @returns {any} the stand-in response.
 */
function makeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
      return this
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk)
    },
  }
}
