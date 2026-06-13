# PERSIST

---

## Context

**Last Updated:** 2026-06-12
**Stage:** Cloud-first multi-provider — models addressed `provider/model`; backends for OpenAI/Anthropic/DeepSeek/Groq/HuggingFace (bespoke) + catalog (OpenRouter/Together/Fireworks/Google/xAI/Mistral/Cohere/Perplexity) over one OpenAI-compatible transport. Runs with no local Ollama (bench defaults + judge resolve cloud-first). Bench harness tuned; in-process eval loops for prompt/tool-usage testing; web dashboard for bench reports.
**Purpose:** Claudette is a multi-provider AI coding assistant CLI + web server (any major LLM provider or hosting platform; local Ollama optional)
**Structure:**
```
claudette.js      CLI entry point
server.js         HTTP API + static server
cli.js            Legacy CLI (uses server as backend)
src/
  env.js          Zero-dep .env parser/loader; env-autoload.js side-effect (first import in entry points)
  config.js       Ollama base URL resolver (OLLAMA_BASE_URL/OLLAMA_HOST; OPENAI_* no longer routed here)
  chat.js         Main REPL, agent loop, text tool-call parser
  tools.js        Tool definitions + executors (bash/read_file/write_file/str_replace/list_dir/search_code/fetch_url/patch_file)
  session.js      Session CRUD (data/sessions/*.json)
  context.js      CLAUDE.md loader, @file expansion
  ollama.js       Ollama API client (getModels, chatStream)
  anthropic.js    Anthropic Messages API client (native; anthropic/ + legacy anthropic:)
  openai.js       OpenAI adapter + shared OpenAI-compatible Chat Completions transport + provider factory
  deepseek.js     DeepSeek adapter (deepseek/) — reuses openai.js transport
  groq.js         Groq adapter (groq/, hosted Llama) — reuses openai.js transport
  huggingface.js  HuggingFace router adapter (hf/) — reuses openai.js transport
  providers.js    Catalog of OpenAI-compatible providers (OpenRouter/Together/Fireworks/Google/xAI/Mistral/Cohere/Perplexity)
  provider.js     Registry router: provider/model -> backend; bare/ollama/ -> Ollama; missingCredential()
  ui.js           ANSI terminal rendering, spinner
bench/            Benchmark harness (run.js, worktree runs, reports) + evals.js in-process eval loops + evals/ cases
data/sessions/    Persisted session JSON files
public/           Web UI (index.html, styles.css, app.js, bench.html dashboard)
test/test.js      Comprehensive test suite + config coverage
```

---

## History

| Date | Agent | Action |
|------|-------|--------|
| 2026-04-17 | Claude | Benchmarked `deepseek-coder-v2:16b` (avg 9.25) and `qwen2.5-coder:14b` (avg 9.12) on all 6 tasks via remote g5.xlarge; both already installed. `add-new-tool` scores 8.9 on both — judge penalty only (edit succeeds but verification cmd fails). |
| 2026-04-18 | Claude | Full benchmark round on 8 tasks × 2 models. Committed `claudette.js` to git (was untracked, causing ENOENT in all worktrees). Hardened system prompt (thoroughness/editing/reliability sections, str_replace recovery hints). Added agent loop RECOVERY hints on tool errors. Final scores: tool-roundtrip=10, edit-two-timeouts=10, health-check=10, add-no-color-flag=10 (both models). count-lines-tool=3.6/5.3, extract-print-help=4.3/4.3 — hard ceiling for 14-16B models on multi-step exact-reproduction tasks. |
| 2026-04-18 | Codex | Restarted the AWS Ollama g5.xlarge, verified installed models (`deepseek-coder-v2:16b`, `qwen2.5-coder:14b`, `qwen2.5-coder:7b`), and ran a fresh 3-task comparison. All three hit the same 5.3 hard-score ceiling on `count-lines-tool`; `extract-print-help` stayed weak (DeepSeek 4.0, Qwen 14B/7B 3.2); `add-no-color-flag` passed strongly (DeepSeek 10, Qwen 14B 9.2, Qwen 7B 8.8). |
| 2026-04-18 | Codex | Added `bench/leaderboard.js`, `npm run bench:leaderboard`, and generated `bench/LEADERBOARD.md` from the latest benchmark report per model/task pair. |
| 2026-04-18 | Claude | Added live token streaming (`onDelta` in agentLoop), `read_file` offset/limit line-range params, and context-size warning at ~25k tokens. Inspired by Claude Code reference. |
| 2026-05-30 | Claude | Added Anthropic provider: `src/anthropic.js` (Messages API client w/ SSE streaming, tool_use/tool_result translation, synthesized tool ids) + `src/provider.js` router (`anthropic:` prefix → Anthropic, else Ollama). Wired CLI + web server through the router; `--model anthropic:claude-opus-4-8` now works. +10 tests. |
| 2026-05-30 | Claude | Benchmark harness multi-provider: judge routes through the provider (`--judge anthropic:*` works, no local Ollama needed when agent+judge are both cloud); fail-fast guard when an `anthropic:*` model is requested without `ANTHROPIC_API_KEY`. Documented running Opus 4.8 on the `count-lines-tool`/`extract-print-help` ceiling tasks. |
| 2026-06-01 | Claude | Landed the floating feature stack into `main` (PR #6). `main` had diverged onto a parallel, superseded line (`ed429f4`); merged it with `-s ours` so the active trunk's tree wins and `main` becomes an ancestor, then preserved its 3 unique artifacts (`Changelog.md` + `admin-hardening`/`permission-prompt-shortcut` bench tasks). Closed superseded PR #5; removed the stale `.ship-worktree` pinning old `main`. Tests pass except the env-dependent `GET /api/models` (needs a live provider). |
| 2026-06-01 | Claude | Multi-provider expansion: `provider/model` slash addressing; bespoke OpenAI/DeepSeek/Groq/HuggingFace adapters over one OpenAI-compatible transport (`src/openai.js`) + catalog (`src/providers.js`: OpenRouter/Together/Fireworks/Google/xAI/Mistral/Cohere/Perplexity). Registry router; `missingCredential()` guard. `OPENAI_BASE_URL` no longer routes Ollama (collision fix in config.js). Cloud-first (no Ollama needed). +18 tests. Researched terminal-bench, lm-eval-harness, HELM, KIRA, opencode for design (see TODO). Merged PR #8. |
| 2026-06-01 | Claude | Usability: zero-dep `.env` autoloader (`src/env.js` + `src/env-autoload.js`, first import in claudette.js/server.js/bench/run.js so keys land before config.js reads env). `.env.example` catalogs all provider keys (OpenRouter highlighted); `.env` gitignored; "no models" onboarding message walks through setup. +3 tests; README Setup section. |
| 2026-06-12 | Claude | Repo hygiene (PR #10): gitignored `tmp/`/`test_prompts.txt`/`.claude/settings.local.json` (untracked the latter — per-machine state), committed docs/validation-summary.html. Bench dashboard (PRs #11-#12): committed long-floating `public/bench.html` (renders GET /api/bench), sidebar link, de-staled gemma4 branding, +2 endpoint tests. |
| 2026-06-12 | Claude | Cloud-first bench defaults + SSE hang fix (PR #13): providers declare `DEFAULT_MODELS` (anthropic/claude-opus-4-8 + sonnet judge; openai/gpt-4o + 4o-mini judge); `defaultCloudModels()` in provider.js; bench agent/judge defaults resolve cloud-first, Ollama fallback w/ 3s timeout. Fixed server stream hang: provider error after SSE headers left responses open forever (this is what stalled the test suite ~9min on no-provider machines) — stream now ends with `{type:'error'}` + failed traceTurn; regression test vs dead Ollama port. |
| 2026-06-12 | Claude | Prompt/tool-usage eval loops (PR #14): `bench/evals.js` runs declarative cases (`bench/evals/*.json`) through an in-process agent loop in a tmp sandbox; expectations = ordered tool-call subsequence w/ arg matchers (string=substring), forbidden tools, file post-state, answer regex; `--repeat` → pass@k/pass^k for flakiness. chatFn injectable → 7 offline tests w/ scripted mock model. `parseTextToolCalls` now a public chat.js export. Suite on no-provider machine: 125 pass / 32 env-dependent fails (live provider needed: /api/models, streaming, interactive CLI, stress). |
| 2026-06-12 | Claude | TUI fixes from live OpenRouter use (PR #16): streamed responses now render markdown — `createMarkdownStream()` in ui.js line-buffers deltas through the (now stateful, shared) line renderer so fences/bold/bullets style correctly mid-stream (line-by-line, not token-by-token); gated tool calls print once (agentLoop skips its ⏺ line via `needsApproval()` when the permission prompt will render its own). +4 offline tests; verified live vs openrouter/openai/gpt-4o-mini. User runs OpenRouter (`openrouter/anthropic/claude-opus-4.8` — note OpenRouter slugs use dots; bare `anthropic/...` needs ANTHROPIC_API_KEY). |
| 2026-06-12 | Claude | CLI credential guard (PR #18): explicit `--model` whose provider lacks a key now fails at startup (before the banner) via `missingCredential()`, with `suggestCredentialFix()` pointing at the `openrouter/` route when an OpenRouter key is present. Fixes recurring "anthropic/* needs ANTHROPIC_API_KEY" confusion (cwd is irrelevant — `.env` resolves from code location). +3 tests. |
| 2026-06-12 | Claude | Reasoning effort + bypass (PR #19): `--effort`/`/effort`/`CLAUDETTE_EFFORT` (low\|medium\|high\|xhigh\|max), plumbed only-when-set → Anthropic `output_config.effort`, OpenRouter catalog nested `reasoning.effort`, OpenAI-compatible flat `reasoning_effort`; shown in banner/`/config` + system prompt so the model can report it. Bypass: `--yolo`/`--bypass`/`--dangerously-skip-permissions`/`-y` + `CLAUDETTE_AUTO_APPROVE` env + `/yolo` toggle; `resolveAutoApprove()` pure helper. +12 tests. |
| 2026-06-12 | Claude | Project-scale bench tasks (PR #20): new `project` category in bench/tasks — `notes-app-nextauth-postgres` (Next.js+NextAuth Google+Prisma/Postgres), `express-postgres-crud-api`, `fastapi-sqlite-todo`. Structural verify (files + manifest deps + node --check/py_compile + wiring greps, no installs) + LLM judge. `npm run bench:projects`. |
| 2026-06-12 | Claude | Fixed stale package.json description ("backed by Ollama" → terminal CLI + browser UI, Ollama + 13+ cloud providers), matching the updated GitHub repo description. Uncommitted on `feature/effort-and-bypass`. |
| 2026-06-12 | Codex | Designed queued follow-ups and mid-run steering: live input, FIFO safe-boundary injection, interruption semantics, state model, tests, and phased rollout in `docs/queued-followups-plan.md`. |
| 2026-06-12 | Codex | Designed model-agnostic parallel subagents: read-only fan-out/fan-in first, reusable agent runner, lifecycle manager, queue integration, then worktree editing and agent teams in `docs/parallel-subagents-plan.md`. |
| 2026-06-12 | Antigravity | Scoped benchmark and evaluation harness; generated detailed scoping report artifact. |
| 2026-06-12 | Claude | Hardened bench harness upgrades on `feature/harness-upgrades`: extracted side-effect-free `bench/tasks.js` w/ literal-block YAML loader, re-migrated all 20 tasks to round-trip the original JSON exactly (fixes folded-scalar prompt corruption that collapsed str_replace anchors); clean JSONL `--json-ipc` (gated spinner/markdown/banner/goodbye); `buildWorkflowSummary` now parses JSON events; cache hardened (stable order-independent key, atomic temp+rename writes, corrupt/miss → live call w/ warning). +10 offline tests (parser round-trip, cache, end-to-end IPC). Suite: 165 pass / 15 env-dependent fails. Docs: Changelog, bench/README, model-attribution convention in CLAUDE.md+AGENTS.md. |
| 2026-06-12 | Claude | TUI session logging (`feature/tui-session-logging`): extracted a shared turn/event tracer `src/trace.js` from server.js, refactored the server onto it, and wired it into the chat.js agent loop so CLI sessions now record `session.turns[]` (status/model/metrics/events: input_received→model_request_started→tool_call/tool_result→assistant_completed\|failed), matching the web server. `session.js` seeds `turns:[]`. +offline test asserting a mock-Ollama CLI tool-loop turn records the events + token/duration metrics. |
| 2026-06-12 | Claude | Cost controls (`feature/cost-savings`, stacked on logging): Anthropic prompt caching (native + OpenRouter `cache_control` on system prompt + conversation tail, default-on via `src/llm-config.js`); sane `max_tokens` default 16k on the OpenAI-compatible transport (fixes OpenRouter reserving model-max 65k → spurious 402s); `capBashOutput` caps bash tool output (head+tail) before it re-enters context each iteration; live cost meter (`src/cost.js` pricing + per-turn `$` in footer + accurate `/cost` from trace metrics); removed duplicate tool-call labels (`Read`, not `Read [read_file]`). +offline tests (cache breakpoints, pricing, max_tokens, bash cap). Suite 162 pass / 15 pre-existing env fails. |
| 2026-06-12 | Claude | Iteration cap (PR #26): `resolveMaxIterations` — default 50 (was hard 20), `--max-iterations`/`CLAUDETTE_MAX_ITERATIONS`; on the cap an interactive TTY offers to keep going (continues same turn+trace). +test. |
| 2026-06-12 | Claude | Queued follow-ups Phase 1 (`feature/queued-followups`): `src/input.js` `InputController` (FIFO enqueue/drain/list/clear + `buildFollowUpMessage`); `agentLoop` drains the queue at safe boundaries (after tool iterations + at would-be completion) into one steering user message and continues the same turn (one loop/session); live raw-mode capture in a turn wrapper gated to auto-approve TTY (avoids permission-prompt stdin conflict); `/queue` + `/queue clear`. +offline tests for the queue brain. Suite 177 pass / 15 env fails. Phase 2: echo/redraw, approval-mode input, interrupt/redirect. |

---

## Commands

| Command | Description |
|---------|-------------|
| `node claudette.js` | Start CLI (auto-selects best available model) |
| `node claudette.js --model <name>` | Start CLI with specific model |
| `node claudette.js --model openrouter/anthropic/claude-opus-4.8` | Run latest Opus through OpenRouter (user's key; OR slugs use dots) |
| `node claudette.js -y` / `--yolo` / `--bypass` | Start CLI with auto-approve for all tool calls (or set `CLAUDETTE_AUTO_APPROVE=1`) |
| `node claudette.js --effort <low\|medium\|high\|xhigh\|max>` | Set reasoning effort (or `CLAUDETTE_EFFORT`; `/effort` at runtime) |
| `node server.js` | Start web server on port 4321 |
| `NODE_ENV=test node --test test/test.js` | Run full test suite (~45-90s; spawns server+CLI subprocesses. Run ONE at a time — server tests bind fixed port 14322, so concurrent runs conflict) |
| `OLLAMA_BASE_URL=http://localhost:11434 node claudette.js --model gemma4:latest` | Point CLI at the SSH-tunneled Ollama endpoint explicitly |
| `npm run bench:gemma` | Run all benchmark tasks against gemma4 with live output |
| `npm run bench -- --task <id> --model gemma4:latest --verbose` | Run one task with live output |
| `node bench/run.js --task <id> --model gemma4:latest --model qwen2.5-coder:14b` | Compare multiple installed models on the same task |
| `npm run bench -- --task <id> --model gemma4:latest --repeat 3` | Stress-test a task N times |
| `npm run bench -- --task <id> --model gemma4:latest --keep` | Keep worktree for post-mortem |
| `npm run bench:list` | List all benchmark tasks |
| `npm run bench:projects -- --model <provider/model>` | Run the project-scale build-a-whole-app suite (notes-app, express CRUD, fastapi, fullstack) |
| `npm run bench:leaderboard` | Regenerate `bench/LEADERBOARD.md` from the latest report file for each model/task pair |
| `npm run eval -- --all --model <provider/model>` | Run all prompt/tool-usage eval cases (in-process, fast; no worktree) |
| `npm run eval -- --case <id> --repeat 5` | Flakiness loop on one eval case (pass@k / pass^k) |
| `npm run eval:list` | List eval cases (`bench/evals/*.json`) |
| `NODE_ENV=test node --test --test-name-pattern "<pattern>" test/test.js` | Run a targeted slice of the suite (fast; skips other suites' bodies) |
| `node bench/run.js --all --model qwen3.5:0.8b` | Run the full installed-model benchmark sweep used for the current passing scores |

---

## TODO

### Outstanding Tasks
- `count-lines-tool` and `extract-print-help` stuck at 4-5/10 — need 32B+ model or structured-task shortcut to improve.
- Port bench harness to Windows machine at 192.168.0.178 (Node/Ollama/bash already installed) — use remote EC2 Ollama via SSH tunnel.
- Re-run full benchmark matrix after any model upgrade.

### Feature Ideas

**Audit priorities (2026-06-12):**
- Security: bind the web server to loopback by default or add authentication; remove the production exact-bash benchmark shortcut; make `glob` shell-free; enforce realpath/symlink workspace boundaries.
- Privacy: add transcript/session recording controls, redaction, retention, deletion, and a clear startup indicator.
- Architecture: move the web server onto the shared provider/session/context/agent core so every provider and tool workflow behaves consistently across CLI and browser.
- Reliability: add request/body limits, provider timeouts/retries, client-disconnect cancellation, atomic session writes, and concurrent-turn protection.
- Product: position Claudette as a multi-provider coding-agent workbench; make the browser a real tool-capable agent or describe it explicitly as a chat/trace dashboard.
- Interaction: implement `docs/queued-followups-plan.md` — live prompt during execution, visible FIFO follow-ups injected at safe model/tool boundaries, interrupt/redirect, then background Bash and browser parity.
- Parallel agents: implement `docs/parallel-subagents-plan.md` — extract a reusable runner, add capped read-only subagents, then isolated worktree editing and eventually peer-coordinated teams.

**Multi-provider roadmap (from terminal-bench / lm-eval-harness / HELM / KIRA / opencode research):**
- _Highest leverage (opencode):_ consider building the model layer on the Vercel AI SDK provider packages + Models.dev metadata, with `@ai-sdk/openai-compatible` as the generic BYO-endpoint path — collapses most hand-maintained provider code and gives 75+ providers + model limits/cost for ~free.
- Split secrets out of env/config into a credentials store + interactive `claudette auth login` (provider menu, OAuth *and* pasted keys). Anthropic Claude-subscription OAuth worth supporting.
- `$schema` JSONC config, deep-merged global→project, with `{env:VAR}` substitution; `small_model` slot for cheap auxiliary calls (judge titles/summaries) to cut bench cost.
- Per-provider config: `baseURL`/`apiKey`/`headers` + capability flags (`supportsTools`, `chatOnly`, pricing) + `concurrency`/`maxRetries`/`timeout` with exponential backoff (lm-eval).
- Permissions map (`allow`/`ask`/`deny`, glob-matched bash, last-match-wins, per-agent merge) + `external_directory` guard (opencode).
- **Bench harness upgrades (Scoped 2026-06-12):**
  - *Phase 1 (Robustness & Caching):* Request caching (local `.cache/` hash map) for deterministic/free re-judging; robust subprocess communication via structured IPC/JSON protocol instead of terminal prompt token regex; task-level custom idle timeouts.
  - *Phase 2 (Granularity):* Track token counts/cost/durations per run; multi-metric result vector (correctness, cost-efficiency, speed) in reports and leaderboard.
  - *Phase 3 (DX & Orchestration):* Migrate to YAML task definitions (allows clean multi-line blocks); tag/suite grouping and filtering; resumable execution for interrupted runs.
- **Agent loop (KIRA):** per-step token+cost trajectory; two-phase "are you sure?" completion gate with a test/QA/user checklist (reusable as a judge rubric); graceful context-overflow fallback (summarize → minimal-context retry); structured `analysis`/`plan` fields inside the action tool schema.
- Adopt opencode's one-server-many-clients shape: OpenAPI spec + SSE events; `--attach` a warm server for the bench harness to skip per-prompt boot.
