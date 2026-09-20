# Claudette

Claudette is a full-stack coding chat app with a terminal-first workflow. It runs
against any major LLM provider — OpenAI, Anthropic, Google Gemini, xAI, Mistral,
DeepSeek, Cohere, Perplexity — and hosting platforms (OpenRouter, Together,
Fireworks, Groq, HuggingFace), or local models via Ollama. No local GPU required.

## What it includes

- Local CLI with slash commands, tool use, and streamed chat
- Headless one-shot mode (`-p`) and a JSONL line protocol (`--json-ipc`) for scripts
- Browser dashboard with session history, model switching, streamed responses, and
  per-turn traces (chat and trace only — the tool-running agent is the CLI)
- Persistent JSON session storage (`<workspace>/.claudette/state/sessions` in a
  sandboxed macOS CLI; `data/sessions` otherwise)
- `@relative/path` file expansion so prompts can inline workspace files
- A benchmark harness (`bench/`) that runs the same agent loop the CLI ships

## Setup

You need one provider key. Copy the example into Claudette's trusted user config
and add a key:

```bash
mkdir -p ~/.config/claudette
cp .env.example ~/.config/claudette/.env
# edit ~/.config/claudette/.env — OPENROUTER_API_KEY is the easiest start
```

A real shell variable still wins. A Claudette source checkout can use its own
gitignored `.env`, but the project being edited cannot: workspace `.env` files
are intentionally ignored so untrusted code cannot alter approval policy,
provider endpoints, or tool-secret allowlists. Set
`CLAUDETTE_ENV_FILE=/trusted/path/claudette.env` to name another trusted file.
No key? Run a local model with Ollama instead (bare model ids like
`qwen2.5-coder:14b`). See
[Models & providers](#models--providers) for the full list.

## Run

```bash
npm start
```

Open `http://127.0.0.1:4321`.

In another terminal:

```bash
npm run cli
```

Use `/copy` to copy the last assistant message to your clipboard, preserving its
Markdown and line breaks. Linux requires `wl-copy`, `xclip`, or `xsel`.

Inside the CLI, `Tab` completes slash commands and `@paths`, and `/help` lists
everything. The git-oriented commands are:

Tool activity is visually separated from prompts and assistant replies. Bash,
writes, edits, denials, and failures stay explicit; consecutive successful
`read_file`, `list_dir`, `glob`, and `search_code` calls collapse into one
`Explored …` row. The exact tool-call/result messages remain in session JSON for
safe resume, while the human-readable transcript summarizes routine exploration.

```text
/status               show branch + working tree state
/diff                 show the unstaged diff
/commit               write and run a git commit for the staged changes
/review               review the staged changes
```

### Workspace confinement on macOS

The macOS CLI confines itself to the directory where it starts before loading
the application. The trusted launcher stays outside Seatbelt as a minimal Bash
broker, while the main Claudette process runs inside the workspace profile. A
private authenticated Node parent/child IPC channel lets the sandboxed process
request Bash; it cannot choose an executable, profile, environment, or arbitrary
working directory. The broker independently validates the canonical workspace
and cwd, scrubs the environment, and launches every command under exactly one
stricter Bash profile. No model-writable filesystem socket is involved.

Model tools cannot read or write outside the workspace, signal processes outside
their own command tree, send Apple Events, or move Bash to a parent directory. Model Bash can
reach loopback services but not external networks by default, and receives no
credential-like inherited environment variables. npm/npx wrappers, timeouts,
cancellation, and output limits are enforced by the broker. Sessions,
transcripts, temporary files, and dev-server logs stay below
`<workspace>/.claudette/`.

The sandbox is enabled by default, including with `--yolo`. If a build genuinely
needs one inherited variable, pass its exact name in a comma-separated allowlist,
for example `CLAUDETTE_TOOL_ENV_ALLOW=DATABASE_URL`. The emergency opt-out is
`CLAUDETTE_WORKSPACE_SANDBOX=0`; it removes the operating-system boundary and
should not be used for unattended or auto-approved sessions. When a build needs
remote packages or public APIs, add `--network` to that Claudette launch (or set
`CLAUDETTE_BASH_NETWORK=1`). This removes only the Bash egress denial; workspace
filesystem confinement, signal/AppleEvent denial, cwd validation, secret
scrubbing, timeouts, and the authenticated broker remain active. On macOS it
also grants exact read access to the system DNS resolver socket/configuration;
no broader host directory becomes readable. The enabled command can reach
public, private/LAN, and metadata endpoints, so use it only for workspaces and
prompts you trust. `fetch_url` remains separately SSRF-hardened.

When the workspace contains a conventional `.venv` or `venv`, Claudette places
its executable directory on model Bash's `PATH` and sets `VIRTUAL_ENV`
automatically. Commands such as `python3`, `python`, and `pip` therefore use the
project environment without an activation step. A PEP 668
`externally-managed-environment` error refers to the selected system Python; it
does not mean the workspace is read-only.

Bash runs with `pipefail`, so a failing command remains a failure when its output
is piped through another command. Tool output is already capped; run checks
directly instead of filtering them through `head` or `tail`.

### Running it without a terminal

```bash
claudette -p "why does the build fail?"     # one prompt, prints the answer, exits
claudette -p "fix the lint errors" -y       # …with tools auto-approved
claudette --continue                        # reattach to the newest session
claudette --resume 3f9a1c2b                 # reattach to a specific session
claudette --json-ipc                        # JSONL protocol on stdin/stdout
```

`-p` prints the reply and nothing else — no banner, spinner, or cost footer — so
`claudette -p "…" > answer.txt` gives you exactly the response. It exits non-zero
when the turn fails, so a script can branch on it.

## Use it from a script

```bash
npm install claudette      # or: npm link, from a clone
```

```js
import { run, stream, createAgent } from 'claudette';

// One turn, tools and all. `cwd` bounds structured filesystem tools. Use the
// macOS CLI when model-issued Bash also needs an operating-system boundary.
const { text, toolCalls, costUsd, status } = await run('fix the failing test', {
  cwd: './my-project',
  model: 'openrouter/openai/gpt-5-nano',   // or a bare Ollama id
  tools: true,
  allowShell: true,                     // allow test/build commands
});

// Watch it work.
for await (const ev of stream('audit src/auth.js for injection risks', { tools: true })) {
  if (ev.type === 'text') process.stdout.write(ev.text);
  if (ev.type === 'tool_call') console.error('→', ev.name, ev.args);
  if (ev.type === 'result') console.error('\ndone:', ev.status, ev.usage);
}

// Keep a conversation.
const agent = createAgent({ cwd: './my-project', tools: true, allowShell: true });
await agent.send('what does src/index.js export?');
await agent.send('add JSDoc to each of them');   // remembers the answer above
```

Filesystem tools are off by default; set `tools: true` to enable them and
`allowShell: true` to also allow Bash. Useful options include `approve: (name) => name !== 'bash'`
to gate enabled tools (default allows everything, since a script has nobody to ask),
`signal` to cancel, `maxIterations`, `system` / `append` to shape the prompt, and
`messages` to continue an earlier conversation.

Streams start when iteration begins. Breaking out of a `for await` loop cancels
the active turn and waits for cleanup before returning; a reusable agent stays
busy until that cleanup finishes. Abandoned streams do not update its history.

Lower-level pieces are exported too — `runAgent` (the loop, fully hookable),
`executeTool`, `chatStream`, `getModels` — for building something else on top.
TypeScript definitions ship in `index.d.ts`.

## Benchmarks

`bench/` is a private regression suite: worktree-isolated task runs, hard checks,
an LLM judge, and a leaderboard.

```bash
npm run bench -- --task <id> --model <provider/model> --judge <provider/model>
npm run bench:list
npm run bench:leaderboard
npm run eval -- --all --model <provider/model>   # fast in-process tool-usage evals
npm run eval -- --all --model <m> --json        # one JSON document, for comparing models
```

For comparable public numbers, claudette runs as a **Terminal-Bench 2.x agent**
through Harbor:

```bash
uv venv .venv-harbor --python "$(command -v python3)"   # must be a native arm64/x86_64 python
uv pip install -p .venv-harbor -e bench/harbor

.venv-harbor/bin/harbor run -d terminal-bench@2.0 \
  -a claudette_harbor:Claudette \
  -m ollama/qwen3.6:35b-a3b-opencode \
  --agent-kwarg version=main \
  -i openssl-selfsigned-cert -o bench/runs/harbor -n 1
```

The adapter installs claudette into the task container from a GitHub tarball, so
`version=` must name a pushed ref. A local `ollama/…` model works: the loopback
URL is rewritten to `host.docker.internal` so the container can reach Ollama on
the host, which makes benchmark runs free.

## Tests

```bash
npm test           # the offline suite — what CI runs, ~60s, no key or GPU needed
npm run test:live  # adds the Stress suite, which drives a real local Ollama model
npm run coverage   # Node 22/24: enforce 70% lines and 60% branches
npm ci --ignore-scripts  # install locked development tools
npm run typecheck  # strict public TypeScript API declarations + consumer fixture
```

The offline suite requires no dependency installation and drives a mock Ollama
over loopback. Type checking uses the pinned development-only TypeScript compiler;
it checks the public declarations, not every JavaScript implementation. Coverage
uses Node's built-in test runner and measures the source it loads. Node 20 can run
the suite but cannot enforce these coverage thresholds, so `coverage` fails with
an explanation on that version. CI enforces coverage on Node 24.

Test commands discover files without shell globs and preserve failure and
interruption exit codes. `npm run test:split` is a compatibility alias for the
same complete offline suite. Pass Node test options after `--`, for example
`npm test -- --test-name-pattern=clipboard`.

`test:live` is slow by nature — each prompt is a real generation, so a 27B model
turns it into a 40-minute run.

## Models & providers

Models are addressed `provider/model` (LiteLLM / terminal-bench style). The
provider prefix selects the backend; the rest is the model id (which may itself
contain slashes, e.g. HuggingFace/OpenRouter ids). A bare name with no known
prefix (or an explicit `ollama/`) routes to local Ollama.

```bash
export OPENAI_API_KEY=sk-...
node claudette.js --model openai/gpt-4o

export ANTHROPIC_API_KEY=sk-ant-...
node claudette.js --model anthropic/claude-opus-4-8   # legacy anthropic: still works
```

`/models` lists everything reachable under the active model policy, and the web
UI dropdown mirrors it. **No Ollama needed** — cloud models work on their own.
Switching with `/model` preserves the current conversation and tool history:

```text
/models
/model openrouter/<model>
/model groq/<model>
/model anthropic/<model>
```

To allow paid/direct routes as well as verified-free routes, configure the
providers you intend to use, restart Claudette, and keep every selected model
tool-capable:

```env
CLAUDETTE_FREE_TIER_ONLY=0
CLAUDETTE_REQUIRE_TOOLS=1
CLAUDETTE_MODEL_ROTATION=1
CLAUDETTE_MODEL_ROTATION_MAX=2
CLAUDETTE_MAX_RETRIES=0
```

Resume the same stored context with `claudette --continue`, or choose it with
`claudette --resume <session-id>`. Manual `/model` switching with rotation capped
at 2 is the predictable default. Automatic rotation resends the full conversation
to every attempted model; one observed turn consumed **114,157 tokens across five
models**. Free providers will eventually rate-limit, so paid routes or local
Ollama are needed for reliable uninterrupted continuation.

### Supported providers

| Prefix | Provider | Key env |
| ------ | -------- | ------- |
| `openai/` | OpenAI | `OPENAI_API_KEY` |
| `anthropic/` | Anthropic (Claude) | `ANTHROPIC_API_KEY` |
| `google/` (`gemini/`) | Google Gemini | `GEMINI_API_KEY` |
| `xai/` (`grok/`) | xAI Grok | `XAI_API_KEY` |
| `mistral/` | Mistral | `MISTRAL_API_KEY` |
| `deepseek/` | DeepSeek (direct API is billed) | `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY` |
| `cohere/` | Cohere | `COHERE_API_KEY` |
| `perplexity/` (`pplx/`) | Perplexity | `PERPLEXITY_API_KEY` |
| `openrouter/` | **OpenRouter** (every major provider, one key) | `OPENROUTER_API_KEY` |
| `together/` | Together (hosting) | `TOGETHER_API_KEY` |
| `fireworks/` | Fireworks (hosting) | `FIREWORKS_API_KEY` |
| `groq/` | Groq Free-plan GPT-OSS/Qwen hosting | `GROQ_API_KEY` |
| `hf/` (`huggingface/`) | HuggingFace router | `HF_TOKEN` / `HF_KEY` |
| `ollama/` or bare | local Ollama | — |

### Free-only, tool-capable mode

These hard boundaries are enabled by default (set an individual option to `0`
to opt out):

```bash
CLAUDETTE_FREE_TIER_ONLY=1
CLAUDETTE_REQUIRE_TOOLS=1
CLAUDETTE_ALWAYS_TRACK=1
CLAUDETTE_MODEL_ROTATION=1
CLAUDETTE_MODEL_ROTATION_MAX=2
```

Discovery, startup, `/model`, browser selection, and provider dispatch reject
any route that is not both verified free and natively tool-capable. A provider
key never counts as proof that a route is free. Direct DeepSeek, Anthropic, and
OpenAI routes are therefore blocked. DeepSeek can be used only when a currently
listed route such as `openrouter/deepseek/...:free` actually exists. Claudette
never silently falls through to a paid route.

When a provider fails or rate-limits a request before emitting any response
text, Claudette automatically rotates to another live free native-tool model.
Known coding routes follow the same practical ranking used at automatic startup
and in `/models`. For provider-wide quota/network failures, Claudette jumps to
the highest-ranked route on another provider first; routes that cannot accept
the estimated request size are skipped rather than sent a guaranteed failure.
Unknown routes retain provider-diverse fallback ordering.
Claudette records the failure and every attempted model, and makes the
successful fallback the session model for later tool iterations and prompts.
Two switches per turn are allowed by default. Rotation stops after output
begins so partial answers are never duplicated; if no alternate exists, the
ordinary bounded retry policy is used on the current model.

The current automatic order starts with the Ollama Cloud models validated across
the five-worker Farm matrix: Kimi K2.7 Code, DeepSeek V4 Pro, MiniMax M3, GLM
5.3, GLM 5.3 Flash, then GPT-OSS 120B. Existing OpenRouter/Groq fallbacks follow
in their prior order; GPT-OSS 20B Cloud stays behind them after scoring 3/11.
Missing, uninstalled, or no-longer-free routes are simply skipped because
selection is always intersected with the live free/native-tool catalog.

OpenRouter is discovered from its live catalog: only zero-price models whose
metadata includes `tools` are listed. Use its free feature-aware router or pick
an explicit route shown by `/models`:

```bash
claudette --model openrouter/free
/models
/model openrouter/nvidia/nemotron-3.5-lightning:free
```

Hugging Face free accounts receive a small monthly inference credit, but that is
not treated as a zero-price route. Claudette queries the live HF catalog and
exposes only provider routes explicitly marked `is_free` and tool-capable. If
none exist, HF remains absent rather than risking purchased credit.

Completed, failed, and cancelled turns are recorded locally in
`data/usage/usage.jsonl`; always-track mode prevents `CLAUDETTE_USAGE_LOG=0`
from disabling that record. Provider-reported token counts are the ground truth.

### No local GPU? Use a hosting platform

If your machine can't run Ollama, point Claudette at a hosting platform. The
simplest is **OpenRouter** — one key reaches many providers. In free-only mode,
use only the live zero-price routes shown by `/models`:

```bash
export OPENROUTER_API_KEY=sk-or-...
node claudette.js --model openrouter/free
```

Llama (Meta/Facebook) and DeepSeek are reachable on `groq/`, `together/`,
`fireworks/`, `hf/`, or `openrouter/` without any local model. To use a local
OpenAI-compatible server instead (LM Studio, vLLM, llama.cpp), set
`OPENAI_BASE_URL` to its URL and address models with `openai/`.

Every provider above speaks the OpenAI Chat Completions format, so adding another
(or a private proxy) is a one-row change in `src/providers.js`. Anthropic and
Ollama use their own native APIs (`src/anthropic.js`, `src/ollama.js`).

### Groq Free plan

With `GROQ_API_KEY` set, Claudette checks Groq's live model catalog and exposes
only the reviewed Free-plan coding models. It defaults to GPT-OSS 120B for agent
work and GPT-OSS 20B for judging/auxiliary calls:

```bash
npm run groq      # terminal UI
npm run groq:web  # browser UI at http://127.0.0.1:4321
node claudette.js --model groq/openai/gpt-oss-120b
node claudette.js --model groq/openai/gpt-oss-20b
node claudette.js --model groq/qwen/qwen3.8-27b
node claudette.js --model groq/qwen/qwen3.6-27b
```

The current base Free-plan limits for these models are 30 requests/minute,
1,000 requests/day, and 8,000 tokens/minute at the organization level. The
daily token limit is 200,000 for GPT-OSS and Qwen 3.6, and 2,000,000 for Qwen
3.8. Claudette prints Groq's remaining-token/request headers in the completion
footer when the API provides them. Groq rejects or throttles a request when any
bucket is exhausted; Claudette never falls back to a paid provider
automatically. Groq responses reserve at most 1,024 output tokens by default so
a small prompt fits the 8K TPM bucket; customize that reservation with
`GROQ_MAX_TOKENS`. Claudette also excerpts combined tool results to about 8,000
characters in the outbound Groq payload so several large file reads cannot make
the next request exceed Free TPM. Full results remain in local session JSON;
derived text transcripts omit successful routine read-only result bodies but
retain substantive tools and errors. Customize with `GROQ_TOOL_OUTPUT_CHARS`
(`0` disables it for a higher-tier account).

## Environment

- `CLAUDETTE_ENV_FILE`: explicit trusted configuration file; workspace `.env`
  files are never discovered automatically
- `PORT`: server port, default `4321`
- `HOST`: bind host, default `127.0.0.1`
- `CLAUDETTE_SERVER_TOKEN`: bearer token required by every browser API when set;
  mandatory for a non-loopback `HOST`
- `CLAUDETTE_ALLOWED_HOSTS`: comma-separated exact Host names; mandatory for a
  non-loopback `HOST` and enforced with Origin checks
- `OLLAMA_BASE_URL`: Ollama API base URL, default `http://localhost:11434`
- `OLLAMA_HOST`: alternate Ollama API base URL env var, also supported
- Provider keys (each enables that provider when set): `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `XAI_API_KEY`,
  `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY` (or `DEEPSEEK_KEY`), `COHERE_API_KEY`, `PERPLEXITY_API_KEY`,
  `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `GROQ_API_KEY`,
  `HF_TOKEN` (or `HF_KEY` / `HUGGINGFACE_API_KEY`)
- Per-provider base-URL overrides (for proxies / local OpenAI-compatible servers):
  `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `DEEPSEEK_BASE_URL`, `GROQ_BASE_URL`,
  `HF_BASE_URL`, `OPENROUTER_BASE_URL`, `TOGETHER_BASE_URL`, `FIREWORKS_BASE_URL`,
  `GEMINI_BASE_URL`, `XAI_BASE_URL`, `MISTRAL_BASE_URL`, `COHERE_BASE_URL`,
  `PERPLEXITY_BASE_URL`
- `ANTHROPIC_MAX_TOKENS`: max output tokens for Anthropic responses, default `4096`
- `GROQ_MAX_TOKENS`: max output tokens reserved per Groq response, default `1024`
- `GROQ_TPM_LIMIT`: Groq request preflight ceiling used during rotation, default `8000`
- `GROQ_TOOL_OUTPUT_CHARS`: combined outbound tool-result budget, default `8000`; `0` disables
- `OPENROUTER_MAX_TOKENS`: output reservation on free routes, default `1024`
- `OPENROUTER_TOOL_OUTPUT_CHARS`: combined outbound tool-result budget, default `12000`; `0` disables
- `HF_MAX_TOKENS`: output reservation for an eligible free HF route, default `1024`
- `WORKSPACE_ROOT`: allowed root for `@file` expansion, default repo root
- `CLAUDETTE_WORKSPACE_SANDBOX`: macOS CLI workspace confinement, default `1`;
  setting `0` disables the operating-system boundary
- `CLAUDETTE_BASH_NETWORK`: allow outbound model-issued Bash networking in the
  macOS sandbox, default `0`; equivalent to the explicit `--network` flag
- `CLAUDETTE_TOOL_ENV_ALLOW`: comma-separated inherited environment variable
  names model-issued Bash may receive; credential-like names are removed by default
- `CLAUDETTE_FREE_TIER_ONLY`: only verified free routes, default `1`
- `CLAUDETTE_REQUIRE_TOOLS`: only native tool-capable models, default `1`
- `CLAUDETTE_ALWAYS_TRACK`: force local per-turn usage logging, default `1`
- `CLAUDETTE_MODEL_ROTATION`: rotate after silent provider failures/rate limits, default `1`
- `CLAUDETTE_MODEL_ROTATION_MAX`: maximum model switches per turn, default `2`

### Agent behaviour

- `CLAUDETTE_MAX_ITERATIONS`: tool iterations per turn, default `150` (`--max-iterations N`)
- `CLAUDETTE_ACT_NUDGE`: read-only tool calls before the agent is pushed to act, default `15`; `0` disables
- `CLAUDETTE_VERIFY_GATE`: `0` lets a turn finish without a passing build/test after editing
- `CLAUDETTE_POST_VERIFY_GUARD`: extra tool calls allowed after a passing check
  without another edit, default `6`; two ignored nudges force one tools-disabled
  final-summary response; `0` disables
- `CLAUDETTE_LIST_DIR_MAX_ENTRIES`: broad directory-listing cap, default `200`,
  hard maximum `1000`; generated dependency/build/cache trees are not descended
  unless `list_dir` explicitly sets `include_generated`
- `CLAUDETTE_AUTO_COMPACT` / `CLAUDETTE_COMPACT_TOKENS`: history compaction (`0` / default `60000`).
  Compaction archives the full history below the active state directory before summarising
- `CLAUDETTE_BASH_TIMEOUT` / `CLAUDETTE_BASH_OUTPUT_CHARS`: bash tool limits, default `120000` ms / `16000` chars
- `CLAUDETTE_FETCH_TIMEOUT` / `CLAUDETTE_FETCH_MAX_BYTES`: `fetch_url` deadline
  and response cap, default `15000` ms / `1048576` bytes; every redirect is
  revalidated and the connection is pinned to a checked public DNS answer
- `CLAUDETTE_NUM_CTX`: Ollama context window, default `32768`. Raise it for models
  that support more (qwen3.6 exposes 256k); Ollama's own default is 4096, which
  truncates an agent loop almost immediately, so one is always sent

While a turn is running, ordinary text + Enter is queued for the next safe
boundary. To redirect immediately, type `/interrupt <new prompt>`: Claudette
visibly acknowledges it, aborts the active model request or foreground tool,
retains completed edits/tool results, then starts the injected prompt as the
next sequential turn. There is never a second concurrent agent loop.

Ctrl+C interrupts a running tool as well as the model request, so a hung
`npm run build` can be stopped without killing the session. Permission choices
also acknowledge `y`, `n`, or `a` immediately and show the approved command in
the running status line until it finishes. Typing prose at a y/n/a gate denies
that pending tool and immediately uses the prose as the redirect prompt; it no
longer waits in the safe queue behind the pending operation.

### Provider resilience

- Silent provider failures rotate through ranked eligible free native-tool
  models. Shared quota/network failures prefer another provider, and the
  current request size filters out Groq/context-limited routes that cannot fit;
  the CLI names skipped routes. Unranked routes retain provider-diverse ordering.
  `CLAUDETTE_MODEL_ROTATION=0` disables this; `CLAUDETTE_MODEL_ROTATION_MAX`
  bounds switches. Neither rotation nor retry occurs after output starts streaming.
- `CLAUDETTE_MAX_RETRIES`: same-model retries when rotation is disabled or no
  alternate exists, default `2`. Backoff is exponential with jitter and honours
  `Retry-After`
- `CLAUDETTE_STALL_TIMEOUT`: give up when a provider sends nothing for this long,
  default `300000` ms; `0` waits indefinitely
- `CLAUDETTE_QUIET_RETRIES=1`: don't print the retry notice

### Web server

- `CLAUDETTE_MAX_BODY_BYTES`: request body cap, default `1048576` (1 MB); over it the
  server answers 413
- One turn per session at a time; a second concurrent POST gets 409. Closing the tab
  aborts the provider call instead of paying for a response nobody reads

The server binds loopback by default. A non-loopback `HOST` is rejected unless
`CLAUDETTE_SERVER_TOKEN` and `CLAUDETTE_ALLOWED_HOSTS` are configured; every API
request then requires the bearer token and an allowed Host/Origin. Keep the token
out of the workspace and treat remote exposure as privileged access to an agent.

> Note: `OPENAI_BASE_URL` / `OPENAI_API_BASE` no longer configure Ollama (that was
> a legacy fallback). `OPENAI_BASE_URL` now configures the OpenAI provider; use
> `OLLAMA_BASE_URL` for Ollama.


## Project Instructions

Claudette loads `CLAUDE.md` and `CLAUDETTE.md` from the workspace root and parent directories (up to git root), parent-first so inner wins. `CLAUDETTE.md` augments/overrides `CLAUDE.md` when both exist.
