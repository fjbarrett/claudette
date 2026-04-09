# PERSIST

---

## Context

**Last Updated:** 2026-04-08
**Stage:** Tested and bug-fixed
**Purpose:** Local Claude Code-style AI coding assistant CLI + web server backed by Ollama
**Structure:**
```
ollama-code.js    CLI entry point
server.js         HTTP API + static server
cli.js            Legacy CLI (uses server as backend)
src/
  chat.js         Main REPL, agent loop, text tool-call parser
  tools.js        Tool definitions + executors (bash/read_file/write_file/str_replace/glob/grep)
  session.js      Session CRUD (data/sessions/*.json)
  context.js      CLAUDE.md loader, @file expansion
  ollama.js       Ollama API client (getModels, chatStream)
  ui.js           ANSI terminal rendering, spinner
data/sessions/    Persisted session JSON files
public/           Web UI (index.html, styles.css, app.js)
test/test.js      Comprehensive test suite (96 tests)
```

---

## History

| Date | Agent | Action |
|------|-------|--------|
| 2026-04-08 | Claude | Wrote 96-test suite covering session, context, tools, server HTTP API, CLI commands, Ollama stress loop |
| 2026-04-08 | AI Agent | Wrote basic FizzBuzz function to workspace/fizzbuzz.py |

---

## Commands

| Command | Description |
|---------|-------------|
| `node ollama-code.js` | Start CLI (auto-selects best available model) |
| `node ollama-code.js --model <name>` | Start CLI with specific model |
| `node ollama-code.js -y` | Start CLI with auto-approve for all tool calls |
| `node server.js` | Start web server on port 4321 |
| `node --test test/test.js` | Run full test suite (96 tests, ~45s) |

---

## TODO

### Outstanding Tasks

### Feature Ideas
