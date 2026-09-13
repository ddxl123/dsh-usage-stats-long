# dsh-usage-stats-long

Accurate, provider-billed token usage statistics for **DeepSeek Harness** — as a
plugin, three model tools, a CLI, and a self-contained interactive dashboard.

[中文说明](README.zh.md)

```
$ dsh-usage-stats summary --since 7d

# Token usage report

## Headline

| Sessions | Billed model calls | Turns | Steps | Model routes | Projects |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 24 | 782 | 5 | 782 | 2 | 3 |

| Uncached input | Cache read | Cache write | Output | Reasoning (in output) | Prompt tokens | Total tokens | Cache hit rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,284,991 | 138,204,672 | 0 | 214,553 | 41,208 | 139,489,663 | 139,704,216 | 99.1% |
```

## What "accurate" means here

Every number in this project is the **usage record the model provider returned**
for a real billed call, read from the durable session log the harness wrote.
Nothing is estimated from text.

That is a deliberate difference from the harness's own context meter: `ctx.tokenMeter`
answers *"how full is my context window"* with a four-characters-per-token
heuristic, which is the right tool for compaction and occupancy but the wrong
tool for a usage report. This project reads the other half of the log — the
provider's exact counters on `assistant/message` and `compaction/summary`.

| Counter | Meaning |
|---|---|
| `inputTokens` | **Uncached** prompt tokens. Cached shares are not folded in. |
| `cacheReadTokens` | Prompt tokens the provider served from its cache. |
| `cacheWriteTokens` | Prompt tokens the provider wrote to its cache. |
| `outputTokens` | The full completion, reasoning included. |
| `reasoningTokens` | The reasoning subset of the output — never added on top. |
| `totalTokens` | The provider's exact full-call total, or every part summed when it reported none. |

Four rules make the totals trustworthy, and each is covered by tests:

1. **One call per billed call.** A step that succeeds writes one usage-bearing
   `assistant/message`; a retried attempt writes an `assistant/attempt` with no
   usage. Summing usage-bearing events therefore never double-bills a retry.
2. **Forks do not recount the parent.** A seeded, resumed or forked log replays
   an inherited prefix that its parent already paid for. Everything before the
   last `session/end-seed` boundary is excluded from turns, steps and calls.
3. **Derived totals are labelled.** When a provider omits `totalTokens` the total
   is derived from its parts and marked with `*` — never silently presented as
   provider-exact.
4. **Costs are never invented.** The shipped price book is empty. Without rates
   you supply, cost columns stay `-` and the report names exactly which models
   are unpriced.

See [docs/accuracy.md](docs/accuracy.md) for the full derivation, including how
this was validated against an independently written implementation.

## Install

```sh
# from this checkout
dsh plugin --profile web add /absolute/path/to/dsh-usage-stats-long

# or from git (approve the prepare script when pnpm asks)
dsh plugin --profile web add github:ddxl123/dsh-usage-stats-long
dsh --profile web --dump-config   # shows the "# == dsh-usage-stats-long" layer
dsh --profile web
```

The bundle inserts one host-plane row:

```yaml
- id: usage-stats
  name: 'dsh-usage-stats-long'
  config:
    sessionsRoot: ''      # default: $DSH_HOME/sessions
    priceBookPath: ''     # JSON price book for cost columns
    cacheSize: 256        # folded sessions retained between queries
    registerTools: true
    web: true             # start the plugin's own dashboard server
    webHost: '127.0.0.1'
    webPort: 3090         # 0 lets the OS pick; the next ports are tried if taken
    webPortAttempts: 10
    webTtlMs: 10000       # reuse a rendered page for this long
    webLang: 'zh'         # default page language; ?lang=en still overrides
```

Override any of it from `$DSH_HOME/cordis.patch.yml` or a `--patch` overlay; a
patch replaces a row's whole `config`, so restate every key you need.

**Requirements.** Node ≥ 22.15 (the engine decodes zstd). One of: the `zstd` CLI
on `PATH` (fastest, recommended), or nothing at all — the built-in frame-by-frame
decoder is pure Node.

`@deepseek-ai/cordis`, `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`
are **peer dependencies**: they belong to your harness installation and are not
bundled. They must be resolvable *from this package's own directory*, which is
subtly different from being installed in your profile:

> Node resolves a package's bare imports from its **real** path, following
> symlinks. `dsh` links an out-of-tree plugin at `<profile>/node_modules/<name>`
> and maintains `profiles/node_modules/@deepseek-ai/*` as a fallback, but
> resolution from the plugin's real directory walks up *that* tree instead and
> never sees either. Without the peers resolvable locally the plugin fails to
> load with `Cannot find package '@deepseek-ai/cordis'`.

The bundled `prepare` script establishes them, so a git or npm install needs
nothing from you. For a `link:` install pnpm runs no scripts, so run it once:

```sh
node scripts/link-harness-deps.mjs              # finds your harness automatically
node scripts/link-harness-deps.mjs --from /path/to/node_modules
```

It exits successfully and silently when the peers already resolve, so it is safe
to re-run and safe to ignore when your deployment resolves them another way.

## Use

### Model tools

The plugin registers three tools, split by the question being asked:

| Tool | Use it for |
|---|---|
| `usage_stats` | How much was spent, aggregated. Filters, grouping, sections, cost. |
| `usage_sessions` | Which sessions exist and what can be filtered by (models, providers, projects, kinds, presets). |
| `usage_calls` | The exact per-call ledger, one row per billed model call. |

Ask the agent things like:

- *"How many tokens did I use this week, broken down by model?"*
- *"Which project cost the most yesterday?"*
- *"Show me the ten most expensive model calls, with their sessions and steps."*
- *"Compare cache hit rate between deepseek-flash and deepseek-v4.1-flash."*

### Filters

Every surface takes the same selectors, so a question can be narrowed the same
way in a tool call, a shell command and the dashboard:

| Filter | Accepts |
|---|---|
| `since` / `until` | ISO instant, `YYYY-MM-DD` (a bare date includes the whole day), or a relative span: `90m`, `24h`, `7d`, `2w`, `3mo` |
| session | Exact id, or an unambiguous prefix such as `45ee17c8` |
| `model` | `provider/model`, a bare `model`, a `provider`, or `provider/*` |
| `provider`, `project`, `cwd` | Name or path allow-lists |
| `kind` | `session` (top-level) or `subagent` |
| `agentPreset` | Preset name |
| `search` | Substring of id, title, working directory or preset |
| `minTokens` | Drop sessions below a spend threshold |

### CLI

```sh
dsh-usage-stats summary --since 7d
dsh-usage-stats models --model deepseek-flash --lang zh
dsh-usage-stats projects --since 30d
dsh-usage-stats sessions --limit 50
dsh-usage-stats timeline --limit 14              # terminal bar chart
dsh-usage-stats turns --session 45ee17c8         # per-turn detail
dsh-usage-stats calls --session 45ee17c8 --limit 100
dsh-usage-stats calls --order size --limit 10    # heaviest calls first
dsh-usage-stats export --out usage.json          # the whole report as JSON
dsh-usage-stats dashboard --out usage.html       # interactive dashboard
dsh-usage-stats filters --since 7d               # show the compiled filters
```

Global flags: `--sessions-root`, `--prices`, `--detail`, `--granularity`,
`--lang`, `--limit`, `--out`, `--json`, `--no-color`, `--quiet`, `--help`.

### Web page

The plugin starts **its own dashboard server together with the harness** and
serves the report there:

```
http://127.0.0.1:3090/                 # interactive dashboard
http://127.0.0.1:3090/?lang=en         # English labels
http://127.0.0.1:3090/?view=text       # plain-text report
http://127.0.0.1:3090/report.json      # the whole report as JSON
http://127.0.0.1:3090/healthz          # liveness plus engine state
```

**The page is Chinese by default** (`webLang: 'zh'`), because the report labels,
the time series and the drill-down all read more naturally in it. `?lang=en`
switches a single request to English, and `webLang: 'en'` changes the default
for a deployment; an unrecognized `?lang` value falls back to the configured
default rather than rendering an unlabeled page.

It is a listener of its own rather than a route on the harness webserver, for
two reasons: `ctx.webServer` is a single implementation per context and the
shipped Web composition already owns it, and this way the page also exists in a
deployment that mounts no webserver at all.

Details that matter in practice:

- **Port.** `webPort` is tried first (3090 by default) and the next few are tried
  in turn, so a second harness gets its own page instead of a failed plugin. Set
  `webPort: 0` to let the OS pick.
- **Bind address.** Loopback by default: the page is never exposed by accident.
  `webHost: '0.0.0.0'` makes it reachable from your LAN.
- **Freshness.** A rendered page is reused for `webTtlMs` (10s by default), so a
  refresh picks up new turns while an unchanged corpus is a cache hit.
- **Failure is not fatal.** An unavailable port degrades one page; every tool
  and the CLI keep working, and the reason is reported through `status()` and
  `GET /healthz`.

### Dashboard file

`dsh-usage-stats dashboard --out usage.html` writes **one self-contained HTML
file**: no CDN, no build step, no network access after it is written. It opens
from `file://`, can be committed or emailed, and works offline.

It carries eight views — overview, by model, by project, by session, timeline,
the call ledger, the text report, and diagnostics — with date / model / project /
kind / text filters, sortable columns, click-to-expand per-turn detail for any
session, and a JSON export of whatever is currently filtered.

[`usage-dashboard.example.html`](usage-dashboard.example.html) is a real one,
built from an 80-session corpus, so you can open the artifact before generating
your own. It embeds only the twelve heaviest sessions to stay small; a full run
includes every session and every call (about 3.5 MB for that corpus).

### Costs

Prices change and differ per route, so none are shipped:

```sh
cp prices.example.json prices.json   # then edit the rates you actually pay
dsh-usage-stats summary --prices ./prices.json
```

```yaml
- id: usage-stats
  name: 'dsh-usage-stats-long'
  config:
    priceBookPath: '/absolute/path/prices.json'
```

```json
{
  "prices": {
    "provider-a/model-x": { "input": 0.27, "output": 1.10, "cacheRead": 0.027 },
    "*": { "input": 1.0, "output": 2.0, "cacheRead": 0.1, "cacheWrite": 0.5 }
  }
}
```

Rates are USD per million tokens. Keys are matched most-specific first:
`provider/model`, then `model`, then `*`. A model with no match is reported as
unpriced instead of being priced at zero.

## Develop

```sh
node scripts/link-harness-deps.mjs   # symlink @deepseek-ai/* from your harness install
npm test                             # 107 tests, no network, no fixtures to download
npm run lint
```

The test suite includes a **differential test**: an independently written,
deliberately naive fold that reads the same bytes and must produce identical
counters, call by call and route by route. Point it at a real corpus with:

```sh
DSH_REAL_SESSIONS=~/.dsh/sessions npm test
```

## How it is built

```
lib/core/          host-independent engine — no Cordis, no services, plain data
  reader.js          log discovery + multi-frame zstd decoding
  fold.js            one session log -> exact, attributable model calls
  filters.js         filter compilation and application
  aggregate.js       rollups and time series
  pricing.js         the optional price book
  render-text.js     markdown for tools and terminals
  render-html.js     the self-contained dashboard
lib/host/          the plugin: usageStats service + model tools
lib/cli/           the dsh-usage-stats command line
```

The engine knows nothing about the harness, which is what lets the model tool,
the CLI and the dashboard share one implementation and therefore one set of
numbers. The plugin layer adds caching, cancellation, and provider-reported
status around it; it never recomputes a total.

## License

MIT
