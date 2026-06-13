// ANSI-based terminal rendering — no external dependencies
import process from 'node:process';
import { formatUsd } from './cost.js';

const jsonIpc = process.argv.includes('--json-ipc');

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

// Spinner
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let _spinTimer = null, _spinIdx = 0;

export function startSpinner(label = 'Thinking') {
  if (jsonIpc) return;
  if (_spinTimer) return;
  process.stdout.write('\n');
  _spinTimer = setInterval(() => {
    process.stdout.write(`\r  ${P}${FRAMES[_spinIdx++ % FRAMES.length]}${R} ${D}${label}…${R}  `);
  }, 80);
}

export function stopSpinner() {
  if (jsonIpc) return;
  if (!_spinTimer) return;
  clearInterval(_spinTimer);
  _spinTimer = null;
  process.stdout.write('\r\x1b[2K');
}

export function cols() {
  return Math.min(process.stdout.columns || 80, 88);
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
  if (jsonIpc) return;
  process.stdout.write(`\n${B}${P}◆${R} `);
}

export function printAssistantMessage(text) {
  if (jsonIpc) return;
  const rendered = renderMarkdown(text);
  if (!rendered) return;
  process.stdout.write(rendered);
}

export function printAssistantEnd({ model: m, tokens, costUsd, sessionCostUsd } = {}) {
  if (jsonIpc) return;
  const turnCost = formatUsd(costUsd);
  const sessCost = formatUsd(sessionCostUsd);
  const info = [
    m,
    tokens ? `~${tokens} tokens` : null,
    turnCost ? `~${turnCost}` : null,
    sessCost ? `session ~${sessCost}` : null,
  ].filter(Boolean).join(' · ');
  process.stdout.write(info ? `\n\n${GR}  ↳ ${info}${R}\n` : '\n');
}

const TOOL_DISPLAY = {
  bash: 'Bash', read_file: 'Read', write_file: 'Write',
  str_replace: 'Edit', glob: 'Glob', grep: 'Grep',
};

export function toolDisplayName(name) {
  return TOOL_DISPLAY[name] ?? name;
}

export function printToolCall(name, args) {
  if (jsonIpc) return;
  const displayName = toolDisplayName(name);
  const primary =
    args.command   ? truncate(args.command, cols() - 20) :
    args.path      ? args.path :
    args.pattern   ? args.pattern :
    args.content   ? `${String(args.content).split('\n').length} lines` :
    truncate(JSON.stringify(args), cols() - 20);
  // One clean label per call — the friendly name only (no redundant `[read_file]`).
  process.stdout.write(`\n${B}${G}⏺ ${displayName}${R}${GR}(${truncate(primary, cols() - displayName.length - 8)})${R}\n`);
}

export function printToolResult(name, output, isError = false) {
  if (jsonIpc) return;
  const str   = String(output).trimEnd();
  const lines = str.split('\n');
  const col   = isError ? RE : GR;

  if (isError) {
    lines.slice(0, 6).forEach(l => console.log(`${col}  ⎿ ${l}${R}`));
    if (lines.length > 6) console.log(`${GR}  ⎿ … (${lines.length - 6} more lines)${R}`);
    return;
  }

  switch (name) {
    case 'read_file':
      if (lines[0]?.startsWith('Directory:')) {
        console.log(`${GR}  ⎿ Listed ${lines.length - 1} entries${R}`);
      } else {
        console.log(`${GR}  ⎿ Read ${lines.length} line${lines.length === 1 ? '' : 's'}${R}`);
      }
      break;
    case 'write_file':
      console.log(`${GR}  ⎿ ${str}${R}`);
      break;
    case 'str_replace':
      console.log(`${GR}  ⎿ ${str}${R}`);
      break;
    case 'glob': {
      const count = str === '(no matches)' ? 0 : lines.filter(Boolean).length;
      console.log(`${GR}  ⎿ ${count ? `Found ${count} file${count === 1 ? '' : 's'}` : 'No matches'}${R}`);
      break;
    }
    case 'grep': {
      if (str === '(no matches)') {
        console.log(`${GR}  ⎿ No matches${R}`);
      } else {
        const count = lines.filter(Boolean).length;
        console.log(`${GR}  ⎿ ${count} match${count === 1 ? '' : 'es'}${R}`);
      }
      break;
    }
    case 'bash':
    default: {
      const SHOW = 6;
      lines.slice(0, SHOW).forEach(l => console.log(`${GR}  ⎿ ${l}${R}`));
      if (lines.length > SHOW) console.log(`${GR}  ⎿ … (${lines.length - SHOW} more lines)${R}`);
      break;
    }
  }
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function printPermissionPrompt(toolName, detail) {
  if (jsonIpc) return;
  const displayName = toolDisplayName(toolName);
  const detailLines = detail.split('\n');
  const preview = detailLines.slice(0, 8);
  const truncated = detailLines.length > 8;
  // Show the call like a tool call line, then the detail block
  const primary = truncate(detail.split('\n')[0], cols() - displayName.length - 4);
  console.log(`\n${B}${Y}⏺ ${displayName}${R}${GR}(${primary})${R}`);
  if (detailLines.length > 1) {
    preview.slice(1).forEach(l => console.log(`   ${GR}${l}${R}`));
    if (truncated) console.log(`   ${GR}… (truncated)${R}`);
  }
  console.log(`\n  ${Y}Allow this tool call?${R}`);
}

export function printError(msg)   { if (jsonIpc) return; console.error(`\n  ${RE}✗ ${msg}${R}\n`); }
export function printInfo(msg)    { if (jsonIpc) return; console.log(`\n  ${C}ℹ ${msg}${R}`); }
export function printSuccess(msg) { if (jsonIpc) return; console.log(`\n  ${G}✓ ${msg}${R}`); }
export function printWarning(msg) { if (jsonIpc) return; console.log(`\n  ${Y}⚠ ${msg}${R}`); }

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
      console.log(`  ${C}${String(k).padEnd(20)}${R}${W}${v}${R}`);
    }
  }
  console.log();
}

// ─── Follow-up queue (mid-run steering) ──────────────────────────────────────

export function printQueued(item, count) {
  if (jsonIpc || !item) return;
  const preview = truncate(item.content.replace(/\s+/g, ' '), cols() - 24);
  process.stdout.write(`\n  ${C}⊕ Queued (${count})${R} ${GR}${preview}${R}\n`);
}

export function printQueue(items) {
  if (jsonIpc) return;
  if (!items.length) { console.log(`\n  ${GR}Queue empty.${R}`); return; }
  console.log(`\n  ${B}Queued follow-ups (${items.length})${R}`);
  items.forEach((it, i) => {
    console.log(`  ${C}${String(i + 1).padStart(2)}.${R} ${GR}${truncate(it.content.replace(/\s+/g, ' '), cols() - 8)}${R}`);
  });
  console.log();
}

export function printFollowUpDelivery(items) {
  if (jsonIpc || !items.length) return;
  const label = items.length === 1 ? 'follow-up' : `${items.length} follow-ups`;
  process.stdout.write(`\n  ${P}↳ delivering your ${label}…${R}\n`);
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
