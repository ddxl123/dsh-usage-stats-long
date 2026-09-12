/**
 * Fold and report tests: the accuracy rules, stated as executable claims.
 *
 * Each test names a way a usage total can be wrong — double-billed retries,
 * a fork recounting its parent's spend, a torn log discarding real calls — and
 * asserts the number this project reports instead.
 */

import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { buildReport, listSessions } from '../lib/core/scan.js'
import { foldSessionLog } from '../lib/core/fold.js'
import { discoverSessionLogs } from '../lib/core/reader.js'
import { LogBuilder, makeTempRoot, writeCorpus, writeLog } from './helpers/log-builder.js'

/** @type {string} */
let root
/** @type {{ expected: { calls: number, totals: Record<string, number> }, sessions: Record<string, string> }} */
let corpus

before(() => {
  root = makeTempRoot('dsh-fold-test-')
  corpus = writeCorpus(root)
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Fold one session by its corpus key.
 *
 * @param {keyof typeof corpus.sessions} key corpus key.
 * @returns {Promise<import('../lib/core/types.js').SessionReport>} the folded session.
 */
async function fold(key) {
  const id = corpus.sessions[key]
  const log = discoverSessionLogs({ sessionsRoot: root }).files.find((file) => file.sessionId === id)
  assert.ok(log, `the corpus must contain ${key}`)
  return foldSessionLog(log)
}

describe('provider-reported counting', () => {
  it('counts exactly one call per usage-bearing event, with its own counters', async () => {
    const session = await fold('alpha')
    assert.equal(session.calls, 2)
    assert.equal(session.turns, 1)
    assert.equal(session.steps, 2)
    assert.deepEqual(
      {
        inputTokens: session.tokens.inputTokens,
        outputTokens: session.tokens.outputTokens,
        cacheReadTokens: session.tokens.cacheReadTokens,
        totalTokens: session.tokens.totalTokens,
      },
      { inputTokens: 150, outputTokens: 30, cacheReadTokens: 1000, totalTokens: 1180 },
    )
    assert.equal(session.peakPromptTokens, 1050, 'the peak prompt includes the cached share')
    assert.equal(session.contextWindow, 200000)
  })

  it('attributes a call to its own message source', async () => {
    const session = await fold('compacting')
    const routes = session.callDetails.map((call) => `${call.provider}/${call.model}`)
    assert.deepEqual(routes, ['prov-a/model-x', 'prov-b/model-z', 'prov-b/model-z'])
  })

  it('counts a compaction summary as a billed call of its own route', async () => {
    const session = await fold('compacting')
    const compaction = session.callDetails.find((call) => call.kind === 'compaction')
    assert.ok(compaction, 'the compaction summary must appear in the ledger')
    assert.equal(compaction.model, 'model-z')
    assert.equal(compaction.tokens.totalTokens, 440)
    assert.equal(compaction.compactionId, 'c1')
  })

  it('reads a legacy log that has no route events at all', async () => {
    const session = await fold('legacy')
    assert.equal(session.logVersion, 0)
    assert.equal(session.calls, 1)
    assert.equal(session.tokens.totalTokens, 10)
    assert.equal(session.tokens.reasoningTokens, 2)
    assert.equal(session.tokens.totalDerived, true, 'the provider reported no exact total')
    assert.equal(session.callDetails[0].provider, 'prov-b')
  })
})

describe('seed boundaries', () => {
  it('excludes the fork-inherited prefix that was already billed to the parent', async () => {
    const session = await fold('forked')
    assert.equal(session.seeded, true)
    assert.equal(session.calls, 1, 'only the call after the seed boundary is this session\'s own')
    assert.equal(session.tokens.totalTokens, 36)
    assert.ok(session.inheritedEventCount > 0)
  })
})

describe('subagent attribution', () => {
  it('marks a child session and keeps its own spend', async () => {
    const session = await fold('child')
    assert.equal(session.isSubagent, true)
    assert.equal(session.kind, 'subagent')
    assert.equal(session.delegationDepth, 1)
    assert.equal(session.tokens.totalTokens, 15)
  })
})

describe('torn input', () => {
  it('keeps the calls recorded before a malformed line and warns', async () => {
    const session = await fold('torn')
    assert.equal(session.calls, 1)
    assert.equal(session.tokens.totalTokens, 20)
    assert.ok(session.warnings.some((warning) => warning.includes('malformed')))
  })
})

describe('session identity', () => {
  it('uses the header cwd and derives the project label from it', async () => {
    const session = await fold('alpha')
    assert.equal(session.cwd, '/work/alpha')
    assert.equal(session.project, 'alpha')
  })

  it('folds the latest title', async () => {
    const session = await fold('alpha')
    assert.equal(session.title, 'Alpha session')
  })
})

describe('whole-corpus totals', () => {
  it('matches the independently computed expectation exactly', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'full' })
    assert.equal(report.summary.calls, corpus.expected.calls)
    assert.equal(report.totals.inputTokens, corpus.expected.totals.inputTokens)
    assert.equal(report.totals.outputTokens, corpus.expected.totals.outputTokens)
    assert.equal(report.totals.cacheReadTokens, corpus.expected.totals.cacheReadTokens)
    assert.equal(report.totals.cacheWriteTokens, corpus.expected.totals.cacheWriteTokens)
    assert.equal(report.totals.reasoningTokens, corpus.expected.totals.reasoningTokens)
    assert.equal(report.totals.totalTokens, corpus.expected.totals.totalTokens)
  })

  it('keeps the sum of its sessions equal to its own total', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'turns' })
    const summed = report.sessions.reduce((total, session) => total + session.tokens.totalTokens, 0)
    assert.equal(summed, report.totals.totalTokens)
    const modelSum = report.models.reduce((total, model) => total + model.totalTokens, 0)
    assert.equal(modelSum, report.totals.totalTokens)
    const projectSum = report.projects.reduce((total, project) => total + project.tokens.totalTokens, 0)
    assert.equal(projectSum, report.totals.totalTokens)
    const seriesSum = report.series.reduce((total, bucket) => total + bucket.tokens.totalTokens, 0)
    assert.equal(seriesSum, report.totals.totalTokens)
  })

  it('omits a session that recorded no usage from the report but keeps it in the catalog', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'none' })
    assert.equal(report.sessions.find((session) => session.sessionId === corpus.sessions.empty), undefined)
    const catalog = await listSessions({ sessionsRoot: root })
    assert.ok(catalog.sessions.some((session) => session.sessionId === corpus.sessions.empty))
  })

  it('groups the same spend under two projects', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'none' })
    const alpha = report.projects.find((project) => project.project === 'alpha')
    assert.ok(alpha)
    assert.equal(alpha.sessions, 4, 'alpha, its fork, compacting and the subagent child share the directory')
  })
})

describe('filters', () => {
  it('selects by model and recomputes session totals from the surviving calls', async () => {
    const report = await buildReport({ sessionsRoot: root, filters: { models: ['model-z'] }, detail: 'full' })
    assert.ok(report.summary.calls > 0)
    for (const call of report.calls) assert.equal(call.model, 'model-z')
    const compacting = report.sessions.find((session) => session.sessionId === corpus.sessions.compacting)
    assert.ok(compacting)
    assert.equal(compacting.calls, 2, 'only the model-z calls survive')
    assert.equal(compacting.tokens.totalTokens, 468)
  })

  it('selects a provider name and a provider wildcard alike', async () => {
    const byName = await buildReport({ sessionsRoot: root, filters: { providers: ['prov-b'] }, detail: 'none' })
    const byWildcard = await buildReport({ sessionsRoot: root, filters: { models: ['prov-b/*'] }, detail: 'none' })
    assert.equal(byName.totals.totalTokens, byWildcard.totals.totalTokens)
    assert.ok(byName.totals.totalTokens > 0)
  })

  it('accepts a session id prefix', async () => {
    const prefix = corpus.sessions.compacting.replace(/^session-/, '').slice(0, 8)
    const report = await buildReport({ sessionsRoot: root, filters: { sessionIds: [prefix] }, detail: 'none' })
    assert.equal(report.summary.sessions, 1)
    assert.equal(report.totals.totalTokens, 483)
  })

  it('restricts to subagent children', async () => {
    const report = await buildReport({ sessionsRoot: root, filters: { kinds: ['subagent'] }, detail: 'none' })
    assert.equal(report.summary.sessions, 1)
    assert.equal(report.summary.subagentSessions, 1)
    assert.equal(report.totals.totalTokens, 15)
  })

  it('applies a time window to individual calls', async () => {
    const all = await buildReport({ sessionsRoot: root, detail: 'full' })
    const sorted = [...all.calls].sort((a, b) => a.time - b.time)
    const pivot = sorted[Math.floor(sorted.length / 2)].time
    const later = await buildReport({ sessionsRoot: root, filters: { since: pivot }, detail: 'full' })
    assert.ok(later.summary.calls < all.summary.calls)
    for (const call of later.calls) assert.ok(call.time >= pivot)
    assert.equal(later.totals.totalTokens, sorted.filter((call) => call.time >= pivot).reduce((sum, call) => sum + call.tokens.totalTokens, 0))
  })

  it('drops sessions below a spend threshold', async () => {
    const report = await buildReport({ sessionsRoot: root, filters: { minTokens: 400 }, detail: 'none' })
    for (const session of report.sessions) assert.ok(session.tokens.totalTokens >= 400)
  })

  it('searches titles, ids and working directories', async () => {
    const report = await buildReport({ sessionsRoot: root, filters: { search: 'Alpha session' }, detail: 'none' })
    assert.equal(report.summary.sessions, 1)
    assert.equal(report.sessions[0].sessionId, corpus.sessions.alpha)
  })

  it('rejects an unknown session kind instead of silently widening the query', async () => {
    await assert.rejects(
      () => buildReport({ sessionsRoot: root, filters: { kinds: ['everything'] }, detail: 'none' }),
      /kinds must be one of/,
    )
  })

  it('rejects an unparseable time window', async () => {
    await assert.rejects(
      () => buildReport({ sessionsRoot: root, filters: { since: 'yesterday-ish' }, detail: 'none' }),
      /not a recognizable instant/,
    )
  })

  it('rejects an inverted window', async () => {
    await assert.rejects(
      () => buildReport({ sessionsRoot: root, filters: { since: '2026-02-01', until: '2026-01-01' }, detail: 'none' }),
      /since must not be later than until/,
    )
  })
})

describe('pricing', () => {
  it('leaves cost absent and names the unpriced models when no price is configured', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'none' })
    assert.equal(report.summary.costUsd, undefined)
    assert.equal(report.summary.costComplete, false)
    assert.ok(report.summary.unpricedModels.length > 0)
  })

  it('prices every route from an explicit book', async () => {
    const report = await buildReport({
      sessionsRoot: root,
      prices: { '*': { input: 1, output: 2, cacheRead: 0.1 } },
      detail: 'none',
    })
    assert.equal(report.summary.costComplete, true)
    const expected = (report.totals.inputTokens * 1 + report.totals.outputTokens * 2 + report.totals.cacheReadTokens * 0.1) / 1_000_000
    assert.ok(Math.abs((report.summary.costUsd ?? 0) - expected) < 1e-9)
  })
})

describe('detail levels', () => {
  it('retains per-call rows only when asked', async () => {
    const full = await buildReport({ sessionsRoot: root, detail: 'full' })
    const turns = await buildReport({ sessionsRoot: root, detail: 'turns' })
    const none = await buildReport({ sessionsRoot: root, detail: 'none' })
    assert.ok(full.sessions[0].callDetails.length > 0)
    assert.equal(turns.sessions[0].callDetails.length, 0)
    assert.ok(turns.sessions[0].turnRollup.length > 0)
    assert.equal(none.sessions[0].turnRollup.length, 0)
    assert.equal(full.totals.totalTokens, none.totals.totalTokens, 'detail must not change the numbers')
  })

  it('rejects an unknown detail level', async () => {
    await assert.rejects(() => buildReport({ sessionsRoot: root, detail: 'everything' }), /detail must be/)
  })
})

describe('granularity', () => {
  it('chooses a readable bucket size for the covered span', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'full' })
    assert.ok(['hour', 'day', 'week', 'month'].includes(report.granularity))
  })

  it('honors a requested granularity and fills gaps with zeros', async () => {
    const report = await buildReport({ sessionsRoot: root, granularity: 'day', detail: 'full' })
    assert.equal(report.granularity, 'day')
    const keys = report.series.map((bucket) => bucket.key)
    assert.deepEqual([...keys].sort(), keys, 'buckets are ascending')
  })
})

describe('an empty corpus', () => {
  it('reports nothing rather than failing', async () => {
    const empty = makeTempRoot('dsh-empty-test-')
    try {
      const report = await buildReport({ sessionsRoot: empty, detail: 'none' })
      assert.equal(report.summary.sessions, 0)
      assert.equal(report.summary.calls, 0)
      assert.equal(report.totals.totalTokens, 0)
      assert.deepEqual(report.models, [])
      assert.deepEqual(report.series, [])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('warns when the sessions root does not exist', async () => {
    const report = await buildReport({ sessionsRoot: '/definitely/not/a/real/sessions/root', detail: 'none' })
    assert.equal(report.summary.calls, 0)
    assert.ok(report.warnings.some((warning) => warning.includes('does not exist')))
  })
})
