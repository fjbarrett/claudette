# CONTINUE

Use this file to resume an interrupted active task. Read `AGENTS.md`,
`CLAUDE.md`, and `PERSIST.md` as usual, then treat this file as the most current
handoff for work in progress.

## State: review + hardening + cleanup + library API + Terminal-Bench (2026-08-10)

All committed and pushed on `feature/review-hardening`. **318 tests, 316 pass, 0 fail.**

### The three things that now work
1. **CLI** — `npm link` puts `claudette` on PATH. `-p` headless, `--json-ipc`,
   `--continue`/`--resume`, Tab completion.
2. **Library** — `import { run, stream, createAgent } from 'claudette'`
   (`index.js` + `index.d.ts`, `main`/`exports`/`files` in package.json).
   Verified as a linked consumer, against both Ollama and OpenRouter.
3. **Terminal-Bench** — Harbor adapter runs claudette in the task container
   against **host Ollama** (loopback rewritten to `host.docker.internal`), so runs
   are free. `openssl-selfsigned-cert`: 5/6 grader tests, reward 0.0.

### Local performance — the machine is fine, the config was not
M1 Max / 32GB. Two fixes worth ~100x combined:
- `think:false` by default — these are reasoning models burning ~1k tokens per
  step before answering. 27b 17.2s→0.8s; 35b-a3b 11.6s→0.4s.
- Use the **a3b MoE** (52.8 tok/s), never the dense 27B (9.2 tok/s).
Full agentic turn: 49s. Suite: 60s offline / 102s live. Cloud nano: 2.0s.
RAM is the real limit — one 24GB model resident leaves little room, and swapping
models costs 20-120s. Pick one and stay on it.


A full program review found four defects (three reproduced live) plus a set of
structural gaps; a second pass then finished the "before 1.0" security items and
cleaned the repo. All committed on `feature/review-hardening`. Details in
`Changelog.md` under `[Unreleased]`.

**Suite: 306/306, live model tests included.**

### What changed, and why it mattered

**Security**
- Removed the exact-bash shortcut. It scanned the *@file-expanded* prompt for
  "Call bash with EXACTLY this command…" and ran the rest through `executeTool`
  with no `checkPermission`. Verified exploitable: a `notes.md` carrying that
  sentence plus `please summarize @notes.md` executed a command before any model
  request. The two bench tasks that used it (`count-lines-tool`,
  `extract-print-help`) are rewritten as genuine task descriptions.
- Bash "always" approval is scoped to the exact command (`permissionKey`). It
  used to authorise every later command in the session.

**Correctness**
- `dropOrphanToolMessages` strips `role:'tool'` messages with no preceding
  `tool_calls` from outbound payloads. The shortcut wrote those, and OpenAI/Azure
  reject the whole request — poisoning the session for every later prompt.
- `--json-ipc` no longer drops prompts 2..N (`createLineQueue` in `src/input.js`).
- Compaction archives to `data/sessions/archive/` before summarising.
- Session writes go through `writeFileAtomic`.

**Structure — the important one**
- `src/agent-runner.js` now owns the loop. `chat.js` is a terminal/permission/
  session shell around `runAgent()`, and `bench/evals.js` runs the same loop
  instead of its own simpler copy. Hooks: `emit(type,data)`, `onDelta`, `approve`,
  `takeFollowUps`, `onMaxIterations`. Every appended message is emitted **by
  reference**, so mirroring into `session.messages` picks up in-place edits (the
  act nudge appends to the last tool result).
- Text tool-call parsing moved to `src/tool-call-parser.js`.
- `chat.js` re-exports the moved helpers, so existing importers are unaffected.

**Reliability** — `src/retry.js`: backoff + jitter, `Retry-After`, no retry once
bytes have streamed, stall watchdog that reports a plain Error (never an
`AbortError`, which the loop reads as user-cancel).

**Added** — `-p` headless, `--continue`/`--resume`, Tab completion, `npm test` (offline) /
`npm run test:live`, GitHub Actions CI on Node 20/22/24.

### Tests
**318 total: 316 passing, 0 failing** (2 live-model tests skip without `CLAUDETTE_SKIP_LIVE`; `npm run test:live` runs them).
Those 12 live tests used to hardcode `llama3.2:latest`, which was not installed, so
they failed on every machine and were miscategorised in PERSIST as
"env-dependent". They now discover an installed Ollama model (smallest that
advertises `tools`) and skip with a reason when Ollama is absent. `llama3.2:3b`,
`qwen3:4b` and `qwen2.5-coder:7b` were pulled for this; discovery picks
`llama3.2:3b`, which runs each Stress prompt in 2-9s instead of the 118-240s a 27B
model took. The `normalizeArgs` tests asserted against an inlined copy of the alias
tables in a subprocess; they import the real function now.

Verified live against local Ollama: headless `-p` returns a clean, pipeable answer
and exits 0.

### Mid-turn steering (done 2026-08-11)
Typing while the agent works now queues a follow-up in **any TTY session**; it
previously required `--yolo`. The blocker was stdin ownership — `checkPermission`
wanted readline's `question()` while the raw-mode reader held stdin — so both now
share one reader: `InputController.awaitApproval()` parks the prompt, `submit()`
sends `y`/`n`/`a` to it and queues everything else. Ctrl+C denies a parked
approval before aborting; `runTurn`'s finally settles one if the turn dies.

Verified in a real pty with `expect` (`scratchpad/steer.exp`) — blind
timing cannot test this, because a `y` sent before the prompt appears correctly
becomes a follow-up. Observed: prose queued at the `[y/n/a]` gate, prompt still
waiting, `y` then ran the tool, queue drained at the safe boundary, model acted
on the steer.

**Known edge, not fixed:** slash commands other than `/queue` typed mid-turn are
queued as prose and sent to the model — so `/exit` during a turn steers rather
than exits. Ctrl+C is the documented interrupt. Decide the intended behaviour
before changing it.

### Repetition guard (done 2026-08-11)
Built after a live session on `24p.mov` re-issued the same five curl commands 30
times running, for 37 minutes. `createRepeatDetector` compares each response by
`responseSignature(calls)` — tool names + normalised arguments, prose excluded —
and nudges when the same signature repeats 3× (`CLAUDETTE_REPEAT_GUARD`, 0
disables). Two ignored nudges end the turn with status `'repeating'`.

Why nothing caught it before: the act nudge counts read-only streaks and a
**successful** `bash` resets that streak, so a loop of successful identical
commands looked like progress every iteration. `maxIterations` (150) was the only
backstop, ~2h away at 75s/iteration. The guard stops it in ~9.

Checked *after* the batch executes (keeps tool_call/tool_result pairing valid)
and in the else-branch of the follow-up drain, so an automated nudge never stacks
a second adjacent user message on a delivered follow-up.

### Model bake-off — RESUMED (2026-08-11 evening)

The paused run's table was in a session scratchpad and was gone by the next
session. It has been **recovered and made durable**: the JSON reports it was
derived from were in `bench/runs/evals/` the whole time, so
`node bench/eval-summary.js --since 2026-08-11 --write` now rebuilds
**`bench/BAKEOFF.md`** (tracked; the reports stay gitignored). Keyed on the
latest result per model *and* case, because a bake-off gets run in pieces.

The 3 lost "harder" cases were not recovered — four new ones were written
instead, aimed at what actually separates models here rather than at whether a
model can call a tool at all:
`multi-file-rename`, `fix-failing-test`, `already-correct`, `ambiguous-anchor`.
They needed assertions the harness lacked: `files.excludes` (the change landed
but the rewrite dropped everything else), `files.absent`, and a `maxToolCalls`
budget — which is how correctness ties break.

**Do not compare a cached run against a live one.** `bench/evals.js` used to
turn the response cache ON by default; it is now opt-in (`--cache`).

#### Result so far — winner on this machine: `qwen3.6:35b-a3b-q4_K_M`
**9/9 in 161s.** The only other clean sweep, `qwen3.6:27b-opencode`, takes
**698s for the same work** — 4.3x, and the dense/MoE split is the whole gap.
Full table in `bench/BAKEOFF.md` (regenerate with `bench/eval-summary.js --write`).

Read the table with two caveats:
- `qwen3.6:35b-a3b-opencode`'s (the previous incumbent's) `multi-file-rename`
  failure is **infrastructure, not the model** — Ollama auto-updated mid-run and
  killed the request. Re-run that one case to settle it.
- `qwen3-coder:30b`'s 6/9 predates the XML tool-call fix; its
  `write-then-verify` failure was claudette failing to parse a correct call.
  Re-run it for an honest number.

**STOPPED at the user's request (needed the GPU/CPU) partway through
`gpt-oss:20b`.** Not yet benchmarked: `gpt-oss:20b`, `devstral:24b`,
`qwen3.6:27b-q4_K_M`. Skip `qwen3.6:latest` — same blob id (07d35212591f) as
`qwen3.6:35b-a3b-q4_K_M`, so it is that model under a second tag.

To resume (one pass per model — a swap costs 12-120s of load, so revisiting a
model is the expensive mistake):
```sh
export CLAUDETTE_MAX_RETRIES=4
for m in gpt-oss:20b devstral:24b qwen3.6:27b-q4_K_M; do
  node bench/evals.js --model "$m" --all; ollama stop "$m"
done
node bench/evals.js --model qwen3-coder:30b --all            # re-run: XML parser fix
node bench/evals.js --model qwen3.6:35b-a3b-opencode --case multi-file-rename
node bench/eval-summary.js --since 2026-08-11 --write
```

**RAM is the binding constraint, not compute.** `qwen3.6:35b-a3b-coding-nvfp4`
sat at 27GB resident on a 32GB machine: 31G used, 298MB free, 4.1GB swapped, and
the machine unusable for anything else. It was still fast (8/9, 132s), but it is
not a model to keep loaded while working. The q4_K_M winner is 23GB and leaves
room.

### Four bugs found by trying to read the bake-off numbers (2026-08-11 evening)
1. **Retry backoff could be ~0.** Full jitter draws from `[0, exponential]`, so
   three attempts fit inside a second. Now half jitter, and a *connection*
   failure (nothing answering the socket, as against a 429 that answered) starts
   from a 3s base. Found when Ollama **auto-updated itself mid-run**, SIGTERMed
   its server, and took 8.4s to return — the run died with the case's context
   thrown away. For unattended runs also set `CLAUDETTE_MAX_RETRIES=4`.
2. **Anthropic cached input was not counted.** `input_tokens` is the *uncached*
   remainder; OpenAI-compatible providers put the whole input in
   `prompt_tokens`. A five-case eval billed 52 input tokens. `promptTokens` is
   now the true total, with the cache split carried so `estimateCost` prices a
   read at 0.1x and a write at 1.25x.
3. **The bench cache replayed stale results.** Fixing (2) changed nothing
   because the harness kept replaying a reply recorded before the fix — and a
   replay also reports a near-zero duration, so a cached model looks instant.
4. **A failed run threw away the provider error.** `runAgent`'s failed result
   now carries it; that is why `openrouter/anthropic/claude-opus-5` scored 2/5
   with no explanation (three runs died on a provider error, not on quality).

### Next steps
1. **Open a PR to main** (branch is pushed).
2. **Rebaseline the benchmark.** `count-lines-tool` and `extract-print-help` were
   4-5/10 *with* a shortcut that did the work; they will score lower now, honestly.
   `npm run bench -- --task <id> --model <m> --judge <m>` (OpenRouter declares no
   `DEFAULT_MODELS`, so pass both explicitly), then `npm run bench:leaderboard`.
3. **MCP client** — the biggest remaining capability gap (9 hardcoded tools).
4. **Browser parity** — `server.js` still has no tools and duplicates session
   storage / @file expansion / the system prompt. The extraction unblocks it.
5. **Subagents** — `docs/parallel-subagents-plan.md`; its Phase 1 (reusable runner)
   is now done.
6. **Queued follow-ups, Phase 3+** — phases 1-2 are done (see above). Next is
   `Ctrl+B` to background a long-running Bash command, which shares a task
   registry with `docs/parallel-subagents-plan.md`, then browser parity (a
   server-side per-session queue).

Both `docs/*-plan.md` remain user-owned and untracked — do NOT commit them.
