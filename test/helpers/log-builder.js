/**
 * Test helpers that build real session-log files on disk.
 *
 * Fixtures are written through the same primitives the harness uses — a
 * `session` header plus JSONL events, each flush its own zstd frame — so a test
 * exercises the actual decoder path rather than a mock of it.
 *
 * @module test/helpers/log-builder
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

/**
 * Encode a DSH session directory name for a working directory.
 *
 * The harness wraps the separator-replaced path in a leading and trailing `-`,
 * so `/work/app` becomes `--work-app--`.
 *
 * @param {string} cwd absolute working directory.
 * @returns {string} the encoded directory name.
 */
export function encodeProjectDir(cwd) {
  // `/work/app` becomes `--work-app--`: the leading separator is implicit in the
  // wrapper, matching the harness and `decodeProjectDir`.
  const trimmed = cwd.startsWith('/') ? cwd.slice(1) : cwd
  return `--${trimmed.replaceAll('/', '-')}--`
}

/**
 * Build one in-memory session log.
 */
export class LogBuilder {
  /**
   * @param {object} [options] builder options.
   * @param {string} [options.id] session id.
   * @param {string} [options.cwd] working directory.
   * @param {number} [options.createdAt] creation time in epoch milliseconds.
   * @param {object} [options.header] extra header fields, for example `{ isSeeded: true }`.
   */
  constructor(options = {}) {
    this.id = options.id ?? `session-${Math.random().toString(16).slice(2, 10)}`
    this.cwd = options.cwd ?? '/tmp/project'
    this.createdAt = options.createdAt ?? Date.UTC(2026, 0, 1, 0, 0, 0)
    this.header = options.header ?? {}
    /** @type {string[]} */
    this.lines = []
    this.seq = 0
    this.time = this.createdAt
    this.headerLine = JSON.stringify({
      type: 'session',
      version: 3,
      id: this.id,
      createdAt: this.createdAt,
      cwd: this.cwd,
      isSeeded: false,
      delegationDepth: 0,
      ...this.header,
    })
  }

  /**
   * Advance the synthetic clock.
   *
   * @param {number} [ms] milliseconds to advance.
   * @returns {number} the new clock value.
   */
  tick(ms = 1000) {
    this.time += ms
    return this.time
  }

  /**
   * Append one event.
   *
   * @param {string} type event type.
   * @param {any} data event payload.
   * @param {object} [options] event options.
   * @param {boolean} [options.raw] append the object verbatim, ignoring the generated envelope.
   * @returns {this} this builder.
   */
  event(type, data, options = {}) {
    if (options.raw === true) {
      this.lines.push(JSON.stringify(data))
      return this
    }
    this.lines.push(JSON.stringify({ type, seq: this.seq, time: this.tick(), data }))
    this.seq += 1
    return this
  }

  /**
   * Append a raw line that is not valid JSON, to exercise torn-tail handling.
   *
   * @returns {this} this builder.
   */
  malformed() {
    this.lines.push('{"type":"assistant/message","seq":')
    return this
  }

  /**
   * Append a `turn/start` event.
   *
   * @param {number} turn turn index.
   * @returns {this} this builder.
   */
  turnStart(turn) {
    return this.event('turn/start', { turn })
  }

  /**
   * Append a `step/start` event.
   *
   * @param {number} turn turn index.
   * @param {number} step step index.
   * @returns {this} this builder.
   */
  stepStart(turn, step) {
    return this.event('step/start', { turn, step })
  }

  /**
   * Append a `request/context` route event.
   *
   * @param {string} provider provider route.
   * @param {string} model model id.
   * @param {number} [contextWindow] advertised capacity.
   * @returns {this} this builder.
   */
  route(provider, model, contextWindow) {
    return this.event('request/context', {
      provider,
      model,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    })
  }

  /**
   * Append a usage-bearing `assistant/message`.
   *
   * @param {object} spec the call.
   * @param {number} spec.turn turn index.
   * @param {number} spec.step step index.
   * @param {string} spec.provider provider that served the call.
   * @param {string} spec.model model id.
   * @param {import('../../lib/core/types.js').RawUsage} spec.usage reported usage.
   * @param {boolean} [spec.interrupted] whether the turn was cancelled mid-stream.
   * @param {boolean} [spec.noSource] omit the message source, forcing route attribution.
   * @returns {this} this builder.
   */
  assistant(spec) {
    return this.event('assistant/message', {
      turn: spec.turn,
      step: spec.step,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        ...(spec.noSource === true ? {} : { source: { kind: 'model', provider: spec.provider, model: spec.model } }),
        id: `msg-${this.seq}`,
      },
      usage: spec.usage,
      ...(spec.interrupted === true ? { interrupted: true } : {}),
    })
  }

  /**
   * Append a `compaction/summary` with usage.
   *
   * @param {object} spec the compaction call.
   * @param {string} spec.compactionId compaction identity.
   * @param {string} spec.provider provider route.
   * @param {string} spec.model model id.
   * @param {import('../../lib/core/types.js').RawUsage} spec.usage reported usage.
   * @returns {this} this builder.
   */
  compactionSummary(spec) {
    return this.event('compaction/summary', {
      compactionId: spec.compactionId,
      provider: spec.provider,
      model: spec.model,
      summary: '<compacted-summary>',
      usage: spec.usage,
    })
  }

  /**
   * Append a `session/title` event.
   *
   * @param {string} title the title.
   * @returns {this} this builder.
   */
  title(title) {
    return this.event('session/title', { title, messageSeqs: [0] })
  }

  /**
   * Append the seed boundary that ends a fork-inherited prefix.
   *
   * @param {object} [options] marker options.
   * @param {boolean} [options.inherited] whether the marker is the fork cut.
   * @returns {this} this builder.
   */
  endSeed(options = {}) {
    return this.event('session/end-seed', options.inherited === true ? { inherited: true } : {})
  }

  /**
   * Encode the log as concatenated zstd frames, one per line.
   *
   * Writing one frame per line mirrors how the harness appends a frame per
   * durability flush, so tests exercise multi-frame decoding rather than a
   * single-frame shortcut.
   *
   * @param {object} [options] encoding options.
   * @param {number} [options.framesPer] lines per frame.
   * @returns {Buffer} the compressed log bytes.
   */
  toBuffer(options = {}) {
    const per = Math.max(1, options.framesPer ?? 1)
    /** @type {Buffer[]} */
    const frames = []
    const all = [this.headerLine, ...this.lines]
    for (let index = 0; index < all.length; index += per) {
      const chunk = `${all.slice(index, index + per).join('\n')}\n`
      frames.push(zstdCompressSync(Buffer.from(chunk, 'utf8')))
    }
    return Buffer.concat(frames)
  }
}

/**
 * Create a temporary sessions root.
 *
 * @param {string} [label] directory-name hint.
 * @returns {string} the created root path.
 */
export function makeTempRoot(label = 'dsh-usage-stats-test-') {
  return mkdtempSync(join(tmpdir(), label))
}

/**
 * Write one builder into a sessions root using the real directory layout.
 *
 * @param {string} root sessions root.
 * @param {LogBuilder} builder the log to write.
 * @param {object} [options] write options.
 * @param {number} [options.framesPer] lines per zstd frame.
 * @param {string} [options.fileName] log file name override, for legacy layouts.
 * @returns {{ file: string, dir: string }} where the log was written.
 */
export function writeLog(root, builder, options = {}) {
  const dir = join(root, encodeProjectDir(builder.cwd), builder.id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, options.fileName ?? 'session.v3.jsonl.zstd')
  writeFileSync(file, builder.toBuffer({ framesPer: options.framesPer }))
  return { file, dir }
}

/**
 * Build a corpus of several sessions that covers every accuracy rule.
 *
 * The returned map records the tokens each session is *expected* to contribute,
 * computed independently of the engine, so a test can assert exact totals.
 *
 * @param {string} root sessions root to populate.
 * @returns {{ expected: { calls: number, totals: Record<string, number> }, sessions: Record<string, string> }} expectations.
 */
export function writeCorpus(root) {
  /** @type {Record<string, number>} */
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
  let calls = 0
  /**
   * Fold one call's expected contribution into the running total.
   *
   * @param {import('../../lib/core/types.js').RawUsage} usage reported usage.
   * @returns {void}
   */
  const expect = (usage) => {
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    const read = usage.cacheReadTokens ?? 0
    const write = usage.cacheWriteTokens ?? 0
    totals.inputTokens += input
    totals.outputTokens += output
    totals.cacheReadTokens += read
    totals.cacheWriteTokens += write
    totals.reasoningTokens += usage.reasoningTokens ?? 0
    totals.totalTokens += usage.totalTokens ?? (input + output + read + write)
    calls += 1
  }

  /** @type {Record<string, string>} */
  const sessions = {}

  // A plain top-level session across two turns and three steps.
  const alpha = new LogBuilder({ id: 'session-alpha-0001', cwd: '/work/alpha' })
  alpha.turnStart(1).stepStart(1, 1).route('prov-a', 'model-x', 200000)
  alpha.assistant({ turn: 1, step: 1, provider: 'prov-a', model: 'model-x', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } })
  expect({ inputTokens: 100, outputTokens: 10, totalTokens: 110 })
  alpha.stepStart(1, 2)
  alpha.assistant({ turn: 1, step: 2, provider: 'prov-a', model: 'model-x', usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 1000, totalTokens: 1070 } })
  expect({ inputTokens: 50, outputTokens: 20, cacheReadTokens: 1000, totalTokens: 1070 })
  alpha.title('Alpha session')
  writeLog(root, alpha, { framesPer: 3 })
  sessions.alpha = alpha.id

  // Legacy v0 layout, no route events, reasoning reported, no provider total.
  const legacy = new LogBuilder({ id: 'session-legacy-0002', cwd: '/work/legacy' })
  legacy.turnStart(1).stepStart(1, 1)
  legacy.assistant({ turn: 1, step: 1, provider: 'prov-b', model: 'model-y', usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 2 } })
  expect({ inputTokens: 7, outputTokens: 3, reasoningTokens: 2 })
  writeLog(root, legacy, { fileName: 'session.jsonl.zstd', framesPer: 2 })
  sessions.legacy = legacy.id

  // A compaction summary billed to the compaction model, plus a second route.
  const compacting = new LogBuilder({ id: 'session-compact-0003', cwd: '/work/alpha' })
  compacting.turnStart(1).stepStart(1, 1).route('prov-a', 'model-x', 200000)
  compacting.assistant({ turn: 1, step: 1, provider: 'prov-a', model: 'model-x', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
  expect({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  compacting.compactionSummary({ compactionId: 'c1', provider: 'prov-b', model: 'model-z', usage: { inputTokens: 400, outputTokens: 40, totalTokens: 440 } })
  expect({ inputTokens: 400, outputTokens: 40, totalTokens: 440 })
  compacting.turnStart(2).stepStart(2, 2).route('prov-b', 'model-z', 100000)
  compacting.assistant({ turn: 2, step: 2, provider: 'prov-b', model: 'model-z', usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } })
  expect({ inputTokens: 20, outputTokens: 8, totalTokens: 28 })
  writeLog(root, compacting, { framesPer: 5 })
  sessions.compacting = compacting.id

  // A forked log: the inherited prefix carries usage that was already billed to
  // the parent, so only the events after the seed boundary may be counted.
  const forked = new LogBuilder({ id: 'session-forked-0004', cwd: '/work/alpha', header: { isSeeded: true, parentSession: 'session-alpha-0001' } })
  forked.turnStart(1).stepStart(1, 1).route('prov-a', 'model-x', 200000)
  forked.assistant({ turn: 1, step: 1, provider: 'prov-a', model: 'model-x', usage: { inputTokens: 9999, outputTokens: 999, totalTokens: 10998 } })
  forked.endSeed({ inherited: true })
  forked.turnStart(2).stepStart(2, 1)
  forked.assistant({ turn: 2, step: 1, provider: 'prov-a', model: 'model-x', usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 } })
  expect({ inputTokens: 30, outputTokens: 6, totalTokens: 36 })
  writeLog(root, forked, { framesPer: 1 })
  sessions.forked = forked.id

  // A subagent child, attributed by its own header.
  const child = new LogBuilder({
    id: 'session-child-0005',
    cwd: '/work/alpha',
    header: { origin: 'subagent', delegationDepth: 1, parentSession: 'session-alpha-0001' },
  })
  child.turnStart(1).stepStart(1, 1).route('prov-c', 'model-w', 64000)
  child.assistant({ turn: 1, step: 1, provider: 'prov-c', model: 'model-w', usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } })
  expect({ inputTokens: 11, outputTokens: 4, totalTokens: 15 })
  writeLog(root, child, { framesPer: 2 })
  sessions.child = child.id

  // A session with a torn tail: the malformed line must not discard the calls
  // recorded before it, and must be surfaced as a warning.
  const torn = new LogBuilder({ id: 'session-torn-0006', cwd: '/work/torn' })
  torn.turnStart(1).stepStart(1, 1).route('prov-a', 'model-x', 200000)
  torn.assistant({ turn: 1, step: 1, provider: 'prov-a', model: 'model-x', usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 } })
  expect({ inputTokens: 13, outputTokens: 7, totalTokens: 20 })
  torn.malformed()
  writeLog(root, torn, { framesPer: 1 })
  sessions.torn = torn.id

  // A session that recorded no usage at all: visible in the catalog, absent from
  // a usage report.
  const empty = new LogBuilder({ id: 'session-empty-0007', cwd: '/work/empty' })
  empty.turnStart(1).stepStart(1, 1)
  writeLog(root, empty)
  sessions.empty = empty.id

  return { expected: { calls, totals }, sessions }
}
