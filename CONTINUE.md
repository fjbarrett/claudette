# CONTINUE

Use this file to resume an interrupted active task. Read `AGENTS.md`,
`CLAUDE.md`, and `PERSIST.md` as usual, then treat this file as the most current
handoff for work in progress.

## Active branch — `feature/context-management` (uncommitted)

Log-driven hardening of context + input handling. Everything below is uncommitted
on `feature/context-management`. Full suite: **200 pass / 14 fail**; all 14 are
pre-existing env-dependent (live-provider Stress suite + `/api/models` + message
stream). `git diff --check` clean.

Grounded in `data/usage/usage.jsonl` (28 turns: 30:1 input:output, 4 turns >500k
input, max 1.73M, 6 turns ≥50 tools, 3 failed):

- **Tool-output trimming** — `trimToolOutputs` (src/context.js) collapses old
  large tool results in the model payload (keep most recent 6); stored history
  untouched. Wired into `agentLoop`.
- **Auto-compaction** — `maybeAutoCompact` summarises history past ~60k tokens
  (`CLAUDETTE_COMPACT_TOKENS`; `CLAUDETTE_AUTO_COMPACT=0` to disable) before a turn.
- **Iteration cap 50 → 150** (`resolveMaxIterations`) — logs showed 6 turns hitting
  the old cap; safe now that trimming bounds per-iteration growth.
- **Idle-prompt paste coalescing** — `createBurstReader` + `readCoalescedPrompt`
  join readline's per-newline `line` burst so a pasted block is ONE prompt (the
  in-turn path was already fixed; this closes the idle gap).
- **Input sanitization** — `sanitizeUserInput` strips ANSI + cuts a single typed
  line at leaked ⏺/⎿ render glyphs (multi-line pastes kept whole).
- **Usage-log signals** — `iterations`, `hitToolCap`, `compacted` added to
  `buildUsageRecord` (+ `turn.compacted` in trace.js) to measure the above.
- **Clear model-error message** — `explainStreamError`: a turn failing on a bad
  model id (logs: `gpt-54-mini`, tools=0/in=0) now points at the slug / `/models`.
- **Re-read guard + anti-over-exploration prompt** — the "results not good" root
  cause: a real turn made 128 tool calls, first edit at #109, **69% of reads were
  redundant re-reads** (one file 23×). `read_file` now short-circuits an identical
  unchanged re-read (per-turn `readCache` in agentLoop → executeTool; changed file
  / new range still reads); system prompt tells the agent to explore only as needed
  and act once it understands. (System prompt also renamed "Ollama Code"→"Claudette".)
- **Action-forcing nudge** (`createActNudger`/`resolveActNudge`, default 15,
  `CLAUDETTE_ACT_NUDGE`) — re-read guard alone didn't stop flailing (live: still
  read same files ×dozens, 0 edits). After N read-only tool calls with no edit, a
  steering line is appended to the last tool result. **Verified live on gpt-5-nano:
  nudge fired at 3 reads → model immediately made the edit, typo fixed.**
- **Piped-input EOF fixes (found via live testing):** `readCoalescedPrompt` flushes
  a buffered line on stream close (was dropped when EOF raced the 40ms window);
  main loop breaks on `rlClosed`; `rl.resume()` in agentLoop's finally is guarded
  (was throwing "readline was closed" and crashing a turn when stdin closed
  mid-turn). +regression test (`echo "/help" | claudette`).

## Live stress test (realistic Next.js "fix the CSS" task, gpt-5-nano)
Built a sandbox mirroring the real flailing turn (rankings page + components +
globals.css missing `.rankings-table`). Two kinks found & fixed: (1) a failed
no-op `patch_file` reset the nudge streak → now a failed action counts toward the
nudge (`record(name, isError)`); (2) `list_dir` threw on `path:""` → now defaults
to root. Re-run after fixes: **clean success — 3 successful patches, table fully
styled, no empty-path errors, no flailing.**

## Verified working from the logs (post-change turns)
The re-read guard fired 6× across 2 real sessions; 2 of 3 recent turns dropped
redundant reads from the 69% baseline to **14–29%** with first-edit at call 13–24
(was 109). One hard turn still flailed (40+ reads, 0 edits) → that's what the
action-nudge (above) now forces. Token A/B (eval, gpt-5-nano): trim −35% peak.
- **Eval harness instrumented** — `bench/evals.js` applies trimming (toggle
  `--no-trim`), records `promptTokens/peakInputTokens/completionTokens`, reports
  avgIn/avgPeakIn/avgOut; new `context-stress-reads` case (10 sizable files).
- **/help test fix** — it asserted phantom `/feature`+`/publish` commands; now
  asserts the real `/diff`+`/commit`.

**Live validation (gpt-5-nano via OpenRouter — user constraint: gpt-5-nano only):**
context-stress A/B → trim ON peak 7,459 / total 57,978; OFF peak 11,463 / total
67,988 (**−35% peak, −15% total**), both PASS. Full eval suite (5 cases) all pass
with trim on.

## Docs-plan review (user asked: delete if fully implemented → KEEP both)
- `docs/queued-followups-plan.md` — Phase 1 done (queue, /queue, live input);
  Phase 2 partial (Ctrl+C aborts model, but `executeTool` takes no AbortSignal so
  foreground Bash/fetch can't be interrupted; `'approval'` input mode defined but
  never set in chat.js); Phases 3 (background Bash/Ctrl+B) & 4 (browser queue) not
  started. **Keep.**
- `docs/parallel-subagents-plan.md` — NOT STARTED (no agent-manager/agent-runner/
  delegate_agents/`/agents`). **Keep.**
- Both remain user-owned untracked planning docs — do NOT commit into this branch.

## Open follow-ups (next, all log-supported)
- Queued-followups Phase 2: give `executeTool` an AbortSignal (interrupt foreground
  Bash/fetch); wire `'approval'` input mode so typing during a permission prompt is
  queued, not consumed.
- Prose-pollution: the 04:00 failed turn's prompt had leaked assistant text
  ("…Absolutely. If you're") with no glyph — sanitizeUserInput can't catch that;
  root-cause the in-turn capture mixing streamed output into the follow-up buffer.
- Decide commit/PR for this branch.
