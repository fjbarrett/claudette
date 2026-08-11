# CONTINUE

Use this file to resume an interrupted active task. Read `AGENTS.md`,
`CLAUDE.md`, and `PERSIST.md` as usual, then treat this file as the most current
handoff for work in progress.

## State: review + hardening + cleanup, committed on `feature/review-hardening` (2026-08-10)

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
**289 / 289 passing, including the live-model suite** — the first fully green run.
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
6. **Queued follow-ups, rest of Phase 2** — Ctrl+C interrupts a foreground tool
   now; what remains is the `'approval'` input mode, so text typed during a
   permission prompt queues instead of answering it.

Both `docs/*-plan.md` remain user-owned and untracked — do NOT commit them.
