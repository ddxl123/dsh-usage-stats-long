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
import { startDashboardServer, DEFAULT_HOST, DEFAULT_LANG, DEFAULT_PORT, DEFAULT_PORT_ATTEMPTS, DEFAULT_TTL_MS } from './server.js'

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
 * @property {boolean} [web] start the plugin's own dashboard server.
 * @property {string} [webHost] bind address for that server.
 * @property {number} [webPort] first port to try; 0 binds an ephemeral one.
 * @property {number} [webPortAttempts] consecutive ports to try when taken.
 * @property {number} [webTtlMs] how long a rendered page is reused.
 * @property {'en' | 'zh'} [webLang] default label language for the page.
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
  web: Schema.boolean().default(true),
  webHost: Schema.string().default(DEFAULT_HOST),
  webPort: Schema.number().default(DEFAULT_PORT),
  webPortAttempts: Schema.number().default(DEFAULT_PORT_ATTEMPTS),
  webTtlMs: Schema.number().default(DEFAULT_TTL_MS),
  webLang: Schema.union(['en', 'zh']).default(DEFAULT_LANG),
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
  if (config.web) {
    // Binding is asynchronous, and `apply` must not await a socket: a plugin that
    // blocked here would delay the whole composition, and an unavailable port must
    // degrade one page rather than the plugin. `ctx.effect` keeps the server
    // owned by this fiber, so a reload, a config change or an unload closes it
    // instead of leaking a listener on the port.
    const state = { server: undefined, error: undefined, starting: undefined }
    service.web = state
    ctx.effect(() => {
      state.starting = startDashboardServer(service, {
        host: config.webHost,
        port: config.webPort,
        portAttempts: config.webPortAttempts,
        ttlMs: config.webTtlMs,
        lang: config.webLang,
        status: () => service.status(),
      }).then(
        (server) => {
          state.server = server
          state.error = undefined
          ctx.logger?.info?.(`usage-stats: dashboard on ${server.url}`)
          return server
        },
        (error) => {
          state.error = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`usage-stats: dashboard server did not start: ${state.error}`)
          return undefined
        },
      )
      return () => {
        const running = state.server
        state.server = undefined
        void running?.close()
      }
    })
  }
}

export { UsageStatsService }
export { registerUsageTools }
export { startDashboardServer }
export { DEFAULT_PORT, DEFAULT_HOST }
export default { name, inject, Config, apply }
