#!/usr/bin/env node
/**
 * Executable entry point for `dsh-usage-stats`.
 *
 * Kept to argument passing and exit-code handling so every behavior stays
 * testable through `lib/cli/index.js`.
 */

import { run } from '../lib/cli/index.js'

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`dsh-usage-stats crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
