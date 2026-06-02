#!/usr/bin/env node
/**
 * Claudette — terminal-first AI coding assistant backed by Ollama
 *
 * Usage:
 *   node claudette.js                         # start in current directory
 *   node claudette.js --cwd /path/to/project  # set workspace
 *   node claudette.js --model qwen2.5-coder:32b
 *   node claudette.js -y                      # auto-approve all tool calls
 */
import './src/env-autoload.js'; // load .env before anything reads process.env
import { start } from './src/chat.js';

start().catch(err => {
  console.error('\x1b[31m✗ Fatal:\x1b[0m', err.message);
  process.exit(1);
});
