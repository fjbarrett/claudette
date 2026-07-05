# claudette-harbor

Harbor adapter that runs **claudette** as the agent under test on
[Terminal-Bench](https://www.harborframework.com/) (and any other Harbor
dataset). This is the bridge to the benchmark used by frontier-model
releases; the in-repo harness (`bench/run.js`) stays the fast local
regression loop.

## How it works

- `install()` puts Node 22 (nvm) into the task container and
  `npm install -g`'s claudette from a GitHub tarball of this repo
  (no npm dependencies, so installs are quick).
- `run()` pipes one `{"type":"prompt","text":...}` line into
  `claudette --json-ipc -y --model <provider/model>`; claudette runs the
  full agentic turn and exits on stdin EOF. The JSONL event stream
  (minus `delta` spam) is teed to `/logs/agent/claudette.jsonl`.
- `populate_context_post_run()` reads the final `done` event for
  prompt/completion token counts.

Claudette's model ids are already Harbor's `provider/model` format, so
`-m` values pass through verbatim.

## Setup

```sh
uv venv .venv-harbor
uv pip install -p .venv-harbor -e bench/harbor
```

## Run

```sh
export OPENROUTER_API_KEY=...   # or the key for whatever provider you use

.venv-harbor/bin/harbor run \
  -d terminal-bench@2.1 \
  -a claudette_harbor:Claudette \
  -m openrouter/openai/gpt-5-nano \
  --agent-kwarg version=feature/context-management \
  -n 1
```

- `--agent-kwarg version=<ref>` pins the claudette git ref (branch, tag,
  SHA) installed in the container; defaults to `main`. **Push before you
  run** — the container installs from GitHub, not your working tree.
- `-t <task-name>` runs a single task; omit for the whole dataset.
- Results land under `runs/` (harbor's default output dir).
