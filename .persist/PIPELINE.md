# Pipeline / Workflow

```
User (CLI or Browser)
    │
    ├── cli.js ──────────────────────────────────────────────────┐
    │   - REPL loop, slash commands, @file expansion             │
    │                                                            ▼
    └── public/ (Web UI) ──── HTTP/SSE ──► server.js ──► Ollama API (11434)
            index.html                      │               /api/chat (stream)
            styles.css                      │               /api/tags (models)
            app.js                          │
                                            └──► data/sessions/ (JSON files)
```

- `server.js` proxies all Ollama requests and manages session persistence
- `cli.js` talks directly to `server.js` endpoints
- Sessions stored as JSON in `data/sessions/`
- Streaming via SSE from server to web UI; readline stream in CLI
