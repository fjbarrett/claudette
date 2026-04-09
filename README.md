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

## Environment

- `PORT`: server port, default `4321`
- `HOST`: bind host, default `127.0.0.1`
- `OLLAMA_BASE_URL`: Ollama API base URL, default `http://127.0.0.1:11434`
- `WORKSPACE_ROOT`: allowed root for `@file` expansion, default repo root
