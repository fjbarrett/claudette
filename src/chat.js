/**
 * Main REPL + agent loop.
 *
 * Agent loop (mirrors Claude Code's architecture):
 *   Input → expand @files → build messages → stream Ollama
 *   → if tool_calls: execute tools → loop
 *   → else: done
 */
import readline from 'node:readline/promises';
import { stdin, stdout, exit } from 'node:process';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { getModels, chatStream, missingCredential } from './provider.js';
import { TOOL_DEFS, executeTool } from './tools.js';
import { createSession, loadSession, saveSession, scheduleSessionSave, flushSessionSave, listSessions } from './session.js';
import { loadClaudeMd, expandFiles } from './context.js';
import * as ui from './ui.js';

const execFile = promisify(_execFile);

const jsonIpc = process.argv.includes('--json-ipc');

// ─── Mutable app state ────────────────────────────────────────────────────────

// Reasoning-effort levels accepted by --effort / /effort, in increasing depth.
// Passed through to providers that support it (Anthropic output_config.effort;
// OpenRouter/OpenAI reasoning_effort). null = unset = nothing sent.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function isValidEffort(value) {
  return EFFORT_LEVELS.includes(value);
}

// Flags/env that turn on auto-approval (no per-call permission prompts). `-y`
// is the original; the rest mirror the muscle memory of other CLIs.
export const BYPASS_FLAGS = ['-y', '--yes', '--yolo', '--bypass', '--dangerously-skip-permissions'];
export function resolveAutoApprove(argv = process.argv, env = process.env) {
  if (BYPASS_FLAGS.some(f => argv.includes(f))) return true;
  const v = env.CLAUDETTE_AUTO_APPROVE;
  return v != null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

let model      = null;
let session    = null;
let workspace  = process.cwd();
let toolsOn    = true;
let autoApprove = resolveAutoApprove();
let effort     = null;  // reasoning effort, or null when unset
let currentAC  = null;  // AbortController for active stream

// Permission memory: set of tool names or "bash:<cmd>" the user said "always" to
const alwaysAllow = new Set();

// ─── Entry point ──────────────────────────────────────────────────────────────
export async function start() {
  // Parse --cwd flag
  const cwdIdx = process.argv.indexOf('--cwd');
  if (cwdIdx !== -1 && process.argv[cwdIdx + 1]) {
    workspace = path.resolve(process.argv[cwdIdx + 1]);
  }

  // --model flag
  const modelIdx = process.argv.indexOf('--model');
  const modelArg = modelIdx !== -1 ? process.argv[modelIdx + 1] : null;

  // --effort flag (or CLAUDETTE_EFFORT env). Reject unknown levels up front so
  // a typo fails here, not as a provider 400 on the first message.
  const effortIdx = process.argv.indexOf('--effort');
  const effortArg = effortIdx !== -1 ? process.argv[effortIdx + 1] : process.env.CLAUDETTE_EFFORT;
  if (effortArg) {
    if (!isValidEffort(effortArg)) {
      ui.printError(`Unknown --effort "${effortArg}". Choose one of: ${EFFORT_LEVELS.join(', ')}.`);
      exit(1);
    }
    effort = effortArg;
  }

  // Connect to Ollama
  let models;
  try {
    models = await getModels();
    if (!models.length) throw new Error('No models available');
  } catch (err) {
    ui.printError(
      `No models available — add a provider key to get started:\n` +
      `  1. cp .env.example .env\n` +
      `  2. put one key in .env  (OPENROUTER_API_KEY is easiest — one key, every provider)\n` +
      `  3. claudette --model openrouter/anthropic/claude-3.7-sonnet\n` +
      `Or run a local model with Ollama (${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'}).\n` +
      `  ${err.message}`
    );
    exit(1);
  }
  // Prefer models known to support proper tool calling — iterate PREFERENCE order, not model list order
  const PREFERRED_MODELS = ['gemma4', 'qwen2.5-coder', 'qwen2.5', 'mistral', 'llama3.1', 'qwen3.5'];
  let defaultModel = models[0].name;
  for (const pref of PREFERRED_MODELS) {
    const found = models.find(m => m.name.includes(pref));
    if (found) { defaultModel = found.name; break; }
  }
  model = modelArg ?? process.env.OLLAMA_MODEL ?? defaultModel;

  // Fail fast on an explicit --model whose provider has no key, instead of
  // showing the banner and only erroring at the first message. Auto-selected
  // models are already credential-filtered, so this only guards --model.
  if (modelArg) {
    const missing = missingCredential([model]);
    if (missing) {
      ui.printError(suggestCredentialFix(missing));
      exit(1);
    }
  }

  // Create fresh session
  session = await createSession({ model, cwd: workspace });

  if (!jsonIpc) ui.printBanner({ model, cwd: workspace, sessionId: session.id, effort, autoApprove });

  // Handle Ctrl+C: cancel stream if running, else exit
  process.on('SIGINT', () => {
    if (currentAC) {
      currentAC.abort();
      currentAC = null;
      ui.stopSpinner();
      stdout.write(`\n${'\x1b[90m'}(cancelled)\x1b[0m\n`);
    } else {
      if (!jsonIpc) console.log('\n\x1b[90mGoodbye.\x1b[0m\n');
      exit(0);
    }
  });

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: !jsonIpc });

  // Main REPL loop
  while (true) {
    let line;
    try {
      if (jsonIpc) {
        console.log(JSON.stringify({ type: 'ready' }));
      }
      line = await rl.question(jsonIpc ? '' : '\x1b[35m\x1b[1m>\x1b[0m ');
    } catch {
      break; // Ctrl+D / EOF
    }

    line = line.trim();
    if (!line) continue;

    if (jsonIpc) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'prompt') {
          line = parsed.text;
        } else if (parsed.type === 'exit') {
          break;
        }
      } catch {
        // Fallback for non-JSON lines
      }
    }

    if (line.startsWith('/')) {
      const cont = await handleCommand(line, rl);
      if (!cont) break;
    } else if (line.startsWith('!')) {
      // Direct shell execution — bypass AI, run immediately
      const cmd = line.slice(1).trim();
      if (cmd) {
        try {
          const { stdout: out, stderr: err } = await execFile('sh', ['-c', cmd], { cwd: workspace });
          const combined = (out + err).trimEnd();
          if (combined) console.log('\n' + combined);
        } catch (err) {
          ui.printError(err.message);
        }
      }
    } else {
      await handleMessage(line, rl);
    }
  }

  rl.close();
  if (!jsonIpc) console.log('\n\x1b[90mGoodbye.\x1b[0m\n');
}

// ─── User message handler ─────────────────────────────────────────────────────
async function handleMessage(text, rl) {
  // Expand @file references
  const { text: expandedText, files } = await expandFiles(text, workspace, workspace);
  if (files.length) ui.printInfo(`Including: ${files.join(', ')}`);

  // Push to session history
  session.messages.push({ role: 'user', content: expandedText });
  if (session.title === 'New Session') session.title = text.slice(0, 60);
  void scheduleSessionSave(session);

  const exactCommand = extractExactBashCommand(expandedText);
  if (exactCommand) {
    await runExactBashShortcut(exactCommand);
    return;
  }

  // Warn when context is getting large
  const approxTokens = session.messages.reduce((acc, m) => {
    const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
    return acc + Math.ceil(len / 4);
  }, 0);
  if (approxTokens > 25_000) {
    ui.printWarning(`Context ~${Math.round(approxTokens / 1000)}k tokens — type /compact to compress history`);
  }

  // Load CLAUDE.md context
  const claudeMd = await loadClaudeMd(workspace);

  // Build full message list for Ollama
  const messages = [
    { role: 'system', content: buildSystemPrompt(claudeMd, effort) },
    ...session.messages,
  ];

  await agentLoop(messages, rl);
}

async function runExactBashShortcut(command) {
  ui.printToolCall('bash', { command });
  try {
    const output = await executeTool('bash', { command }, { cwd: workspace, workspace });
    ui.printToolResult('bash', output);
    const assistantMsg = 'Executed the exact bash command from the prompt.';
    session.messages.push({ role: 'assistant', content: assistantMsg });
    session.messages.push({ role: 'tool', content: output, name: 'bash' });
    await flushSessionSave(session);
  } catch (err) {
    ui.printToolResult('bash', err.message, true);
    session.messages.push({
      role: 'tool',
      content: `Exact-command shortcut failed: ${err.message}`,
      name: 'bash',
    });

    const claudeMd = await loadClaudeMd(workspace);
    const messages = [
      { role: 'system', content: buildSystemPrompt(claudeMd, effort) },
      ...session.messages,
      {
        role: 'user',
        content: `The exact bash command from the prompt failed.\nCommand:\n${command}\n\nError:\n${err.message}\n\nInspect the relevant file(s), repair the issue, and verify the task.`,
      },
    ];
    await agentLoop(messages, nullReadline());
  }
}

// ─── Agent loop ───────────────────────────────────────────────────────────────
async function agentLoop(messages, rl) {
  const tools = toolsOn ? TOOL_DEFS : [];
  let iteration = 0;
  const MAX_ITERATIONS = 20; // prevent runaway loops

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    if (jsonIpc) {
      console.log(JSON.stringify({ type: 'turn', iteration }));
    }
    const label = iteration === 1 ? 'Thinking' : 'Working';
    if (!jsonIpc) ui.startSpinner(label);

    const ac = new AbortController();
    currentAC = ac;

    // Pause readline so direct stdout.write() during streaming doesn't confuse it
    rl.pause();

    // When readline is paused, raw terminal mode means Ctrl+C sends \x03 to stdin
    // rather than generating SIGINT — process.on('SIGINT') won't fire. Listen directly.
    const ctrlCHandler = (chunk) => {
      if (chunk[0] === 0x03 && currentAC) {
        currentAC.abort();
        currentAC = null;
        ui.stopSpinner();
        stdout.write(`\n\x1b[90m(cancelled)\x1b[0m\n`);
      }
    };
    process.stdin.resume();
    process.stdin.on('data', ctrlCHandler);

    // Live streaming: stop spinner on first token, render deltas through the
    // incremental markdown stream (line-buffered so formatting is correct).
    let streamStarted = false;
    let mdStream = null;
    const onDelta = (delta) => {
      if (jsonIpc) {
        console.log(JSON.stringify({ type: 'delta', content: delta }));
        return; // IPC mode emits only JSONL — no terminal rendering
      }
      if (!streamStarted) {
        streamStarted = true;
        ui.stopSpinner();
        ui.printAssistantStart();
        mdStream = ui.createMarkdownStream();
      }
      mdStream.write(delta);
    };


    let result;
    try {
      result = await chatStream({
        model,
        messages,
        tools,
        signal: ac.signal,
        onDelta,
        ...(effort ? { effort } : {}),
      });
    } catch (err) {
      if (!jsonIpc) ui.stopSpinner();
      if (err.name === 'AbortError') return; // user cancelled
      if (jsonIpc) {
        console.log(JSON.stringify({ type: 'error', error: err.message }));
      } else {
        ui.printError(`Stream error: ${err.message}`);
      }
      return;
    } finally {
      process.stdin.removeListener('data', ctrlCHandler);
      currentAC = null;
      rl.resume(); // restore readline after streaming
    }

    if (!jsonIpc && !streamStarted) ui.stopSpinner();

    // ── Merge text-parsed tool calls with API tool calls ─────────────────────
    // Some models (qwen2.5-coder) emit some calls via API and others as JSON
    // text in the same response. We need both — text-parsed calls go first
    // since they appear earlier in the output.
    if (result.content) {
      const textParsed = parseTextToolCalls(result.content);
      if (textParsed.length) {
        if (!result.toolCalls?.length) {
          result.toolCalls = textParsed;
        } else {
          // Prepend text-parsed calls that aren't already covered by API calls
          const apiKeys = new Set(result.toolCalls.map(c => JSON.stringify(c.function)));
          const novel = textParsed.filter(c => !apiKeys.has(JSON.stringify(c.function)));
          result.toolCalls = [...novel, ...result.toolCalls];
        }
      }
    }

    // ── No tool calls → normal response, done ──────────────────────────────
    if (!result.toolCalls?.length) {
      if (!jsonIpc) {
        if (!streamStarted && result.content) {
          // Nothing was streamed (e.g. empty onDelta path) — render with markdown
          ui.printAssistantStart();
          ui.printAssistantMessage(result.content);
        } else if (streamStarted) {
          mdStream.end(); // flush a trailing partial line
          stdout.write('\n');
        }
        ui.printAssistantEnd({
          model,
          tokens: (result.promptTokens ?? 0) + (result.completionTokens ?? 0) || null,
        });
      }
      session.messages.push({ role: 'assistant', content: result.content });
      await flushSessionSave(session);
      if (jsonIpc) {
        console.log(JSON.stringify({ type: 'assistant', content: result.content }));
        console.log(JSON.stringify({ type: 'done', tokens: (result.promptTokens ?? 0) + (result.completionTokens ?? 0) }));
      }
      return;
    }

    // ── Tool calls ─────────────────────────────────────────────────────────
    if (!jsonIpc) {
      if (!streamStarted && result.content) {
        // Content wasn't streamed yet — render it before tool blocks
        ui.printAssistantStart();
        ui.printAssistantMessage(result.content);
        stdout.write('\n');
      } else if (streamStarted) {
        mdStream.end(); // flush a trailing partial line
        stdout.write('\n'); // newline after streamed text before tool blocks
      }
    }

    // Record assistant turn with tool_calls
    const assistantMsg = { role: 'assistant', content: result.content ?? '', tool_calls: result.toolCalls };
    messages.push(assistantMsg);
    session.messages.push(assistantMsg);
    if (jsonIpc) {
      console.log(JSON.stringify({ type: 'assistant', content: result.content ?? '', toolCalls: result.toolCalls }));
    }

    for (const call of result.toolCalls) {
      const { name, arguments: rawArgs } = call.function;
      let args;
      try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
      } catch {
        args = { raw: rawArgs };
      }

      if (jsonIpc) {
        console.log(JSON.stringify({ type: 'tool_call', name, arguments: args }));
      }

      // The permission prompt renders the call itself — printing the normal
      // tool-call line too showed the same call twice.
      if (!jsonIpc && !needsApproval(name, args)) ui.printToolCall(name, args);

      // Permission check
      const allowed = await checkPermission(name, args, rl);
      if (!allowed) {
        const denied = 'User denied permission for this operation.';
        ui.printWarning(denied);
        const deniedMsg = { role: 'tool', content: denied, ...(call.id ? { tool_call_id: call.id } : {}) };
        messages.push(deniedMsg);
        session.messages.push(deniedMsg);
        continue;
      }

      // Execute
      let toolResult;
      let isError = false;
      try {
        toolResult = String(await executeTool(name, args, { cwd: workspace, workspace }));
      } catch (err) {
        toolResult = `Error: ${err.message}`;
        isError = true;
      }

      if (jsonIpc) {
        console.log(JSON.stringify({ type: 'tool_result', name, result: toolResult, isError }));
      }

      if (!jsonIpc) ui.printToolResult(name, toolResult, isError);

      const resultMsg = { role: 'tool', content: toolResult, ...(call.id ? { tool_call_id: call.id } : {}) };

      messages.push(resultMsg);
      session.messages.push(resultMsg);
    }

    await flushSessionSave(session);
    // Loop continues → send tool results back to model
  }

  ui.printWarning(`Reached ${MAX_ITERATIONS} tool iterations — stopping to prevent runaway loop.`);
}

// ─── Permission check ─────────────────────────────────────────────────────────

// True when checkPermission would prompt the user (the prompt renders its own
// tool-call header, so the caller must not print one too).
function needsApproval(toolName, args) {
  // Read-only ops always allowed
  if (['read_file', 'list_dir', 'glob', 'grep', 'search_code', 'fetch_url'].includes(toolName)) return false;
  if (autoApprove) return false;

  const key = toolName === 'bash' ? `bash:${args.command}` : toolName;
  if (alwaysAllow.has(key) || alwaysAllow.has(toolName)) return false;
  return true;
}

async function checkPermission(toolName, args, rl) {
  if (!needsApproval(toolName, args)) return true;

  const detail = toolName === 'bash' ? args.command : JSON.stringify(args, null, 2);
  ui.printPermissionPrompt(toolName, detail);

  const raw = await rl.question(`  \x1b[90m[\x1b[0my\x1b[90m/\x1b[0mn\x1b[90m/\x1b[0ma\x1b[90m]\x1b[0m `);
  const a = raw.trim().toLowerCase();

  if (a === 'always' || a === 'a') {
    alwaysAllow.add(toolName); // allow all future calls to this tool type
    return true;
  }
  return a === 'y' || a === 'yes';
}

// ─── Slash command handler ────────────────────────────────────────────────────
async function handleCommand(line, rl) {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd) {
    // ── Navigation ──────────────────────────────────────────────────────────
    case '/exit':
    case '/quit':
      return false;

    case '/help':
      ui.table('Commands', [
        ['Setup & Config'],
        ['/model [name]',    'Show or switch the active model'],
        ['/models',          'List all available models (Ollama + cloud providers)'],
        ['/effort [level]',  'Show or set reasoning effort (low|medium|high|xhigh|max|off)'],
        ['/config',          'Show current configuration'],
        ['/tools',           'Toggle tool calling on/off'],
        ['/yolo',            'Toggle auto-approve (run tool calls without prompting)'],

        ['Session'],
        ['/session',         'Show current session info'],
        ['/sessions',        'List saved sessions'],
        ['/resume <id>',     'Resume a saved session (short ID ok)'],
        ['/clear',           'Start a new session with the same model'],
        ['/compact',         'Summarize + compress conversation history'],

        ['Files & Workspace'],
        ['/files [dir]',     'List files in workspace (or subdir)'],
        ['/add-dir <path>',  'Change the active workspace directory'],

        ['Git & Code'],
        ['/diff',            'Show git diff of workspace'],
        ['/status',          'Show git status'],
        ['/commit',          'Ask Claude to write and run a git commit'],
        ['/review',          'Review staged changes'],

        ['Info'],
        ['/cost',            'Estimate token usage for this session'],
        ['/vim',             'Toggle vim mode indicator'],
        ['/exit',            'Quit'],
      ]);
      return true;

    // ── Model ────────────────────────────────────────────────────────────────
    case '/model': {
      if (arg) {
        model = arg;
        session.model = model;
        await saveSession(session);
        ui.printSuccess(`Model → ${model}`);
        return true;
      }
      // fall through to /models display
    }
    // eslint-disable-next-line no-fallthrough
    case '/models': {
      const list = await getModels().catch(err => { ui.printError(err.message); return []; });
      ui.table('Available Models', list.map(m => [m.name, `${m.paramSize.padEnd(8)} ${m.family}`]));
      if (cmd === '/model') ui.printInfo(`Current: ${model}  |  /model <name> to switch`);
      return true;
    }

    // ── Config ───────────────────────────────────────────────────────────────
    case '/config':
      ui.table('Config', [
        ['model',       model],
        ['effort',      effort ?? 'default (unset)'],
        ['workspace',   workspace],
        ['session',     session.id.slice(0, 8)],
        ['tools',       toolsOn ? 'enabled' : 'disabled'],
        ['auto-approve', String(autoApprove)],
        ['ollama',      process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'],
      ]);
      return true;

    case '/tools':
      toolsOn = !toolsOn;
      ui.printInfo(`Tool calling ${toolsOn ? 'enabled' : 'disabled'}`);
      return true;

    case '/effort': {
      if (!arg) {
        ui.printInfo(`Reasoning effort: ${effort ?? 'default (unset)'}  |  /effort <${EFFORT_LEVELS.join('|')}|off>`);
        return true;
      }
      if (arg === 'off' || arg === 'none' || arg === 'default') {
        effort = null;
        ui.printSuccess('Reasoning effort → default (unset)');
        return true;
      }
      if (!isValidEffort(arg)) {
        ui.printError(`Unknown effort "${arg}". Choose one of: ${EFFORT_LEVELS.join(', ')}, or off.`);
        return true;
      }
      effort = arg;
      ui.printSuccess(`Reasoning effort → ${effort}`);
      return true;
    }

    case '/yolo':
    case '/bypass':
      autoApprove = !autoApprove;
      if (autoApprove) ui.printWarning('Auto-approve ON — tool calls run without asking. Use with care.');
      else ui.printInfo('Auto-approve OFF — tool calls will prompt for permission.');
      return true;

    // ── Sessions ─────────────────────────────────────────────────────────────
    case '/session':
      ui.table('Current Session', [
        ['id',       session.id],
        ['title',    session.title],
        ['model',    session.model],
        ['messages', String(session.messages.length)],
        ['cwd',      session.cwd],
        ['updated',  session.updatedAt],
      ]);
      return true;

    case '/sessions': {
      const all = await listSessions();
      if (!all.length) { ui.printInfo('No saved sessions.'); return true; }
      ui.table('Sessions', all.map(s => [
        s.id.slice(0, 8),
        `${(s.model ?? '?').padEnd(22)} ${String(s.count).padStart(3)}msg  ${s.title}`,
      ]));
      return true;
    }

    case '/resume':
    case '/use': {
      if (!arg) { ui.printWarning(`Usage: ${cmd} <session-id>`); return true; }
      try {
        session = await loadSession(arg);
        model = session.model ?? model;
        workspace = session.cwd ?? workspace;
        ui.printSuccess(`Resumed: ${session.id.slice(0, 8)} — ${session.title}`);
      } catch (err) {
        ui.printError(err.message);
      }
      return true;
    }

    case '/new':
    case '/clear': {
      session = await createSession({ model, cwd: workspace });
      ui.printSuccess(`New session: ${session.id.slice(0, 8)}`);
      return true;
    }

    case '/compact': {
      if (session.messages.length < 4) {
        ui.printInfo('Session is too short to compact.');
        return true;
      }
      ui.printInfo('Compacting…');
      try {
        const summary = await summariseMessages(session.messages);
        session.messages = [{ role: 'user', content: `[Conversation summary]: ${summary}` }];
        await flushSessionSave(session);
        ui.printSuccess('Compacted — history replaced with summary.');
      } catch (err) {
        ui.printError(`Compact failed: ${err.message}`);
      }
      return true;
    }

    // ── Files ────────────────────────────────────────────────────────────────
    case '/files': {
      const dir = arg ? path.resolve(workspace, arg) : workspace;
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        const rows = entries
          .filter(e => !e.name.startsWith('.') || e.name === '.persist' || e.name === '.claude')
          .sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name))
          .map(e => [e.isDirectory() ? `${e.name}/` : e.name, e.isDirectory() ? '(dir)' : '']);
        ui.table(path.relative(process.cwd(), dir) || '.', rows);
      } catch (err) {
        ui.printError(err.message);
      }
      return true;
    }

    case '/add-dir': {
      if (!arg) { ui.printWarning('Usage: /add-dir <path>'); return true; }
      const target = path.resolve(workspace, arg);
      try {
        const stat = await fsp.stat(target);
        if (!stat.isDirectory()) throw new Error('Not a directory');
        workspace = target;
        session.cwd = workspace;
        await flushSessionSave(session);
        ui.printSuccess(`Workspace → ${workspace}`);
      } catch (err) {
        ui.printError(err.message);
      }
      return true;
    }

    // ── Git ──────────────────────────────────────────────────────────────────
    case '/status': {
      try {
        const { stdout: out } = await execFile('git', ['status', '--short'], { cwd: workspace });
        console.log('\n' + (out.trim() || '(clean working tree)'));
      } catch { ui.printError('Not a git repo or git unavailable.'); }
      return true;
    }

    case '/diff': {
      try {
        const { stdout: out } = await execFile('git', ['diff'], { cwd: workspace });
        console.log('\n' + (out.trim() || '(no unstaged changes)'));
      } catch { ui.printError('Not a git repo or git unavailable.'); }
      return true;
    }

    case '/commit':
      await handleMessage(
        'Look at the staged git changes with `git diff --staged`. Write a concise commit message, then run `git commit -m "..."`. Follow conventional commits if applicable.',
        rl
      );
      return true;

    case '/review':
      await handleMessage(
        'Review the current staged changes (`git diff --staged`). Look at the files changed, check for bugs, code quality issues, and suggest improvements.',
        rl
      );
      return true;

    // ── Info ─────────────────────────────────────────────────────────────────
    case '/cost': {
      const approxTokens = session.messages.reduce((acc, m) => {
        const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
        return acc + Math.ceil(len / 4);
      }, 0);
      ui.table('Session Cost Estimate', [
        ['messages',      String(session.messages.length)],
        ['approx tokens', `~${approxTokens.toLocaleString()}`],
        ['model',         model],
      ]);
      return true;
    }

    case '/vim':
      ui.printInfo('Vim mode is cosmetic — readline keybindings active (Ctrl+A, Ctrl+E, etc.)');
      return true;

    default:
      ui.printWarning(`Unknown command: ${cmd}  (type /help)`);
      return true;
  }
}

// ─── Text-based tool call parser (fallback for models that don't use the API) ─
// Handles models like llama3.2 that output tool calls as JSON text content.
const TOOL_ALIASES = {
  // bash aliases
  run: 'bash', execute: 'bash', shell: 'bash', cmd: 'bash', command: 'bash', bash_cmd: 'bash',
  run_bash: 'bash', run_command: 'bash', run_shell: 'bash',
  // read aliases
  read: 'read_file', cat: 'read_file', open: 'read_file', open_file: 'read_file', file_read: 'read_file',
  // write aliases
  write: 'write_file', create: 'write_file', create_file: 'write_file', file_write: 'write_file',
  // str_replace aliases
  edit: 'str_replace', replace: 'str_replace', modify: 'str_replace', patch: 'str_replace',
  // glob aliases
  list: 'glob', find: 'glob', find_files: 'glob', list_files: 'glob', search_files: 'glob',
  // search aliases
  search: 'search_code', grep: 'search_code', find_in_files: 'search_code', grep_files: 'search_code',
};

// Tools that are really interpreters — map to bash and prepend interpreter name
const INTERPRETER_TOOLS = {
  python3: 'python3', python: 'python3', node: 'node', ruby: 'ruby',
  perl: 'perl', sh: 'sh', bash_run: 'bash',
};

function normalizeToolName(raw) {
  const lower = raw.toLowerCase().replace(/[\s-]/g, '_');
  if (TOOL_ALIASES[lower]) return TOOL_ALIASES[lower];
  // Fuzzy: if any known tool name is a substring match
  const known = ['bash', 'read_file', 'write_file', 'str_replace', 'glob', 'grep'];
  for (const t of known) if (lower.includes(t.replace('_', '')) || lower.includes(t)) return t;
  // Fuzzy against aliases keys
  for (const [alias, tool] of Object.entries(TOOL_ALIASES)) {
    if (lower.includes(alias)) return tool;
  }
  return raw; // return as-is if no match
}

// Canonical param names — keyed by tool so ambiguous shorthands (e.g. 's') resolve correctly
const PARAM_ALIASES_BY_TOOL = {
  read_file:  { p: 'path', f: 'path', fp: 'path', filepath: 'path', filename: 'path',
                file: 'path', file_path: 'path', s: 'path', src: 'path', source: 'path' },
  write_file: { p: 'path', f: 'path', fp: 'path', filepath: 'path', filename: 'path',
                file: 'path', file_path: 'path', contents: 'content', text: 'content', data: 'content' },
  str_replace: { p: 'path', f: 'path', filepath: 'path', file: 'path', file_path: 'path',
                 old: 'old_str', old_string: 'old_str', original: 'old_str', search: 'old_str', s: 'old_str',
                 new: 'new_str', new_string: 'new_str', replacement: 'new_str', replace: 'new_str', r: 'new_str' },
  bash:       { cmd: 'command', shell_command: 'command', bash_command: 'command' },
  glob:       { glob_pattern: 'pattern', file_pattern: 'pattern' },
  grep:       { regex: 'pattern', query: 'pattern', dir: 'path', directory: 'path' },
};
// Fallback aliases applied when no tool-specific entry matches
const PARAM_ALIASES_COMMON = {
  p: 'path', f: 'path', filepath: 'path', filename: 'path', file_path: 'path',
  glob_pattern: 'pattern', file_pattern: 'pattern',
  regex: 'pattern', query: 'pattern', dir: 'path', directory: 'path',
};

function normalizeArgs(args, toolName) {
  const toolTable = PARAM_ALIASES_BY_TOOL[toolName] ?? {};
  const cleaned = {};
  for (const [k, v] of Object.entries(args)) {
    const key = k.toLowerCase();
    const normKey = toolTable[key] ?? PARAM_ALIASES_COMMON[key] ?? k;
    if (typeof v === 'string') {
      // Fix single-element list-wrapped values: "['ls -la']" → "ls -la"
      const listMatch = v.match(/^\[['"]([^'"]+)['"]\]$/);
      if (listMatch) {
        cleaned[normKey] = listMatch[1];
      } else {
        // Try to parse as JSON array and join with space: ['python3', 'file.py'] → 'python3 file.py'
        try {
          const parsed = JSON.parse(v.replace(/'/g, '"'));
          if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
            cleaned[normKey] = parsed.join(' ');
          } else {
            cleaned[normKey] = v;
          }
        } catch {
          cleaned[normKey] = v;
        }
      }
    } else if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
      // Handle actual array values: join with space
      cleaned[normKey] = v.join(' ');
    } else {
      cleaned[normKey] = v;
    }
  }
  return cleaned;
}

// Escape literal control characters inside JSON string values so JSON.parse accepts them.
// Models like qwen2.5-coder write multi-line file content with literal \n/\t in JSON strings.
function sanitizeJsonControls(s) {
  let inStr = false, esc = false, out = '';
  for (const c of s) {
    if (esc)              { esc = false; out += c; continue; }
    if (c === '\\' && inStr) { esc = true; out += c; continue; }
    if (c === '"')        { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if      (c === '\n') { out += '\\n'; continue; }
      else if (c === '\r') { out += '\\r'; continue; }
      else if (c === '\t') { out += '\\t'; continue; }
      else if (c === '\b') { out += '\\b'; continue; }
      else if (c === '\f') { out += '\\f'; continue; }
    }
    out += c;
  }
  return out;
}

function extractJsonObjects(text) {
  // Brace-counting extractor — handles any nesting depth, respects strings
  const results = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue; }
    let depth = 0, inStr = false, esc = false, j = i;
    while (j < text.length) {
      const c = text[j];
      if (esc)                          { esc = false; }
      else if (c === '\\' && inStr)     { esc = true; }
      else if (c === '"')               { inStr = !inStr; }
      else if (!inStr && c === '{')     { depth++; }
      else if (!inStr && c === '}')     { depth--; if (depth === 0) { results.push(text.slice(i, j + 1)); break; } }
      j++;
    }
    i = j + 1;
  }
  return results;
}

function parseTextToolCalls(text) {
  // Strip markdown code fences
  const stripped = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1').trim();

  const calls = [];
  // Try the whole text, then each individual JSON object found
  const candidates = [stripped, ...extractJsonObjects(stripped)];

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(sanitizeJsonControls(candidate));
      const wrappedCalls = obj.tool_calls ?? obj.calls;
      if (Array.isArray(wrappedCalls)) {
        for (const wrapped of wrappedCalls) {
          const inner = wrapped.function ?? wrapped.tool ?? wrapped;
          if (typeof inner?.name !== 'string') continue;
          const toolName = normalizeToolName(inner.name);
          const rawArgs = inner.arguments ?? inner.parameters ?? inner.args ?? {};
          const args = typeof rawArgs === 'object' && rawArgs !== null
            ? normalizeArgs(rawArgs, toolName)
            : rawArgs;
          calls.push({ function: { name: toolName, arguments: args } });
        }
        continue;
      }

      // Must have a name field and arguments or parameters
      if (typeof obj.name !== 'string') continue;
      const rawArgs = obj.arguments ?? obj.parameters ?? obj.args ?? {};
      if (typeof rawArgs !== 'object') continue;

      // Check if this is an interpreter invocation (e.g. python3, node)
      const lowerName = obj.name.toLowerCase();
      const interp = INTERPRETER_TOOLS[lowerName];
      if (interp) {
        const fileArg = rawArgs.command ?? rawArgs.file ?? rawArgs.file_name ?? rawArgs.script ?? rawArgs.path ?? '';
        calls.push({ function: { name: 'bash', arguments: { command: `${interp} ${fileArg}`.trim() } } });
        continue;
      }

      const toolName = normalizeToolName(obj.name);
      const args = normalizeArgs(rawArgs, toolName);
      calls.push({ function: { name: toolName, arguments: args } });
    } catch { /* keep trying */ }
  }

  // Deduplicate by stringified identity (whole-text parse can overlap with extracted objects)
  const seen = new Set();
  return calls.filter(c => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractExactBashCommand(text) {
  // Accept either a space or a newline after the colon: when the prompt is fed
  // over stdin, readline splits on embedded newlines, so the command must be
  // able to ride on the same line as the instruction.
  const match = String(text ?? '').match(/Call bash with EXACTLY this command \(copy character-for-character, do not modify anything\):\s+([\s\S]+)/);
  return match?.[1]?.trim() || null;
}

function buildSystemPrompt(claudeMd, effort) {
  const lines = [
    'You are Ollama Code, an AI coding assistant running in the terminal.',
    'You have access to tools: bash, read_file, write_file, str_replace, patch_file, list_dir, glob, grep, search_code, fetch_url.',
    'Guidelines:',
    '- Always read files before editing them.',
    '- Prefer patch_file or str_replace for targeted edits over rewriting whole files.',
    '- Be concise. When writing code, provide complete working implementations.',
    '- Use tools proactively to explore the codebase before making changes.',
    '- Run tests or linters after making changes when they exist.',
    '- All file paths must be relative to the workspace root — never use /tmp or absolute paths outside the workspace.',
    '- To run a file, use bash with e.g. {"command": "python3 fizzbuzz.py"} — run it in the workspace, not a copy.',
    '- Never describe or summarize a file\'s contents without reading it first with read_file. Do not guess.',
    '- For large files, use read_file with offset and limit to read specific line ranges (e.g. {"path":"foo.js","offset":100,"limit":50}).',
    '- When asked about a directory or project, read README.md or key source files — do not invent descriptions.',
    '- Use list_dir for directory inspection and search_code for repo-wide searches when possible.',
    '- If the prompt says to call bash with EXACTLY a given command, do that first without modifying the command.',
    '- Do not read or edit CLAUDE.md, PERSIST.md, or docs unless the prompt explicitly asks for those files.',
    '- Do not run git add, git commit, git push, or create branches unless the prompt explicitly asks for git actions.',
    '- If a tool call fails because a file is missing, use the filenames named in the prompt before trying unrelated files.',
  ];
  // Let the model answer "what effort am I on?" — it has no other introspection.
  if (effort) {
    lines.push(
      `- Your reasoning effort is set to "${effort}" (one of ${EFFORT_LEVELS.join('/')}). ` +
      `If asked what effort or reasoning level you are running at, answer "${effort}".`
    );
  }
  if (claudeMd) {
    lines.push('', '--- Project Instructions ---', claudeMd);
  }
  return lines.join('\n');
}

function nullReadline() {
  return {
    pause() {},
    resume() {},
    async question() { return 'n'; },
  };
}

/**
 * Build the startup error shown when an explicit --model names a provider with
 * no API key. `missing` is the {model, env, label} from missingCredential().
 * When an OpenRouter key IS present, point the user at routing the same model
 * through OpenRouter (their working path) instead of just naming the missing key.
 */
export function suggestCredentialFix(missing, env = process.env) {
  const lines = [
    `${missing.label} model "${missing.model}" needs ${missing.env}, which is not set.`,
  ];
  // `provider/model` → drop the leading provider segment to get the bare id.
  const slash = missing.model.indexOf('/');
  const bare = slash === -1 ? missing.model : missing.model.slice(slash + 1);

  if (env.OPENROUTER_API_KEY) {
    lines.push(
      `You have an OpenRouter key set — route this model through it instead:`,
      `  --model openrouter/${missing.label.toLowerCase()}/${bare}`,
      `(OpenRouter uses its own model slugs — run /models or see openrouter.ai/models for the exact id.)`,
    );
  } else {
    lines.push(
      `Add ${missing.env} to .env, or use a provider you have a key for.`,
      `Easiest: put OPENROUTER_API_KEY in .env (one key, every provider), then`,
      `  --model openrouter/${missing.label.toLowerCase()}/${bare}`,
    );
  }
  return lines.join('\n');
}

// Reused by bench/evals.js so its agent loop merges text-emitted tool calls
// exactly the way the interactive CLI does.
export { parseTextToolCalls };

export const __test_parseTextToolCalls = parseTextToolCalls;
export const __test_extractExactBashCommand = extractExactBashCommand;

async function summariseMessages(messages) {
  const transcript = messages
    .slice(-40) // cap at recent 40 for summarisation
    .map(m => {
      const role = m.role.toUpperCase();
      const content = typeof m.content === 'string' ? m.content.slice(0, 800) : '[tool data]';
      return `${role}: ${content}`;
    })
    .join('\n---\n');

  let summary = '';
  await chatStream({
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'user',
        content: `Summarise this conversation in 4–6 sentences. Keep key decisions, code written, file paths, and the current state of the task:\n\n${transcript}`,
      },
    ],
    tools: [],
    onDelta: d => { summary += d; },
  });
  return summary.trim();
}
