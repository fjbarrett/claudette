# Continuous streaming tests — 2026-09-05

This follows the [earlier reliability campaign](testing-2026-09-05.md). Testing
remains active at the user's request. Results apply to the uncommitted
`feature/review-hardening` working tree.

## Defects fixed

- All three provider adapters retained response-reader locks, including when a
  consumer callback threw. Readers now release on every exit and cancel unused
  bodies. Cleanup failures preserve the original exception.
- Streamed provider errors and malformed JSON could be silently discarded.
  They now reject the request. Ollama documents errors inside an otherwise
  successful HTTP stream; Anthropic also defines streamed error events.
  [Ollama errors](https://docs.ollama.com/api/errors),
  [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).
- SSE handling assumed one JSON object per LF-delimited line. The shared parser
  supports CR, LF, CRLF, split UTF-8, BOM, comments, and multi-line data fields;
  incomplete events are not dispatched.
  [SSE framing specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation).
- Ollama's last NDJSON object was lost when it lacked a trailing newline.
- The adapters waited for socket closure after completion, and empty/truncated
  responses could return success. They now recognize completion markers and
  reject missing completion. OpenAI-compatible endpoints may also complete with
  `finish_reason` followed by EOF; later usage events remain counted.
- Aborting from a text callback could allow more already-buffered text through.
  Adapters now check cancellation between events and before returning.

## Validation checkpoints

| Check | Result |
| --- | --- |
| Pre-fix reader/consumer regressions | Four failures reproduced |
| Pre-fix premature EOF regressions | Three failures reproduced |
| Full Node 20.20.2 / 22.23.2 / 24.18.0 after adapter fixes | Each 489 passed, zero failed, two expected live skips |
| Final Node 24 full suite with added fuzz/cleanup cases | 496 passed, zero failed, two expected live skips (498 total) |
| Final targeted Node 20 / 22 streaming suite | Each 32 passed |
| Text/usage transport matrix per streaming run | 540 scenarios: three providers, six payloads, line framing and six chunk sizes |
| SSE semantics | 40 cases |
| Interleaved tool calls | 15 provider/chunk configurations, fragmented Unicode JSON |
| Real HTTP cancellation | Six provider/timing configurations |
| Simultaneous requests | 96 independent streams per run |
| Large payloads | Roughly 1 MB per provider, exact content verified |
| Generated fuzzing | Configurable seed and case count; default 300 per suite |
| Initial coordinator smoke | Four batches, 8,000 generated cases, all passed |
| Coordinator stop/argument checks | Clean stop and five invalid-input cases passed |
| Shared parser coverage | 100% lines/functions; 93.18% branches in the focused run |
| Package | Shared helper and three adapters included, byte-identical to working files |

The continuous loop initially passed another 24 batches / 48,000 generated
cases. Counts continue increasing; `results.jsonl` is authoritative. The
focused coverage percentages for unrelated adapters are not full-suite coverage.

## Live model checks

Three uncached, non-rotating `farm-unicode-path` runs per model used isolated
fixtures and the free Ollama Cloud routes. MiniMax M3 passed 2/3; GLM 5.3 Flash
passed 0/3 under the fixture's strict expected-answer rule. File validation
succeeded, but some answers included extra prose. GLM also made recoverable
wrong-path reads. These remain model-quality failures, not passing cases.

Reports:

- `bench/runs/evals/2026-09-05T16-43-06-961Z-minimax-m3-cloud.json`
- `bench/runs/evals/2026-09-05T16-42-55-586Z-glm-5.3-flash-cloud.json`

## Reproduce or continue

```sh
node --test test/streaming.test.js
CLAUDETTE_STRESS_SEED=42 CLAUDETTE_STRESS_CASES=10000 node --test test/streaming.test.js
node scripts/stress-streams.mjs --batches 4 --cases 2000 --seed 20260905
node scripts/stress-streams.mjs --cases 2000
```

The last command runs until interrupted or a failing batch. The runner records
each seed, runtime, timezone, locale, memory limit, exit code, and complete test
output. It cycles 128/256/512 MiB heap limits and four timezone/locale settings.
Locale settings exercise environment variation; they do not establish that the
host has every locale installed. Ctrl+C stops the active process group. Supply
`--output NEW_DIR` to choose a new artifact directory.

Current campaign artifacts:
`/var/folders/xn/5987rxq95wjbb6mvn_m06l1c0000gn/T/claudette-ongoing-vf7haq54`.
The active loop writes `continuous/results.jsonl` and `continuous.log` there.
No user project files or clipboard contents are changed by this loop.
