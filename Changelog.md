# Changelog

## [Unreleased]

### Added
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
