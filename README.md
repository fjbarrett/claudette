# Claudette

Claudette is a local full-stack coding chat app with a terminal-first workflow, backed by Ollama.

## What it includes

- Browser UI with session history, model switching, and streamed responses
- Local CLI with slash commands and streamed chat
- Persistent JSON session storage in `data/sessions`
- `@relative/path` file expansion so prompts can inline workspace files

## Run

```bash
npm start
```

Open `http://127.0.0.1:4321`.

In another terminal:

```bash
npm run cli
```

Inside the CLI, the main git workflow commands are:

```text
/status               show branch + working tree state
/feature <name>       create and switch to feature/<name>
/save <message>       git add -A && git commit -m "<message>"
/publish              push the current branch to origin
/update               pull latest changes with --ff-only
```

## Cloud models (Anthropic)

Claudette can route to Anthropic's API alongside local Ollama models. Set an
API key and address a model with the `anthropic:` prefix:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node claudette.js --model anthropic:claude-opus-4-8
```

The provider is selected by the model id: `anthropic:*` ids go to the Anthropic
Messages API, everything else goes to Ollama. `/models` lists both, and the web
UI dropdown includes the Claude models when a key is set. If Ollama is not
running, Claudette still works with `anthropic:*` models.

Available ids: `anthropic:claude-opus-4-8`, `anthropic:claude-sonnet-4-6`,
`anthropic:claude-haiku-4-5`.

## Environment

- `PORT`: server port, default `4321`
- `HOST`: bind host, default `127.0.0.1`
- `OLLAMA_BASE_URL`: Ollama API base URL, default `http://localhost:11434`
- `OLLAMA_HOST`: alternate Ollama API base URL env var, also supported
- `OPENAI_BASE_URL`: accepted for compatibility; if it ends with `/v1`, the app strips that and uses the native Ollama routes
- `OPENAI_API_BASE`: accepted for compatibility; if it ends with `/v1`, the app strips that and uses the native Ollama routes
- `ANTHROPIC_API_KEY`: enables `anthropic:*` models (Claude via the Messages API)
- `ANTHROPIC_BASE_URL`: override the Anthropic API base, default `https://api.anthropic.com`
- `ANTHROPIC_MAX_TOKENS`: max output tokens for Anthropic responses, default `4096`
- `WORKSPACE_ROOT`: allowed root for `@file` expansion, default repo root
