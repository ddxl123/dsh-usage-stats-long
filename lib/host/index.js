/**
 * The DSH host plugin: `usageStats` service plus the model-facing tools.
 *
 * Mount it as a bundle row:
 *
 * ```yaml
 * - id: usage-stats
 *   name: 'dsh-usage-stats-long'
 * ```
 *
 * It contributes:
 * - the `usageStats` service (report, sessions, dimensions, findSession, status);
 * - `usage_stats`, `usage_sessions` and `usage_calls`, registered into `ctx.tools`.
 *
 * Both are effect-owned: unmounting the row removes the service and every tool,
 * because registration goes through `ctx` rather than a module-level singleton.
 *
 * @module dsh-usage-stats-long
 */

import Schema from '@deepseek-ai/schemastery'
import { UsageStatsService } from './service.js'
import { registerUsageTools } from './tool.js'
import { registerDashboardRoute, DEFAULT_ROUTE_PATH, DEFAULT_TTL_MS } from './web.js'

export const name = 'usage-stats'

/**
 * Tools are a hard dependency: this plugin's entire model-facing surface is
 * tools, so it must not activate before the registry exists.
 */
export const inject = ['tools']

/**
 * @typedef {object} Config
 * @property {string} [sessionsRoot] sessions root override; defaults to `$DSH_HOME/sessions`.
 * @property {string} [priceBookPath] JSON price book to load for cost estimates.
 * @property {number} [cacheSize] folded sessions retained between queries.
 * @property {boolean} [registerTools] register the model-facing tools.
 * @property {boolean} [webRoute] serve the dashboard on the harness webserver.
 * @property {string} [webPath] URL path for that route.
 * @property {number} [webTtlMs] how long a rendered page is reused.
 */

/**
 * Defaults live in the schema, so every knob is changeable from `cordis.yml`
 * without editing code — the harness convention for deployment-varying values.
 */
export const Config = Schema.object({
  sessionsRoot: Schema.string().default(''),
  priceBookPath: Schema.string().default(''),
  cacheSize: Schema.number().default(256),
  registerTools: Schema.boolean().default(true),
  webRoute: Schema.boolean().default(true),
  webPath: Schema.string().default(DEFAULT_ROUTE_PATH),
  webTtlMs: Schema.number().default(DEFAULT_TTL_MS),
})

/**
 * Mount the service and, optionally, the tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx the owning context.
 * @param {Config} config validated plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const service = new UsageStatsService(ctx, {
    sessionsRoot: config.sessionsRoot === '' ? undefined : config.sessionsRoot,
    priceBookPath: config.priceBookPath === '' ? undefined : config.priceBookPath,
    cacheSize: config.cacheSize,
  })
  // `Service` construction registers the service with this fiber, so an unmount
  // disposes it and any consumer that injected it waits for a replacement.
  void service
  if (config.registerTools) {
    registerUsageTools(ctx, { usageStats: service })
  }
  if (config.webRoute) {
    // The webserver is composed by a different bundle row, so it may not exist
    // yet when this row loads — and it may be replaced later. `ctx.inject` is
    // the deferred form: it runs now if the service is present, waits if it is
    // not, and re-runs on replacement, unloading the previous registration.
    // A deployment that never mounts a webserver (headless, TUI) simply never
    // runs the callback, which is not an error.
    ctx.inject(['webServer'], (webCtx) => {
      const route = registerDashboardRoute(webCtx, service, {
        path: config.webPath,
        ttlMs: config.webTtlMs,
      })
      return () => route?.dispose()
    })
  }
}

export { UsageStatsService }
export { registerUsageTools }
export { registerDashboardRoute }
export { DEFAULT_ROUTE_PATH }
export default { name, inject, Config, apply }
