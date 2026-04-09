// ANSI-based terminal rendering — no external dependencies
import process from 'node:process';

const R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';
const P = '\x1b[35m', C = '\x1b[36m', G = '\x1b[32m';
const Y = '\x1b[33m', RE = '\x1b[31m', GR = '\x1b[90m', W = '\x1b[97m';

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
  if (_spinTimer) return;
  process.stdout.write('\n');
  _spinTimer = setInterval(() => {
    process.stdout.write(`\r  ${P}${FRAMES[_spinIdx++ % FRAMES.length]}${R} ${D}${label}…${R}  `);
  }, 80);
}

export function stopSpinner() {
  if (!_spinTimer) return;
  clearInterval(_spinTimer);
  _spinTimer = null;
  process.stdout.write('\r\x1b[2K');
}

export function cols() {
  return Math.min(process.stdout.columns || 80, 88);
}

export function printBanner({ model, cwd, sessionId }) {
  const sep = `${GR}${'─'.repeat(cols())}${R}`;
  console.log(`\n${B}${P}  ◆ Ollama Code${R}  ${GR}— Claude Code for local models${R}`);
  console.log(sep);
  console.log(`  ${GR}model   ${R}${C}${model}${R}`);
  console.log(`  ${GR}session ${R}${GR}${sessionId?.slice(0, 8) ?? '–'}${R}`);
  console.log(`  ${GR}cwd     ${R}${W}${cwd}${R}`);
  console.log(sep);
  console.log(`  ${GR}Type ${W}/help${GR} for commands  ·  Use ${W}@path/to/file${GR} to include files${R}\n`);
}

export function printAssistantStart() {
  process.stdout.write(`\n${B}${P}◆${R} `);
}

export function printAssistantMessage(text) {
  const rendered = renderMarkdown(text);
  if (!rendered) return;
  process.stdout.write(rendered);
}

export function printAssistantEnd({ model: m, tokens } = {}) {
  const info = [m, tokens ? `~${tokens} tokens` : null].filter(Boolean).join(' · ');
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
  const displayName = toolDisplayName(name);
  const primary =
    args.command   ? truncate(args.command, cols() - 20) :
    args.path      ? args.path :
    args.pattern   ? args.pattern :
    args.content   ? `${String(args.content).split('\n').length} lines` :
    truncate(JSON.stringify(args), cols() - 20);
  process.stdout.write(`\n${B}${G}⏺ ${displayName}${R}${GR}(${truncate(primary, cols() - displayName.length - 4)})${R}\n`);
}

export function printToolResult(name, output, isError = false) {
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

export function printError(msg)   { console.error(`\n  ${RE}✗ ${msg}${R}\n`); }
export function printInfo(msg)    { console.log(`\n  ${C}ℹ ${msg}${R}`); }
export function printSuccess(msg) { console.log(`\n  ${G}✓ ${msg}${R}`); }
export function printWarning(msg) { console.log(`\n  ${Y}⚠ ${msg}${R}`); }

export function table(title, rows) {
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

function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;

  for (const rawLine of lines) {
    if (rawLine.startsWith('```')) {
      inCode = !inCode;
      if (inCode) {
        const lang = rawLine.slice(3).trim();
        out.push(`\n${GR}  ${'─'.repeat(Math.min(cols() - 4, 40))}${R}`);
        if (lang) out.push(`${GR}  ${lang}${R}`);
      } else {
        out.push(`${GR}  ${'─'.repeat(Math.min(cols() - 4, 40))}${R}\n`);
      }
      continue;
    }

    if (inCode) {
      out.push(`\n${C}  ${rawLine || ' '}${R}`);
      continue;
    }

    const line = rawLine.trimEnd();
    if (!line.trim()) {
      out.push('\n');
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(`\n${B}${W}${applyInlineMarkdown(heading[2].trim())}${R}\n`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      out.push(`\n${Y}  •${R} ${applyInlineMarkdown(bullet[2])}`);
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numbered) {
      out.push(`\n${Y}  ${numbered[2]}.${R} ${applyInlineMarkdown(numbered[3])}`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(`\n${GR}  │ ${applyInlineMarkdown(quote[1])}${R}`);
      continue;
    }

    out.push(`\n${applyInlineMarkdown(line)}`);
  }

  return out.join('').replace(/^\n/, '');
}

function applyInlineMarkdown(line) {
  return line
    .replace(/`([^`]+)`/g, `${C}$1${R}`)
    .replace(/\*\*([^*]+)\*\*/g, `${B}$1${R}`)
    .replace(/\*([^*]+)\*/g, `${D}$1${R}`);
}
