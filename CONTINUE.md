# CONTINUE

Use this file to resume an interrupted active task. Read `AGENTS.md`,
`CLAUDE.md`, and `PERSIST.md` as usual, then treat this file as the most current
handoff for work in progress.

## Active Task

None in progress. The benchmark harness upgrades on `feature/harness-upgrades`
are complete and pushed; see the PR for review status.

## Last Completed (2026-06-12, Claude — Opus 4.8 1M)

Audited and finished the harness upgrades the prior agent left half-done:

- **YAML task loading** — extracted a side-effect-free `bench/tasks.js`
  (`parseYaml`/`toYaml`/`validateTask`/`loadTasks`). Multi-line prompts are now
  literal `|-` blocks; all 20 tasks were re-migrated so each loads to an object
  byte-identical to the original JSON (verified by round-trip). This fixes the
  folded-scalar bug that collapsed `str_replace` anchors and changed what the
  model was asked. `bench/run.js` imports the module and no longer auto-runs on
  import.
- **JSON IPC** — `claudette.js --json-ipc` now emits *pure* JSONL on stdout
  (spinner, markdown stream, banner, tool lines, and "Goodbye" are gated behind
  `!jsonIpc`), including a `{type:error}` shutdown path. `buildWorkflowSummary`
  parses the JSON event stream instead of grepping terminal glyphs.
- **Cache** — `provider.chatStream` cache hardened: order-independent key over
  output-affecting fields (callbacks excluded), atomic temp+rename writes, and
  corrupt/missing entries degrade to a live call with a stderr warning.
  `CACHE_VERSION` invalidates stale entries.
- **Tests** — +10 offline tests (parser round-trip, cache key/atomicity/
  corruption, end-to-end IPC protocol). Full suite: 165 pass / 15 fail, where
  all 15 are pre-existing env-dependent failures (live provider, SSE streaming,
  interactive-CLI drift, Stress suite). `git diff --check` is clean.
- **Docs** — Changelog, `bench/README.md`, and the model-attribution commit
  convention added to `CLAUDE.md` + `AGENTS.md`.

## Preserve

These unrelated, user-owned untracked files must NOT be committed into the
harness PR:

- `docs/parallel-subagents-plan.md`
- `docs/queued-followups-plan.md`

## Open follow-ups (requested mid-session, not yet started)

- Monokai (VS Code) theme for the harness/TUI colors (`src/ui.js` + bench
  verbose colors in `bench/run.js`).
- Session logging/debuggability audit — is enough recorded to debug a past
  session? Then bring that to the TUI.
- Queued follow-ups / mid-run steering in the TUI — implement
  `docs/queued-followups-plan.md`.
