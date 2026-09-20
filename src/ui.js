// ANSI-based terminal rendering — no external dependencies
import process from 'node:process';
import { formatExplorationSummary, isRoutineExplorationTool } from './tool-activity.js';

const jsonIpc = process.argv.includes('--json-ipc');

// Headless (`-p "…"`) shares IPC's "no terminal chrome" rule: a spinner repainting
// a line 12×/second is unreadable once stdout is a pipe, and the trailing model /
// token footer is not part of the answer a script asked for. Chat output itself
// still prints, so `claudette -p "…" > out.txt` gives you exactly the reply.
const headless = process.argv.includes('-p') || process.argv.includes('--print');
const quiet = jsonIpc || headless;

// Palette: VS Code Default Dark+ (24-bit truecolor). Honors NO_COLOR.
const NO_COLOR = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const sgr = (code) => (NO_COLOR ? '' : code);
const fg = (r, g, b) => (NO_COLOR ? '' : `\x1b[38;2;${r};${g};${b}m`);

const R = sgr('\x1b[0m'), B = sgr('\x1b[1m'), D = sgr('\x1b[2m');
// VS Code Default Dark hues, brightened for terminal readability.
const P  = fg(218, 165, 214);  // keyword purple  #DAA5D6
const C  = fg(112, 184, 235);  // blue            #70B8EB
const G  = fg( 92, 218, 192);  // teal/green      #5CDAC0
const Y  = fg(233, 227, 168);  // function yellow #E9E3A8
const RE = fg(255, 110, 110);  // error red       #FF6E6E
const O  = fg(230, 174, 145);  // string orange   #E6AE91
const GR = fg(180, 186, 196);  // muted gray      #B4BAC4
const W  = fg(238, 238, 238);  // foreground      #EEEEEE

// Exported so callers/tests reference exact codes instead of hardcoding them.
export const palette = { R, B, D, P, C, G, Y, RE, O, GR, W };

export const s = {
  purple:     t => `${P}${t}${R}`,
  cyan:       t => `${C}${t}${R}`,
  green:      t => `${G}${t}${R}`,
  yellow:     t => `${Y}${t}${R}`,
  red:        t => `${RE}${t}${R}`,
  gray:       t => `${GR}${t}${R}`,
  white:      t => `${W}${t}${R}`,
  bold:       t => `${B}${t}${R}`,
  dim:        t => `${D}${t}${R}`,
  bp:         t => `${B}${P}${t}${R}`,
  bg:         t => `${B}${G}${t}${R}`,
  bc:         t => `${B}${C}${t}${R}`,
};

// ─── Managed turn status ─────────────────────────────────────────────────────
// The bottom of the terminal is one small, owned display. Model identity gets a
// dedicated row (and is never truncated); activity/progress lives below it. A
// typed follow-up temporarily replaces only the progress row, so the selected
// model stays visible and spinner, streamed output, and input cannot race for
// the same cursor position.
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let _spinTimer = null, _spinIdx = 0, _spinLabel = 'Thinking';
let _managedRows = 0;
let _toolSectionOpen = false;
let _routineToolCalls = [];

const emptyTurnStatus = () => ({
  activeModel: '', resolvedModel: '', resolvedProvider: '',
  phase: 'Thinking', iteration: 0, maxIterations: 0, toolCount: 0,
  promptTokens: 0, completionTokens: 0, cost: '', queueCount: 0,
  startedAt: 0,
});
let _turnStatus = emptyTurnStatus();

function statusTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
}

function elapsedLabel(startedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - (Number(startedAt) || now)) / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${seconds}s`;
}

const ROUTER_LABELS = {
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  hf: 'Hugging Face',
  xai: 'xAI',
};

export function buildRouteLabel({ model, resolvedProvider } = {}) {
  const modelId = String(model ?? '').trim();
  const rawRouter = modelId.includes('/') ? modelId.split('/')[0].trim() : 'ollama';
  const router = ROUTER_LABELS[rawRouter.toLowerCase()]
    ?? `${rawRouter.charAt(0).toUpperCase()}${rawRouter.slice(1)}`;
  const provider = String(resolvedProvider ?? '').trim();
  return provider && provider.toLowerCase() !== router.toLowerCase()
    ? `${router} / ${provider}`
    : router;
}

export function buildAssistantFooter({ model, resolvedProvider, tokens } = {}) {
  const route = buildRouteLabel({ model, resolvedProvider });
  return [route, tokens ? `~${tokens} tokens` : null].filter(Boolean).join(' · ');
}

function wrapIdentity(label, value, width) {
  const prefix = `  ${String(label).padEnd(7)}`;
  const continuation = ' '.repeat(prefix.length);
  const available = Math.max(1, width - prefix.length);
  const text = String(value || '–');
  const rows = [];
  for (let offset = 0; offset < text.length; offset += available) {
    rows.push(`${offset ? continuation : prefix}${text.slice(offset, offset + available)}`);
  }
  return rows.length ? rows : [`${prefix}–`];
}

// Pure formatter exported for focused tests. Keep one compact router/provider
// identity row; the activity row below already owns progress and token counts.
export function buildTurnStatusLines(state = {}, width = cols(), frame = FRAMES[0], now = Date.now()) {
  const maxWidth = Math.max(24, Number(width) || 80);
  const route = buildRouteLabel({ model: state.activeModel, resolvedProvider: state.resolvedProvider });
  const rows = wrapIdentity('route', route, maxWidth);

  const rawPhase = String(state.phase || 'Working').replace(/…+$/, '');
  const phase = truncate(rawPhase, Math.max(12, Math.floor(maxWidth * 0.34)));
  const details = [
    state.iteration ? `step ${state.iteration}/${state.maxIterations || '?'}` : null,
    state.queueCount ? `${state.queueCount} queued` : null,
    elapsedLabel(state.startedAt, now),
    `${Number(state.toolCount) || 0} tools`,
    `in ${statusTokens(state.promptTokens)}`,
    `out ${statusTokens(state.completionTokens)}`,
    state.cost || null,
  ].filter(Boolean);
  let progress = `  ${frame} ${phase}`;
  for (const detail of details) {
    const candidate = `${progress} · ${detail}`;
    if (candidate.length <= maxWidth) progress = candidate;
  }
  rows.push(progress);
  return rows;
}

function colorStatusLine(line) {
  const identity = line.match(/^(\s*)(model|route)(\s+)(.*)$/);
  if (identity) return `${identity[1]}${GR}${identity[2]}${R}${identity[3]}${C}${identity[4]}${R}`;
  const activity = line.match(/^(\s*)([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])(\s+)(.*)$/u);
  if (activity) return `${activity[1]}${P}${activity[2]}${R}${activity[3]}${GR}${activity[4]}${R}`;
  if (line.startsWith('  ❯ ')) return `${GR}  ❯ ${R}${W}${line.slice(4)}${R}`;
  return `${C}${line}${R}`; // wrapped continuation of a compact route label
}

function clearManagedRows() {
  if (!_managedRows) return;
  for (let row = 0; row < _managedRows; row++) {
    process.stdout.write('\r\x1b[2K');
    if (row < _managedRows - 1) process.stdout.write('\x1b[1A');
  }
  _managedRows = 0;
}

function managedLines() {
  const showStatus = Boolean(_spinTimer && _turnStatus.activeModel);
  const showInput = Boolean(_liveOn && _liveText);
  if (!showStatus && !showInput) return [];
  if (!showStatus) return [`  ❯ ${_liveText}`];
  const rows = buildTurnStatusLines(_turnStatus, cols() - 1, FRAMES[_spinIdx++ % FRAMES.length]);
  if (showInput) rows[rows.length - 1] = `  ❯ ${_liveText}`;
  return rows;
}

function renderManagedRows() {
  if (quiet) return;
  clearManagedRows();
  const rows = managedLines();
  if (!rows.length) return;
  process.stdout.write(rows.map(colorStatusLine).join('\n'));
  _managedRows = rows.length;
}

function writeAboveManaged(text) {
  const redraw = Boolean(_spinTimer || (_liveOn && _liveText));
  clearManagedRows();
  process.stdout.write(String(text));
  if (redraw) renderManagedRows();
}

function ensureToolSection() {
  if (quiet || _toolSectionOpen) return;
  writeAboveManaged(`\n  ${B}${C}Tools${R}\n`);
  _toolSectionOpen = true;
}

function writeToolLine(text) {
  if (quiet) return;
  ensureToolSection();
  writeAboveManaged(`  ${GR}│${R} ${text}\n`);
}

function toolCallPrimary(args = {}) {
  return args.command
    ?? args.path
    ?? args.pattern
    ?? (args.content ? `${String(args.content).split('\n').length} lines` : JSON.stringify(args));
}

function writeToolCallLine(name, args = {}, color = G) {
  const displayName = toolDisplayName(name);
  const primary = truncate(String(toolCallPrimary(args) ?? ''), cols() - displayName.length - 12);
  writeToolLine(`${B}${color}⏺ ${displayName}${R}${GR}(${primary})${R}`);
}

function flushRoutineToolSummary() {
  const completed = _routineToolCalls.filter(call => call.completed);
  if (!completed.length) return;
  _routineToolCalls = _routineToolCalls.filter(call => !call.completed);
  writeToolLine(`${G}⏺ ${formatExplorationSummary(completed.map(call => call.summaryName ?? call.name))}${R}`);
}

export function finishToolSection() {
  if (quiet) {
    _routineToolCalls = [];
    _toolSectionOpen = false;
    return;
  }
  flushRoutineToolSummary();
  if (_routineToolCalls.length) {
    for (const call of _routineToolCalls) writeToolCallLine(call.name, call.args);
    _routineToolCalls = [];
  }
  if (_toolSectionOpen) {
    writeAboveManaged('\n');
    _toolSectionOpen = false;
  }
}

export function beginTurnStatus({ model = '', maxIterations = 0 } = {}) {
  stopSpinner();
  finishToolSection();
  _turnStatus = { ...emptyTurnStatus(), activeModel: String(model), maxIterations, startedAt: Date.now() };
}

export function updateTurnStatus(patch = {}) {
  _turnStatus = { ..._turnStatus, ...patch };
  if (_spinTimer) renderManagedRows();
}

export function setQueueCount(count) {
  updateTurnStatus({ queueCount: Math.max(0, Number(count) || 0) });
}

export function noteToolCall() {
  updateTurnStatus({ toolCount: _turnStatus.toolCount + 1 });
}

export function startSpinner(label = 'Thinking') {
  if (quiet) return;
  _spinLabel = String(label || 'Working');
  _turnStatus.phase = _spinLabel;
  if (!_spinTimer) { _spinTimer = setInterval(renderManagedRows, 120); _spinTimer.unref?.(); }
  renderManagedRows(); // immediate acknowledgement; do not wait for frame one
}

export function stopSpinner() {
  if (quiet) return;
  if (_spinTimer) clearInterval(_spinTimer);
  _spinTimer = null;
  clearManagedRows();
}

export function endTurnStatus() {
  stopSpinner();
  finishToolSection();
  _turnStatus = emptyTurnStatus();
}

// ─── Live input line (see your follow-ups while the agent works) ─────────────
let _liveOn = false;
let _liveText = '';

export function setLiveInputActive(on) {
  _liveOn = Boolean(on);
  if (!_liveOn) {
    _liveText = '';
    renderManagedRows();
  }
}

export function updateLiveInput(text) {
  if (jsonIpc || !_liveOn) return;
  _liveText = String(text ?? '');
  renderManagedRows();
}

// Write turn output above the live input line: erase it first so output never
// lands on the same row. The next keystroke redraws the input.
export function printAboveLive(s) {
  if (jsonIpc) { process.stdout.write(s); return; }
  writeAboveManaged(s);
}

export function cols() {
  return Math.max(40, process.stdout.columns || 80);
}

export function printBanner({ model, cwd, sessionId, effort, autoApprove }) {
  if (jsonIpc) return;
  const sep = `${GR}${'─'.repeat(cols())}${R}`;
  console.log(`\n${B}${P}  ◆ Claudette${R}  ${GR}— multi-provider coding assistant${R}`);
  console.log(sep);
  const modelExtra = [
    effort ? `effort ${effort}` : null,
    autoApprove ? 'auto-approve' : null,
  ].filter(Boolean).join('  ·  ');
  console.log(`  ${GR}model   ${R}${C}${model}${R}${modelExtra ? `  ${GR}${modelExtra}${R}` : ''}`);
  console.log(`  ${GR}session ${R}${GR}${sessionId?.slice(0, 8) ?? '–'}${R}`);
  console.log(`  ${GR}cwd     ${R}${W}${cwd}${R}`);
  console.log(sep);
  console.log(`  ${GR}Type ${W}/help${GR} for commands  ·  Use ${W}@path/to/file${GR} to include files${R}\n`);
}

export function printAssistantStart() {
  if (quiet) return; // headless emits the answer text alone, with no ◆ gutter
  finishToolSection();
  process.stdout.write(`\n${B}${P}◆${R} `);
}

export function printAssistantMessage(text) {
  if (jsonIpc) return;
  const rendered = renderMarkdown(text);
  if (!rendered) return;
  process.stdout.write(rendered);
}

export function printAssistantEnd({ model, resolvedProvider, tokens } = {}) {
  if (quiet) { if (headless) process.stdout.write('\n'); return; }
  finishToolSection();
  const info = buildAssistantFooter({ model, resolvedProvider, tokens });
  process.stdout.write(info ? `\n\n${GR}  ↳ ${info}${R}\n` : '\n');
}

const TOOL_DISPLAY = {
  bash: 'Bash', read_file: 'Read', write_file: 'Write',
  str_replace: 'Edit', patch_file: 'Patch', glob: 'Glob', grep: 'Search',
  search_code: 'Search', list_dir: 'List', fetch_url: 'Fetch',
};

export function toolDisplayName(name) {
  return TOOL_DISPLAY[name] ?? name;
}

export function printToolCall(name, args = {}) {
  if (jsonIpc) return;
  stopSpinner();
  if (isRoutineExplorationTool(name)) {
    _routineToolCalls.push({ name, args, completed: false });
    return;
  }
  flushRoutineToolSummary();
  writeToolCallLine(name, args);
}

function toolPrimary(args = {}) {
  return args.command ?? args.path ?? args.pattern ?? '';
}

export function toolActivityLabel(name, args = {}) {
  const displayName = toolDisplayName(name);
  const primary = String(toolPrimary(args)).split('\n')[0].trim();
  return primary
    ? `Running ${displayName}: ${truncate(primary, Math.max(12, cols() - displayName.length - 16))}`
    : `Running ${displayName}`;
}

export function startToolActivity(name, args = {}) {
  if (isRoutineExplorationTool(name)) {
    const names = _routineToolCalls.map(call => call.summaryName ?? call.name);
    startSpinner(formatExplorationSummary(names.length ? names : [name], 'Exploring'));
    return;
  }
  startSpinner(toolActivityLabel(name, args));
}

export function printApprovalAccepted(name, args = {}, always = false) {
  if (jsonIpc) return;
  stopSpinner();
  const answer = always ? 'a (always)' : 'y';
  const activity = toolActivityLabel(name, args);
  flushRoutineToolSummary();
  writeToolLine(`${G}✓ Accepted ${answer}${R}${GR} — ${activity}${R}`);
  startSpinner(activity);
}

export function printApprovalDenied(name) {
  if (jsonIpc) return;
  stopSpinner();
  const pending = _routineToolCalls.findIndex(call => call.name === name && !call.completed);
  if (pending !== -1) _routineToolCalls.splice(pending, 1);
  flushRoutineToolSummary();
  writeToolLine(`${Y}✓ Accepted n${R}${GR} — skipped ${toolDisplayName(name)}${R}`);
}

export function printInterruptRequested(item) {
  if (jsonIpc) return;
  stopSpinner();
  finishToolSection();
  const summary = truncate(String(item?.content ?? ''), Math.max(20, cols() - 20));
  console.log(`\n  ${Y}↳ Interrupt accepted${R}${GR} — stopping the current operation${R}`);
  console.log(`  ${GR}Next prompt: ${W}${summary}${R}`);
  startSpinner('Interrupting current operation');
}

export function printRedirectStarted(prompt) {
  if (jsonIpc) return;
  stopSpinner();
  finishToolSection();
  const summary = truncate(String(prompt ?? ''), Math.max(20, cols() - 18));
  console.log(`\n  ${G}✓ Interrupted${R}${GR} — applying: ${W}${summary}${R}`);
}

export function printToolResult(name, output, isError = false) {
  if (jsonIpc) return;
  stopSpinner();
  const str   = String(output).trimEnd();
  const lines = str.split('\n');
  const col   = isError ? RE : GR;

  if (isRoutineExplorationTool(name)) {
    const index = _routineToolCalls.findIndex(call => call.name === name && !call.completed);
    const call = index === -1 ? { name, args: {} } : _routineToolCalls[index];
    if (!isError) {
      call.completed = true;
      if (name === 'read_file' && lines[0]?.startsWith('Directory:')) call.summaryName = 'list_dir';
      if (index === -1) _routineToolCalls.push(call);
      return;
    }
    if (index !== -1) _routineToolCalls.splice(index, 1);
    flushRoutineToolSummary();
    writeToolCallLine(name, call.args, RE);
    lines.slice(0, 6).forEach(line => writeToolLine(`${RE}⎿ ${line}${R}`));
    if (lines.length > 6) writeToolLine(`${GR}⎿ … (${lines.length - 6} more lines)${R}`);
    return;
  }

  flushRoutineToolSummary();
  ensureToolSection();

  if (isError) {
    lines.slice(0, 6).forEach(line => writeToolLine(`${col}⎿ ${line}${R}`));
    if (lines.length > 6) writeToolLine(`${GR}⎿ … (${lines.length - 6} more lines)${R}`);
    return;
  }

  switch (name) {
    case 'read_file':
      if (lines[0]?.startsWith('Directory:')) {
        writeToolLine(`${GR}⎿ Listed ${lines.length - 1} entries${R}`);
      } else {
        writeToolLine(`${GR}⎿ Read ${lines.length} line${lines.length === 1 ? '' : 's'}${R}`);
      }
      break;
    case 'write_file':
      writeToolLine(`${GR}⎿ ${str}${R}`);
      break;
    case 'str_replace':
      writeToolLine(`${GR}⎿ ${str}${R}`);
      break;
    case 'glob': {
      const count = str === '(no matches)' ? 0 : lines.filter(Boolean).length;
      writeToolLine(`${GR}⎿ ${count ? `Found ${count} file${count === 1 ? '' : 's'}` : 'No matches'}${R}`);
      break;
    }
    case 'grep': {
      if (str === '(no matches)') {
        writeToolLine(`${GR}⎿ No matches${R}`);
      } else {
        const count = lines.filter(Boolean).length;
        writeToolLine(`${GR}⎿ ${count} match${count === 1 ? '' : 'es'}${R}`);
      }
      break;
    }
    case 'bash':
    default: {
      const SHOW = 6;
      lines.slice(0, SHOW).forEach(line => writeToolLine(`${GR}⎿ ${line}${R}`));
      if (lines.length > SHOW) writeToolLine(`${GR}⎿ … (${lines.length - SHOW} more lines)${R}`);
      break;
    }
  }
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function printPermissionPrompt(toolName, detail) {
  if (jsonIpc) return;
  stopSpinner();
  const displayName = toolDisplayName(toolName);
  const detailLines = detail.split('\n');
  const preview = detailLines.slice(0, 8);
  const truncated = detailLines.length > 8;
  // Show the call like a tool call line, then the detail block
  const primary = truncate(detail.split('\n')[0], cols() - displayName.length - 4);
  flushRoutineToolSummary();
  writeToolLine(`${B}${Y}⏺ ${displayName}${R}${GR}(${primary})${R}`);
  if (detailLines.length > 1) {
    preview.slice(1).forEach(line => writeToolLine(`  ${GR}${line}${R}`));
    if (truncated) writeToolLine(`  ${GR}… (truncated)${R}`);
  }
  writeToolLine(`${Y}Allow this tool call?${R}`);
}

export function printError(msg)   { if (jsonIpc) return; stopSpinner(); finishToolSection(); console.error(`  ${RE}✗ ${msg}${R}\n`); }
export function printInfo(msg)    { if (jsonIpc) return; finishToolSection(); writeAboveManaged(`  ${C}ℹ ${msg}${R}\n`); }
export function printSuccess(msg) { if (jsonIpc) return; finishToolSection(); writeAboveManaged(`  ${G}✓ ${msg}${R}\n`); }
export function printWarning(msg) { if (jsonIpc) return; finishToolSection(); writeAboveManaged(`  ${Y}⚠ ${msg}${R}\n`); }

export function table(title, rows) {
  if (jsonIpc) return;
  const width = cols() - 4;
  console.log(`\n  ${B}${title}${R}`);
  console.log(`  ${GR}${'─'.repeat(width)}${R}`);
  for (const row of rows) {
    if (row.length === 1) {
      console.log(`\n  ${D}${row[0]}${R}`);
    } else {
      const [k, v] = row;
      // Keep a visible delimiter even when a key is longer than the nominal
      // column width (model IDs commonly are).
      console.log(`  ${C}${String(k).padEnd(20)}${R}  ${W}${v}${R}`);
    }
  }
  console.log();
}

// ─── Follow-up queue (mid-run steering) ──────────────────────────────────────

export function printQueued(item, count) {
  if (jsonIpc || !item) return;
  setQueueCount(count);
  const preview = truncate(item.content.replace(/\s+/g, ' '), cols() - 24);
  writeAboveManaged(`  ${C}⊕ Queued (${count})${R} ${GR}${preview}${R}\n`);
}

export function printQueue(items) {
  if (jsonIpc) return;
  if (!items.length) { writeAboveManaged(`  ${GR}Queue empty.${R}\n`); return; }
  const rows = [`  ${B}Queued follow-ups (${items.length})${R}`];
  items.forEach((it, i) => rows.push(
    `  ${C}${String(i + 1).padStart(2)}.${R} ${GR}${truncate(it.content.replace(/\s+/g, ' '), cols() - 8)}${R}`
  ));
  writeAboveManaged(`${rows.join('\n')}\n`);
}

export function printFollowUpDelivery(items) {
  if (jsonIpc || !items.length) return;
  const label = items.length === 1 ? 'follow-up' : `${items.length} follow-ups`;
  setQueueCount(0);
  writeAboveManaged(`  ${P}↳ delivering your ${label}…${R}\n`);
}


// Per-line markdown renderer with persistent state (code-fence tracking), so
// the same logic serves whole-message rendering and incremental streaming.
// Each call returns the rendered line prefixed with '\n' (callers strip the
// first one), matching the historical renderMarkdown output byte-for-byte.
function createMarkdownLineRenderer() {
  let inCode = false;

  return function renderLine(rawLine) {
    if (rawLine.startsWith('```')) {
      inCode = !inCode;
      if (inCode) {
        const lang = rawLine.slice(3).trim();
        return `\n${GR}  ${'─'.repeat(Math.min(cols() - 4, 40))}${R}` +
          (lang ? `${GR}  ${lang}${R}` : '');
      }
      return `${GR}  ${'─'.repeat(Math.min(cols() - 4, 40))}${R}\n`;
    }

    if (inCode) return `\n${C}  ${rawLine || ' '}${R}`;

    const line = rawLine.trimEnd();
    if (!line.trim()) return '\n';

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) return `\n${B}${W}${applyInlineMarkdown(heading[2].trim())}${R}\n`;

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) return `\n${Y}  •${R} ${applyInlineMarkdown(bullet[2])}`;

    const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numbered) return `\n${Y}  ${numbered[2]}.${R} ${applyInlineMarkdown(numbered[3])}`;

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) return `\n${GR}  │ ${applyInlineMarkdown(quote[1])}${R}`;

    return `\n${applyInlineMarkdown(line)}`;
  };
}

function renderMarkdown(text) {
  const renderLine = createMarkdownLineRenderer();
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  return lines.map(renderLine).join('').replace(/^\n/, '');
}

/**
 * Incremental markdown renderer for live streaming: buffers deltas until a
 * full line is available, renders it with the same state machine as
 * renderMarkdown (so code fences survive chunk boundaries), and writes it.
 * Output appears line-by-line instead of token-by-token — the price of
 * formatted streaming. Call end() to flush a trailing partial line.
 */
export function createMarkdownStream(write = chunk => process.stdout.write(chunk)) {
  if (jsonIpc) return { write() {}, end() {} };
  const renderLine = createMarkdownLineRenderer();

  let buffer = '';
  let first = true;

  const emit = (rawLine) => {
    let rendered = renderLine(rawLine);
    if (first) {
      rendered = rendered.replace(/^\n/, '');
      first = false;
    }
    if (rendered) write(rendered);
  };

  return {
    write(delta) {
      buffer += String(delta ?? '').replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    end() {
      if (buffer) {
        emit(buffer);
        buffer = '';
      }
    },
  };
}

function applyInlineMarkdown(line) {
  return line
    .replace(/`([^`]+)`/g, `${C}$1${R}`)
    .replace(/\*\*([^*]+)\*\*/g, `${B}$1${R}`)
    .replace(/\*([^*]+)\*/g, `${D}$1${R}`);
}
