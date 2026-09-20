// Zero-dependency .env loader.
//
// Lets users keep provider keys in a trusted Claudette or user configuration
// file instead of re-exporting shell vars every session. A workspace `.env` is
// deliberately not loaded: the checkout being edited must not control approval,
// provider endpoint, or model-tool environment policy.
//
// Precedence (first wins; a real process.env value always wins over any file):
//   1. $CLAUDETTE_ENV_FILE     — explicit trusted file, when configured
//   2. <package root>/.env     — a Claudette development checkout
//   3. ~/.config/claudette/.env — global user configuration
//
// This module imports nothing that reads env, so importing it first is safe.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse the contents of a .env file into a plain object. Supports:
 *   - `KEY=value`, `export KEY=value`, `KEY = value`
 *   - single/double-quoted values (quotes stripped)
 *   - `# full-line comments` and blank lines (skipped)
 *   - values containing `=` (split on the first `=` only)
 * Inline comments are NOT stripped — keep comments on their own line so values
 * may safely contain `#`.
 */
export function parseEnv(text = '') {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function candidateFiles({
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
  packageRoot = PACKAGE_ROOT,
} = {}) {
  const explicit = String(env.CLAUDETTE_ENV_FILE ?? '').trim();
  const files = [
    ...(explicit ? [path.resolve(cwd, explicit)] : []),
    path.join(packageRoot, '.env'),
    path.join(home, '.config', 'claudette', '.env'),
  ];
  // De-dupe identical resolved paths (e.g. run from the package root) while
  // preserving order.
  const seen = new Set();
  return files.filter(f => {
    const r = path.resolve(f);
    if (seen.has(r)) return false;
    seen.add(r);
    return true;
  });
}

/**
 * Load .env files into process.env. A real (already-set) process.env value is
 * never overwritten, and earlier files win over later ones. Returns the list of
 * keys that were applied (useful for tests / a startup hint).
 */
export function loadEnv({ env = process.env, files = candidateFiles() } = {}) {
  const applied = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // missing/unreadable file → skip
    }
    const parsed = parseEnv(text);
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined && !applied.includes(key)) {
        env[key] = value;
        applied.push(key);
      }
    }
  }
  return applied;
}
