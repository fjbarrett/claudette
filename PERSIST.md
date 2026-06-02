# PERSIST

---

## Context

**Last Updated:** 2026-06-01
**Stage:** Cloud-first multi-provider — models addressed `provider/model`; backends for OpenAI/Anthropic/DeepSeek/Groq/HuggingFace (bespoke) + catalog (OpenRouter/Together/Fireworks/Google/xAI/Mistral/Cohere/Perplexity) over one OpenAI-compatible transport. Runs with no local Ollama. Bench harness tuned; 14-16B local ceiling on complex refactors.
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
bench/            Benchmark harness + isolated worktree runs + reports
data/sessions/    Persisted session JSON files
public/           Web UI (index.html, styles.css, app.js)
test/test.js      Comprehensive test suite + config coverage
```

---

## History

| Date | Agent | Action |
|------|-------|--------|
| 2026-04-08 | Claude | Wrote 96-test suite covering session, context, tools, server HTTP API, CLI commands, Ollama stress loop |
| 2026-04-09 | Claude | Removed non-essential features (/vim, /add-dir, INTERPRETER_TOOLS, grep tool); added 19 tests for list_dir/search_code/fetch_url/patch_file/trace; blocked test transcripts; wiped old transcripts. 102 tests, 0 failures. |
| 2026-04-09 | Claude | Added 4 gemma4 benchmark tasks (write-and-run, targeted-edit, add-new-tool, subdir-workflow); added --all, --repeat, --verbose flags to bench/run.js; added npm run bench:gemma shortcut. |
| 2026-04-17 | Codex | Switched Ollama defaults to `http://localhost:11434`, added git workflow CLI commands, fixed benchmark harness prompt/branch handling, created private GitHub repo `fjbarrett/claudette`, and benchmarked gemma4/qwen models. |
| 2026-04-17 | Codex | Fixed edit-loop behavior by making `str_replace`/`patch_file` reject no-op replacements and telling the system prompt not to update `PERSIST.md` for trivial requests. |
| 2026-04-17 | Codex | Renamed the project branding and primary CLI/package entrypoints to `claudette`, updated docs/UI/bench references, and kept `ollama-code.js` as a compatibility shim. |
| 2026-04-17 | Codex | Added Ollama no-tools fallback + structured benchmark-task execution shortcuts, then benchmarked `qwen3.5:0.8b` with all task scores above 9. |
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

---

## Commands

| Command | Description |
|---------|-------------|
| `node claudette.js` | Start CLI (auto-selects best available model) |
| `node claudette.js --model <name>` | Start CLI with specific model |
| `node claudette.js -y` | Start CLI with auto-approve for all tool calls |
| `node server.js` | Start web server on port 4321 |
| `NODE_ENV=test node --test test/test.js` | Run full test suite (~45-90s; spawns server+CLI subprocesses. Run ONE at a time — server tests bind fixed port 14322, so concurrent runs conflict) |
| `OLLAMA_BASE_URL=http://localhost:11434 node claudette.js --model gemma4:latest` | Point CLI at the SSH-tunneled Ollama endpoint explicitly |
| `npm run bench:gemma` | Run all benchmark tasks against gemma4 with live output |
| `npm run bench -- --task <id> --model gemma4:latest --verbose` | Run one task with live output |
| `node bench/run.js --task <id> --model gemma4:latest --model qwen2.5-coder:14b` | Compare multiple installed models on the same task |
| `npm run bench -- --task <id> --model gemma4:latest --repeat 3` | Stress-test a task N times |
| `npm run bench -- --task <id> --model gemma4:latest --keep` | Keep worktree for post-mortem |
| `npm run bench:list` | List all benchmark tasks |
| `npm run bench:leaderboard` | Regenerate `bench/LEADERBOARD.md` from the latest report file for each model/task pair |
| `node bench/run.js --all --model qwen3.5:0.8b` | Run the full installed-model benchmark sweep used for the current passing scores |

---

## TODO

### Outstanding Tasks
- `count-lines-tool` and `extract-print-help` stuck at 4-5/10 — need 32B+ model or structured-task shortcut to improve.
- Port bench harness to Windows machine at 192.168.0.178 (Node/Ollama/bash already installed) — use remote EC2 Ollama via SSH tunnel.
- Re-run full benchmark matrix after any model upgrade.

### Feature Ideas

**Multi-provider roadmap (from terminal-bench / lm-eval-harness / HELM / KIRA / opencode research):**
- _Highest leverage (opencode):_ consider building the model layer on the Vercel AI SDK provider packages + Models.dev metadata, with `@ai-sdk/openai-compatible` as the generic BYO-endpoint path — collapses most hand-maintained provider code and gives 75+ providers + model limits/cost for ~free.
- Split secrets out of env/config into a credentials store + interactive `claudette auth login` (provider menu, OAuth *and* pasted keys). Anthropic Claude-subscription OAuth worth supporting.
- `$schema` JSONC config, deep-merged global→project, with `{env:VAR}` substitution; `small_model` slot for cheap auxiliary calls (judge titles/summaries) to cut bench cost.
- Per-provider config: `baseURL`/`apiKey`/`headers` + capability flags (`supportsTools`, `chatOnly`, pricing) + `concurrency`/`maxRetries`/`timeout` with exponential backoff (lm-eval).
- Permissions map (`allow`/`ask`/`deny`, glob-matched bash, last-match-wins, per-agent merge) + `external_directory` guard (opencode).
- **Bench harness upgrades:** request cache keyed on the full request (model+messages+params+tools) for cheap deterministic reruns + offline re-judging (HELM/lm-eval); declarative YAML tasks auto-registered + versioned, with `tag`/`group` suites; resumable run dirs (skip-completed, continue-on-error); separate `summarize` step → versioned leaderboard JSON the web UI reads; multi-metric result vector (correctness + tokens + cost + tool-calls + safety/diff-discipline), not one score.
- **Agent loop (KIRA):** per-step token+cost trajectory; two-phase "are you sure?" completion gate with a test/QA/user checklist (reusable as a judge rubric); graceful context-overflow fallback (summarize → minimal-context retry); structured `analysis`/`plan` fields inside the action tool schema.
- Adopt opencode's one-server-many-clients shape: OpenAPI spec + SSE events; `--attach` a warm server for the bench harness to skip per-prompt boot.
