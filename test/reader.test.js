/**
 * Reader tests: discovery, the directory-name encoding, and — most importantly
 * — that a multi-frame log decodes completely.
 *
 * The multi-frame case is the one that silently produces wrong numbers: Node's
 * synchronous decoder returns only the first frame, which would look like a
 * session header with no usage. These tests pin the behavior that prevents it.
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  decodeLogText,
  decodeProjectDir,
  discoverSessionLogs,
  forEachLogEvent,
  projectNameOf,
  resolveSessionsRoot,
  splitZstdFrames,
} from '../lib/core/reader.js'
import { LogBuilder, makeTempRoot, writeLog } from './helpers/log-builder.js'

/** @type {string} */
let root

before(() => {
  root = makeTempRoot('dsh-reader-test-')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveSessionsRoot', () => {
  it('honors an explicit override and expands a leading tilde', () => {
    assert.equal(resolveSessionsRoot('/explicit/path'), '/explicit/path')
    assert.match(resolveSessionsRoot('~/sub'), /\/sub$/)
  })

  it('defaults to $DSH_HOME/sessions', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/tmp/dsh-home-test'
    try {
      assert.equal(resolveSessionsRoot(), '/tmp/dsh-home-test/sessions')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('decodeProjectDir', () => {
  it('decodes an encoded working directory, restoring the leading separator', () => {
    assert.equal(decodeProjectDir('--work-find--'), '/work/find')
    assert.equal(decodeProjectDir('--Users-linlong-projects-long_dsh_tool-demo--'), '/Users/linlong/projects/long_dsh_tool/demo')
  })

  it('is best-effort: a path segment containing a separator is unrecoverable', () => {
    // The encoding replaces `/` with `-`, so `/work/my/project` and
    // `/work/my-project` encode identically. This is exactly why a session
    // header's own `cwd` always wins and this decode is only a fallback.
    const ambiguous = '--work-my-project--'
    assert.equal(decodeProjectDir(ambiguous), '/work/my/project')
    assert.notEqual(decodeProjectDir(ambiguous), '/work/my-project')
  })

  it('refuses a name that is not an encoded path', () => {
    assert.equal(decodeProjectDir('not-encoded'), null)
    assert.equal(decodeProjectDir('----'), null)
    assert.equal(decodeProjectDir('-work-find-'), null)
  })
})

describe('projectNameOf', () => {
  it('uses the last path segment', () => {
    assert.equal(projectNameOf('/Users/me/projects/app'), 'app')
    assert.equal(projectNameOf('relative-thing'), 'relative-thing')
  })

  it('names an unknown directory rather than returning an empty label', () => {
    assert.equal(projectNameOf(undefined), '(unknown)')
    assert.equal(projectNameOf(''), '(unknown)')
  })
})

describe('multi-frame decoding', () => {
  it('decodes every frame of a concatenated log', async () => {
    const builder = new LogBuilder({ id: 'session-frames', cwd: '/work/frames' })
    for (let index = 0; index < 12; index += 1) {
      builder.turnStart(index + 1).stepStart(index + 1, 1)
      builder.assistant({
        turn: index + 1,
        step: 1,
        provider: 'prov',
        model: 'model',
        usage: { inputTokens: index + 1, outputTokens: 1, totalTokens: index + 2 },
      })
    }
    writeLog(root, builder, { framesPer: 1 })
    const log = { ...discoverSessionLogs({ sessionsRoot: root }).files.find((file) => file.sessionId === builder.id) }

    const frames = splitZstdFrames((await import('node:fs')).readFileSync(log.file))
    assert.equal(frames.length, 1 + builder.lines.length, 'one frame per line, plus the header frame')

    const decoded = await decodeLogText(log)
    assert.ok(decoded.text.length > 0, 'the whole log must decode, not just its first frame')
    const lines = decoded.text.split('\n').filter((line) => line.length > 0)
    assert.equal(lines.length, 1 + builder.lines.length)

    let usageEvents = 0
    await forEachLogEvent(log, (event) => {
      if (event.type === 'assistant/message') usageEvents += 1
    })
    assert.equal(usageEvents, 12, 'every usage event must survive decoding')
  })

  it('reports which decoder produced the text', async () => {
    const builder = new LogBuilder({ id: 'session-decoder', cwd: '/work/frames' })
    builder.turnStart(1).stepStart(1, 1)
    builder.assistant({ turn: 1, step: 1, provider: 'prov', model: 'model', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
    writeLog(root, builder)
    const log = discoverSessionLogs({ sessionsRoot: root }).files.find((file) => file.sessionId === builder.id)
    const decoded = await decodeLogText(log)
    assert.ok(['command', 'node-frames', 'node-single'].includes(decoded.decodedWith))
    assert.ok(decoded.text.includes('"type":"session"'))
  })
})

describe('torn and malformed input', () => {
  it('keeps the events recorded before a malformed line and reports it', async () => {
    const builder = new LogBuilder({ id: 'session-torn', cwd: '/work/torn' })
    builder.turnStart(1).stepStart(1, 1)
    builder.assistant({ turn: 1, step: 1, provider: 'prov', model: 'model', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } })
    builder.malformed()
    writeLog(root, builder)
    const log = discoverSessionLogs({ sessionsRoot: root }).files.find((file) => file.sessionId === builder.id)
    let events = 0
    const stats = await forEachLogEvent(log, () => { events += 1 })
    assert.equal(stats.malformed, 1)
    assert.ok(stats.warnings.some((warning) => warning.includes('malformed')))
    assert.ok(events >= 3, 'the header and the valid events must still be delivered')
  })

  it('reports an unreadable log instead of throwing', async () => {
    const log = {
      sessionId: 'session-missing', projectDir: 'x', cwd: '', file: join(root, 'does-not-exist.zstd'),
      logVersion: 3, bytes: 1, mtimeMs: 0,
    }
    const decoded = await decodeLogText(log)
    assert.equal(decoded.text, '')
    assert.equal(decoded.decodedWith, 'none')
    assert.ok(decoded.warnings.length > 0)
  })

  it('falls back to the built-in decoder when the external one is unusable', async () => {
    const previous = process.env.DSH_USAGE_STATS_ZSTD
    process.env.DSH_USAGE_STATS_ZSTD = 'definitely-not-a-real-zstd-binary'
    try {
      const builder = new LogBuilder({ id: 'session-fallback', cwd: '/work/frames' })
      builder.turnStart(1).stepStart(1, 1)
      builder.assistant({ turn: 1, step: 1, provider: 'prov', model: 'model', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } })
      writeLog(root, builder, { framesPer: 1 })
      const log = discoverSessionLogs({ sessionsRoot: root }).files.find((file) => file.sessionId === builder.id)
      const decoded = await decodeLogText(log)
      assert.equal(decoded.decodedWith, 'node-frames')
      assert.ok(decoded.text.includes('"type":"session"'))
      assert.ok(decoded.frames > 1, 'the fallback must walk every frame')
      assert.ok(decoded.warnings.some((warning) => warning.includes('definitely-not-a-real-zstd-binary')))
    } finally {
      if (previous === undefined) delete process.env.DSH_USAGE_STATS_ZSTD
      else process.env.DSH_USAGE_STATS_ZSTD = previous
    }
  })
})

describe('discovery', () => {
  it('finds both versioned and legacy log file names', () => {
    const versioned = new LogBuilder({ id: 'session-find-v3', cwd: '/work/find' })
    versioned.turnStart(1)
    writeLog(root, versioned)
    const legacy = new LogBuilder({ id: 'session-find-v0', cwd: '/work/find' })
    legacy.turnStart(1)
    writeLog(root, legacy, { fileName: 'session.jsonl.zstd' })

    const { files } = discoverSessionLogs({ sessionsRoot: root })
    const v3 = files.find((file) => file.sessionId === 'session-find-v3')
    const v0 = files.find((file) => file.sessionId === 'session-find-v0')
    assert.equal(v3?.logVersion, 3)
    assert.equal(v0?.logVersion, 0)
    assert.equal(v0?.cwd, '/work/find', 'the encoded directory decodes back to the working directory')
  })

  it('skips an empty log file, because it holds nothing to fold', () => {
    const dir = join(root, '--work-empty--', 'session-zero')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), '')
    const { files } = discoverSessionLogs({ sessionsRoot: root })
    assert.equal(files.find((file) => file.sessionId === 'session-zero'), undefined)
  })

  it('reports a missing sessions root instead of throwing', () => {
    const result = discoverSessionLogs({ sessionsRoot: join(root, 'nope') })
    assert.deepEqual(result.files, [])
    assert.equal(result.warnings.length, 1)
  })

  it('applies a modification-time window', () => {
    const future = discoverSessionLogs({ sessionsRoot: root, sinceMs: Date.now() + 86_400_000 })
    assert.deepEqual(future.files, [])
  })
})
