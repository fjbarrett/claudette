# Ollama Code Console

Local full-stack coding chat app with a Claude Code-style terminal workflow, backed by Ollama.

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

## Environment

- `PORT`: server port, default `4321`
- `HOST`: bind host, default `127.0.0.1`
- `OLLAMA_BASE_URL`: Ollama API base URL, default `http://localhost:11434`
- `OLLAMA_HOST`: alternate Ollama API base URL env var, also supported
- `OPENAI_BASE_URL`: accepted for compatibility; if it ends with `/v1`, the app strips that and uses the native Ollama routes
- `OPENAI_API_BASE`: accepted for compatibility; if it ends with `/v1`, the app strips that and uses the native Ollama routes
- `WORKSPACE_ROOT`: allowed root for `@file` expansion, default repo root
