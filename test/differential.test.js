/**
 * Differential accuracy tests.
 *
 * The strongest available check on a token-accounting implementation is a
 * second, independently written one that reads the same bytes and must produce
 * the same numbers. Everything here is deliberately naive — a single left-to-
 * right walk with no caching, no aggregation layer and its own JSON parsing —
 * so a bug in the real engine's fold cannot hide behind a shared helper.
 *
 * Two corpora are used:
 * - a synthetic corpus that exercises every documented accuracy rule;
 * - `$DSH_REAL_SESSIONS`, an opt-in snapshot of a real harness session
 *   directory, compared call by call and counter by counter.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { before, after, describe, it } from 'node:test'
import { buildReport } from '../lib/core/scan.js'
import { discoverSessionLogs, decodeLogText } from '../lib/core/reader.js'
import { makeTempRoot, writeCorpus } from './helpers/log-builder.js'

/**
 * Fold a corpus the naive way: decode each log to text, walk the lines, and add
 * up every usage record verbatim.
 *
 * @param {string} root sessions root.
 * @returns {Promise<{ calls: number, totals: Record<string, number>, bySession: Record<string, any>, byRoute: Record<string, number> }>} the naive fold.
 */
async function naiveFold(root) {
  const { files } = discoverSessionLogs({ sessionsRoot: root })
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
  /** @type {Record<string, any>} */
  const bySession = {}
  /** @type {Record<string, number>} */
  const byRoute = {}
  let calls = 0
  for (const file of files) {
    const { text } = await decodeLogText(file)
    if (text.length === 0) continue
    const perSession = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, calls: 0,
    }
    /** @type {any} */
    let header
    /** @type {'inherited' | 'own'} */
    let region = 'own'
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'session') {
        if (header === undefined) {
          header = event
          if (event.isSeeded === true) region = 'inherited'
        }
        continue
      }
      if (event.type === 'session/end-seed') {
        region = 'own'
        continue
      }
      if (region === 'inherited') continue
      const data = event.data
      if (data === undefined || data === null) continue
      if (event.type !== 'assistant/message' && event.type !== 'compaction/summary') continue
      const usage = data.usage
      if (usage === undefined || usage === null) continue
      const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
      const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
      const read = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
      const write = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
      const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : input + output + read + write
      perSession.inputTokens += input
      perSession.outputTokens += output
      perSession.cacheReadTokens += read
      perSession.cacheWriteTokens += write
      perSession.reasoningTokens += typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0
      perSession.totalTokens += total
      perSession.calls += 1
      totals.inputTokens += input
      totals.outputTokens += output
      totals.cacheReadTokens += read
      totals.cacheWriteTokens += write
      totals.reasoningTokens += typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0
      totals.totalTokens += total
      calls += 1
      const source = data.message?.source
      const provider = typeof source?.provider === 'string' ? source.provider : (data.provider ?? '(unknown)')
      const model = typeof source?.model === 'string' ? source.model : (data.model ?? '(unknown)')
      byRoute[`${provider}/${model}`] = (byRoute[`${provider}/${model}`] ?? 0) + total
    }
    if (perSession.calls > 0) bySession[header?.id ?? file.sessionId] = perSession
  }
  return { calls, totals, bySession, byRoute }
}

describe('differential accuracy on a synthetic corpus', () => {
  /** @type {string} */
  let root

  before(() => {
    root = makeTempRoot('dsh-differential-')
    writeCorpus(root)
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('agrees with an independent fold on every counter', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'full' })
    const naive = await naiveFold(root)
    assert.equal(report.summary.calls, naive.calls, 'call count')
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
      assert.equal(report.totals[field], naive.totals[field], field)
    }
    const naiveTotal = Object.values(naive.totals).reduce((sum, value) => sum + value, 0)
    assert.ok(naiveTotal > 0, 'the corpus must actually contain usage')
  })

  it('agrees per session', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'turns' })
    const naive = await naiveFold(root)
    for (const session of report.sessions) {
      const expected = naive.bySession[session.sessionId]
      assert.ok(expected, `the naive fold must know ${session.sessionId}`)
      assert.equal(session.calls, expected.calls, `${session.sessionId} calls`)
      assert.equal(session.tokens.totalTokens, expected.totalTokens, `${session.sessionId} total`)
      assert.equal(session.tokens.inputTokens, expected.inputTokens, `${session.sessionId} input`)
      assert.equal(session.tokens.cacheReadTokens, expected.cacheReadTokens, `${session.sessionId} cache read`)
      assert.equal(session.tokens.outputTokens, expected.outputTokens, `${session.sessionId} output`)
    }
  })

  it('agrees per model route', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'none' })
    const naive = await naiveFold(root)
    for (const model of report.models) {
      const key = `${model.provider}/${model.model}`
      assert.equal(model.totalTokens, naive.byRoute[key], key)
    }
    assert.equal(
      Object.keys(naive.byRoute).sort().join(','),
      report.models.map((model) => `${model.provider}/${model.model}`).sort().join(','),
    )
  })
})

const realRoot = process.env.DSH_REAL_SESSIONS

describe('differential accuracy on a real corpus', { skip: realRoot === undefined ? 'set DSH_REAL_SESSIONS to a sessions directory to run this' : false }, () => {
  it('agrees with an independent fold on every counter', async () => {
    const report = await buildReport({ sessionsRoot: realRoot, detail: 'full' })
    const naive = await naiveFold(/** @type {string} */ (realRoot))
    assert.equal(report.summary.calls, naive.calls, 'call count')
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
      assert.equal(report.totals[field], naive.totals[field], field)
    }
  })

  it('agrees per session and per route', async () => {
    const report = await buildReport({ sessionsRoot: realRoot, detail: 'turns' })
    const naive = await naiveFold(/** @type {string} */ (realRoot))
    for (const session of report.sessions) {
      const expected = naive.bySession[session.sessionId]
      assert.ok(expected)
      assert.equal(session.calls, expected.calls, `${session.sessionId} calls`)
      assert.equal(session.tokens.totalTokens, expected.totalTokens, `${session.sessionId} total`)
    }
    const models = await buildReport({ sessionsRoot: realRoot, detail: 'none' })
    for (const model of models.models) {
      assert.equal(model.totalTokens, naive.byRoute[`${model.provider}/${model.model}`], `${model.provider}/${model.model}`)
    }
  })

  it('decodes every log in the corpus completely', async () => {
    const { files } = discoverSessionLogs({ sessionsRoot: realRoot })
    assert.ok(files.length > 0, 'the corpus must contain at least one log')
    for (const file of files) {
      const decoded = await decodeLogText(file)
      if (decoded.text.length === 0) continue
      const firstLine = readFileSync(file.file).length
      assert.ok(firstLine > 0)
      assert.ok(
        decoded.text.includes('"type":"session"'),
        `${file.file} must decode to a session log, not a fragment`,
      )
    }
  })
})
