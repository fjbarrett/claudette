# Benchmark Harness

This harness runs repeatable coding/admin tasks against the local CLI agent in isolated git worktrees.

## What it does

- Creates a temporary git branch and worktree for each run
- Drives the local CLI agent (`claudette.js`) over a structured JSON IPC
  protocol (`--json-ipc`) rather than scraping terminal output
- Caches provider responses by default so re-runs and re-judging are free
- Captures the workflow transcript, git diff, and verification results
- Runs an LLM judge over the workflow and outcome
- Writes JSON and Markdown reports under `bench/runs/`
- Generates a latest-per-model leaderboard in `bench/LEADERBOARD.md`

## Usage

List tasks:

```bash
npm run bench:list
```

Regenerate the leaderboard from the latest report files:

```bash
npm run bench:leaderboard
```

Run one task against gemma4 with live output:

```bash
npm run bench -- --task write-and-run --model gemma4:latest --verbose
```

Run all tasks against gemma4 (the default testing loop):

```bash
npm run bench:gemma
```

Repeat a task 3 times to check consistency:

```bash
npm run bench -- --task targeted-edit --model gemma4:latest --repeat 3 --verbose
```

Run one task against several models:

```bash
npm run bench -- --task add-new-tool --model gemma4:latest --model qwen2.5-coder:latest
```

Keep the worktree/branch for post-mortem inspection:

```bash
npm run bench -- --task subdir-workflow --model gemma4:latest --keep --verbose
```

Choose a different judge model:

```bash
npm run bench -- --task admin-hardening --model gemma4:latest --judge qwen2.5:latest
```

### Cloud models (any provider)

Both the agent model (`--model`) and the judge (`--judge`) route through the
provider layer, so any `provider/model` id works anywhere a model id is accepted
(`anthropic/…`, `openai/…`, `openrouter/…`, `groq/…`, …). Set the matching key
first; the harness fails fast (before spinning up worktrees) if a cloud model is
requested without its key.

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# Run Opus 4.8 on the two tasks where local 14–16B models hit a ceiling,
# judged by Sonnet so the judge doesn't depend on a local Ollama:
npm run bench -- --task count-lines-tool --model anthropic/claude-opus-4-8 \
  --judge anthropic/claude-sonnet-4-6 --verbose
npm run bench -- --task extract-print-help --model anthropic/claude-opus-4-8 \
  --judge anthropic/claude-sonnet-4-6 --verbose

# Head-to-head across providers on the same task (no local GPU needed):
npm run bench -- --task count-lines-tool \
  --model anthropic/claude-opus-4-8 --model openai/gpt-4o \
  --model openrouter/meta-llama/llama-3.3-70b-instruct \
  --judge anthropic/claude-sonnet-4-6
```

This needs no local Ollama when `--model` and `--judge` are all cloud ids.
After a run, refresh the leaderboard with `npm run bench:leaderboard`.

## Tasks

| ID | Category | What it tests |
|----|----------|---------------|
| `write-and-run` | coding | Write a function with self-tests, run it, iterate until clean |
| `targeted-edit` | coding | Read a file, make a minimal str_replace edit, verify the result |
| `add-new-tool` | coding | Add a tool to an existing registry, keep TOOL_DEFS and switch in sync |
| `subdir-workflow` | coding | Create a project in a subdirectory and run it with the right cwd |
| `permission-prompt-shortcut` | coding | Find and fix a specific UI string |
| `admin-hardening` | admin | Inspect and harden operational risks |

### Project-scale tasks (`category: project`)

End-to-end "build a whole app" tasks for stress-testing the agent on realistic,
multi-file scaffolding. Each says exactly which files to create in a fresh
subdirectory; verification is **structural** (files exist, package/manifest deps
match the stack, `node --check` / `py_compile` parse the code, key wiring strings
present) so it stays deterministic without network installs — the LLM judge
scores correctness and wiring quality on top.

| Task | Stack | What it builds |
|------|-------|----------------|
| `notes-app-nextauth-postgres` | Next.js + NextAuth + Prisma/Postgres | Note-taking app with Google auth and a Postgres-backed notes API |
| `express-postgres-crud-api` | Express + pg | REST API with full CRUD over Postgres (parameterized queries) |
| `fastapi-sqlite-todo` | FastAPI + SQLAlchemy + SQLite | Todo service with list/create/update endpoints |
| `fullstack-nextjs-postgres` | Next.js + Postgres (Docker) | Containerized Next.js + Postgres scaffold |

Run the whole project suite (pass your own capable model):

```sh
npm run bench:projects -- --model openrouter/anthropic/claude-opus-4.8
# or a single one with live output:
npm run bench -- --task notes-app-nextauth-postgres --model anthropic/claude-opus-4-8 --verbose
```

These are deliberately demanding — small local models will score poorly. They're
meant to differentiate capable cloud models and surface where the agent loop
breaks down on long, multi-file builds.

## Task File Format

Task definitions live in `bench/tasks/*.yaml` (legacy `*.json` is still loaded).
The loader (`bench/tasks.js`) parses a small, lossless YAML subset; multi-line
prompts are stored as literal `|-` blocks so exact-reproduction prompts keep
their line breaks and indentation byte-for-byte. (Folded `>` scalars must be
avoided for those — they collapse line breaks and silently change the task.)

Each task supports:

- `id`
- `title`
- `category`
- `prompt` — use a literal `|-` block for any multi-line prompt
- `verify`: array of shell commands run after the agent finishes (exit 0 = pass)
- `timeoutSec`
- `singleTurn` (optional): exit after the first model turn (single-shot tasks)
- `judgeFocus`: guidance for the LLM judge

## Request caching

Provider responses are cached by default under `bench/runs/.cache/` (gitignored),
keyed by a content hash of the request (model, messages, tools, effort). This
makes re-running a task or re-judging an existing run deterministic and free.

```bash
npm run bench -- --task add-new-tool --model anthropic/claude-opus-4-8   # caches
npm run bench -- --task add-new-tool --model anthropic/claude-opus-4-8 --no-cache
```

Pass `--no-cache` to force live provider calls. Cache writes are atomic and a
corrupt or missing entry degrades to a live call (with a warning on stderr),
never a crash. Bump `CACHE_VERSION` in `src/provider.js` to invalidate the cache
after a result-shape change.

## Process protocol (`--json-ipc`)

The harness spawns `claudette.js --json-ipc` and exchanges newline-delimited JSON
instead of parsing the human terminal UI. The harness sends
`{"type":"prompt","text":...}` and `{"type":"exit"}`; the agent emits a pure
JSONL event stream on stdout: `ready`, `turn`, `delta`, `tool_call`,
`tool_result`, `assistant`, `done`, and `error`. No spinner, markdown, or banner
output is written in this mode, so the stream stays machine-parseable.

## Eval Loops (`bench/evals.js`)

A lighter, faster companion to the full benchmark harness for testing **prompts
and tool usage**. Instead of a git worktree and a CLI subprocess per run, each
case drives an in-process agent loop (`chatStream` + `executeTool`) inside a
throwaway sandbox, records every tool call, and checks declarative
expectations: which tools were called (ordered subsequence, with argument
matchers), which tools are forbidden, what the workspace files look like
afterwards, and what the final answer says.

```sh
npm run eval:list                                    # list cases
npm run eval -- --all --model anthropic/claude-opus-4-8
npm run eval -- --case edit-not-rewrite --repeat 5   # flakiness loop: pass@k / pass^k
npm run eval -- --case bash-echo --verbose --keep    # show tool calls, keep sandbox
```

Cases live in `bench/evals/*.json` (see the header comment in `bench/evals.js`
for the schema). Repeating a case N times reports `pass@k` (any iteration
passed) and `pass^k` (all passed) — the standard way to surface flaky
tool-calling behaviour. Reports land in `bench/runs/evals/` (gitignored).
Expected string argument values match by substring; everything else strictly.
The loop merges text-emitted tool calls exactly the way the interactive CLI
does, so models that write JSON tool calls into their text body are scored
fairly. With no `--model`, the first credentialed cloud provider's default
agent model is used.

## Notes

- The harness runs the real CLI agent with `-y`, so tool calls are auto-approved during benchmark runs.
- Reports are ignored by git.
- `npm run bench:leaderboard` snapshots the most recent result for each `(model, task)` pair.
- Models that do not support tools may still perform well on pure generation tasks, but they will score poorly on tool-using tasks.
