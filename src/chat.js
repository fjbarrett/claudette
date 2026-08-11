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
import { TOOL_DEFS } from './tools.js';
import { createSession, loadSession, saveSession, scheduleSessionSave, flushSessionSave, listSessions, archiveMessages } from './session.js';
import { flushTranscripts } from './transcript.js';
import { loadClaudeMd, expandFiles } from './context.js';
import { parseTextToolCalls } from './tool-call-parser.js';
import { runAgent, resolveMaxIterations } from './agent-runner.js';
import { createTurnTrace, truncateLine } from './trace.js';
import { estimateCost, formatUsd, formatTokens } from './cost.js';
import { InputController, buildFollowUpMessage, createInputAssembler, sanitizeUserInput, createBurstReader, createLineQueue } from './input.js';
import { recordTurnUsage } from './usage.js';
import { loadHistory, appendHistory } from './history.js';
import { createCompleter } from './completion.js';
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

// The loop itself lives in agent-runner.js so the CLI, the eval harness, and
// future subagents all run the same agent. Re-exported here because this module
// has been the public surface for them since before the extraction.
export {
  resolveMaxIterations, resolveActNudge, createActNudger,
  resolveVerifyGate, looksLikeVerification, buildVerifyNudge,
  dropOrphanToolMessages,
} from './agent-runner.js';

// Turn a raw provider stream error into an actionable message. The usage logs
// showed turns failing instantly (tools=0, in=0) on typo'd model slugs
// (e.g. openrouter/openai/gpt-54-mini) with only a generic "Stream error", which
// led to the same typo being retried — so detect model-not-found errors and
// point at the fix (the slug / /models) instead.
export function explainStreamError(err, model) {
  const msg = err?.message ? String(err.message) : String(err);
  const low = msg.toLowerCase();
  const badModel =
    /not a valid model|no endpoints found|model_not_found|unknown model|no such model|does not exist/.test(low) ||
    (low.includes('model') && (low.includes('not found') || low.includes('invalid') || low.includes('404')));
  if (badModel) {
    return `Model "${model}" was rejected by the provider — check the slug ` +
      `(run /models, or set a valid one with /model <provider/model>).\n  ${msg}`;
  }
  return `Stream error: ${msg}`;
}

let model      = null;
let session    = null;
let workspace  = process.cwd();
let toolsOn    = true;
let autoApprove = resolveAutoApprove();
let effort     = null;  // reasoning effort, or null when unset
let currentAC  = null;  // AbortController for active stream
let sessionInput = new InputController(); // follow-up queue for mid-run steering

// Permission memory: set of tool names or "bash:<cmd>" the user said "always" to
const alwaysAllow = new Set();

// Read one prompt from the idle REPL, coalescing a pasted multi-line block into a
// single submission. readline emits one 'line' per newline, so without this a
// paste (a stack trace, a build log) fragments into N prompts — the first lines
// even getting misread as slash/`!` commands. Lines arriving within a short burst
// are joined; a real pause flushes. Rejects on stream close (Ctrl+D / EOF).
function readCoalescedPrompt(rl, promptStr, { flushMs = 40 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => { if (settled) return; settled = true; teardown(); fn(val); };
    function teardown() {
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
    }
    const reader = createBurstReader({ flushMs, onPrompt: (text) => finish(resolve, text) });
    const onLine = (l) => reader.push(l);
    // EOF (Ctrl+D / piped `echo … | claudette` / heredoc): flush any buffered line
    // first so a prompt submitted right before close isn't dropped, THEN reject.
    const onClose = () => { reader.flush(); finish(reject, new Error('EOF')); };
    rl.on('line', onLine);
    rl.once('close', onClose);
    rl.setPrompt(promptStr);
    rl.prompt();
  });
}

/** Value following a flag on argv, or null when the flag is absent/bare. */
function flagValue(flag, argv = process.argv) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : null;
}

/** Most recently updated saved session — what `--continue` reattaches to. */
async function loadLatestSession() {
  const all = await listSessions();
  if (!all.length) throw new Error('no saved sessions to continue');
  return loadSession(all[0].id);
}

/**
 * One prompt, one answer, exit — `claudette -p "…"`. Runs the same agent as the
 * REPL (tools, permissions via auto-approve, trace, usage log), then flushes.
 * Exits non-zero when the turn failed, so a script can branch on it.
 */
async function runHeadless(prompt) {
  const rl = { pause() {}, resume() {}, async question() { return 'n'; } };
  await handleMessage(prompt, rl);
  await flushSessionSave(session);
  await flushTranscripts();
  const last = session.turns?.[session.turns.length - 1];
  if (last?.status === 'failed') exit(1);
}

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

  // --resume <id> / --continue: pick up an existing conversation instead of
  // starting cold. `/resume` already existed inside the REPL, but reattaching
  // meant launching, reading /sessions, and typing the id every time.
  const resumeArg = flagValue('--resume');
  const wantsContinue = process.argv.includes('--continue') || process.argv.includes('-c');
  session = null;
  if (resumeArg || wantsContinue) {
    try {
      session = resumeArg ? await loadSession(resumeArg) : await loadLatestSession();
      model = modelArg ?? session.model ?? model;
      workspace = session.cwd ?? workspace;
      if (!jsonIpc) ui.printInfo(`Resumed ${session.id.slice(0, 8)} — ${session.title} (${session.messages.length} messages)`);
    } catch (err) {
      ui.printError(`Could not resume: ${err.message}`);
      exit(1);
    }
  }
  session ??= await createSession({ model, cwd: workspace });

  // -p / --print: one prompt, one answer, exit. The headless entry point every
  // script and CI job wants; --json-ipc is the structured sibling.
  const wantsPrint = process.argv.includes('-p') || process.argv.includes('--print');
  if (wantsPrint) {
    const printPrompt = flagValue('-p') ?? flagValue('--print');
    if (!printPrompt) {
      // Silently dropping into the REPL here would hang a script forever.
      ui.printError('-p / --print needs a prompt, e.g. claudette -p "why does the build fail?"');
      exit(2);
    }
    await runHeadless(printPrompt);
    return;
  }

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

  // Seed readline with this directory's prior-session prompts so up-arrow recalls
  // them like a normal shell (newest-first, per the readline contract).
  const history = jsonIpc ? [] : await loadHistory(workspace);
  const rl = readline.createInterface({
    input: stdin, output: stdout, terminal: !jsonIpc, history, historySize: 1000,
    // Tab completes slash commands and @paths (never in IPC mode — that stream
    // carries JSON, and a stray completion would corrupt it).
    ...(jsonIpc ? {} : { completer: createCompleter(() => workspace) }),
  });
  let rlClosed = false;
  rl.on('close', () => { rlClosed = true; });
  // IPC drives a line protocol, so every line must be buffered: `rl.question()`
  // listens only while awaited, which silently dropped prompts 2..N (and all of
  // them when stdin is a file redirect that arrives in one burst).
  const ipcLines = jsonIpc ? createLineQueue(rl) : null;

  // Main REPL loop
  while (true) {
    if (!jsonIpc && rlClosed) break; // stdin reached EOF (Ctrl+D / piped input drained)
    // Don't advertise `ready` into a closed, drained stream — a driver would be
    // told to send a prompt that can never arrive.
    if (jsonIpc && ipcLines.closed && !ipcLines.pending) break;
    let line;
    try {
      if (jsonIpc) {
        console.log(JSON.stringify({ type: 'ready' }));
        line = await ipcLines.next(); // structured line protocol — no coalescing
        if (line === null) break;     // stdin closed and the buffer is drained
      } else {
        // Coalesce a pasted multi-line block into one prompt (idle prompt only).
        line = await readCoalescedPrompt(rl, '\x1b[35m\x1b[1m>\x1b[0m ');
      }
    } catch {
      break; // Ctrl+D / EOF
    }

    // Strip echoed tool-render glyphs / ANSI that can leak from raw-mode capture
    // during the previous turn (jsonIpc carries structured JSON, so leave it).
    line = jsonIpc ? line.trim() : sanitizeUserInput(line);
    if (!line) continue;

    // Persist the entered line to this directory's history for next session.
    // (Skip under the test runner so spawned CLI tests don't write history files.)
    if (!jsonIpc && process.env.NODE_ENV !== 'test') appendHistory(workspace, line);

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
  await flushTranscripts(); // transcript writes are throttled during a turn
  if (!jsonIpc) console.log('\n\x1b[90mGoodbye.\x1b[0m\n');
}

// ─── Context management ───────────────────────────────────────────────────────

// Rough token estimate (~4 chars/token) of the stored conversation.
function estimateHistoryTokens(messages) {
  return messages.reduce((acc, m) => {
    const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
    return acc + Math.ceil(len / 4);
  }, 0);
}

function compactThreshold() {
  return Number(process.env.CLAUDETTE_COMPACT_TOKENS) || 60_000;
}

// Summarize prior history into a single recap when it grows past the threshold,
// so a long session stops re-sending everything each turn. On by default; set
// CLAUDETTE_AUTO_COMPACT=0 to disable. The turn trace (session.turns) keeps the
// full event record either way.
async function maybeAutoCompact() {
  if (process.env.CLAUDETTE_AUTO_COMPACT === '0') return false;
  if (!session || session.messages.length < 6) return false;
  const tokens = estimateHistoryTokens(session.messages);
  if (tokens < compactThreshold()) return false;
  ui.printInfo(`Auto-compacting context (~${Math.round(tokens / 1000)}k tokens)…`);
  try {
    const summary = await summariseMessages(session.messages);
    // Snapshot before the summary replaces the conversation — the transcript is
    // regenerated from session.messages, so without this the original is gone.
    const archive = await archiveMessages(session, 'autocompact');
    session.messages = [{ role: 'user', content: `[Conversation summary]: ${summary}` }];
    await flushSessionSave(session);
    ui.printSuccess(`Compacted older history into a summary (full history kept at ${path.basename(archive)}).`);
    return true;
  } catch (err) {
    ui.printWarning(`Auto-compact skipped: ${err.message}`);
    return false;
  }
}

// ─── User message handler ─────────────────────────────────────────────────────
async function handleMessage(text, rl) {
  // Compress prior history before this turn if it has grown large, so a long
  // session doesn't keep re-sending everything. (Within a turn, trimToolOutputs
  // handles tool-output growth.)
  const compacted = await maybeAutoCompact();

  // Expand @file references
  const { text: expandedText, files } = await expandFiles(text, workspace, workspace);
  if (files.length) ui.printInfo(`Including: ${files.join(', ')}`);

  // Push to session history
  session.messages.push({ role: 'user', content: expandedText });
  if (session.title === 'New Session') session.title = text.slice(0, 60);

  // Start a turn trace (session.turns[]) so this turn can be debugged later.
  if (!Array.isArray(session.turns)) session.turns = [];
  const trace = createTurnTrace({
    prompt: text, model, cwd: workspace, expandedFiles: files, compacted,
    onFinish: (turn) => recordTurnUsage(turn, session), // append per-turn usage log
  });
  session.turns.push(trace.turn);
  trace.event('input_received', { promptChars: text.length });
  trace.event('files_expanded', { count: files.length, files });

  void scheduleSessionSave(session);

  // Warn when context is getting large (below the auto-compact threshold).
  const approxTokens = estimateHistoryTokens(session.messages);
  if (approxTokens > 25_000) {
    ui.printWarning(`Context ~${Math.round(approxTokens / 1000)}k tokens — /compact (or it auto-compacts past ${Math.round(compactThreshold() / 1000)}k)`);
  }

  // Load CLAUDE.md context
  const claudeMd = await loadClaudeMd(workspace);

  // Build full message list for Ollama
  const systemPrompt = buildSystemPrompt(claudeMd, effort);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.messages,
  ];
  trace.event('system_prompt_built', { systemChars: systemPrompt.length, historyMessages: messages.length });

  await runTurn(messages, rl, trace);
}

// Run one agent turn, capturing typed follow-ups into the session queue while it
// works. Live capture is enabled only for an auto-approve TTY session: a normal
// turn needs stdin for permission prompts, and --json-ipc has no terminal. The
// queue drain inside agentLoop runs regardless, so it stays unit-testable.
async function runTurn(messages, rl, trace) {
  const capture = autoApprove && !jsonIpc && process.stdin.isTTY;
  if (!capture) {
    await agentLoop(messages, rl, trace, null);
    return;
  }
  sessionInput.setMode('working');
  try { rl.pause(); } catch { /* readline already closed (EOF) */ }
  process.stdin.resume();
  stdout.write('\x1b[?2004h'); // enable bracketed paste so a paste arrives as one unit
  ui.setLiveInputActive(true); // show what the user types while the turn runs
  const handler = makeTurnInputHandler(sessionInput);
  process.stdin.on('data', handler);
  try {
    await agentLoop(messages, rl, trace, sessionInput);
  } finally {
    process.stdin.removeListener('data', handler);
    ui.updateLiveInput('');       // erase any in-progress input line
    ui.setLiveInputActive(false);
    stdout.write('\x1b[?2004l'); // disable bracketed paste
    sessionInput.setMode('idle');
    try { rl.resume(); } catch { /* readline already closed */ }
  }
}

// Minimal raw-mode line reader used only while a turn is running. Raw mode does
// not echo, so typed text isn't shown until submitted (Phase 1) — on Enter the
// line is queued and acknowledged. Ctrl+C still cancels the active stream.
function makeTurnInputHandler(input) {
  const feed = createInputAssembler({
    onLine: (content) => handleTurnInputLine(content, input),
    onChange: (buf) => ui.updateLiveInput(buf), // echo typed text on the bottom row
    onCancel: () => {
      if (currentAC) {
        currentAC.abort();
        currentAC = null;
        ui.stopSpinner();
        stdout.write(`\n\x1b[90m(cancelled)\x1b[0m\n`);
      }
    },
  });
  return (chunk) => feed(chunk.toString('utf8'));
}

function handleTurnInputLine(line, input) {
  if (line === '/queue') { ui.printQueue(input.list()); return; }
  if (line === '/queue clear') {
    const n = input.clear();
    ui.printInfo(`Cleared ${n} queued follow-up${n === 1 ? '' : 's'}.`);
    return;
  }
  const item = input.enqueue(line);
  if (item) ui.printQueued(item, input.size);
}

// Take everything queued during the turn as one steering user message. Returns
// null when the queue is empty. The runner appends and announces it; this only
// builds it and reports it to the user.
async function takeQueuedFollowUps(input, trace) {
  const items = input ? input.drain() : [];
  if (!items.length) return null;
  ui.printFollowUpDelivery(items);
  trace?.event('followup_delivered', { count: items.length });
  return buildFollowUpMessage(items);
}

// ─── Agent loop ───────────────────────────────────────────────────────────────
// Thin shell over runAgent(): the loop is in agent-runner.js, and everything
// here is terminal, permission, and session wiring hung off its hooks.
async function agentLoop(messages, rl, trace = null, input = null) {
  const maxIterations = resolveMaxIterations();
  if (!jsonIpc) ui.setUsageStatus(''); // reset the live token/cost readout for this turn

  // One controller for the whole turn, so Ctrl+C reaches a running tool and not
  // just the model request. It used to be set at request_start and cleared at
  // request_end, which left tool execution — the long part, a `npm run build`
  // that hangs — with nothing listening: Ctrl+C exited the process instead.
  const turnAC = new AbortController();
  currentAC = turnAC;

  // Per-iteration terminal state.
  let ctrlCHandler = null;
  let streamStarted = false;
  let mdStream = null;

  const emit = async (type, data) => {
    switch (type) {
      case 'iteration_start': {
        if (jsonIpc) console.log(JSON.stringify({ type: 'turn', iteration: data.iteration }));
        else ui.startSpinner(data.iteration === 1 ? 'Thinking' : 'Working');
        streamStarted = false;
        mdStream = null;
        break;
      }

      case 'request_start': {
        // When the turn wrapper is capturing follow-ups (auto-approve TTY), it
        // owns stdin and Ctrl+C for the whole turn. Otherwise do the
        // per-iteration readline pause + raw Ctrl+C handling here (so Ctrl+C
        // still cancels and permission prompts keep working).
        if (!input) {
          // Guarded: pause() throws "readline was closed" if stdin already hit
          // EOF (piped one-shot use, e.g. the Harbor adapter) — the turn must
          // still run.
          try { rl.pause(); } catch { /* readline already closed (EOF) */ }
          ctrlCHandler = (chunk) => {
            if (chunk[0] === 0x03 && currentAC) {
              currentAC.abort();
              currentAC = null;
              ui.stopSpinner();
              stdout.write(`\n\x1b[90m(cancelled)\x1b[0m\n`);
            }
          };
          process.stdin.resume();
          process.stdin.on('data', ctrlCHandler);
        }
        trace?.event('model_request_started', { model, iteration: data.iteration });
        break;
      }

      case 'stream_started': {
        if (jsonIpc) break;
        streamStarted = true;
        trace?.event('assistant_stream_started', { iteration: data.iteration });
        ui.stopSpinner();
        ui.printAssistantStart();
        // During capture, route streamed output through printAboveLive so it
        // never lands on the user's live input row.
        mdStream = ui.createMarkdownStream(input ? ui.printAboveLive : undefined);
        break;
      }

      case 'request_end': {
        if (ctrlCHandler) { process.stdin.removeListener('data', ctrlCHandler); ctrlCHandler = null; }
        // Guard: stdin can hit EOF mid-turn (piped input), closing rl — resuming
        // a closed readline throws and would crash the turn.
        if (!input) { try { rl.resume(); } catch { /* readline already closed (EOF) */ } }
        if (!jsonIpc && (data.error || !streamStarted)) ui.stopSpinner();
        break;
      }

      case 'usage': {
        trace?.addUsage({ promptTokens: data.last?.promptTokens, completionTokens: data.last?.completionTokens });
        // Live token/cost readout on the next spinner frame.
        if (!jsonIpc && trace) {
          const m = trace.turn.metrics;
          const cost = formatUsd(estimateCost(model, m));
          ui.setUsageStatus(
            `↑${formatTokens(m.promptTokens)} ↓${formatTokens(m.completionTokens)}` +
            (cost ? ` · ${cost}` : '') + ` · iter ${data.iteration}/${maxIterations}`
          );
        }
        break;
      }

      // Every message the runner appends is mirrored into persisted history —
      // the SAME object, so later in-place edits (the act nudge appends to the
      // last tool result) land in both.
      case 'message': session.messages.push(data.message); break;

      case 'assistant_text': {
        if (jsonIpc) {
          console.log(JSON.stringify({
            type: 'assistant',
            content: data.content ?? '',
            ...(data.toolCalls ? { toolCalls: data.toolCalls } : {}),
          }));
          break;
        }
        if (!streamStarted && data.content) {
          // Nothing streamed (e.g. a cache replay) — render it with markdown.
          ui.printAssistantStart();
          ui.printAssistantMessage(data.content);
          if (!data.final) stdout.write('\n');
        } else if (streamStarted) {
          mdStream.end();       // flush a trailing partial line
          stdout.write('\n');
        }
        break;
      }

      case 'tool_call': {
        trace?.event('tool_call', { name: data.name, preview: truncateLine(JSON.stringify(data.args ?? {}), 200) });
        if (jsonIpc) { console.log(JSON.stringify({ type: 'tool_call', name: data.name, arguments: data.args })); break; }
        // The permission prompt renders the call itself — printing the normal
        // tool-call line too showed the same call twice.
        if (!needsApproval(data.name, data.args)) ui.printToolCall(data.name, data.args);
        break;
      }

      case 'tool_denied': {
        ui.printWarning('User denied permission for this operation.');
        trace?.event('tool_denied', { name: data.name });
        break;
      }

      case 'tool_result': {
        if (jsonIpc) console.log(JSON.stringify({ type: 'tool_result', name: data.name, result: data.result, isError: data.isError }));
        else ui.printToolResult(data.name, data.result, data.isError);
        trace?.event('tool_result', { name: data.name, isError: data.isError, chars: data.result.length });
        break;
      }

      case 'act_nudge': {
        trace?.event('act_nudge', { streak: data.streak });
        if (!jsonIpc) ui.printInfo(`Nudging the model to act (${data.streak} reads without an edit).`);
        break;
      }

      case 'verify_nudge': {
        trace?.event('verify_nudge', { verifyRan: data.verifyRan, attempt: data.attempt });
        if (!jsonIpc) ui.printInfo('Edits not verified — asking the model to build/typecheck/test before finishing.');
        await flushSessionSave(session);
        break;
      }

      case 'iteration_end': await flushSessionSave(session); break;

      case 'cancelled': {
        trace?.event('assistant_aborted', { iteration: data.iteration });
        trace?.cancel(); // 'cancelled', not 'failed' — keeps the dataset clean
        await flushSessionSave(session);
        break;
      }

      case 'failed': {
        trace?.event('assistant_failed', { error: data.error.message, iteration: data.iteration });
        trace?.fail();
        await flushSessionSave(session);
        if (jsonIpc) console.log(JSON.stringify({ type: 'error', error: data.error.message }));
        else ui.printError(explainStreamError(data.error, model));
        break;
      }

      case 'completed': {
        if (!jsonIpc) {
          // Footer goes here, not on the last assistant_text: a turn held open by
          // the verify gate or a queued follow-up produces several assistant
          // messages, and only the last one ends the turn.
          const u = trace ? trace.turn.metrics : { promptTokens: 0, completionTokens: 0 };
          ui.printAssistantEnd({
            model,
            tokens: (u.promptTokens ?? 0) + (u.completionTokens ?? 0) || null,
            costUsd: estimateCost(model, u),
            sessionCostUsd: sessionCostUsd(),
          });
        }
        if (trace) {
          trace.complete();
          trace.event('assistant_completed', { chars: (data.content ?? '').length, ...trace.turn.metrics });
        }
        await flushSessionSave(session);
        if (jsonIpc) {
          // Report the turn's accumulated usage (across tool iterations),
          // matching the interactive cost meter; the last response under-counts.
          const u = trace ? trace.turn.metrics : { promptTokens: 0, completionTokens: 0 };
          console.log(JSON.stringify({
            type: 'done',
            tokens: (u.promptTokens ?? 0) + (u.completionTokens ?? 0),
            promptTokens: u.promptTokens ?? 0,
            completionTokens: u.completionTokens ?? 0,
          }));
        }
        break;
      }

      case 'max_iterations': trace?.event('max_iterations', { iterations: data.iterations }); break;
    }
  };

  let result;
  try {
    result = await runAgent({
      model,
      messages,
      signal: turnAC.signal,
      tools: toolsOn ? TOOL_DEFS : [],
      toolContext: { cwd: workspace, workspace },
      effort,
      maxIterations,
      emit,
      onDelta: (delta) => {
        if (jsonIpc) console.log(JSON.stringify({ type: 'delta', content: delta }));
        else mdStream?.write(delta);
      },
      approve: (name, args) => checkPermission(name, args, rl),
      takeFollowUps: () => takeQueuedFollowUps(input, trace),
      // Don't silently die mid-task. In an interactive terminal, offer to keep
      // going; a fresh iteration budget continues the same turn (and trace).
      onMaxIterations: async ({ iterations }) => {
        if (autoApprove || jsonIpc || !process.stdin.isTTY) return false;
        let answer = '';
        try {
          answer = String(await rl.question(`\n\x1b[90m⚠ Hit ${iterations} tool iterations. Keep going? [y/N] \x1b[0m`)).trim().toLowerCase();
        } catch { /* no usable input — fall through to stop */ }
        return answer === 'y' || answer === 'yes';
      },
    });
  } finally {
    // Release the turn controller, so Ctrl+C at the idle prompt exits rather
    // than aborting a turn that already finished.
    if (currentAC === turnAC) currentAC = null;
  }

  if (result.status === 'max_iterations') {
    if (trace) { trace.complete(); await flushSessionSave(session); }
    ui.printWarning(`Reached ${result.iterations} tool iterations — stopping (runaway guard). Type a message to continue where it left off, or raise the limit with --max-iterations N (or CLAUDETTE_MAX_ITERATIONS).`);
  }
  return result;
}

// ─── Session cost helpers ─────────────────────────────────────────────────────
// Sum the real per-turn token usage recorded on the trace (session.turns[]).
function sessionUsage() {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  return turns.reduce((acc, t) => {
    acc.promptTokens += t.metrics?.promptTokens ?? 0;
    acc.completionTokens += t.metrics?.completionTokens ?? 0;
    return acc;
  }, { promptTokens: 0, completionTokens: 0 });
}

// Estimated cumulative USD for the session, pricing each turn by the model that
// ran it. Returns null when no turn used a model with known pricing.
function sessionCostUsd() {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  let cost = 0;
  let priced = false;
  for (const t of turns) {
    const c = estimateCost(t.model ?? model, t.metrics ?? {});
    if (c != null) { cost += c; priced = true; }
  }
  return priced ? cost : null;
}

// ─── Permission check ─────────────────────────────────────────────────────────

// Memory key for an approved call. Bash is scoped to the EXACT command: "always"
// on `npm test` must not also authorise `rm -rf /` later in the session. Every
// other tool is coarse (the tool name), because its blast radius is already
// bounded by the workspace guard.
export function permissionKey(toolName, args = {}) {
  return toolName === 'bash' ? `bash:${String(args.command ?? '').trim()}` : toolName;
}

// True when checkPermission would prompt the user (the prompt renders its own
// tool-call header, so the caller must not print one too).
function needsApproval(toolName, args) {
  // Read-only ops always allowed
  if (['read_file', 'list_dir', 'glob', 'grep', 'search_code', 'fetch_url'].includes(toolName)) return false;
  if (autoApprove) return false;
  return !alwaysAllow.has(permissionKey(toolName, args));
}

async function checkPermission(toolName, args, rl) {
  if (!needsApproval(toolName, args)) return true;

  const detail = toolName === 'bash' ? args.command : JSON.stringify(args, null, 2);
  ui.printPermissionPrompt(toolName, detail);

  const always = toolName === 'bash' ? 'a=always (this exact command)' : `a=always (${toolName})`;
  const raw = await rl.question(`  \x1b[90m[\x1b[0my\x1b[90m/\x1b[0mn\x1b[90m/\x1b[0ma\x1b[90m] ${always}\x1b[0m `);
  const a = raw.trim().toLowerCase();

  if (a === 'always' || a === 'a') {
    alwaysAllow.add(permissionKey(toolName, args));
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
        ['Tab',              'Complete slash commands and @paths'],
        ['/cost',            'Estimate token usage for this session'],
        ['/queue',           'List follow-ups queued while the agent works (type while it runs); /queue clear'],
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
        const archive = await archiveMessages(session, 'compact');
        session.messages = [{ role: 'user', content: `[Conversation summary]: ${summary}` }];
        await flushSessionSave(session);
        ui.printSuccess(`Compacted — history replaced with summary (full history kept at ${path.basename(archive)}).`);
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
    case '/queue': {
      if (arg === 'clear') {
        const n = sessionInput.clear();
        ui.printInfo(`Cleared ${n} queued follow-up${n === 1 ? '' : 's'}.`);
      } else {
        ui.printQueue(sessionInput.list());
      }
      return true;
    }

    case '/cost': {
      const usage = sessionUsage();
      const total = usage.promptTokens + usage.completionTokens;
      if (total > 0) {
        // Real provider-reported usage, summed from the per-turn trace.
        const cost = sessionCostUsd();
        ui.table('Session Cost', [
          ['turns',         String((session.turns ?? []).length)],
          ['input tokens',  usage.promptTokens.toLocaleString()],
          ['output tokens', usage.completionTokens.toLocaleString()],
          ['total tokens',  total.toLocaleString()],
          ['est. cost',     cost != null ? `~${formatUsd(cost)}` : 'n/a (unpriced model)'],
          ['model',         model],
        ]);
      } else {
        // No turns recorded yet — fall back to a rough char-based estimate.
        const approxTokens = session.messages.reduce((acc, m) => {
          const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
          return acc + Math.ceil(len / 4);
        }, 0);
        ui.table('Session Cost Estimate', [
          ['messages',      String(session.messages.length)],
          ['approx tokens', `~${approxTokens.toLocaleString()}`],
          ['model',         model],
        ]);
      }
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(claudeMd, effort) {
  const lines = [
    'You are Claudette, an AI coding assistant running in the terminal.',
    'You have access to tools: bash, read_file, write_file, str_replace, patch_file, list_dir, glob, grep, search_code, fetch_url.',
    'Guidelines:',
    '- Always read files before editing them.',
    '- Prefer patch_file or str_replace for targeted edits over rewriting whole files.',
    '- Be concise. When writing code, provide complete working implementations.',
    '- Explore only as much as the task needs, then act. Do NOT re-read a file you already read this turn — its contents are still above; re-reading the same file wastes context and stalls progress (a changed file or a new line range is fine).',
    '- Once you understand the relevant code, make the edit. Favor a concrete change you can verify over continued reading; you do not need to read the whole project before acting.',
    '- VERIFY before claiming done: after editing, run the project\'s build, typecheck, or tests (e.g. `npm run build`, `npx tsc --noEmit`, `pytest`) and fix any errors. Never report a task complete without evidence it works — a clean edit is not proof. If a check fails, fix it and re-run until it passes.',
    '- All file paths must be relative to the workspace root — never use /tmp or absolute paths outside the workspace.',
    '- To run a file, use bash with e.g. {"command": "python3 fizzbuzz.py"} — run it in the workspace, not a copy.',
    '- Never describe or summarize a file\'s contents without reading it first with read_file. Do not guess.',
    '- For large files, use read_file with offset and limit to read specific line ranges (e.g. {"path":"foo.js","offset":100,"limit":50}).',
    '- When asked about a directory or project, read README.md or key source files — do not invent descriptions.',
    '- Use list_dir for directory inspection and search_code for repo-wide searches when possible.',
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
