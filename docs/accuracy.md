# Accuracy

How every number in this project is derived, and how it was verified.

## Where usage lives

DSH persists one durable log per session as concatenated zstd frames of JSONL
under `$DSH_HOME/sessions/<encoded-cwd>/<session-id>/`. Exactly two event types
in that log carry token accounting:

| Event | Carries | Producer |
|---|---|---|
| `assistant/message` | `usage: TokenUsage` | the agent loop's own model call for one step |
| `compaction/summary` | `usage: TokenUsage` | the compaction model's summarization call |

Nothing else does. Measured over a real corpus of 80 logs and 8,434 billed calls,
the auxiliary routes — session-title generation (`session/title-llm-request`),
DeepSeek web search (`web/deepseek-search-llm-request`), and every retried
attempt — write **no usage record at all**. There is therefore no second source
to reconcile against, and no estimate to blend in.

`TokenUsage` is the provider's own accounting:

```ts
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number       // provider-exact full-call total
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

## Counter semantics

`inputTokens` is the **uncached** prompt share. Cached shares are reported
separately and are not folded into it. This was verified against every usage
record in the corpus by testing which identity holds:

| Identity | Records |
|---|---:|
| `total === input + output + cacheRead` | 10,584 |
| `total === input + output` | 39 |
| no `total` reported | 64 |

Only the sum of *all* prompt shares plus the output reproduces the provider's
total, so `promptTokens = input + cacheRead + cacheWrite` is the billed prompt
size, and `totalTokens` is taken verbatim whenever the provider supplies it.

`reasoningTokens` is a **subset** of `outputTokens`, not an addition to it: for
every record reporting both, `outputTokens` already accounts for the reasoning.
It is displayed inside the output column and never added on top.

When `totalTokens` is absent, the total is derived as
`input + output + cacheRead + cacheWrite` and marked `totalDerived`, which every
renderer shows as a `*`. A derived total is never presented as provider-exact.

## Attribution

A call is attributed to the `provider`/`model` its own `assistant/message`
records in `message.source`, which the harness always writes. For legacy v0 logs
that predate that field, the fold falls back to the newest `request/context` (or
`request/header`) route in force at that sequence number, so attribution never
degrades into `(unknown)` for a log that carries route metadata.

## The four counting rules

### 1. One call per billed call

A step that succeeds writes one usage-bearing `assistant/message`. A retried
attempt writes an `assistant/attempt` event, which has no `usage`. In the corpus,
of 10,684 steps, 10,684 had exactly one usage-bearing message and none had more
— including the 129 steps that contained a `llm/retry-started` event. Summing
usage-bearing events never double-bills a retry.

### 2. Forks do not recount the parent

A seeded, resumed or forked session replays an inherited prefix that its parent
already paid for. The fold starts with counting **disabled** when the session
header has `isSeeded: true`, and re-enables it only at the last
`session/end-seed` boundary.

An earlier version of this rule re-enabled counting at the first `turn/start`
after the seed. That was wrong: a seeded log replays its parent's `turn/start`
events too, so counting resumed in the middle of the inherited prefix and
double-billed it. A unit test now pins the correct behavior.

Note that `isSeeded` alone is not the same as "has a parent": subagent children
carry `parentSession` and `delegationDepth` but not `isSeeded`, because they
started fresh rather than inheriting a prefix. They are counted in full, and
reported separately as subagent spend.

### 3. Derived totals are labelled

See above. `totalDerived` propagates through every aggregation level, so a
report whose scope contains even one derived call says so.

### 4. Costs are never invented

The shipped price book is empty and `normalizePriceBook` rejects a malformed
rate rather than coercing it. Without a configured rate a model is reported in
`summary.unpricedModels` and contributes nothing to the cost figure, which is
also flagged `costComplete: false`. A dollar amount is either derived from rates
you supplied or clearly incomplete.

## Decoding: the failure that looks like an empty answer

DSH appends a zstd frame per durability flush, so one ordinary session log is
hundreds of frames — the log measured while writing this document was 712 KiB
across **551 frames**.

Node's built-in decoder does not consume that layout:

- `zlib.zstdDecompressSync(buffer)` stops after the **first frame** and returns
  just the session header. This is the dangerous failure: the result is a
  well-formed session with zero usage, not an error.
- `zlib.createZstdDecompress()` fails with `ZSTD_error_prefix_unknown` at the
  second frame.

Decoding therefore tries, in order, and reports which one ran through
`decodedWith`:

1. `DSH_USAGE_STATS_ZSTD`, an operator-provided decoder command;
2. the `zstd` CLI, which decodes the whole concatenated stream;
3. Node's synchronous decoder applied **frame by frame**, using a structural
   frame walk that reads each block header's `lastBlock`, `blockType` and
   `blockSize` fields.

The frame walk is validated against the reference implementation: on a real log
it finds exactly 551 frames, the same count `zstd -l` reports. A frame walk that
cannot describe the whole file falls back to a single-frame interpretation so the
caller's own decoder produces the real diagnostic rather than the scanner
inventing a structure it cannot justify.

## Verification

Three independent checks, all passing:

### 1. Differential test against a second implementation

`test/differential.test.js` contains a deliberately naive fold — its own JSON
parsing, its own event walk, no shared helpers, no caching, no aggregation
layer — and asserts that it produces **identical** counters to the engine: total
calls, all six counters, per session, and per model route.

### 2. Agreement with the harness's own session-query service

A live Cordis plugin (`usage_report_live`, defined at validation time and not
part of this package) folds the corpus a second way: through
`ctx.sessionQuery.readSession()`, the harness's own read path, with its own
counting code. On a frozen 80-log corpus both report:

| | Engine (this package) | Independent live fold |
|---|---:|---:|
| billed model calls | 8,434 | 8,434 |
| uncached input | 26,458,289 | 26,458,289 |
| cache read | 1,708,564,992 | 1,708,564,992 |
| cache write | 0 | 0 |
| output | 5,857,585 | 5,857,585 |
| reasoning | 798,642 | 798,642 |
| total tokens | 1,740,880,866 | 1,740,880,866 |

Identical to the last token, including every per-model subtotal.

### 3. Real-corpus regression run

`DSH_REAL_SESSIONS=~/.dsh/sessions npm test` runs the differential test over a
real session directory, so a change that breaks exactness fails against real
data rather than only against synthetic fixtures.

## What this project deliberately does not do

- **Estimate tokens from text.** That is `ctx.tokenMeter`'s job, for context
  pressure. A usage report must not blend an approximation into a billed total.
- **Count auxiliary model calls.** Title generation and web search are real
  calls, but the harness records no usage for them, so there is nothing exact to
  report. Counting them would require estimating, which the previous point rules
  out. This is a limitation of the durable log, stated rather than papered over.
- **Trust a partial read.** A short decode is treated as a failure, never as a
  small answer.
