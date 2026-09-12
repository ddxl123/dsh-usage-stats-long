/**
 * Peer-resolution tests.
 *
 * The plugin imports `@deepseek-ai/cordis`, `@deepseek-ai/schemastery` and
 * `@deepseek-ai/dsh-tools`, which belong to the harness installation. Node
 * resolves a package's bare imports from its real path, so a linked plugin
 * cannot see the harness's own fallback directory — the failure this project hit
 * in production, where a plugin loaded but its `Config` degraded to a plain
 * function and the whole tree refused to compose.
 *
 * These tests pin the two halves of the guard: the peers must be resolvable,
 * and the helper that establishes them must behave predictably.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { PEERS, linkHarnessDeps } from '../scripts/link-harness-deps.mjs'

describe('harness peer dependencies', () => {
  it('are resolvable, so the plugin can actually load', async () => {
    /** @type {string[]} */
    const failures = []
    for (const name of PEERS) {
      try {
        await import(`@deepseek-ai/${name}`)
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    }
    assert.deepEqual(
      failures,
      [],
      `peer dependencies must resolve (run: node scripts/link-harness-deps.mjs)\n${failures.join('\n')}`,
    )
  })

  it('reports nothing to do when the peers already resolve', async () => {
    const result = await linkHarnessDeps()
    assert.deepEqual(result.linked, [], 'an already-correct install must not be touched')
    assert.deepEqual(result.missing, [])
    assert.equal(result.from, undefined)
  })

  it('reports an absent package instead of throwing, and links nothing', async () => {
    const result = await linkHarnessDeps({ packages: ['definitely-not-a-real-package'] })
    assert.deepEqual(result.linked, [])
    assert.deepEqual(result.missing, ['definitely-not-a-real-package'])
    // A harness was found (that is what makes this a useful negative case): the
    // helper reports the absent package rather than inventing a link for it.
    assert.equal(typeof result.from, 'string')
  })

  it('never exports a Config that is neither a schema nor undefined', async () => {
    // Cordis reads `Config['~standard'].validate`; a plain function here is what
    // turned a degraded plugin into a harness that would not start.
    const { Config } = await import('../lib/host/index.js')
    if (Config === undefined) return
    assert.equal(typeof Config['~standard'], 'object', 'Config must be a Standard Schema')
    assert.equal(typeof Config['~standard'].validate, 'function')
    const result = Config['~standard'].validate({})
    assert.ok(!('then' in result), 'config validation must be synchronous')
    assert.equal(result.issues, undefined, 'the defaults must validate cleanly')
    assert.equal(typeof result.value.webPort, 'number')
  })
})
