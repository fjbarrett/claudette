# PERSIST

---

## Context

**Last Updated:** 2026-09-20
**Stage:** Full code/security review remediated; continuous Code/farm and Ollama-cloud coding bakeoff active. CLI/library/server/evals share one agent loop; browser runs it tool-less and shares private atomic session/context infrastructure. macOS CLI runs inside a workspace Seatbelt profile while a minimal launcher brokers each Bash command over authenticated direct child IPC into exactly one stricter profile; protections remain under `--yolo`. Model Bash automatically activates a canonical workspace `.venv`/`venv`; outbound Bash is loopback-only unless explicitly enabled with `--network`, which retains the remaining boundaries. Default model policy is free/native-tool only, provider-aware rotation is capped at 2, and same-session `/model` switching preserves history. Remote web binds require bearer+Host configuration. CI targets Node 20/22/24; hermetic suite is 542 tests (540 pass/0 fail/2 live skips measured 2026-09-20). The Aug-Sep hardening tree landed 2026-09-20 as 3 local commits on feature/review-hardening (tooling/gates, functional core, docs), each verified isolated-green, NOT pushed. All seven installed Ollama Cloud models passed Scanner's full 294-test validation gate; a five-worker Farm matrix then ran all 11 shipped eval cases per model, led by Kimi and DeepSeek at 11/11.
**Purpose:** Claudette is a multi-provider AI coding assistant CLI + web dashboard (any major LLM provider or hosting platform; local Ollama optional)
**Structure:**
```
claudette.js      CLI entry point (-p headless, --continue/--resume, --json-ipc)
server.js         Authenticated HTTP/NDJSON adapter + static server; shared runner with tools=[] and shared sessions/context
src/
  env.js          Zero-dep trusted config loader; never implicitly consumes the target workspace .env
  config.js       Ollama base URL resolver (OLLAMA_BASE_URL/OLLAMA_HOST; OPENAI_* no longer routed here)
  agent-runner.js THE agent loop — headless, hook-driven (emit/onDelta/approve/takeFollowUps/onMaxIterations).
                  Owns iteration/repeat caps, act nudge, verify/completion gates, Bash mutation detection, payload trim
  evidence.js     Shared review guidance, discovery/check classification, and Bash evidence notes
  streaming.js    Shared UTF-8/SSE framing, strict stream records and reader cleanup
  bash-broker.js  Authenticated direct parent/child IPC for launcher-owned, single-profile model Bash
  bash-process.js  Bounded foreground capture, POSIX command-group cancellation/deadlines and explicit stop causes
  chat.js         REPL + slash commands; terminal/permission/session shell around runAgent(); sequential `/interrupt` redirects
  tool-call-parser.js  Text-emitted tool-call parsing + per-tool arg alias tables
  tools.js        Tool definitions/executors; symlink-aware boundary, brokered Bash, pinned/bounded fetch, shell-free glob
  workspace-sandbox.js / workspace-path.js  macOS outer profile plus canonical workspace/cwd guards
  state-paths.js  Relocates persistent state below sandboxed workspace when launched through the CLI
  retry.js        Retry policy, backoff+jitter, Retry-After, stall watchdog, provider error shaping
  model-policy.js Default-on free-tier/native-tools/usage-tracking policy and rejection guidance
  fs-atomic.js    Private atomic writes with bounded temporary basenames
  completion.js   Tab completion for slash commands and @paths
  clipboard.js    Native clipboard writes + last assistant message selection for /copy
  session.js      Ordered private session saves + collision-free archives -> sessions/archive/
  context.js      Instruction-file identity cache with fresh ancestry; @file expansion and trimToolOutputs
  transcript.js   Derived text transcripts, throttled + flushable
  ollama.js       Ollama API client (getModels, chatStream); num_ctx via CLAUDETTE_NUM_CTX (default 32k)
  anthropic.js    Anthropic Messages API client (native; anthropic/ + legacy anthropic:)
  openai.js       OpenAI adapter + shared OpenAI-compatible Chat Completions transport + provider factory
  deepseek.js     DeepSeek adapter (deepseek/) — reuses openai.js transport
  groq.js         Groq Free adapter (groq/, live GPT-OSS/Qwen allowlist, 1K output reservation) — reuses openai.js transport
  huggingface.js  Hugging Face router adapter (hf/, live zero-price native-tool providers only) — reuses openai.js transport
  providers.js    Catalog of OpenAI-compatible providers (OpenRouter/Together/Fireworks/Google/xAI/Mistral/Cohere/Perplexity)
  provider.js     Registry router + retry/stall + ranked/provider-aware/request-fit free-tool rotation; bare/ollama/ -> Ollama
  ui.js           ANSI terminal rendering + managed model/activity/input footer (silent under --json-ipc and -p)
bench/            Benchmark harness (run.js, worktree runs, reports) + evals.js (now runs the SHARED loop) + evals/ cases
                  + harbor/ (Terminal-Bench adapter)
data/sessions/    Persisted session JSON files; archive/ holds pre-compaction history
public/           Web UI (index.html, styles.css, app.js, bench.html dashboard)
scripts/check-syntax.js  Git-aware JS/MJS/CJS syntax checks used by npm and CI
scripts/run-tests.mjs  Portable offline/live test launcher with native coverage and failure/signal propagation
tsconfig.types.json + test/types/api.ts  Strict public declarations/consumer contract; locked dev-only compiler
scripts/stress-streams.mjs  Continuous or finite seeded transport testing with per-batch logs and environment variation
scripts/test-native-clipboard.swift + .mjs  Opt-in macOS clipboard/CLI integration with in-memory clipboard restoration
docs/testing-2026-09-05.md  Stress-test results, defects fixed, and remaining model-quality failures
test/test.js + streaming.test.js + filesystem.test.js + tooling.test.js + shell.test.js  533 tests; sandbox, transport, persistence, verification and shell stress
docs/cloud-model-benchmark.md  Living cloud-model matrix, fixed scenarios, scoring, and iteration evidence
AGENTS.md         Single source for agent conventions; CLAUDE.md and GEMINI.md point at it
.github/workflows/ci.yml  Offline suite on Node 20/22/24 + bench-task validation
```

---

## History

| Date | Agent | Action |
|------|-------|--------|
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
| 2026-07-05 | Claude | **Repo repair + bench harness re-validated.** `.git/objects` had been lost (repo copied ~Jun 29 without it; git fully broken, bench worktrees impossible). Restored: recreated objects dir, cleared dangling refs/reflogs (backed up first), fetched from origin (origin/main = old branch point 5e8072c, nothing upstream lost). The 5 feature commits' history was unrecoverable but content survived in the working tree → recommitted as one commit `2b9cb6b` on `feature/context-management`, pushed to origin (first push of this branch). Bench harness then verified end-to-end on OpenRouter gpt-5-nano: eval `bash-echo` pass; full bench `targeted-edit` hard=10 judge=8 overall=9.2 (worktree+IPC+verify+judge+report+cleanup all working); leaderboard regenerated. Note: only OPENROUTER_API_KEY is set and OpenRouter has no DEFAULT_MODELS, so `--model`/`--judge` must be passed explicitly. **Cost constraint lifted 2026-08-11 — any model may be used, not just gpt-5-nano.** File mtimes were rewritten by the Jun 29 copy — don't trust `ls -t` on old artifacts. |
| 2026-07-13 | Codex | Captured the repo-review hardening work as a prioritized follow-up for later. |
| 2026-08-10 | Claude | Full-program review for next development. Suite re-run: **219 pass / 13 fail**. Reproduced 3 new defects live (unapproved shell via `@file` content through the exact-bash shortcut; `role:'tool'` with no `tool_calls` → provider 400 poisoning the session; `--json-ipc` drops all prompts after the first) + found the `alwaysAllow` bash-key dead code. Logged them plus the structural gaps in TODO. |
| 2026-08-10 | Claude | **Terminal-Bench running end-to-end on local models.** `openssl-selfsigned-cert` via Harbor + Docker + host Ollama (`qwen3.6:35b-a3b-opencode`): pipeline clean, 0 exceptions, **5/6 grader tests pass**, reward 0.0 (TB reward is binary). The one failure is model behaviour, not harness: the agent verified with `python3 check_cert.py` while the grader runs `python check_cert.py` — a different interpreter without `cryptography`. Deliberately NOT patched around; making the prompt pass one task is exactly the benchmark-gaming the exact-bash shortcut was. The trajectory did expose a real harness flaw — the verify gate didn't recognise `python3 <script>.py` as verification and nudged after every check. Fixed (`RUN_SCRIPT_RE`, with a server-entry-point exception so `node app.js` still doesn't count). Re-run measured: **20→13 tool calls, 79,870→43,729 input tokens (−45%)**, same 5/6. |
| 2026-08-10 | Claude | **Library API + local-model speed + Terminal-Bench wiring.** Added `index.js` / `index.d.ts` — `run()`, `stream()`, `createAgent()`, plus `runAgent`/`executeTool`/`chatStream` — with `main`/`exports`/`files` in package.json; the package had no entry point, so the only ways to drive it were the REPL and a subprocess. **Biggest local-speed find: these are thinking models and `think` was on.** Measured M1 Max, "Reply with just the word READY": qwen3.6:27b-opencode 17.2s→0.8s (21x), qwen3.6:35b-a3b-opencode 11.6s→0.4s (29x). `think:false` is now the default; `--effort medium+` re-enables it; `CLAUDETTE_THINK` forces. A `think:true` 400 on a non-thinking model retries without the flag. Also measured: **a3b MoE generates at 52.8 tok/s vs 9.2 for the dense 27B** — 5.7x, and the dense one is unusable for agent loops. Rebuilt `.venv-harbor` (it had been built against an **x86_64** Python, so `cryptography` tried to compile Rust for x86_64-apple-darwin and failed — use `/opt/homebrew/bin/python3`). Harbor adapter now rewrites the Ollama loopback URL to `host.docker.internal`, so Terminal-Bench runs against a local model for free, and passes the CLAUDETTE_* knobs through. `npm link` puts `claudette` on PATH. Suite 308/308. |
| 2026-08-10 | Claude | **Hardening + repo cleanup.** Security: symlink-aware workspace boundary (`guardPath` now realpath-checks, including not-yet-created files); `glob` rewritten shell-free (tree walk + `globToRegExp`, prunes node_modules/.git during the walk, omits escaping symlinks); server body cap (1MB, 413), 400 on bad JSON, one-turn-per-session (409, claimed synchronously — the check-then-act window let both requests through), and provider-call abort on client disconnect. Ctrl+C now interrupts a **running tool** (one AbortController per turn, threaded into execFile/fetch; interrupted ≠ timed out). Found en route: `executeTool` rejected `signal: null` (execFile validates AbortSignal-or-undefined), which broke every command from the eval harness. Added `CLAUDETTE_NUM_CTX` (Ollama ctx was pinned at 32k; qwen3.6 exposes 256k). Cleanup: deleted `.persist/` (stale state naming a path from months ago), orphaned `cli.js`, unused `workspace/` fixtures; `AGENTS.md` is now the single agent-config source with `CLAUDE.md`/`GEMINI.md` as pointers (they had drifted — 50 vs 20 history rows, and Gemini never had the commit-attribution rule); `.gitignore` regrouped, `data/` ignored wholesale; TODO deduped. **Suite 306/306 green including live tests.** |
| 2026-08-10 | Claude | **Acted on the whole review.** Security: removed the exact-bash prompt→shell bypass (and rewrote the 2 bench tasks that depended on it as real task descriptions); scoped bash "always" approval to the exact command. Fixed: orphan-`tool`-message session poisoning (`dropOrphanToolMessages` on every payload), `--json-ipc` dropping prompts 2..N (`createLineQueue`), lossy compaction (archives to `sessions/archive/` first), non-atomic session writes (`fs-atomic.js`), O(n²) transcript rewrites (throttled + flushed). Structural: extracted **`src/agent-runner.js`** — headless hook-driven loop now shared by chat.js and bench/evals.js (the bench had been measuring a different agent); text parser split to `tool-call-parser.js`. Reliability: `src/retry.js` — backoff+jitter, Retry-After, no retry after streaming starts, stall watchdog (never an AbortError). Added `-p` headless, `--continue`/`--resume`, Tab completion, `npm test`/`test:live`, GitHub Actions CI (Node 20/22/24). Tests: **288 total**; rewrote the `normalizeArgs` tests that asserted against an inlined copy; live suites now discover an Ollama model (smallest tool-capable) and skip cleanly without one — they had hardcoded the uninstalled `llama3.2:latest` and could never pass. Removed root scratch (`fib.py`, `hello.py`, `hello.html`, `console-script.js`, `ollama-code.js`); kept `GEMINI.md` (agent config) and `check_precision.sh` (ops script). |
| 2026-08-11 | Claude | **Mid-turn steering works in every TTY session, not just `--yolo`.** Typing while the agent worked previously did nothing unless auto-approve was on: a normal turn ran with no input controller because `checkPermission` needed readline's `question()` while the raw-mode reader owned stdin. Both now share one reader — `InputController.awaitApproval()` parks the prompt and `submit()` classifies each line, so `y`/`n`/`a` answers it and anything else queues as a follow-up (typing "actually, skip the tests" at a `[y/n/a]` prompt steers instead of being read as `a`=always). Two hang paths closed: Ctrl+C denies a parked approval before aborting, and `runTurn`'s finally settles one if the turn dies. Verified end-to-end in a real pty with `expect` (blind timing can't test this — a `y` sent before the prompt correctly becomes a follow-up): prose queued at the gate, prompt still waiting, `y` then ran the tool, queue drained at the safe boundary and the model acted on the steer. Implements phases 1-2 + test cases 7/8 of `docs/queued-followups-plan.md`. Also: `adaptPayload()` retries OpenAI 400s (`max_completion_tokens`, default-only temperature, `reasoning_effort:'none'` with tools) — all three were masked by OpenRouter normalising them; corrected the Opus pricing table (`claude-opus-4` was matching every modern Opus at the old $15/$75, 3x over); and `npm test` no longer bills a live Opus turn (the missing-key guard found a real key via autoloaded `.env`, so it never fired). Suite **318 total, 316 pass, 0 fail**. |
| 2026-08-11 | Claude | **Repetition guard — the agent can no longer loop on identical tool calls.** A live session re-issued the same five `curl` commands **30 times in a row, byte for byte, for 37 minutes** (38 distinct commands became 183; ~824k tokens). Nothing could see it: the act nudge counts read-only streaks and a *successful* `bash` resets that streak, so a loop of successful identical commands read as progress every iteration — `maxIterations` (150) was the only backstop, ~2h out at 75s/iteration. Added `responseSignature(calls)` (tool names + arguments, key order and string-vs-object normalised; **prose excluded**, since a reworded preamble around identical commands is still a loop) and `createRepeatDetector`: nudge at 3 consecutive identical signatures, end the turn with status `'repeating'` after 2 ignored nudges. Stops in ~9 iterations. Checked *after* the batch executes so tool_call/tool_result pairing stays valid, and only when no follow-up was delivered so an automated nudge never stacks a second adjacent user message on the user's own steering. Tested against the real failure shape with `actNudge` left ON, plus the two things it must not do: repetition after genuine progress isn't a loop, and a follow-up resets the streak. Suite **323 total, 321 pass, 0 fail**. |
| 2026-08-26 | Codex | **Groq Free bring-up.** Replaced shut-down Llama IDs with live `/models` discovery intersected against the reviewed Free GPT-OSS 120B/20B + Qwen 3.6 27B catalog; 120B/20B are agent/judge defaults. Added provider quota-header parsing, trace persistence, CLI completion-footer readout, and a Groq-specific 2,048-token output reservation (configurable with `GROQ_MAX_TOKENS`) to fit the 8K TPM bucket. CLI/browser now reuse the provider registry and honor the configured default; `npm run groq` and `npm run groq:web` launch the Free 120B path. Live-verified discovery, a response, and a tool turn that created/read/verified a file; transient 429s respected Groq reset delays. Full offline suite: **338 total, 336 pass, 0 fail, 2 live skips**. |
| 2026-08-27 | Codex | **Strict free/native-tool model operation.** Added default-on free-tier, native-tools, and always-track policy across startup, switching, dispatch, CLI, browser, and cache; dynamic OpenRouter zero-price tool discovery + `openrouter/free`; dynamic HF `is_free`+`supports_tools` discovery; direct DeepSeek marked paid; current Groq allowlist/caps/timeouts; upstream routed model/provider usage capture; fair tool-output budgets; single-key y/n/a approvals; ANSI/spinner input hardening; browser usage + atomic session writes; model-table spacing. Live OpenRouter `openrouter/free` passed bash and multi-tool edit/test evals; explicit Nemotron route stalled. Final suite: **352 total, 350 pass, 0 fail, 2 live skips**. |
| 2026-08-27 | Codex | **Automatic free-model rotation.** CLI, library, runner, and browser now fail over only among zero-price/free-tier native-tool models; prefer another provider, bound switches (`CLAUDETTE_MODEL_ROTATION_MAX`, default 4), never replay after partial output, and persist a fallback only after success. Every attempt/switch/final route is traced and logged. Live `openrouter/free` Bash turn passed in 4.4s (3,680 in/105 out, one tool); suite **361 total, 359 pass, 0 fail, 2 live skips**. |
| 2026-08-27 | Codex | **Visible approvals + immediate steering.** y/n/a now prints an accepted/skipped acknowledgment; approved tools keep a command-specific running spinner until result. Added `/interrupt <prompt>` during TTY turns: abort current model/foreground tool, retain completed history and ordinary queued follow-ups, then inject the prompt as a fresh sequential trace (never concurrent). Added `tool_start` event/IPC typing and cancellation guards. Mock CLI + approval-boundary tests; suite **366 total, 364 pass, 0 fail, 2 live skips**. |
| 2026-08-27 | Codex | **Approval-gate prose redirect.** Non-y/n/a text at a parked permission prompt now denies/skips the pending tool and immediately becomes the next sequential prompt instead of waiting behind a 120s command timeout. Stabilized spawned-CLI tests with EOF shutdown and event-driven permission input. Final suite **366 total, 364 pass, 0 fail, 2 live skips**. |
| 2026-08-27 | Codex | **Managed CLI flight recorder.** Replaced the competing spinner/input row with a cursor-owned status block: complete selected and OpenRouter-resolved model ids (wrap, never truncate), labeled step/tool/in/out/elapsed/queue state, immediate activity and typed-steering feedback, compact tool ledger, full terminal width, and resolved route in the completion footer. Legacy/new status leakage is sanitized. Current free coding ranking led by Laguna S 2.1 and GLM 5.2; Groq GPT-OSS 120B remains the fast short-burst option under its 8K TPM cap. Pseudo-terminal smoke passed; suite **368 total, 366 pass, 0 fail, 2 live skips**. |
| 2026-08-28 | Codex | **Ranked free-model boot order.** Centralized the ten-model practical coding preference list and applied it to live discovery, `/models`, CLI/library/server/benchmark automatic startup, and known-route failover; explicit selections still win, missing routes are skipped, and unranked/local ordering remains stable. Metadata-only live discovery confirmed all ten routes in order. Suite **371 total, 369 pass, 0 fail, 2 live skips**. |
| 2026-08-28 | Codex | **Long-turn resilience hardening.** `list_dir` now prunes generated trees and caps broad output; rotation estimates request size, skips over-limit Groq/context routes, hops providers on shared failures, and avoids duplicate deterministic 413s; successful verification gets a bounded completion guard, while later direct or Bash edits require a fresh check. Tunables are documented and shown by `/config`. Suite **379 total, 377 pass, 0 fail, 2 live skips**. |
| 2026-08-28 | Codex | **Comprehensive code/security review.** Added `security_best_practices_report.md`: 15 line-referenced findings (5 high/6 medium/4 low) with isolated proofs and remediation order; no production-code edits. JS/Python/package/diff checks passed; offline suite **379 total, 377 pass, 0 fail, 2 live skips**. |
| 2026-08-28 | Codex | **Compact footers + background dev servers.** Completion footer shows only router/provider and approximate output tokens (for example `OpenRouter / Poolside · ~3652 tokens`); the live managed footer likewise uses one router/provider row instead of duplicating selected/resolved model IDs, while retaining progress and in/out tokens. Recognized dev-server Bash commands detach into their own process group and return PID/log/stop details; builds, tests, and explicit background commands remain foreground/user-managed. Suite **382 total, 380 pass, 0 fail, 2 live skips**. |
| 2026-08-31 | Codex | **Full-scale current-tree code review.** Found 15 line-referenced issues (5 high/7 medium/3 low), including pre-sandbox symlink writes, unsafe library/env/web boundaries, cancellation pairing, provider bounce, persistence/trace defects, and API/tooling drift. No production-code edits. Static/package checks passed; offline suite **390 total, 388 pass, 0 fail, 2 live skips**. |
| 2026-08-31 | Codex | **Completed full review remediation and production macOS Bash broker.** Closed all 15 review findings; moved browser chat/session/context onto the shared tool-less runner path; replaced nested Seatbelt and `/tmp` socket bootstrap with authenticated direct child IPC and one strict profile per command; pinned Harbor/NVM/Node/full commit SHA; documented same-session model switching and cap 2. Full suite **418 total, 416 pass, 0 fail, 2 live skips**; real macOS `--yolo` sandbox proof passed. |
| 2026-08-31 | Codex | **Cross-device farm validation.** Exact current-tree snapshot passed local M1 macOS (**416 pass, 0 fail, 2 skips**) and CUDA Ubuntu (**411 pass, 0 fail, 7 platform/live skips**); Intel macOS passed 415 with one real failure: strict Bash Seatbelt blocks Xcode-backed Python under `/Applications`. Proxmox HTTPS was healthy but had no execution auth/agent; ThinkPad timed out. ANSI assertions and AppleDouble staging were isolated as harness artifacts. No production-code edits. |
| 2026-08-31 | Codex | **Farm fix loop, first green cycle.** Added canonical read-only Xcode developer-root support, private tool HOME/TMPDIR, entropy reads, and hostile `DEVELOPER_DIR` scrubbing without weakening write/network/signal/Apple Event boundaries. Benchmark fixture/report loaders now ignore AppleDouble/hidden/non-file entries; CLI assertions are color-independent. Full matrix: local/Intel **419 pass, 0 fail, 2 skips**; CUDA **414 pass, 0 fail, 7 skips**. |
| 2026-09-05 | Codex | **Code review reliability fixes.** Lazy library streams abort and await cleanup, reusable agents retain their busy guard and default signal; Bash verification follows command order and invalidates checks after partial failures, recognizes env-prefixed Python/audit checks; npm/CI syntax checks cover every non-ignored JS module without masking errors. Seven regression tests added; **446 total, 444 pass, 0 fail, 2 live skips**; 46 modules and 20 benchmark tasks validate. |
| 2026-09-05 | Codex | **Scanner SQLite sandbox and failure-loop fixes.** Allowed metadata-only /Users access so disk SQLite/mypy caches work; Bash uses pipefail; three matching exceptions across varied commands stop the loop; edits/checks/steering reset failure counters; cache-only cleanup and tools-disabled blocker answers no longer trigger verification nags. Six regressions; **450 pass, 0 fail, 2 live skips**. Actual Scanner venv SQLite/mypy probes and both previously failing tests pass; Scanner source untouched. |
| 2026-09-05 | Codex | Added **/copy** to copy the latest assistant text verbatim via native clipboard stdin (macOS/Windows/Linux); help/completion, empty/error handling, documentation, and five clipboard/CLI regressions. Tests never alter the host clipboard. Full suite **457 total, 455 pass, 0 fail, 2 live skips**; 47 modules syntax-check. |
| 2026-09-05 | Codex | **Grounded review evidence.** Shared CLI/library/eval guidance requires inspected-code/config findings; Bash labels collection coverage and masked checker exits; collection/help/version/dry-run cannot verify edits. Four regressions plus read-only review fixture; live Kimi found the seeded defect and correctly left actual coverage unknown (4 reads, no edits). Full suite **461 total, 459 pass, 0 fail, 2 live skips**; all 48 JS modules syntax-check. |
| 2026-09-05 | Codex | **Extensive reliability testing.** Eight full Claudette runs, 155 focused checks, six native clipboard cases, and 52 live scenarios. Fixed wrapped/configured discovery verification, /dev/null false edits, and metadata-only /etc for nested login shells. Final Node 20/22/24: **464 pass, 0 fail, 2 skips each**; Scanner strict-sandbox replay **638 pass, 17 skips, 82.87% coverage**. Clipboard coverage 100%; source preserved. Live model failures and stricter review scoring documented in docs/testing-2026-09-05.md. |
| 2026-09-05 | Codex | **Continuous transport stress.** Fixed streamed error/EOF false successes, SSE framing, reader cleanup and buffered cancellation. Added 32 tests; full suite 496 pass/2 skips, prior full Node20/22/24 each 489 pass. Seeded loop varies heap/TZ/locale and remains active; initial 8,000+48,000 generated cases pass. Live MiniMax 2/3, GLMFlash 0/3 Unicode cases retain model-format failures. See docs/testing-streams-2026-09-05.md. |
| 2026-09-05 | Codex | **Persistence stress fixes.** Corrected stale instruction cache, debounce/direct-save races, concurrent publication ordering, archive collisions, transcript flush/eviction loss, and atomic long filenames. Added 14 regressions; Node20/22/24 full suites each 510 pass/2 skips; 60 runtime/pool/flag configurations passed all 840 filesystem tests. Ongoing stream loop reached 866,000 generated cases without failure. |
| 2026-09-05 | Codex | **Real verification gates.** Removed masked compiler/coverage/audit failures, added portable launcher/coordinator and7 regressions, corrected public maxTotalChars type. Full Node22/24:517pass/2skip; Node20:516pass/3skip; native coverage79.66% lines/76.40% branches. Clean dev/prod installs, injected type failure and packed consumer pass. Continuous batch1252 timed out during132s Mac sleep; exact replay and60 cancellation repeats pass, loop restarted with failure retained. |
| 2026-09-05 | Codex | **Shell lifecycle stress fixes.**14 regressions found orphaned children, ignored deadlines returning success, uncapped error output, lost capture-limit reasons, split emoji and disabled fractional timeouts. Added bounded spawn-based foreground execution and scoped POSIX group cleanup. Full Node20:530pass/3skip; Node22/24:531pass/2skip. Coverage79.79% lines/76.59% branches;36 runtime/heap/pool/buffer configurations pass all504 shell tests; package/API checks pass. |
| 2026-09-09 | Codex | Auths integration: optional runAgent execute callback (b2607bf) enables scoped research tools; existing default unchanged. Auths integration tests and live cloud comparisons passed; all prior in-progress hardening remains unstaged. |
| 2026-09-20 | Muse Code | Landed dirty tree as 3 local commits on feature/review-hardening (tooling/gates, functional core, docs; each verified isolated-green; NOT pushed). Full tree: lint clean, 540 pass/0 fail/2 skips of 542. Continuous stress loop found dead; SE3 app question still open. |
| 2026-09-20 | Muse Code | Started verify-grep TODO: count-lines-tool and extract-print-help now assert behavior (TOOL_DEF + two-file counts; printHelp def/call/table-move). Positive/negative scratch controls pass; suite 540/0/2. Committed as 38dfb09, NOT pushed. |

---

## Commands

| Command | Description |
|---------|-------------|
| `.venv-harbor/bin/harbor run -d terminal-bench@2.0 -a claudette_harbor:Claudette -m openrouter/openai/gpt-5-nano --agent-kwarg version=<40-char-commit-sha> -i <task> -o bench/runs/harbor -n 1` | Run claudette on Terminal-Bench via Harbor (push the immutable commit first; omit `-i` for all tasks) |
| `uv venv .venv-harbor && uv pip install -p .venv-harbor -e bench/harbor` | One-time Harbor adapter setup |
| `node claudette.js` | Start CLI (auto-selects best available model) |
| `node claudette.js --model <name>` | Start CLI with specific model |
| `claudette --model openrouter/free` | Start on OpenRouter's free native-tool router (recommended fallback when Groq is rate-limited) |
| `CLAUDETTE_MODEL_ROTATION=0 claudette ...` | Disable automatic free/tool-model failover; leave enabled by default and tune the two-switch cap with `CLAUDETTE_MODEL_ROTATION_MAX=<n>` |
| `GROQ_TPM_LIMIT=8000 CLAUDETTE_LIST_DIR_MAX_ENTRIES=200 CLAUDETTE_POST_VERIFY_GUARD=6 claudette` | Override Groq request-fit preflight, broad directory output cap, and post-verification tool-call threshold |
| `/copy` | Copy the last assistant message to the clipboard, preserving Markdown and line breaks |
| `/models` then `/model <provider/model>` | List currently eligible free native-tool routes and switch the active session model |
| `/interrupt <new prompt>` | While the agent works, abort the active model/tool and immediately continue with the injected prompt; ordinary typed text remains safely queued |
| `npm run groq` | Start the terminal UI on Groq Free GPT-OSS 120B; remaining quota prints after each response |
| `npm run groq:web` | Start the browser UI on Groq Free GPT-OSS 120B at `http://127.0.0.1:4321` |
| `node claudette.js -y` / `--yolo` / `--bypass` | Start CLI with auto-approve for all tool calls (or set `CLAUDETTE_AUTO_APPROVE=1`) |
| `node claudette.js --network --yolo --model <ollama-cloud-model>` | Explicitly allow outbound model Bash in the macOS sandbox while retaining other boundaries; needed for model-run package installs/public API calls and risky for untrusted prompts because LAN/metadata endpoints become reachable |
| `node claudette.js --effort <low\|medium\|high\|xhigh\|max>` | Set reasoning effort (or `CLAUDETTE_EFFORT`; `/effort` at runtime) |
| `node server.js` | Start web server on port 4321 |
| `npm run lint` | Syntax-check all tracked and new non-ignored JS/MJS/CJS files; exits nonzero on any error |
| `/usr/bin/swift scripts/test-native-clipboard.swift "$(command -v node)"` | Opt-in macOS native clipboard/CLI tests; temporarily writes test data and restores all original pasteboard formats from memory |
| `node scripts/stress-streams.mjs --cases 2000` | Continuously test streams across recorded seeds, heap limits, timezones and locales; stops on failure or Ctrl+C; add --batches N for a finite run |
| `CLAUDETTE_STRESS_SEED=42 CLAUDETTE_STRESS_CASES=10000 node --test test/streaming.test.js` | Replay or expand deterministic transport fuzzing without live models |
| `NODE_ENV=test UV_THREADPOOL_SIZE=1 node --jitless --test test/filesystem.test.js` | Stress instruction refresh, concurrent saves, archives, transcripts, write faults and long paths using isolated state |
| `npm ci --ignore-scripts` then `npm run typecheck` | Install locked development compiler and check strict public API declarations/consumer contract |
| `npm run coverage` | Node22/24 native coverage; enforce70% lines/60% branches, fail on unsupported runtimes |
| `NODE_ENV=test node --test test/shell.test.js` | Real process deadlines, cancellation, strict broker, sibling/background isolation, bounded Unicode output and timer overrides |
| `npm test` | Offline suite (~60s) — what CI runs; no provider key, no Ollama. Spawns server+CLI subprocesses; ports are allocated dynamically now, so parallel runs are safe |
| `/Users/frank/Code/farm/bin/farm doctor --inventory /Users/frank/Code/farm/farm.inventory.json --runs <report-dir>` | Probe the recorded farm devices and save readiness evidence; current farm test jobs require a configured worker `agentUrl` and cannot execute commands directly |
| `cd /Users/frank/Code/farm && go run ./cmd/farm run -runs <report-dir> <job.json>` | Run one required-isolation Farm job and retain its report/artifacts; use pinned `deviceIds` and model IDs for comparisons |
| `npm run test:live` | Adds the `Stress:` cases against a real local Ollama model (auto-discovered) |
| `npm link` | Put `claudette` on PATH from this checkout |
| `uv venv .venv-harbor --python /opt/homebrew/bin/python3 && uv pip install -p .venv-harbor -e bench/harbor` | Harbor setup. MUST be a native arm64 python — an x86_64 one makes `cryptography` build Rust for the wrong target and fail |
| `OLLAMA_BASE_URL=http://127.0.0.1:11434 .venv-harbor/bin/harbor run -d terminal-bench@2.0 -a claudette_harbor:Claudette -m ollama/<model> --agent-kwarg version=<40-char-commit-sha> -i <task> -o bench/runs/harbor -n 1` | Terminal-Bench against a local model (free; the adapter rewrites loopback to host.docker.internal) |
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
| `node bench/evals.js --case review-evidence --model kimi-k2.7-code:cloud --verbose` | Check code-review grounding, existing config, and collection-coverage interpretation without changing fixtures |
| `npm run eval -- --all --model <provider/model>` | Run all prompt/tool-usage eval cases (in-process, fast; no worktree) |
| `npm run eval -- --all --model <m> --cache` | Replay recorded replies (opt-in). Never for a model comparison: a replay reports a near-zero duration and the tokens recorded when it was captured |
| `node bench/eval-summary.js --since 2026-08-11 --write` | Rebuild `bench/BAKEOFF.md` from the eval reports (latest result per model *and* case) |
| `CLAUDETTE_MAX_RETRIES=4 npm run eval -- ...` | For unattended runs: the default budget spans ~9s, and a local server restart takes longer |
| `npm run eval -- --case <id> --repeat 5` | Flakiness loop on one eval case (pass@k / pass^k) |
| `npm run eval:list` | List eval cases (`bench/evals/*.json`) |
| `NODE_ENV=test node --test --test-name-pattern "<pattern>" test/test.js` | Run a targeted slice of the suite (fast; skips other suites' bodies) |
| `node bench/run.js --all --model qwen3.5:0.8b` | Run the full installed-model benchmark sweep used for the current passing scores |

---

## TODO

### Outstanding Tasks

**Shipped 2026-08-10** — see `Changelog.md` `[Unreleased]` for the full list.
Two passes: the review response (exact-bash bypass, agent-runner extraction,
provider retry/stall, atomic writes, `-p`/`--resume`, Tab completion, CI), then
the hardening pass (symlink-aware workspace boundary, shell-free `glob`,
interruptible tools, server body/concurrency/disconnect limits, `CLAUDETTE_NUM_CTX`).

**Next, in order:**
- **Extend the completed Ollama Cloud eval matrix to project scale.** The seven-model, five-worker 11-case suite is complete; next run the heavier N01/N02/S01/W01/R01 scenarios from `docs/cloud-model-benchmark.md`, prioritizing Kimi and DeepSeek and retaining pinned cross-host repeats.
- **MCP client.** Nine hardcoded tools vs. the whole ecosystem — the largest single
  capability jump available. stdio + SSE transports, tool discovery, schema translation.
- **Subagents** — `docs/parallel-subagents-plan.md` Phase 2+; Phase 1 (reusable runner) is done.
- Persisted permission rules (allow/ask/deny globs per project). `alwaysAllow` is
  still an in-memory Set that dies with the process.
- **Terminal-Bench: run a wider slice.** One task verified end-to-end; next is a
  10-20 task sample to get a real number. Runs are free against local Ollama now.
- **Rebaseline the benchmark.** `count-lines-tool` and `extract-print-help` are honest
  task descriptions now; the old 4-5/10 was scored with a shortcut that did the work.
  Expect lower, real numbers. Then regenerate `bench/LEADERBOARD.md`.
- Replace the `verify:` grep assertions with real tests — `grep -q 'count_lines'
  src/tools.js` is satisfied by `echo count_lines >> src/tools.js`.
- Port the bench harness to the Windows box at 192.168.0.178 (Node/Ollama/bash
  installed) — use the remote EC2 Ollama over an SSH tunnel.

### Feature Ideas

**Product / architecture:**
- Position Claudette as a multi-provider coding-agent workbench; either make the
  browser a real tool-capable agent or keep describing it as a chat/trace dashboard.
- Privacy: transcript/session recording controls, redaction, retention, deletion,
  and a startup indicator that recording is on.
- Adopt opencode's one-server-many-clients shape: OpenAPI spec + SSE events;
  `--attach` a warm server so the bench harness skips per-prompt boot.

**Multi-provider roadmap (from terminal-bench / lm-eval-harness / HELM / KIRA / opencode research):**
- _Highest leverage (opencode):_ consider building the model layer on the Vercel AI SDK
  provider packages + Models.dev metadata, with `@ai-sdk/openai-compatible` as the generic
  BYO-endpoint path — collapses most hand-maintained provider code and gives 75+ providers
  plus model limits/cost for ~free.
- Split secrets out of env/config into a credentials store + interactive `claudette auth
  login` (provider menu, OAuth *and* pasted keys). Anthropic Claude-subscription OAuth
  worth supporting.
- `$schema` JSONC config, deep-merged global→project, with `{env:VAR}` substitution;
  `small_model` slot for cheap auxiliary calls (judge titles/summaries) to cut bench cost.
- Per-provider config: `baseURL`/`apiKey`/`headers` + capability flags (`supportsTools`,
  `chatOnly`, pricing) + `concurrency`/`maxRetries`/`timeout`.
- Permissions map (`allow`/`ask`/`deny`, glob-matched bash, last-match-wins, per-agent
  merge) + `external_directory` guard (opencode).

**Bench harness upgrades:**
- Per-run token counts/cost/durations; multi-metric result vector (correctness,
  cost-efficiency, speed) in reports and the leaderboard.
- Tag/suite grouping and filtering; resumable execution for interrupted runs;
  task-level custom idle timeouts.
- Container-per-task isolation instead of git worktrees, so a run reproduces on
  another machine (this is what separates `bench/` from Terminal-Bench).

**Agent loop (KIRA):**
- Per-step token+cost trajectory; graceful context-overflow fallback (summarize →
  minimal-context retry); structured `analysis`/`plan` fields inside the action tool schema.
