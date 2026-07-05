# Changelog

## [Unreleased]

### Fixed
- Recoverable tool errors now guide the model instead of repeating. Across real
  sessions 13% of tool calls errored, dominated by three recoverable mistakes —
  file-not-found (59×), missing/empty path (38×), and path-outside-workspace
  (31×). These now return actionable messages ("don't guess paths — run list_dir
  / search_code", "use a path relative to the workspace root") so the model
  self-corrects rather than retrying the same bad call. `patch_file` now gives the
  same recovery hints `str_replace` already had (nearest-line hint on a missing
  old_str, "put updated text in new_str" on a no-op patch, "make it unique" on a
  multi-match), and a blank `bash` command gives a clear error instead of the
  shell's cryptic "-c: option requires an argument".
- `list_dir`, `search_code`, and `grep` with an empty/blank path now target the
  workspace root instead of throwing "Missing required 'path'" — a live nano run
  repeated the same empty-path `search_code` five times in a row on this bug.
- `bash` timeout is configurable and more generous (30s → 120s default,
  `CLAUDETTE_BASH_TIMEOUT`); the timeout error now explains how to recover and
  that long-running servers (`next dev`) can't run in the foreground.
- Piped/automated input is no longer dropped or crashed on EOF. `echo "…" |
  claudette` could lose its last line (the prompt arrived in the same chunk as
  EOF, before the coalesce window flushed), and if stdin closed mid-turn,
  `rl.resume()` threw "readline was closed" and killed the turn. The idle reader
  now flushes a buffered line on close, the loop exits cleanly on EOF, and the
  mid-turn `rl.resume()` is guarded. (Surfaced while live-testing the nudge.)
- A turn that fails because the model id is wrong now says so. The usage log
  showed turns dying instantly (`tools=0, in=0`) on typo'd slugs
  (`openrouter/openai/gpt-54-mini`) behind a generic "Stream error" — and the
  same typo getting retried. `explainStreamError` detects model-not-found errors
  and points at the slug / `/models`.
- Pasting a multi-line block at the **idle prompt** no longer fragments into one
  prompt (or slash-command) per line. readline emits a `line` event per newline;
  a rapid burst is now coalesced into a single submission (`createBurstReader`),
  so a pasted stack trace / build log arrives as one message. (The in-turn paste
  path was already fixed; this closes the idle-prompt gap.)
- Echoed terminal artifacts no longer leak into a captured prompt. A real session
  logged `cont  ⎿ Wrote 1335 chars …` — a typed "cont" plus an echoed tool-result
  line. `sanitizeUserInput` strips ANSI escapes and cuts a single typed line at
  the ⏺/⎿ render glyphs (multi-line pastes are kept whole).
- Usage-dataset quality: a user-cancelled turn (Ctrl+C) now records
  `status: "cancelled"` instead of `"failed"`, and the GPT-5 family
  (`gpt-5`/`-mini`/`-nano`) is priced, so the cost meter and usage log no longer
  report `$0.00` for the models you actually run.
- Pasting a multi-line block while the agent works no longer fragments into one
  queued follow-up per line. Bracketed paste mode is enabled during a turn and a
  pasted block is coalesced into a single follow-up (`createInputAssembler`).

### Changed
- Action-forcing nudge for the agent loop. The re-read guard made flailing cheap
  but didn't stop it — a live gpt-5-nano turn still read the same files dozens of
  times with zero edits. After N consecutive read-only tool calls with no edit or
  command (default 15, `CLAUDETTE_ACT_NUDGE`, 0 disables), a firm steering line is
  appended to the last tool result telling the model to act; it re-arms every N.
  A *failed* action (e.g. a no-op patch) does not reset the streak — it isn't
  progress. Verified live: nudge fired at 3 reads → model immediately made the edit.
- Curbed agent over-exploration — the real cause of slow, often-cancelled turns.
  Session transcripts showed a turn making **128 tool calls, not editing until
  call #109**, with **69% of file reads being redundant re-reads** (one file read
  23×). Two changes: (1) a **per-turn re-read guard** in `read_file` — an
  identical read of an unchanged file returns a short pointer instead of re-sending
  the contents (a changed file or a new line range still reads normally); (2) the
  system prompt now tells the agent to explore only as much as the task needs, not
  re-read files it already read this turn, and to act once it understands the code.
  (Also: the system prompt identified itself as "Ollama Code" → now "Claudette".)
- Default tool-iteration cap raised 50 → 150 (`--max-iterations` /
  `CLAUDETTE_MAX_ITERATIONS` still override). Usage logs showed real turns hitting
  the 50 cap mid-task and forcing repeated "continue" prompts; the higher cap is
  safe now that context management bounds per-iteration token growth.

### Added
- Verification gate — a turn that edited files can't finish without proving the
  result works. A real Sonnet run "completed cleanly" (11 edits, $2.55) but left
  the site broken because it never ran a build. Now, before the agent ends a turn
  in which it edited, it must have run a passing build/typecheck/test
  (`looksLikeVerification` recognizes them, dev servers excluded); otherwise the
  loop pushes it to run one and fix failures (capped at 2 nudges/turn,
  `CLAUDETTE_VERIFY_GATE=0` to disable). The system prompt now also makes "verify
  before claiming done" explicit. Verified live: the gate fires even when the
  model is told to skip verification.
- Realtime token/cost readout on the working spinner (à la Claude Code). While the
  agent runs, the spinner shows cumulative `↑input ↓output · $cost · iter N/max`,
  updated after every model request from the turn's trace metrics —
  `↑3.2k ↓381 · $0.0003 · iter 3/150`. Off under `--json-ipc`. (`setUsageStatus`
  in ui.js, `formatTokens` in cost.js.)
- Context management to curb token blowup (a real session hit 1M+ input tokens in
  a single turn from ~30 accumulated file reads re-sent every iteration).
  **Tool-output trimming**: old, large tool results are collapsed to a placeholder
  in the model payload — keeping the most recent ~6 full — so a long tool loop
  stops re-sending every read; stored history is untouched (`trimToolOutputs`).
  **Re-read guard** (`readCache`): `read_file` short-circuits an identical
  unchanged re-read, and caps repeated reads of the *same* unchanged file across
  different line ranges (a live nano run read one file ~12× and never edited).
  **Auto-compaction**: when prior history passes ~60k tokens
  (`CLAUDETTE_COMPACT_TOKENS`) it's summarized before the next turn
  (`CLAUDETTE_AUTO_COMPACT=0` to disable). Prompt history is no longer written
  under the test runner. The per-turn usage log (`data/usage/usage.jsonl`) now
  records `iterations`, `hitToolCap`, and `compacted` so the effect of these
  controls on input-token growth is measurable from the dataset.
- See your follow-ups while the agent works. In an auto-approve TTY session, typed
  input is now echoed on a managed bottom row (it was blind before) — streamed
  output is routed above it so the two don't collide, and typing pauses the
  spinner. (`updateLiveInput`/`printAboveLive` in `ui.js`, assembler `onChange`.)
- Persistent per-directory prompt history. Re-entering the TUI in the same
  directory restores what you typed there — **up-arrow recalls prior-session
  prompts** like a normal shell (newest-first, consecutive dups skipped). Stored
  under `data/history/` keyed by the absolute cwd (gitignored). (`src/history.js`)
- VS Code Default Dark+ palette, brightened for terminal readability. The CLI/TUI
  colors mirror VS Code's default dark theme (purple, blue, teal, function yellow,
  string orange, error red) with higher luminance so text reads clearly on common
  terminal backgrounds, via 24-bit truecolor (`src/ui.js`); `NO_COLOR` is honored
  and the exact codes are exported as `palette`.
- The CLI/TUI now also loads a **`CLAUDETTE.md`** project-instructions file,
  walked up the directory tree alongside `CLAUDE.md` (innermost wins; a level's
  `CLAUDETTE.md` comes after its `CLAUDE.md` so it can augment/override) — for
  Claudette-specific guidance on a directory or session.
- Token-spend usage log. Every completed turn appends a flat JSONL record to
  `data/usage/usage.jsonl` — model, prompt/completion/total tokens, estimated
  cost, duration, tool-call count, prompt, status — a ready-made dataset for
  studying and improving token efficiency. On by default; `CLAUDETTE_USAGE_LOG=0`
  to disable, `CLAUDETTE_USAGE_DIR` to relocate. (`src/usage.js`; gitignored.)
- Queued follow-ups (mid-run steering). In an auto-approve TTY session you can
  **type while the agent works**; submitted lines go into a visible FIFO queue
  (`/queue`, `/queue clear`) instead of starting a second loop, and are delivered
  as one combined steering message at the next safe boundary (after a model
  response and its tool calls, before the next request) — keeping exactly one
  agent loop per session. `src/input.js` (`InputController`) is unit-tested.
  Phase 1: live capture is gated to auto-approve TTY (a normal turn needs stdin
  for permission prompts); echo/redraw and approval-mode input come next.
- Configurable agent-loop cap. The per-turn tool-iteration limit is now **50** by
  default (was a hard **20** that cut off large multi-file builds mid-task) and
  configurable via `--max-iterations N` / `CLAUDETTE_MAX_ITERATIONS`. On reaching
  it, an interactive session offers to keep going instead of silently stopping,
  and the stop message says how to continue or raise the limit.
- Cost controls. **Prompt caching** for Anthropic — native and via OpenRouter
  (`src/llm-config.js` + ephemeral cache breakpoints on the system prompt and the
  conversation tail; on by default, `CLAUDETTE_PROMPT_CACHE=0` to disable) — so the
  stable prefix isn't re-billed at full input price on every tool iteration / turn.
  **Sane `max_tokens`** default (16k; `CLAUDETTE_MAX_TOKENS`) on the OpenAI-
  compatible transport, so OpenRouter no longer reserves the model max (65k) per
  call (the cause of spurious `402`s). **Bash output cap** before it enters context
  (`CLAUDETTE_BASH_OUTPUT_CHARS`, default 16k, head+tail) so one large dump isn't
  re-sent every iteration. **Live cost meter**: per-turn `~$` in the assistant
  footer and an accurate `/cost` summary from real per-turn token metrics
  (`src/cost.js`; override prices with `CLAUDETTE_PRICES`). Tool-call lines now show
  one clean label (`Read`, not `Read [read_file]`).
- Per-turn session tracing in the CLI/TUI. A shared tracer (`src/trace.js`) records
  each turn into `session.turns[]` — status, model, expanded `@files`, token/
  duration metrics, and an ordered event log (`input_received` →
  `system_prompt_built` → `model_request_started` → `tool_call`/`tool_result` … →
  `assistant_completed`/`assistant_failed`). The web server was refactored onto the
  same tracer, so a past CLI session is now as debuggable as a server one. +offline
  regression test.
- Benchmark harness upgrades. **Request caching** (default-on, `--no-cache`):
  `provider.chatStream` hashes each request (model/messages/tools/effort, order-
  independent, callbacks excluded) into `bench/runs/.cache/` so re-runs and
  re-judging are free; writes are atomic (temp + rename) and a corrupt/missing
  entry degrades to a live call with a stderr warning instead of crashing.
  **Structured JSON IPC**: the harness drives `claudette.js --json-ipc`, which
  emits a pure JSONL event stream (`ready`/`turn`/`delta`/`tool_call`/
  `tool_result`/`assistant`/`done`/`error`) with no spinner/markdown/banner
  leakage, replacing terminal-glyph scraping. **YAML task definitions**
  (`bench/tasks/*.yaml`): a lossless YAML subset loader (`bench/tasks.js`) stores
  multi-line prompts as literal `|-` blocks, so exact-reproduction `str_replace`
  anchors are preserved byte-for-byte. +offline tests for all three (parser
  round-trip, cache key/atomicity/corruption, and the end-to-end IPC protocol).
- First-run setup via a gitignored `.env`: a zero-dependency loader (`src/env.js`)
  autoloads `.env` (package root → cwd → `~/.config/claudette`) before any module
  reads `process.env`; a real shell var always wins. Ships `.env.example`
  cataloging every provider key, and the "no models" message now walks you through
  `cp .env.example .env` + OpenRouter.
- Multi-provider model layer addressed `provider/model` (LiteLLM / terminal-bench
  style). New backends: OpenAI, DeepSeek, Groq, HuggingFace (bespoke modules) plus
  a provider catalog (`src/providers.js`) for OpenRouter, Together, Fireworks,
  Google Gemini, xAI Grok, Mistral, Cohere, and Perplexity — all sharing one
  OpenAI-compatible Chat Completions transport. Cloud models work with no local
  Ollama; OpenRouter reaches every major provider with a single key.
- Explicit CLI git workflow commands for feature branching, saving, publishing, and fast-forward updates.
- Benchmark harness support for multi-task model matrix runs from a single command.

### Changed
- Model addressing moved from the `anthropic:` colon prefix to canonical
  `provider/model` slashes (the `anthropic:` colon form is still accepted; bare
  names and `ollama/` route to local Ollama).
- `OPENAI_BASE_URL` / `OPENAI_API_BASE` no longer fall through to the Ollama base
  resolver — `OPENAI_BASE_URL` now configures the OpenAI provider. Use
  `OLLAMA_BASE_URL` / `OLLAMA_HOST` for Ollama.
- Benchmark credential fail-fast generalized from Anthropic to any cloud provider.
- `str_replace` failures now return targeted hints so models can retry with exact snippets copied from the file.

### Fixed
- Benchmark runs now wait for the CLI to finish task execution before sending `/exit`.
- Text-parsed `grep`-style tool calls are normalized to `search_code` so verification searches work reliably.
