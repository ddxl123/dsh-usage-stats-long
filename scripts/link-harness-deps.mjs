#!/usr/bin/env node
/**
 * Link the harness's `@deepseek-ai/*` packages into this project's
 * `node_modules`, so the plugin-surface tests can load the real `dsh-tools`
 * schema compiler and the real Cordis `Service` base class.
 *
 * These are peer dependencies: in production they come from the user's own
 * harness installation. For local development there is nothing to install, so
 * this script points at the copy that is already on the machine.
 *
 * Resolution order:
 *   1. `--from <dir>` — a node_modules directory or an install root.
 *   2. `DSH_NODE_MODULES` — same, from the environment.
 *   3. Every dsh install reachable from `npx` caches and global installs.
 *
 * Usage:
 *   node scripts/link-harness-deps.mjs
 *   node scripts/link-harness-deps.mjs --from /path/to/node_modules
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGES = ['cordis', 'schemastery', 'dsh-tools', 'dsh-llm', 'dsh-util-values']
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Read `--from <dir>` from argv.
 *
 * @param {string[]} argv process arguments.
 * @returns {string | undefined} the requested directory.
 */
function fromFlag(argv) {
  const index = argv.indexOf('--from')
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--from requires a directory')
  }
  return value
}

/**
 * Does a directory look like a place `@deepseek-ai/*` packages live?
 *
 * @param {string} dir candidate directory.
 * @returns {boolean} true when at least one expected package is present.
 */
function looksLikeNodeModules(dir) {
  if (!existsSync(dir)) return false
  return PACKAGES.some((name) => existsSync(join(dir, '@deepseek-ai', name)))
}

/**
 * Collect candidate `node_modules` directories that could hold the harness.
 *
 * @returns {string[]} candidates, most likely first.
 */
function candidates() {
  /** @type {string[]} */
  const found = []
  const explicit = fromFlag(process.argv.slice(2)) ?? process.env.DSH_NODE_MODULES
  if (explicit !== undefined) {
    const base = resolve(explicit)
    found.push(base)
    found.push(join(base, 'node_modules'))
  }
  // The npx cache layout: ~/.npm/_npx/<hash>/node_modules
  const npxRoot = join(homedir(), '.npm', '_npx')
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      found.push(join(npxRoot, entry, 'node_modules'))
    }
  }
  // A global or local install of the dsh CLI.
  found.push(join(homedir(), '.dsh', 'profiles', 'node_modules'))
  found.push(join(projectRoot, 'node_modules'))
  return found
}

const target = join(projectRoot, 'node_modules', '@deepseek-ai')
let source
for (const candidate of candidates()) {
  if (looksLikeNodeModules(candidate)) {
    source = candidate
    break
  }
}
if (source === undefined) {
  process.stderr.write(
    'Could not find an installed harness with @deepseek-ai/* packages.\n'
    + 'Pass one explicitly:  node scripts/link-harness-deps.mjs --from /path/to/node_modules\n',
  )
  process.exit(1)
}

mkdirSync(target, { recursive: true })
/** @type {string[]} */
const linked = []
/** @type {string[]} */
const missing = []
for (const name of PACKAGES) {
  const from = join(source, '@deepseek-ai', name)
  if (!existsSync(from)) {
    missing.push(name)
    continue
  }
  const to = join(target, name)
  // Replace an existing link deterministically instead of nesting a link in it.
  if (lstatSync(to, { throwIfNoEntry: false }) !== undefined) rmSync(to, { recursive: true, force: true })
  symlinkSync(from, to, 'dir')
  linked.push(name)
}

process.stdout.write(`harness: ${source}\n`)
process.stdout.write(`linked:  ${linked.join(', ') || '(none)'}\n`)
if (missing.length > 0) process.stdout.write(`absent:  ${missing.join(', ')} (tests needing them will skip)\n`)
