#!/usr/bin/env node
/**
 * Syntax-check every shipped JavaScript file.
 *
 * The package ships plain ESM with no build step, so a syntax error would
 * otherwise reach a user's harness at load time. `node --check` parses without
 * executing, which is exactly the guarantee needed here.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['lib', 'bin', 'test', 'scripts']

/**
 * Walk a directory and collect every `.js` or `.mjs` file.
 *
 * @param {string} dir directory to walk.
 * @returns {string[]} absolute file paths.
 */
function collect(dir) {
  /** @type {string[]} */
  const files = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return files
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      files.push(...collect(path))
      continue
    }
    if (entry.endsWith('.js') || entry.endsWith('.mjs')) files.push(path)
  }
  return files
}

/** @type {string[]} */
const files = []
for (const root of ROOTS) files.push(...collect(join(projectRoot, root)))

let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failed += 1
    process.stderr.write(`${file}\n${error instanceof Error ? error.stderr?.toString() ?? error.message : String(error)}\n`)
  }
}

process.stdout.write(`checked ${files.length} file(s), ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
