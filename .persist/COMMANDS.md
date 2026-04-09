# Commands

| Command | Description |
|---------|-------------|
| `node ollama-code.js` | Start the Claude Code-like standalone CLI |
| `node ollama-code.js --model qwen2.5-coder:32b` | Start with a specific model |
| `node ollama-code.js --cwd /path/to/project` | Set workspace directory |
| `node ollama-code.js -y` | Auto-approve all tool calls (no prompts) |
| `npm run cli` | Alias for `node ollama-code.js` |
| `node server.js` | Start the legacy HTTP server + web UI on port 4321 |
| `curl http://127.0.0.1:4321/api/health` | Check legacy server health |
