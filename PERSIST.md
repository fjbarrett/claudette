# PERSIST

---

## Context

**Last Updated:** 2026-08-10
**Stage:** Cloud-first multi-provider with a shared, terminal-free agent loop (`src/agent-runner.js`) used by the CLI and the eval harness. Models addressed `provider/model`; backends for OpenAI/Anthropic/DeepSeek/Groq/HuggingFace (bespoke) + catalog (OpenRouter/Together/Fireworks/Google/xAI/Mistral/Cohere/Perplexity) over one OpenAI-compatible transport. Provider calls retry with backoff and abort on stall. CI on Node 20/22/24.
**Purpose:** Claudette is a multi-provider AI coding assistant CLI + web dashboard (any major LLM provider or hosting platform; local Ollama optional)
**Structure:**
```
claudette.js      CLI entry point (-p headless, --continue/--resume, --json-ipc)
server.js         HTTP API + static server (chat + trace dashboard; no tools yet)
cli.js            Legacy CLI (uses server as backend)
src/
  env.js          Zero-dep .env parser/loader; env-autoload.js side-effect (first import in entry points)
  config.js       Ollama base URL resolver (OLLAMA_BASE_URL/OLLAMA_HOST; OPENAI_* no longer routed here)
  agent-runner.js THE agent loop — headless, hook-driven (emit/onDelta/approve/takeFollowUps/onMaxIterations).
                  Owns iteration cap, act nudge, verify gate, payload trim, orphan-tool-message repair
  chat.js         REPL + slash commands; a terminal/permission/session shell around runAgent()
  tool-call-parser.js  Text-emitted tool-call parsing + per-tool arg alias tables
  tools.js        Tool definitions + executors (bash/read_file/write_file/str_replace/list_dir/search_code/fetch_url/patch_file)
  retry.js        Retry policy, backoff+jitter, Retry-After, stall watchdog, provider error shaping
  fs-atomic.js    writeFileAtomic (temp + rename)
  completion.js   Tab completion for slash commands and @paths
  session.js      Session CRUD (data/sessions/*.json) + archiveMessages -> sessions/archive/
  context.js      CLAUDE.md loader, @file expansion, trimToolOutputs
  transcript.js   Derived text transcripts, throttled + flushable
  ollama.js       Ollama API client (getModels, chatStream)
  anthropic.js    Anthropic Messages API client (native; anthropic/ + legacy anthropic:)
  openai.js       OpenAI adapter + shared OpenAI-compatible Chat Completions transport + provider factory
  deepseek.js     DeepSeek adapter (deepseek/) — reuses openai.js transport
  groq.js         Groq adapter (groq/, hosted Llama) — reuses openai.js transport
  huggingface.js  HuggingFace router adapter (hf/) — reuses openai.js transport
  providers.js    Catalog of OpenAI-compatible providers (OpenRouter/Together/Fireworks/Google/xAI/Mistral/Cohere/Perplexity)
  provider.js     Registry router + retry/stall wrapper; bare/ollama/ -> Ollama; missingCredential()
  ui.js           ANSI terminal rendering, spinner (silent under --json-ipc and -p)
bench/            Benchmark harness (run.js, worktree runs, reports) + evals.js (now runs the SHARED loop) + evals/ cases
                  + harbor/ (Terminal-Bench adapter)
data/sessions/    Persisted session JSON files; archive/ holds pre-compaction history
public/           Web UI (index.html, styles.css, app.js, bench.html dashboard)
test/test.js      Test suite (289 tests, all passing); live-model suites auto-discover an Ollama model and skip without one
.github/workflows/ci.yml  Offline suite on Node 20/22/24 + bench-task validation
```

---

## History

| Date | Agent | Action |
|------|-------|--------|
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
| 2026-06-13 | Claude | Log-driven context+input hardening (`feature/context-management`), all grounded in `data/usage/usage.jsonl` (28 turns: 30:1 in:out, 4 turns >500k input, max 1.73M, 6 turns ≥50 tools, 3 failed): `trimToolOutputs` (collapse old tool outputs in payload, keep 6); `maybeAutoCompact` (summarise history >60k, `CLAUDETTE_AUTO_COMPACT`); iteration cap 50→150; idle-prompt paste coalescing (`createBurstReader`+`readCoalescedPrompt` — joins readline's per-newline burst); `sanitizeUserInput` (strip ANSI + cut single line at leaked ⏺/⎿ glyphs); usage-log signals `iterations`/`hitToolCap`/`compacted`; `explainStreamError` (clear msg for bad model id — logs showed `gpt-54-mini` failing opaquely). Eval harness instrumented (trim toggle `--no-trim`, token columns) + `context-stress-reads` case. Live A/B on gpt-5-nano: trim ON peak 7.5k/total 58k vs OFF 11.5k/68k (−35% peak, −15% total), both pass. +9 offline tests, fixed phantom `/help` assertion. Suite 200 pass / 14 env fails. Reviewed docs plans → both KEEP (queued-followups Phase 2-4 + parallel-subagents unstarted). |
| 2026-06-13 | Claude | Results/behavior fixes (same branch) after session transcripts showed the real "bad results" cause: a turn made 128 tool calls, first edit at #109, **69% of reads redundant** (one file 23×). Added: per-turn **re-read guard** (`read_file` short-circuits identical unchanged re-reads via `readCache`); anti-over-exploration system prompt (+ renamed "Ollama Code"→"Claudette"); **action-forcing nudge** (`createActNudger`, default 15 read-only calls, `CLAUDETTE_ACT_NUDGE`; failed actions don't reset); `explainStreamError` for bad model ids. Fixed (found via live testing): piped-input dropped on EOF + `rl.resume()` crash when stdin closes mid-turn; `list_dir` empty-path throw. **Live-verified on gpt-5-nano**: nudge fired→model edited; realistic CSS-fix task succeeded cleanly. Logs confirm guard fired 6×, redundant reads 69%→14-29% on most turns. Suite 207 pass / 14 env fails. |
| 2026-07-05 | Claude | **Harbor adapter — claudette on Terminal-Bench 2.0.** New `bench/harbor/` Python pkg (`claudette_harbor:Claudette`, BaseInstalledAgent): installs claudette in the task container from a GitHub tarball ref (`--agent-kwarg version=<ref>`), drives it via piped one-line `--json-ipc` prompt, tees JSONL to `/logs/agent/`, reports tokens from `done`. Two claudette fixes shipped with it: guarded `rl.pause()` (piped one-shot died "readline was closed" mid-turn) + `done` event now reports accumulated turn usage split into promptTokens/completionTokens. **First run: `openssl-selfsigned-cert` reward 1.0** (gpt-5-nano, 3m11s, 99.7k in/16.7k out, 25 iterations, 0 exceptions). Setup: `uv venv .venv-harbor && uv pip install -p .venv-harbor -e bench/harbor`. Note: registry serves terminal-bench@2.0 (89 tasks); 2.1 not published there yet. Observation: verify-gate burns ~10 iterations hunting for a build in non-npm task dirs — candidate tuning for benchmark runs. Suite 217/14. |
| 2026-07-05 | Claude | **Repo repair + bench harness re-validated.** `.git/objects` had been lost (repo copied ~Jun 29 without it; git fully broken, bench worktrees impossible). Restored: recreated objects dir, cleared dangling refs/reflogs (backed up first), fetched from origin (origin/main = old branch point 5e8072c, nothing upstream lost). The 5 feature commits' history was unrecoverable but content survived in the working tree → recommitted as one commit `2b9cb6b` on `feature/context-management`, pushed to origin (first push of this branch). Bench harness then verified end-to-end on OpenRouter gpt-5-nano: eval `bash-echo` pass; full bench `targeted-edit` hard=10 judge=8 overall=9.2 (worktree+IPC+verify+judge+report+cleanup all working); leaderboard regenerated. Note: only OPENROUTER_API_KEY is set and OpenRouter has no DEFAULT_MODELS, so `--model`/`--judge` must be passed explicitly. File mtimes were rewritten by the Jun 29 copy — don't trust `ls -t` on old artifacts. |
| 2026-07-13 | Codex | Captured the repo-review hardening work as a prioritized follow-up for later. |
| 2026-08-10 | Claude | Full-program review for next development. Suite re-run: **219 pass / 13 fail**. Reproduced 3 new defects live (unapproved shell via `@file` content through the exact-bash shortcut; `role:'tool'` with no `tool_calls` → provider 400 poisoning the session; `--json-ipc` drops all prompts after the first) + found the `alwaysAllow` bash-key dead code. Logged them plus the structural gaps in TODO. |
| 2026-08-10 | Claude | **Acted on the whole review.** Security: removed the exact-bash prompt→shell bypass (and rewrote the 2 bench tasks that depended on it as real task descriptions); scoped bash "always" approval to the exact command. Fixed: orphan-`tool`-message session poisoning (`dropOrphanToolMessages` on every payload), `--json-ipc` dropping prompts 2..N (`createLineQueue`), lossy compaction (archives to `sessions/archive/` first), non-atomic session writes (`fs-atomic.js`), O(n²) transcript rewrites (throttled + flushed). Structural: extracted **`src/agent-runner.js`** — headless hook-driven loop now shared by chat.js and bench/evals.js (the bench had been measuring a different agent); text parser split to `tool-call-parser.js`. Reliability: `src/retry.js` — backoff+jitter, Retry-After, no retry after streaming starts, stall watchdog (never an AbortError). Added `-p` headless, `--continue`/`--resume`, Tab completion, `npm test`/`test:live`, GitHub Actions CI (Node 20/22/24). Tests: **288 total**; rewrote the `normalizeArgs` tests that asserted against an inlined copy; live suites now discover an Ollama model (smallest tool-capable) and skip cleanly without one — they had hardcoded the uninstalled `llama3.2:latest` and could never pass. Removed root scratch (`fib.py`, `hello.py`, `hello.html`, `console-script.js`, `ollama-code.js`); kept `GEMINI.md` (agent config) and `check_precision.sh` (ops script). |

---

## Commands

| Command | Description |
|---------|-------------|
| `.venv-harbor/bin/harbor run -d terminal-bench@2.0 -a claudette_harbor:Claudette -m openrouter/openai/gpt-5-nano --agent-kwarg version=<git-ref> -i <task> -o bench/runs/harbor -n 1` | Run claudette on Terminal-Bench via Harbor (push ref first; omit `-i` for all 89 tasks) |
| `uv venv .venv-harbor && uv pip install -p .venv-harbor -e bench/harbor` | One-time Harbor adapter setup |
| `node claudette.js` | Start CLI (auto-selects best available model) |
| `node claudette.js --model <name>` | Start CLI with specific model |
| `node claudette.js --model openrouter/anthropic/claude-opus-4.8` | Run latest Opus through OpenRouter (user's key; OR slugs use dots) |
| `node claudette.js -y` / `--yolo` / `--bypass` | Start CLI with auto-approve for all tool calls (or set `CLAUDETTE_AUTO_APPROVE=1`) |
| `node claudette.js --effort <low\|medium\|high\|xhigh\|max>` | Set reasoning effort (or `CLAUDETTE_EFFORT`; `/effort` at runtime) |
| `node server.js` | Start web server on port 4321 |
| `npm test` | Offline suite (~60s) — what CI runs; no provider key, no Ollama. Spawns server+CLI subprocesses; ports are allocated dynamically now, so parallel runs are safe |
| `npm run test:live` | Adds the `Stress:` cases against a real local Ollama model (auto-discovered). Slow — a 27B model makes it a ~40-min run |
| `node claudette.js -p "<prompt>"` | Headless: one prompt, print the answer, exit (non-zero if the turn failed). Add `-y` to auto-approve tools |
| `node claudette.js --continue` / `--resume <id>` | Reattach to the newest / a specific saved session at launch |
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

**Done 2026-08-10** (see Changelog `[Unreleased]`): exact-bash bypass removed (both the
unapproved-exec and the orphan-`tool`-message session poisoning), per-command bash
approval, `--json-ipc` multi-prompt fix, `src/agent-runner.js` extraction (+ evals.js
migrated onto it), provider retry/backoff/stall, atomic session writes, throttled
transcripts, non-destructive compaction, `-p`/`--continue`/`--resume`, Tab completion,
`npm test` + CI, live-test model discovery, dynamic test ports. **Suite 289/289 green including live tests** (277 offline).

**Next, in order:**
- **MCP client.** Nine hardcoded tools vs. the whole ecosystem — the largest single
  capability jump available. stdio + SSE transports, tool discovery, schema translation.
- **Browser parity.** `server.js` still streams chat with no tools and duplicates
  session storage, @file expansion, and the system prompt instead of using
  `src/session.js` / `src/context.js` / `runAgent`. Now unblocked by the extraction.
- **Subagents** — `docs/parallel-subagents-plan.md` Phase 2+; Phase 1 (reusable runner) is done.
- **Queued follow-ups Phase 2** — `executeTool` takes a `signal` now but ignores it;
  wire it to `execFile`/`fetch` so Ctrl+C interrupts a foreground command, and set the
  `'approval'` input mode so typing during a permission prompt queues instead of answering.
- Persisted permission rules (allow/ask/deny globs per project). `alwaysAllow` is still
  an in-memory Set that dies with the process.
- Before public 1.0: make `glob` shell-free; enforce realpath/symlink workspace
  boundaries; add request/body limits to the unauthenticated server; rebaseline the
  benchmark (the two shortcut tasks are now honest task descriptions and will score
  lower until models actually do the work).
- `count-lines-tool` and `extract-print-help` were 4-5/10 *with* a shortcut that did the
  work for them; expect a fresh, lower baseline.
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
