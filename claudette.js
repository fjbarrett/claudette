#!/usr/bin/env node
/**
 * Claudette — terminal-first AI coding assistant
 *
 * Usage:
 *   node claudette.js                         # start in current directory
 *   node claudette.js --cwd /path/to/project  # set workspace
 *   node claudette.js --model qwen2.5-coder:32b
 *   node claudette.js -y                      # auto-approve all tool calls
 *   node claudette.js -p "fix the build"      # headless: one prompt, then exit
 *   node claudette.js --continue              # reattach to the newest session
 *   node claudette.js --resume <id>           # reattach to a specific session
 *   node claudette.js --json-ipc              # JSONL line protocol on stdin/stdout
 */
import './src/env-autoload.js'; // load .env before anything reads process.env
import { start } from './src/chat.js';

start().catch(err => {
  if (process.argv.includes('--json-ipc')) {
    console.log(JSON.stringify({ type: 'error', error: err.message }));
  } else {
    console.error('\x1b[31m✗ Fatal:\x1b[0m', err.message);
  }
  process.exit(1);
});
