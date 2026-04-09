#!/usr/bin/env node
/**
 * Ollama Code — Claude Code-style AI coding assistant backed by Ollama
 *
 * Usage:
 *   node ollama-code.js                         # start in current directory
 *   node ollama-code.js --cwd /path/to/project  # set workspace
 *   node ollama-code.js --model qwen2.5-coder:32b
 *   node ollama-code.js -y                      # auto-approve all tool calls
 */
import { start } from './src/chat.js';

start().catch(err => {
  console.error('\x1b[31m✗ Fatal:\x1b[0m', err.message);
  process.exit(1);
});
