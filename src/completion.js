// Tab completion for the REPL prompt.
//
// readline supports a `completer` and we never passed one, so Tab did nothing —
// you had to remember every slash command and type every @path in full.
// Completes two things, which is all the prompt grammar has:
//   /<command>   the slash commands
//   @<path>      workspace files, directory by directory
//
// Kept free of app state (the workspace is injected) so it unit-tests without a
// terminal.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const SLASH_COMMANDS = [
  '/add-dir', '/clear', '/commit', '/compact', '/config', '/cost', '/diff', '/effort',
  '/exit', '/files', '/help', '/model', '/models', '/queue', '/quit', '/resume',
  '/review', '/session', '/sessions', '/status', '/tools', '/vim', '/yolo',
];

/** Slash-command completions for a line, or null when the line isn't a command. */
export function completeSlashCommand(line) {
  if (!/^\/\S*$/.test(line)) return null; // only the command word itself
  const hits = SLASH_COMMANDS.filter(c => c.startsWith(line));
  return [hits.length ? hits : SLASH_COMMANDS, line];
}

/**
 * Complete the @path token at the end of `line` against the workspace.
 * Directories complete with a trailing slash so the next Tab descends into them.
 */
export async function completeAtPath(line, workspace, readdir = fsp.readdir) {
  const match = line.match(/(?:^|\s)@(\S*)$/);
  if (!match) return null;

  const token = match[1];
  const endsInDir = token === '' || token.endsWith('/');
  const dirPart = endsInDir ? token : path.dirname(token);
  const prefix = endsInDir ? '' : path.basename(token);

  const abs = path.resolve(workspace, dirPart === '.' ? '' : dirPart);
  // Never complete outside the workspace — the same boundary @-expansion uses.
  const rel = path.relative(workspace, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [[], token];

  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return [[], token];
  }

  const base = endsInDir ? token : (dirPart === '.' ? '' : `${dirPart}/`);
  const hits = entries
    .filter(e => e.name.startsWith(prefix))
    .filter(e => prefix.startsWith('.') || !e.name.startsWith('.')) // hidden only when asked for
    .filter(e => e.name !== 'node_modules' && e.name !== '.git')
    .sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name))
    .map(e => `${base}${e.name}${e.isDirectory() ? '/' : ''}`);

  return [hits, token];
}

/**
 * Build the async completer readline expects. `getWorkspace` is a function so
 * the completer follows /add-dir without being rebuilt.
 */
export function createCompleter(getWorkspace) {
  return function completer(line, callback) {
    const slash = completeSlashCommand(line);
    if (slash) { callback(null, slash); return; }
    completeAtPath(line, getWorkspace())
      .then(result => callback(null, result ?? [[], line]))
      .catch(() => callback(null, [[], line]));
  };
}
