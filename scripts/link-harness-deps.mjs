#!/usr/bin/env node
/**
 * Make this package's harness peer dependencies resolvable.
 *
 * ## Why this is necessary
 *
 * The plugin imports `@deepseek-ai/cordis`, `@deepseek-ai/schemastery` and
 * `@deepseek-ai/dsh-tools`. Those are peer dependencies: they belong to the
 * harness installation, not to this package.
 *
 * Node resolves a package's bare imports from its **real** path, following
 * symlinks. A harness-managed profile therefore cannot help here: `dsh` links an
 * out-of-tree plugin at `<profile>/node_modules/<name>` and maintains
 * `profiles/node_modules/@deepseek-ai/*` as a fallback, but resolution from the
 * plugin's real directory walks up *that* tree instead and never sees either.
 * The result is not a degraded plugin but a failed load — `Cannot find package
 * '@deepseek-ai/cordis'` — which is why this runs automatically after install.
 *
 * Resolution order:
 *   1. `node_modules/@deepseek-ai/*` inside this package, when already correct;
 *   2. `--from <dir>` or `DSH_NODE_MODULES` — a node_modules directory or an
 *      install root to link from;
 *   3. every `npx` cache and the profile fallback directory the harness
 *      maintains, newest first.
 *
 * A deployment that resolves the peers by some other means (a published
 * install, a workspace, a bundler) needs nothing from this script: it exits
 * successfully and silently when the peers are already importable.
 *
 * @module dsh-usage-stats-long/scripts/link-harness-deps
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Peer packages this package imports at runtime. */
export const PEERS = ['cordis', 'schemastery', 'dsh-tools']

/** Packages that are useful for local development and tests. */
export const DEV_PEERS = ['dsh-llm', 'dsh-util-values']

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
  if (value === undefined || value.startsWith('--')) throw new Error('--from requires a directory')
  return resolve(value)
}

/**
 * Can this package import its peers already?
 *
 * @param {string[]} packages package names to check.
 * @returns {Promise<string[]>} the names that failed to import.
 */
async function unresolvable(packages) {
  /** @type {string[]} */
  const failed = []
  for (const name of packages) {
    try {
      await import(`@deepseek-ai/${name}`)
    } catch {
      failed.push(name)
    }
  }
  return failed
}

/**
 * Does a directory look like a place the harness packages live?
 *
 * @param {string} dir candidate directory.
 * @returns {boolean} true when at least one expected package is present.
 */
function looksLikeHarnessModules(dir) {
  if (!existsSync(dir)) return false
  return ['cordis', 'dsh', 'schemastery'].some((name) => existsSync(join(dir, '@deepseek-ai', name)))
}

/**
 * Collect candidate `node_modules` directories, most likely first.
 *
 * @returns {string[]} candidates.
 */
function candidates() {
  /** @type {string[]} */
  const found = []
  const explicit = fromFlag(process.argv.slice(2)) ?? process.env.DSH_NODE_MODULES
  if (explicit !== undefined) {
    found.push(explicit)
    found.push(join(explicit, 'node_modules'))
  }
  // The npx cache layout: ~/.npm/_npx/<hash>/node_modules — newest first, since
  // a fresh `npx @deepseek-ai/dsh` lands in a new hash directory.
  const npxRoot = join(homedir(), '.npm', '_npx')
  if (existsSync(npxRoot)) {
    /** @type {Array<{ dir: string, mtime: number }>} */
    const entries = []
    for (const entry of readdirSync(npxRoot)) {
      const dir = join(npxRoot, entry, 'node_modules')
      try {
        entries.push({ dir, mtime: statSync(join(npxRoot, entry)).mtimeMs })
      } catch {
        // A cache directory that vanished mid-scan is simply not a candidate.
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries) found.push(entry.dir)
  }
  // The fallback directory the harness maintains for profile plugins.
  found.push(join(homedir(), '.dsh', 'profiles', 'node_modules'))
  found.push(join(projectRoot, 'node_modules'))
  return found
}

/**
 * Link the peers from the first harness installation that has them.
 *
 * @param {object} [options] options.
 * @param {string[]} [options.packages] packages to link; defaults to the runtime peers.
 * @param {boolean} [options.quiet] suppress the success line.
 * @returns {Promise<{ linked: string[], from?: string, missing: string[] }>} the outcome.
 */
export async function linkHarnessDeps(options = {}) {
  const packages = options.packages ?? PEERS
  const already = await unresolvable(packages)
  if (already.length === 0) return { linked: [], missing: [] }

  /** @type {string | undefined} */
  let source
  for (const candidate of candidates()) {
    if (looksLikeHarnessModules(candidate)) {
      source = candidate
      break
    }
  }
  if (source === undefined) {
    return { linked: [], missing: already }
  }

  const target = join(projectRoot, 'node_modules', '@deepseek-ai')
  mkdirSync(target, { recursive: true })
  /** @type {string[]} */
  const linked = []
  /** @type {string[]} */
  const missing = []
  for (const name of packages) {
    const from = join(source, '@deepseek-ai', name)
    if (!existsSync(from)) {
      missing.push(name)
      continue
    }
    const to = join(target, name)
    // Replace rather than nest, so a re-run cannot build a link inside a link.
    if (lstatSync(to, { throwIfNoEntry: false }) !== undefined) rmSync(to, { recursive: true, force: true })
    symlinkSync(from, to, 'dir')
    linked.push(name)
  }
  return { linked, missing, from: source }
}

// Run as a script, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await linkHarnessDeps()
  if (runtime.linked.length === 0 && runtime.missing.length === 0) {
    process.stdout.write('harness peers already resolvable; nothing to do\n')
  } else if (runtime.from === undefined) {
    process.stderr.write(
      `Could not find an installed harness providing: ${runtime.missing.join(', ')}\n`
      + 'The plugin will fail to load until they resolve. Point at one explicitly:\n'
      + '  node scripts/link-harness-deps.mjs --from /path/to/node_modules\n',
    )
    process.exitCode = 1
  } else {
    process.stdout.write(`harness: ${runtime.from}\nlinked:  ${runtime.linked.join(', ')}\n`)
    if (runtime.missing.length > 0) process.stdout.write(`absent:  ${runtime.missing.join(', ')}\n`)
  }
}
