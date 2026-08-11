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
- Persistent JSON session storage in `data/sessions`
- `@relative/path` file expansion so prompts can inline workspace files
- A benchmark harness (`bench/`) that runs the same agent loop the CLI ships

## Setup

You need one provider key. Copy the example env file and add a key — `.env` is
autoloaded on start (and gitignored), so you don't re-export anything:

```bash
cp .env.example .env
# edit .env — the easiest is OPENROUTER_API_KEY (one key, every major provider)
```

A real shell env var still overrides `.env`. No key? Run a local model with
Ollama instead (bare model ids like `qwen2.5-coder:14b`). See
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

Inside the CLI, `Tab` completes slash commands and `@paths`, and `/help` lists
everything. The git-oriented commands are:

```text
/status               show branch + working tree state
/diff                 show the unstaged diff
/commit               write and run a git commit for the staged changes
/review               review the staged changes
```

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

## Tests

```bash
npm test           # the offline suite — what CI runs, ~60s, no key or GPU needed
npm run test:live  # adds the Stress suite, which drives a real local Ollama model
```

No dependencies to install; the offline suite drives a mock Ollama over loopback.
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

`/models` lists everything reachable (only providers whose key is set), and the
web UI dropdown mirrors it. **No Ollama needed** — cloud models work on their own.

### Supported providers

| Prefix | Provider | Key env |
| ------ | -------- | ------- |
| `openai/` | OpenAI | `OPENAI_API_KEY` |
| `anthropic/` | Anthropic (Claude) | `ANTHROPIC_API_KEY` |
| `google/` (`gemini/`) | Google Gemini | `GEMINI_API_KEY` |
| `xai/` (`grok/`) | xAI Grok | `XAI_API_KEY` |
| `mistral/` | Mistral | `MISTRAL_API_KEY` |
| `deepseek/` | DeepSeek | `DEEPSEEK_API_KEY` |
| `cohere/` | Cohere | `COHERE_API_KEY` |
| `perplexity/` (`pplx/`) | Perplexity | `PERPLEXITY_API_KEY` |
| `openrouter/` | **OpenRouter** (every major provider, one key) | `OPENROUTER_API_KEY` |
| `together/` | Together (hosting) | `TOGETHER_API_KEY` |
| `fireworks/` | Fireworks (hosting) | `FIREWORKS_API_KEY` |
| `groq/` | Groq (hosting, fast Llama) | `GROQ_API_KEY` |
| `hf/` (`huggingface/`) | HuggingFace router | `HF_TOKEN` |
| `ollama/` or bare | local Ollama | — |

### No local GPU? Use a hosting platform

If your machine can't run Ollama, point Claudette at a hosting platform. The
simplest is **OpenRouter** — one key reaches OpenAI, Anthropic, Google, Meta
Llama, Mistral, DeepSeek, and more:

```bash
export OPENROUTER_API_KEY=sk-or-...
node claudette.js --model openrouter/anthropic/claude-3.7-sonnet
node claudette.js --model openrouter/meta-llama/llama-3.3-70b-instruct
```

Llama (Meta/Facebook) and DeepSeek are reachable on `groq/`, `together/`,
`fireworks/`, `hf/`, or `openrouter/` without any local model. To use a local
OpenAI-compatible server instead (LM Studio, vLLM, llama.cpp), set
`OPENAI_BASE_URL` to its URL and address models with `openai/`.

Every provider above speaks the OpenAI Chat Completions format, so adding another
(or a private proxy) is a one-row change in `src/providers.js`. Anthropic and
Ollama use their own native APIs (`src/anthropic.js`, `src/ollama.js`).

## Environment

- `PORT`: server port, default `4321`
- `HOST`: bind host, default `127.0.0.1`
- `OLLAMA_BASE_URL`: Ollama API base URL, default `http://localhost:11434`
- `OLLAMA_HOST`: alternate Ollama API base URL env var, also supported
- Provider keys (each enables that provider when set): `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `XAI_API_KEY`,
  `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `COHERE_API_KEY`, `PERPLEXITY_API_KEY`,
  `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `GROQ_API_KEY`,
  `HF_TOKEN`
- Per-provider base-URL overrides (for proxies / local OpenAI-compatible servers):
  `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `DEEPSEEK_BASE_URL`, `GROQ_BASE_URL`,
  `HF_BASE_URL`, `OPENROUTER_BASE_URL`, `TOGETHER_BASE_URL`, `FIREWORKS_BASE_URL`,
  `GEMINI_BASE_URL`, `XAI_BASE_URL`, `MISTRAL_BASE_URL`, `COHERE_BASE_URL`,
  `PERPLEXITY_BASE_URL`
- `ANTHROPIC_MAX_TOKENS`: max output tokens for Anthropic responses, default `4096`
- `WORKSPACE_ROOT`: allowed root for `@file` expansion, default repo root

### Agent behaviour

- `CLAUDETTE_MAX_ITERATIONS`: tool iterations per turn, default `150` (`--max-iterations N`)
- `CLAUDETTE_ACT_NUDGE`: read-only tool calls before the agent is pushed to act, default `15`; `0` disables
- `CLAUDETTE_VERIFY_GATE`: `0` lets a turn finish without a passing build/test after editing
- `CLAUDETTE_AUTO_COMPACT` / `CLAUDETTE_COMPACT_TOKENS`: history compaction (`0` / default `60000`).
  Compaction archives the full history to `data/sessions/archive/` before summarising
- `CLAUDETTE_BASH_TIMEOUT` / `CLAUDETTE_BASH_OUTPUT_CHARS`: bash tool limits, default `120000` ms / `16000` chars
- `CLAUDETTE_NUM_CTX`: Ollama context window, default `32768`. Raise it for models
  that support more (qwen3.6 exposes 256k); Ollama's own default is 4096, which
  truncates an agent loop almost immediately, so one is always sent

Ctrl+C interrupts a running tool as well as the model request, so a hung
`npm run build` can be stopped without killing the session.

### Provider resilience

- `CLAUDETTE_MAX_RETRIES`: retries for rate limits and transient 5xx, default `2`.
  Backoff is exponential with jitter and honours `Retry-After`. A response that has
  already started streaming is never retried, so output can't be duplicated
- `CLAUDETTE_STALL_TIMEOUT`: give up when a provider sends nothing for this long,
  default `300000` ms; `0` waits indefinitely
- `CLAUDETTE_QUIET_RETRIES=1`: don't print the retry notice

### Web server

- `CLAUDETTE_MAX_BODY_BYTES`: request body cap, default `1048576` (1 MB); over it the
  server answers 413
- One turn per session at a time; a second concurrent POST gets 409. Closing the tab
  aborts the provider call instead of paying for a response nobody reads

The server binds loopback and has no authentication. `HOST=0.0.0.0` exposes an
unauthenticated agent to your LAN — don't.

> Note: `OPENAI_BASE_URL` / `OPENAI_API_BASE` no longer configure Ollama (that was
> a legacy fallback). `OPENAI_BASE_URL` now configures the OpenAI provider; use
> `OLLAMA_BASE_URL` for Ollama.
