// Benchmark task loading. Tasks are authored as YAML (with a JSON fallback) and
// loaded into plain objects identical to the original JSON definitions.
//
// The YAML subset supported here is deliberately small but lossless for the
// shapes these tasks use:
//   key: <scalar>            double-quoted (JSON), number, boolean, null, plain
//   key: |  / |-             literal block scalar (newlines preserved verbatim)
//   key: >  / >-             folded block scalar
//   key:                     block sequence of scalars on following `- ` lines
//
// Multi-line prompts are stored as literal `|-` blocks so exact-reproduction
// tasks keep their byte-for-byte structure; the previous folded-scalar approach
// collapsed those line breaks and silently changed what the model was asked.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TASKS_DIR = path.join(__dirname, 'tasks');

const REQUIRED_FIELDS = ['id', 'title', 'category', 'prompt', 'verify'];

export function parseYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const result = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { i++; continue; }

    const indent = line.length - line.trimStart().length;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Invalid YAML (expected "key: value"): ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      const block = readBlock(lines, i + 1, indent, rest);
      result[key] = block.value;
      i = block.next;
    } else if (rest === '') {
      const next = lines[i + 1];
      const nextIndent = next === undefined ? -1 : next.length - next.trimStart().length;
      if (next !== undefined && nextIndent > indent && /^-(\s|$)/.test(next.trim())) {
        const seq = readSequence(lines, i + 1, indent);
        result[key] = seq.value;
        i = seq.next;
      } else {
        result[key] = '';
        i++;
      }
    } else {
      result[key] = parseScalar(rest);
      i++;
    }
  }

  return result;
}

// Read a block scalar (literal `|`/`|-` or folded `>`/`>-`) starting at `start`.
// Lines more indented than the parent key belong to the block; the common
// leading indent is stripped so internal indentation is preserved relative to it.
function readBlock(lines, start, parentIndent, style) {
  const folded = style[0] === '>';
  const strip = style.endsWith('-');
  const collected = [];
  let blockIndent = null;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { collected.push(''); continue; } // tolerate trailing-space blanks
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = indent;
    collected.push(line.slice(blockIndent));
  }
  // Blank lines collected past the final content line are separators, not content.
  while (collected.length && collected[collected.length - 1] === '') collected.pop();

  let value = folded ? foldLines(collected) : collected.join('\n');
  if (!strip && value !== '') value += '\n'; // clip keeps exactly one trailing newline
  return { value, next: i };
}

// Approximate YAML folding: single line breaks between non-blank lines become a
// space, blank lines become a newline. The task files use literal blocks, so
// this exists only so a hand-authored folded block does not parse to garbage.
function foldLines(lines) {
  let out = '';
  let prevBlank = true;
  for (const l of lines) {
    if (l === '') { out += '\n'; prevBlank = true; continue; }
    out += out === '' ? l : (prevBlank ? l : ' ' + l);
    prevBlank = false;
  }
  return out;
}

function readSequence(lines, start, parentIndent) {
  const items = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) break;
    const t = line.trim();
    if (!t.startsWith('-')) break;
    items.push(parseScalar(t.slice(1).trim()));
  }
  return { value: items, next: i };
}

function parseScalar(token) {
  if (token === '') return '';
  if (token.startsWith('"')) {
    try { return JSON.parse(token); } catch { /* fall through to plain */ }
  }
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null' || token === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  return token;
}

// Serialize a task object to the YAML dialect parseYaml understands. Used by the
// migration generator and round-trip tests; kept here so the writer and reader
// stay in lockstep.
export function toYaml(obj, keyOrder = ['id', 'title', 'category', 'timeoutSec', 'singleTurn', 'prompt', 'verify', 'judgeFocus']) {
  const keys = [...keyOrder.filter(k => k in obj), ...Object.keys(obj).filter(k => !keyOrder.includes(k))];
  const out = [];
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      out.push(`${key}:`);
      for (const item of value) out.push(`  - ${JSON.stringify(item)}`);
    } else if (typeof value === 'string' && value.includes('\n')) {
      out.push(`${key}: |-`);
      for (const line of value.split('\n')) out.push(line === '' ? '' : `  ${line}`);
    } else if (typeof value === 'string') {
      out.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      out.push(`${key}: ${String(value)}`);
    }
  }
  return out.join('\n') + '\n';
}

export function validateTask(task, source = 'task') {
  for (const field of REQUIRED_FIELDS) {
    if (task[field] === undefined) throw new Error(`${source}: missing required field "${field}"`);
  }
  if (!Array.isArray(task.verify)) throw new Error(`${source}: "verify" must be a list`);
  if (task.verify.some(cmd => typeof cmd !== 'string')) throw new Error(`${source}: every "verify" entry must be a string`);
  return task;
}

export async function loadTasks(tasksDir = TASKS_DIR) {
  const entries = await fs.readdir(tasksDir);
  const tasks = [];
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (ext !== '.json' && ext !== '.yaml' && ext !== '.yml') continue;
    const raw = await fs.readFile(path.join(tasksDir, entry), 'utf8');
    const task = ext === '.json' ? JSON.parse(raw) : parseYaml(raw);
    tasks.push(validateTask(task, entry));
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
