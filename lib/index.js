/**
 * Package entry point.
 *
 * A `dsh.bundle` patch row names this package, so the harness imports exactly
 * this module to load the plugin. It is a one-line re-export of the host plugin
 * so that `dsh-usage-stats-long`, `dsh-usage-stats-long/host` and the entry in
 * the patch all load the same module instance — importing the plugin directly
 * from `./host/index.js` is equivalent, and the two never diverge.
 *
 * @module dsh-usage-stats-long
 */

export * from './host/index.js'
export { default } from './host/index.js'
