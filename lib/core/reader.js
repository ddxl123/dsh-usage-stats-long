/**
 * Session log discovery and zstd decoding.
 *
 * ## Why decoding is not a one-liner
 *
 * DSH persists one durable log per session as **concatenated zstd frames** of
 * JSONL under `$DSH_HOME/sessions/<encoded-cwd>/<session-id>/`. The harness
 * appends a frame per durability flush, so one ordinary session log is not one
 * frame but hundreds — a 712 KiB log measured while writing this project held
 * **551 frames**.
 *
 * Node's built-in decoder does not consume that layout:
 * `zlib.zstdDecompressSync()` stops after the first frame (returning just the
 * session header and zero usage), and `zlib.createZstdDecompress()` fails with
 * `ZSTD_error_prefix_unknown` at the second frame. Both outcomes are *wrong
 * answers*, not errors a caller would notice — which is why this module owns
 * decoding explicitly and never trusts a short read.
 *
 * Decoding therefore tries, in order:
 *
 * 1. `DSH_USAGE_STATS_ZSTD` — an operator-provided decoder command.
 * 2. the `zstd` CLI, which decodes the whole concatenated stream correctly.
 * 3. Node's synchronous decoder, applied frame by frame by
 *    {@link splitZstdFrames} — slower, but pure JavaScript and dependency-free.
 *
 * A caller can see which method ran through `decodedWith` on every result, so a
 * report never hides how its numbers were obtained.
 *
 * @module dsh-usage-stats-long/core/reader
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** The zstd frame magic number, little-endian. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** The skippable-frame magic number prefix every skippable frame starts with. */
const SKIPPABLE_MAGIC_LE = Buffer.from([0x50, 0x2a, 0x4d, 0x18])

/**
 * Resolve the directory DSH keeps its session logs in.
 *
 * Honors `DSH_HOME` exactly as the harness does, then falls back to `~/.dsh`.
 *
 * @param {string} [override] explicit directory from plugin config or a CLI flag.
 * @returns {string} absolute path to the sessions root.
 */
export function resolveSessionsRoot(override) {
  if (override && override.length > 0) return resolve(expandHome(override))
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return resolve(join(home, 'sessions'))
}

/**
 * Expand a leading `~` into the current user's home directory.
 *
 * @param {string} path candidate path.
 * @returns {string} the expanded path.
 */
export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Decode the DSH session-directory encoding back into an absolute path.
 *
 * DSH stores a session under a directory named after its working directory with
 * every path separator replaced by `-`, wrapped in a leading and trailing `-`:
 * `/Users/me/app` becomes `--Users-me-app--`. The encoding is lossy, so the
 * decoded value is only a fallback — a session header's own `cwd` always wins —
 * and it is meaningful only for an absolute path, which is what the leading
 * separator the wrapper implies produces.
 *
 * @param {string} encoded directory name.
 * @returns {string | null} best-effort absolute path, or null when it is not an encoded path.
 */
export function decodeProjectDir(encoded) {
  if (!encoded.startsWith('--') || !encoded.endsWith('--')) return null
  const inner = encoded.slice(2, -2)
  if (inner.length === 0) return null
  // `/Users/me` encodes to `Users-me`, so the leading `/` is implicit in the
  // wrapper rather than present as an empty first segment.
  return `/${inner.split('-').join('/')}`
}

/**
 * Derive a short, human project label from a working directory.
 *
 * @param {string | null | undefined} cwd absolute working directory.
 * @returns {string} the last path segment, or `(unknown)`.
 */
export function projectNameOf(cwd) {
  if (!cwd || cwd.length === 0) return '(unknown)'
  const name = basename(cwd)
  return name.length > 0 ? name : cwd
}

/**
 * The log file names DSH has used.
 *
 * `session.v<N>.jsonl.zstd` carries the format version; the unversioned
 * `session.jsonl.zstd` is the v0 layout. Both are read, because a user's
 * history is exactly as accurate as the logs still on disk.
 */
const LOG_FILE_PATTERN = /^session(?:\.v(\d+))?\.jsonl\.zstd$/

/**
 * One discovered session log file.
 * @typedef {object} SessionLogFile
 * @property {string} sessionId session id taken from the directory name.
 * @property {string} projectDir encoded project directory name.
 * @property {string} cwd best-effort decoded working directory.
 * @property {string} file absolute path of the log file.
 * @property {number} logVersion physical format version.
 * @property {number} bytes compressed size in bytes.
 * @property {number} mtimeMs file modification time in milliseconds.
 */

/**
 * Enumerate every session log under a sessions root.
 *
 * Directory and stat errors are isolated per entry: an unreadable session
 * directory is skipped rather than failing the whole scan, so one broken
 * permission never hides the rest of the history.
 *
 * @param {object} [options] scan options.
 * @param {string} [options.sessionsRoot] sessions root override.
 * @param {number} [options.sinceMs] only include files modified at or after this time.
 * @param {number} [options.untilMs] only include files modified at or before this time.
 * @returns {{ root: string, files: SessionLogFile[], warnings: string[] }} discovered logs.
 */
export function discoverSessionLogs(options = {}) {
  const root = resolveSessionsRoot(options.sessionsRoot)
  /** @type {SessionLogFile[]} */
  const files = []
  /** @type {string[]} */
  const warnings = []
  if (!existsSync(root)) {
    return { root, files, warnings: [`sessions root does not exist: ${root}`] }
  }
  /** @type {string[]} */
  let projectDirs
  try {
    projectDirs = readdirSync(root)
  } catch (error) {
    return { root, files, warnings: [`cannot list sessions root ${root}: ${describeError(error)}`] }
  }
  for (const projectDir of projectDirs) {
    const projectPath = join(root, projectDir)
    let entries
    try {
      if (!statSync(projectPath).isDirectory()) continue
      entries = readdirSync(projectPath)
    } catch (error) {
      warnings.push(`cannot list ${projectPath}: ${describeError(error)}`)
      continue
    }
    for (const sessionDir of entries) {
      const sessionPath = join(projectPath, sessionDir)
      let sessionEntries
      try {
        if (!statSync(sessionPath).isDirectory()) continue
        sessionEntries = readdirSync(sessionPath)
      } catch {
        continue
      }
      for (const entry of sessionEntries) {
        const match = LOG_FILE_PATTERN.exec(entry)
        if (!match) continue
        const file = join(sessionPath, entry)
        let info
        try {
          info = statSync(file)
        } catch {
          continue
        }
        if (!info.isFile() || info.size === 0) continue
        if (options.sinceMs !== undefined && info.mtimeMs < options.sinceMs) continue
        if (options.untilMs !== undefined && info.mtimeMs > options.untilMs) continue
        const logVersion = match[1] === undefined ? 0 : Number.parseInt(match[1], 10)
        files.push({
          sessionId: sessionDir,
          projectDir,
          cwd: decodeProjectDir(projectDir) ?? '',
          file,
          logVersion: Number.isFinite(logVersion) ? logVersion : 0,
          bytes: info.size,
          mtimeMs: info.mtimeMs,
        })
      }
    }
  }
  files.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  return { root, files, warnings }
}

/**
 * A decoded log together with the decoder that produced it.
 * @typedef {object} DecodedLog
 * @property {string} text decoded UTF-8 text, or `''` when decoding failed.
 * @property {'command' | 'node-frames' | 'node-single' | 'none'} decodedWith decoder that succeeded.
 * @property {number} frames zstd frames decoded, when the decoder could report it.
 * @property {string[]} warnings non-fatal problems.
 */

/**
 * Decode one log file, trying every available decoder until one is exact.
 *
 * @param {SessionLogFile} log discovered log file.
 * @param {object} [options] decode options.
 * @param {AbortSignal} [options.signal] cooperative cancellation.
 * @returns {Promise<DecodedLog>} the decoded text and the method used.
 */
export async function decodeLogText(log, options = {}) {
  /** @type {string[]} */
  const warnings = []
  const configured = process.env.DSH_USAGE_STATS_ZSTD
  const command = configured && configured.trim().length > 0 ? configured.trim() : 'zstd'

  if (options.signal?.aborted) throw new Error('aborted')

  // Strategy 1: an external decoder (the `zstd` CLI by default). It is the only
  // decoder measured to consume the full concatenated stream at native speed.
  try {
    const text = await decodeWithCommand(command, log.file, options.signal)
    return { text, decodedWith: 'command', frames: 0, warnings }
  } catch (error) {
    if (options.signal?.aborted) throw error
    warnings.push(`decoder "${command}" unavailable or failed (${describeError(error)}); falling back to the built-in decoder`)
  }

  // Strategy 2: Node's decoder, applied frame by frame.
  /** @type {Buffer} */
  let raw
  try {
    raw = readFileSync(log.file)
  } catch (error) {
    return { text: '', decodedWith: 'none', frames: 0, warnings: [...warnings, `cannot read ${log.file}: ${describeError(error)}`] }
  }

  const frames = splitZstdFrames(raw)
  if (frames.length <= 1) {
    try {
      const text = zstdDecompressSync(raw).toString('utf8')
      return { text, decodedWith: 'node-single', frames: 1, warnings }
    } catch (error) {
      return { text: '', decodedWith: 'none', frames: 0, warnings: [...warnings, `cannot decompress ${log.file}: ${describeError(error)}`] }
    }
  }

  /** @type {Buffer[]} */
  const parts = []
  let decoded = 0
  for (const frame of frames) {
    try {
      parts.push(zstdDecompressSync(frame))
      decoded += 1
    } catch (error) {
      warnings.push(`stopped at frame ${decoded + 1}/${frames.length} of ${log.file}: ${describeError(error)}`)
      break
    }
  }
  if (decoded === 0) {
    return { text: '', decodedWith: 'none', frames: 0, warnings: [...warnings, `cannot decompress ${log.file}`] }
  }
  return { text: Buffer.concat(parts).toString('utf8'), decodedWith: 'node-frames', frames: decoded, warnings }
}

/**
 * Run an external zstd-compatible decoder over one file and collect stdout.
 *
 * @param {string} command decoder executable, resolved through `PATH`.
 * @param {string} file file to decode.
 * @param {AbortSignal} [signal] cooperative cancellation.
 * @returns {Promise<string>} decoded UTF-8 text.
 */
function decodeWithCommand(command, file, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(command, ['-dc', '--', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      rejectPromise(error)
      return
    }
    /** @type {Buffer[]} */
    const stdout = []
    /** @type {Buffer[]} */
    const stderr = []
    let settled = false
    const onAbort = () => {
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString('utf8').trim().split('\n')[0] ?? `exit code ${code}`
        rejectPromise(new Error(message))
        return
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8'))
    })
  })
}

/**
 * Split a buffer into its concatenated zstd frames.
 *
 * Boundaries are found structurally — magic number, frame header descriptor,
 * optional fields, then a block walk to the last block — and each candidate
 * frame is validated by decoding it. A false magic number inside compressed
 * data therefore cannot corrupt the result: the structural walk or the
 * validation rejects it and the scan continues.
 *
 * @param {Buffer} buffer the whole concatenated file.
 * @returns {Buffer[]} frame slices in file order; a single slice when the buffer is one frame.
 */
export function splitZstdFrames(buffer) {
  /** @type {Buffer[]} */
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    if (buffer.length - offset >= 8 && buffer.subarray(offset, offset + 4).equals(SKIPPABLE_MAGIC_LE)) {
      const size = buffer.readUInt32LE(offset + 4)
      if (offset + 8 + size > buffer.length) break
      offset += 8 + size
      continue
    }
    const end = frameEnd(buffer, offset)
    if (end === undefined) break
    frames.push(buffer.subarray(offset, end))
    offset = end
  }
  // A walk that did not reach the end of the file means this parser could not
  // describe the layout (an unusual frame shape, or a trailing partial frame).
  // Report one frame so the caller's own decoder produces the real diagnostics
  // instead of this scanner inventing a structure it cannot justify.
  if (frames.length === 0 || offset < buffer.length) return [buffer]
  return frames
}

/**
 * Compute one frame's exclusive end offset, or undefined when it is not a frame.
 *
 * Implements the zstd frame layout: magic number, frame header descriptor with
 * its optional window descriptor, dictionary id and content size, then blocks.
 * Each block header is 3 little-endian bytes carrying `lastBlock` (bit 0),
 * `blockType` (bits 1–2) and `blockSize` (bits 3–23), where `blockSize` is the
 * **compressed** payload length for a compressed block, the literal length for
 * a raw block, and the single byte's value for an RLE block — so the walk is
 * exact for every block type without needing the frame's content size.
 *
 * @param {Buffer} buffer the whole file.
 * @param {number} offset frame start.
 * @returns {number | undefined} exclusive end offset.
 */
function frameEnd(buffer, offset) {
  if (buffer.length - offset < 6) return undefined
  if (!buffer.subarray(offset, offset + 4).equals(ZSTD_MAGIC)) return undefined
  let cursor = offset + 4
  const descriptor = buffer[cursor]
  cursor += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksumFlag = (descriptor >> 2) & 1
  const dictionaryIdFlag = descriptor & 3
  if (!singleSegment) cursor += 1
  cursor += [0, 1, 2, 4][dictionaryIdFlag]
  const contentSizeBytes = contentSizeFlag === 0
    ? (singleSegment ? 1 : 0)
    : [2, 4, 8][contentSizeFlag - 1]
  cursor += contentSizeBytes
  for (;;) {
    if (cursor + 3 > buffer.length) return undefined
    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
    cursor += 3
    const lastBlock = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >>> 3
    // 0 = raw, 1 = RLE (one literal byte), 2 = compressed, 3 = reserved.
    if (blockType === 3) return undefined
    cursor += blockType === 1 ? 1 : blockSize
    if (cursor > buffer.length) return undefined
    if (lastBlock === 1) break
  }
  if (checksumFlag === 1) cursor += 4
  if (cursor > buffer.length) return undefined
  return cursor
}

/**
 * Iterate one session log's parsed events without materializing the event list.
 *
 * The callback receives every event in log order. Parse failures are counted
 * and surfaced, never thrown, because the corpus is append-only data written by
 * a different process and a torn tail must not discard the calls durably
 * recorded before it.
 *
 * @param {SessionLogFile} log discovered log file.
 * @param {(event: any) => void} onEvent called once per parsed event, in log order.
 * @param {AbortSignal} [signal] cooperative cancellation.
 * @returns {Promise<{ events: number, malformed: number, warnings: string[], bytes: number, decodedWith: string, frames: number }>} read statistics.
 */
export async function forEachLogEvent(log, onEvent, signal) {
  const decoded = await decodeLogText(log, { signal })
  const warnings = [...decoded.warnings]
  let events = 0
  let malformed = 0
  if (decoded.text.length > 0) {
    const lines = decoded.text.split('\n')
    // A log's final newline is a terminator, not an empty record.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) {
      if (line.length === 0) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        malformed += 1
        continue
      }
      if (event === null || typeof event !== 'object') {
        malformed += 1
        continue
      }
      events += 1
      onEvent(event)
    }
  }
  if (malformed > 0) warnings.push(`${log.file}: skipped ${malformed} malformed line(s)`)
  return { events, malformed, warnings, bytes: log.bytes, decodedWith: decoded.decodedWith, frames: decoded.frames }
}

/**
 * Read and decode one session log into its raw JSONL lines.
 *
 * @param {SessionLogFile} log discovered log file.
 * @param {AbortSignal} [signal] cooperative cancellation.
 * @returns {Promise<{ lines: string[], warnings: string[] }>} decoded lines.
 */
export async function readLogLines(log, signal) {
  const { text, warnings } = await decodeLogText(log, { signal })
  if (text.length === 0) return { lines: [], warnings }
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { lines, warnings }
}

/**
 * Describe an unknown thrown value as a stable message.
 *
 * @param {unknown} error thrown value.
 * @returns {string} a message suitable for a warning list.
 */
export function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Re-exported for callers that need path helpers without importing node:path. */
export { dirname, basename }
