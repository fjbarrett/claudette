// Persistent per-directory prompt history for up-arrow recall, like a shell.
//
// Each workspace gets its own history file under data/history/ (keyed by the
// absolute path), so re-entering the TUI in the same directory restores what you
// typed there. readline maintains in-session history automatically; this seeds
// it from prior sessions and appends new entries for the next one.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = path.join(__dirname, '..', 'data', 'history');
const MAX_LINES = 1000;

export function historyFile(cwd, dir = HISTORY_DIR) {
  const abs = path.resolve(cwd);
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12);
  const base = (path.basename(abs).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'root');
  return path.join(dir, `${base}-${hash}.log`);
}

// Newest-first list for readline's `history` option (readline stores newest
// first). The on-disk file is oldest-first (append order).
export async function loadHistory(cwd, { dir = HISTORY_DIR, max = MAX_LINES } = {}) {
  try {
    const raw = await fsp.readFile(historyFile(cwd, dir), 'utf8');
    const lines = raw.split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
    return lines.slice(-max).reverse();
  } catch {
    return [];
  }
}

// Append one entered line. Skips blanks and consecutive duplicates, and only
// stores single-line entries (a pasted block collapses to one space-joined line
// so up-arrow recall stays sane). Best-effort: never throws.
export function appendHistory(cwd, line, { dir = HISTORY_DIR } = {}) {
  const text = String(line ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = historyFile(cwd, dir);
    let last = '';
    try {
      const prev = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      last = prev[prev.length - 1] ?? '';
    } catch { /* no file yet */ }
    if (text === last) return; // skip immediate duplicate
    fs.appendFileSync(file, text + '\n', 'utf8');
  } catch { /* history is best-effort */ }
}
