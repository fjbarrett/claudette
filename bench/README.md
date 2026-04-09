# Benchmark Harness

This harness runs repeatable coding/admin tasks against the local CLI agent in isolated git worktrees.

## What it does

- Creates a temporary git branch and worktree for each run
- Executes the local CLI agent (`ollama-code.js`) with a task prompt
- Captures the workflow transcript, git diff, and verification results
- Runs an LLM judge over the workflow and outcome
- Writes JSON and Markdown reports under `bench/runs/`

## Usage

List tasks:

```bash
npm run bench:list
```

Run one task against one model:

```bash
npm run bench -- --task permission-prompt-shortcut --model gemma4:latest
```

Run one task against several models:

```bash
npm run bench -- --task admin-hardening --model gemma4:latest --model deepseek-coder-v2:16b
```

Keep the worktree/branch for inspection:

```bash
npm run bench -- --task admin-hardening --model gemma4:latest --keep
```

Choose a different judge model:

```bash
npm run bench -- --task admin-hardening --model gemma4:latest --judge qwen3.5:latest
```

## Task Files

Task definitions live in `bench/tasks/*.json`.

Each task supports:

- `id`
- `title`
- `category`
- `prompt`
- `verify`: array of shell commands run after the agent finishes
- `timeoutSec`
- `judgeFocus`

## Notes

- The harness runs the real CLI agent with `-y`, so tool calls are auto-approved during benchmark runs.
- Reports are ignored by git.
- Models that do not support tools may still perform well on pure generation tasks, but they will score poorly on tool-using tasks.
