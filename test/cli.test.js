/**
 * CLI and dashboard tests.
 *
 * The CLI is asserted through its real entry point with captured output, so the
 * flags, the exit codes and the rendered text are all covered. The dashboard is
 * asserted by executing its embedded browser script in a minimal DOM and
 * checking what it renders — a dashboard that silently renders nothing would
 * otherwise ship unnoticed.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { run, parseArgv, USAGE } from '../lib/cli/index.js'
import { buildReport } from '../lib/core/scan.js'
import { renderDashboard } from '../lib/core/render-html.js'
import { makeTempRoot, writeCorpus } from './helpers/log-builder.js'

/** @type {string} */
let root

before(() => {
  root = makeTempRoot('dsh-cli-test-')
  writeCorpus(root)
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Run the CLI and capture both streams.
 *
 * @param {string[]} argv arguments.
 * @returns {Promise<{ code: number, out: string, err: string }>} the result.
 */
async function cli(argv) {
  let out = ''
  let err = ''
  const code = await run([...argv, '--sessions-root', root, '--quiet'], {
    out: (text) => { out += text },
    err: (text) => { err += text },
  })
  return { code, out, err }
}

describe('argument parsing', () => {
  it('defaults to the summary command', () => {
    const parsed = parseArgv([])
    assert.equal(parsed.command, 'summary')
    assert.equal(parsed.help, false)
  })

  it('accumulates a repeated filter flag', () => {
    const parsed = parseArgv(['summary', '--model', 'a', '--model', 'b'])
    assert.equal(parsed.filters.models, 'a,b')
  })

  it('accepts --flag=value', () => {
    const parsed = parseArgv(['summary', '--since=7d', '--limit=5'])
    assert.equal(parsed.filters.since, '7d')
    assert.equal(parsed.options.limit, 5)
  })

  it('rejects an unknown flag with the usage text', () => {
    assert.throws(() => parseArgv(['summary', '--nope']), /unknown option: --nope/)
  })

  it('rejects a flag with no value', () => {
    assert.throws(() => parseArgv(['summary', '--model']), /--model requires a value/)
  })
})

describe('help', () => {
  it('prints usage without reading the corpus', async () => {
    const result = await cli(['help'])
    assert.equal(result.code, 0)
    assert.ok(result.out.includes('dsh-usage-stats'))
    assert.equal(result.out, USAGE, 'help must print the documented usage verbatim')
  })

  it('honors --help on any command', async () => {
    const result = await cli(['timeline', '--help'])
    assert.equal(result.code, 0)
    assert.ok(result.out.includes('Commands:'))
  })
})

describe('summary', () => {
  it('reports the corpus totals', async () => {
    const result = await cli(['summary', '--detail', 'standard'])
    assert.equal(result.code, 0)
    assert.ok(result.out.includes('## Headline'))
    assert.ok(result.out.includes('## By model'))
    assert.ok(result.out.includes('## By session'))
    assert.ok(result.out.includes('Token usage report'))
  })

  it('rejects an unknown detail level with exit code 2', async () => {
    const result = await cli(['summary', '--detail', 'everything'])
    assert.equal(result.code, 2)
    assert.match(result.err, /--detail must be compact, standard or full/)
  })

  it('emits machine-readable JSON on request', async () => {
    const result = await cli(['summary', '--json'])
    assert.equal(result.code, 0)
    const parsed = JSON.parse(result.out)
    assert.equal(typeof parsed.totals.totalTokens, 'number')
    assert.ok(Array.isArray(parsed.calls))
    assert.equal(typeof parsed.describeFilters, 'string')
  })

  it('keeps a section allow-list small', async () => {
    const full = await cli(['summary', '--detail', 'standard'])
    const narrow = await cli(['summary', '--detail', 'standard', '--max-sessions', '0', '--max-calls', '0'])
    assert.ok(narrow.out.length <= full.out.length)
  })
})

describe('filters on the command line', () => {
  it('narrows to one model', async () => {
    const result = await cli(['models', '--model', 'model-z'])
    assert.equal(result.code, 0)
    assert.ok(result.out.includes('model-z'))
    assert.ok(!result.out.includes('model-x'), 'the other model must be filtered out')
  })

  it('narrows to one session by prefix', async () => {
    const result = await cli(['calls', '--session', 'compact', '--limit', '100'])
    assert.equal(result.code, 0)
    assert.match(result.out, /Matching calls: 3/)
  })

  it('prints the compiled filters for the given flags', async () => {
    const result = await cli(['filters', '--since', '7d', '--model', 'model-z', '--kind', 'subagent'])
    assert.equal(result.code, 0)
    const parsed = JSON.parse(result.out)
    assert.deepEqual(parsed.filters.models, ['model-z'])
    assert.deepEqual(parsed.filters.kinds, ['subagent'])
    assert.equal(typeof parsed.filters.since, 'number')
  })

  it('fails clearly on an unusable filter value', async () => {
    const result = await cli(['summary', '--since', 'not-a-date'])
    assert.equal(result.code, 1)
    assert.match(result.err, /cannot be interpreted|not a recognizable instant/)
  })
})

describe('other commands', () => {
  it('prints the session catalog', async () => {
    const result = await cli(['sessions', '--limit', '20'])
    assert.equal(result.code, 0)
    assert.ok(result.out.includes('Session catalog'))
    assert.ok(result.out.includes('alpha'))
  })

  it('draws a timeline bar chart', async () => {
    const result = await cli(['timeline', '--limit', '10'])
    assert.equal(result.code, 0)
    assert.ok(result.out.includes('Timeline'))
    assert.match(result.out, /[#=]/)
  })

  it('prints per-turn detail', async () => {
    const result = await cli(['turns', '--session', 'alpha'])
    assert.equal(result.code, 0)
    assert.ok(result.out.includes('| Turn | Steps | Calls |'))
  })

  it('prints the call ledger and agrees with the JSON export', async () => {
    const ledger = await cli(['calls', '--limit', '2'])
    assert.equal(ledger.code, 0)
    assert.ok(ledger.out.includes('seq='))
    assert.ok(ledger.out.includes('Matching calls: 9'), 'the corpus has nine billable calls')

    const json = await cli(['calls', '--json'])
    assert.equal(json.code, 0)
    const calls = JSON.parse(json.out)
    assert.equal(calls.length, 9)
    assert.equal(
      ledger.out.match(/Matching calls: (\d+)/)[1],
      String(calls.length),
      'the rendered count and the exported rows must agree',
    )
  })

  it('orders the ledger by size when asked, matching the exported maximum', async () => {
    const json = await cli(['calls', '--json'])
    const calls = JSON.parse(json.out)
    const heaviest = Math.max(...calls.map((call) => call.tokens.totalTokens))
    const result = await cli(['calls', '--limit', '1', '--order', 'size'])
    assert.equal(result.code, 0)
    const row = result.out.split('\n').find((line) => line.includes('seq='))
    assert.ok(row, 'the ledger must print at least one row')
    assert.ok(row.includes(`total=${heaviest}`), `the first row must be the ${heaviest}-token call`)
  })

  it('writes an export file', async () => {
    const out = join(root, 'export.json')
    const result = await cli(['export', '--out', out])
    assert.equal(result.code, 0)
    const parsed = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(typeof parsed.totals.totalTokens, 'number')
    assert.ok(Array.isArray(parsed.sessions))
  })

  it('refuses a dashboard without an output file', async () => {
    const result = await cli(['dashboard'])
    assert.equal(result.code, 2)
    assert.match(result.err, /needs --out/)
  })

  it('writes a dashboard that embeds the corpus and honors --max-sessions', async () => {
    const out = join(root, 'dashboard.html')
    const result = await cli(['dashboard', '--out', out, '--max-sessions', '2'])
    assert.equal(result.code, 0)
    const html = readFileSync(out, 'utf8')
    assert.ok(html.startsWith('<!doctype html>'))
    const payload = JSON.parse(
      /<script type="application\/json" id="dsh-usage-data">([\s\S]*?)<\/script>/.exec(html)[1]
        .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'),
    )
    assert.equal(payload.report.sessions.length, 2, '--max-sessions must reach the embedded payload')
    assert.ok(payload.report.sessions.every((session) => session.callDetails.length > 0), 'call rows must be retained for the drill-down')
  })

  it('rejects an unknown command', async () => {
    const result = await cli(['frobnicate'])
    assert.equal(result.code, 2)
    assert.match(result.err, /unknown command: frobnicate/)
  })

  it('rejects an unreadable price book before scanning', async () => {
    const result = await cli(['summary', '--prices', '/nope/prices.json'])
    assert.equal(result.code, 2)
    assert.match(result.err, /cannot read price book/)
  })

  it('prices the report from a price book', async () => {
    const prices = join(root, 'prices.json')
    writeFileSync(prices, JSON.stringify({ '*': { input: 1, output: 1, cacheRead: 0 } }))
    const result = await cli(['summary', '--prices', prices, '--detail', 'compact'])
    assert.equal(result.code, 0)
    assert.ok(result.out.includes('Estimated cost'))
    assert.ok(!result.out.includes('Estimated cost: -'), 'a full price book must produce a number')
  })
})

describe('dashboard document', () => {
  /** @type {string} */
  let html

  before(async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'full' })
    html = renderDashboard(report, {
      title: 'Test dashboard',
      status: { sessionsRoot: root, cachedSessions: 0, cacheSize: 16 },
    })
  })

  it('is one self-contained document with no external references', () => {
    assert.ok(html.startsWith('<!doctype html>'))
    assert.ok(html.includes('</html>'))
    assert.ok(!/<script[^>]+src=/.test(html), 'no external script')
    assert.ok(!/<link[^>]+stylesheet/.test(html), 'no external stylesheet')
    assert.ok(!/https?:\/\//.test(html.replaceAll('http://www.w3.org', '')), 'no remote URLs')
  })

  it('embeds the report as escaped JSON so it cannot terminate the host element', () => {
    const match = /<script type="application\/json" id="dsh-usage-data">([\s\S]*?)<\/script>/.exec(html)
    assert.ok(match, 'the payload element must exist')
    const raw = match[1]
    assert.ok(!raw.includes('</'), 'a literal closing tag would end the element early')
    const payload = JSON.parse(raw.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'))
    assert.equal(typeof payload.report.summary.calls, 'number')
    assert.ok(payload.report.sessions.length > 0)
    assert.equal(typeof payload.text, 'string')
  })

  it('runs its embedded script and renders the report', () => {
    const script = html.split('<script>')[1].split('</script>')[0]
    const payloadMatch = /<script type="application\/json" id="dsh-usage-data">([\s\S]*?)<\/script>/.exec(html)
    const payload = JSON.parse(payloadMatch[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'))

    /** @type {any} */
    let app
    const makeElement = (tag) => {
      const element = {
        tagName: String(tag).toUpperCase(),
        style: {},
        value: '',
        className: '',
        _html: '',
        _text: '',
        children: [],
        get innerHTML() { return this._html },
        set innerHTML(value) { this._html = value },
        get textContent() { return this._text },
        set textContent(value) { this._text = value },
        appendChild(child) { this.children.push(child); return child },
        insertBefore(child) { this.children.push(child); return child },
        removeChild(child) { this.children = this.children.filter((entry) => entry !== child) },
        setAttribute() {},
        getAttribute() { return null },
        addEventListener() {},
        click() {},
        classList: { contains: () => false, add() {}, remove() {} },
        get nextElementSibling() { return null },
        get parentNode() { return null },
      }
      return element
    }
    app = makeElement('div')
    const data = makeElement('script')
    data.textContent = JSON.stringify(payload)

    const previous = { document: globalThis.document, window: globalThis.window, Blob: globalThis.Blob, URL: globalThis.URL }
    globalThis.document = {
      getElementById: (id) => (id === 'app' ? app : id === 'dsh-usage-data' ? data : makeElement('input')),
      querySelectorAll: () => [],
      createElement: (tag) => makeElement(tag),
    }
    globalThis.window = globalThis
    globalThis.Blob = class { constructor(parts) { this.parts = parts } }
    globalThis.URL = { createObjectURL: () => 'blob:', revokeObjectURL() {} }
    try {
      // eslint-disable-next-line no-new-func
      new Function(script)()
    } finally {
      globalThis.document = previous.document
      globalThis.window = previous.window
      globalThis.Blob = previous.Blob
      globalThis.URL = previous.URL
    }

    const rendered = app.innerHTML
    assert.ok(rendered.length > 3000, 'the dashboard must render a real document')
    assert.ok(rendered.includes('data-tab='), 'tabs must be rendered')
    assert.ok(rendered.includes('class="card"'), 'headline cards must be rendered')
    assert.ok(rendered.includes('<table'), 'at least one table must be rendered')
    assert.ok(rendered.includes('Test dashboard') || rendered.includes('DSH token usage'))
  })

  it('renders a localized document when asked for Chinese', async () => {
    const report = await buildReport({ sessionsRoot: root, detail: 'none' })
    const chinese = renderDashboard(report, { lang: 'zh' })
    assert.ok(chinese.includes('lang="zh"'))
    assert.ok(chinese.includes('DSH Token 用量看板'))
  })
})
