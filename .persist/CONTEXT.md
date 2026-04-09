# Project Context

## Purpose
"Ollama Code Console" — a full-stack local app mimicking Claude Code CLI behavior but connecting to Ollama.

## Current State
Built and running. Server health check passed. Endpoint validation was in progress when interrupted.

## Structure
```
/home/frank/Code/test/
├── CLAUDE.md
├── README.md
├── package.json
├── server.js          # HTTP server, connects to Ollama at http://127.0.0.1:11434
├── cli.js             # CLI client
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js         # Web UI
├── data/
│   └── sessions/      # Saved session storage
└── .persist/
```
