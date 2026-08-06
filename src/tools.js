import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';

const execFile = promisify(_execFile);

// Workspace boundary check using relative path. Error messages are written to be
// actionable: the usage logs showed the model repeating the same mistakes — paths
// outside the workspace (31×) and missing paths (38×) — because the raw errors
// gave it nothing to recover with.
function guardPath(filePath, cwd, workspace) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`Missing required 'path' argument (got: ${JSON.stringify(filePath)}). Pass a path relative to the workspace root, e.g. "src/index.js".`);
  }
  const abs = path.resolve(cwd, filePath);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path '${filePath}' is outside the workspace root. Use a path relative to the workspace (no leading '/' and no '..'); the workspace is the project you are working in.`);
  }
  return abs;
}

// ─── Tool definitions (Ollama/OpenAI function calling format) ─────────────────

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the workspace directory. Use for tests, git, build tools, etc. Avoid interactive commands.',
      parameters: {
        type: 'object',
        properties: {
          command:     { type: 'string', description: 'Shell command to execute' },
          description: { type: 'string', description: 'One-line description of what this does' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file\'s contents. Returns the full text. Prefer this before editing. Use offset/limit to read specific line ranges of large files.',
      parameters: {
        type: 'object',
        properties: {
          path:   { type: 'string',  description: 'File path relative to workspace root' },
          offset: { type: 'integer', description: 'First line to return (1-based). Omit to start at line 1.' },
          limit:  { type: 'integer', description: 'Maximum number of lines to return. Omit for the full file.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or fully overwrite a file. Use str_replace for targeted edits.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to workspace root' },
          content: { type: 'string', description: 'Full content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'str_replace',
      description: 'Replace an exact unique string in a file. The old_str must appear exactly once.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to workspace root' },
          old_str: { type: 'string', description: 'Exact string to find (must be unique in the file)' },
          new_str: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories from a relative path, with optional recursion depth.',
      parameters: {
        type: 'object',
        properties: {
          path:  { type: 'string', description: 'Directory path relative to workspace root' },
          depth: { type: 'integer', description: 'How many levels to recurse (default 1)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern. Supports ** for recursive search. Skips node_modules and .git.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "src/*.js"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search code with ripgrep-style regex matching and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or plain-text search pattern' },
          path:    { type: 'string', description: 'File or directory to search (default: .)' },
          include: { type: 'string', description: 'Optional glob filter such as "*.js"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a URL and return the readable text content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP or HTTPS URL' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Apply one or more exact-match replacements to a file in sequence.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to workspace root' },
          old_str: { type: 'string', description: 'Exact text to replace when applying a single patch' },
          new_str: { type: 'string', description: 'Replacement text for a single patch' },
          patches: {
            type: 'array',
            description: 'Optional batch of replacements to apply in order',
            items: {
              type: 'object',
              properties: {
                old_str: { type: 'string' },
                new_str: { type: 'string' },
              },
              required: ['old_str', 'new_str'],
            },
          },
        },
        required: ['path'],
      },
    },
  },
];

// ─── Executor dispatch ────────────────────────────────────────────────────────

export async function executeTool(name, args, { cwd, workspace, readCache } = {}) {
  switch (name) {
    case 'bash': {
      let cmd = args.command;
      // Models sometimes call run_file → bash with file/file_name instead of command
      if (!cmd) {
        const file = args.file ?? args.file_name ?? args.script ?? args.filename;
        if (file) {
          const ext = path.extname(file).toLowerCase();
          const interp = { '.py': 'python3', '.js': 'node', '.sh': 'bash', '.rb': 'ruby', '.ts': 'ts-node' }[ext];
          cmd = interp ? `${interp} ${file}` : file;
        }
      }
      // Coerce + trim so a missing/blank/non-string command gives a clear error
      // instead of bash's cryptic "-c: option requires an argument".
      cmd = cmd == null ? '' : String(cmd);
      if (!cmd.trim()) throw new Error("bash: missing required argument 'command' — pass the shell command as {\"command\": \"...\"}");
      return runBash(cmd, cwd);
    }
    case 'read_file': {
      if (!args.path) return 'Error: read_file requires {"path": "relative/path/to/file"}';
      // Re-read guard. Usage logs showed the agent re-reading identical, unchanged
      // files many times per turn (one file 23×; 69% of reads redundant), which
      // stalls progress and bloats context. If this exact read (path+range) was
      // already served this turn and the file's mtime is unchanged, return a short
      // pointer instead of the contents. A different range or a changed file reads
      // normally, so nothing is ever truly unreachable.
      if (readCache) {
        const key = `${args.offset ?? ''}|${args.limit ?? ''}`;
        try {
          const mtime = (await fsp.stat(guardPath(args.path, cwd, workspace))).mtimeMs;
          const entry = readCache.get(args.path);
          if (entry && entry.mtime === mtime) {
            // Exact same range, unchanged → already in context.
            if (entry.keys.has(key)) {
              return `[read_file: "${args.path}" — you already read this exact range and the file hasn't changed. Its contents are above; not re-sending. Act on what you have, or read a DIFFERENT file.]`;
            }
            // Same file, different range, but read many times unchanged → the logs
            // showed nano re-reading one file 17× across ranges and never editing.
            if (entry.count >= 3) {
              return `[read_file: you've already read "${args.path}" ${entry.count} times this turn and it hasn't changed. You have enough of this file — stop re-reading it and make your edit, or read a different file.]`;
            }
            const result = await readFile(args.path, cwd, workspace, { offset: args.offset, limit: args.limit });
            entry.keys.add(key); entry.count++;
            return result;
          }
          const result = await readFile(args.path, cwd, workspace, { offset: args.offset, limit: args.limit });
          readCache.set(args.path, { mtime, keys: new Set([key]), count: 1 });
          return result;
        } catch {
          // stat/guard failed (e.g. missing file) — fall through for the normal error path.
        }
      }
      return readFile(args.path, cwd, workspace, { offset: args.offset, limit: args.limit });
    }
    case 'write_file': {
      if (!args.path) return 'Error: write_file requires {"path": "relative/path/to/file", "content": "..."}';
      if (args.content == null) return `Error: write_file requires a "content" field. Got: ${JSON.stringify(args)}`;
      return writeFile(args.path, args.content, cwd, workspace);
    }
    case 'str_replace': {
      if (!args.path) return `Error: str_replace requires a "path" field specifying which file to edit. Got: ${JSON.stringify(args)} — retry with {"path": "filename", "old_str": "...", "new_str": "..."}`;
      if (!args.old_str) return `Error: str_replace requires "old_str" (exact text to find) and "new_str" (replacement). Got: ${JSON.stringify(args)}`;
      return strReplace(args.path, args.old_str, args.new_str ?? '', cwd, workspace);
    }
    case 'glob': {
      if (!args.pattern) return 'Error: glob requires {"pattern": "**/*.js"}';
      return runGlob(args.pattern, cwd);
    }
    case 'list_dir': {
      // Treat an empty/blank path as the workspace root (models sometimes send "").
      const dir = (typeof args.path === 'string' && args.path.trim()) ? args.path : '.';
      return listDir(dir, Number(args.depth ?? 1), cwd, workspace);
    }
    case 'search_code': {
      if (!args.pattern) return 'Error: search_code requires {"pattern": "search regex", "path": "optional/dir"}';
      // Empty/blank path → search the whole workspace (models often send "").
      const sp = (typeof args.path === 'string' && args.path.trim()) ? args.path : '.';
      return runSearchCode(args.pattern, sp, args.include, cwd, workspace);
    }
    case 'grep': {
      if (!args.pattern) return 'Error: grep requires {"pattern": "search regex", "path": "optional/dir"}';
      const gp = (typeof args.path === 'string' && args.path.trim()) ? args.path : '.';
      return runGrep(args.pattern, gp, args.include, cwd);
    }
    case 'fetch_url': {
      if (!args.url) return 'Error: fetch_url requires {"url": "https://..."}';
      return fetchUrl(args.url);
    }
    case 'patch_file': {
      if (!args.path) return 'Error: patch_file requires a "path" field.';
      return patchFile(args.path, args, cwd, workspace);
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Implementations ──────────────────────────────────────────────────────────

// Default bash timeout. The old hard 30s killed real builds/tests (the logs show
// "next build" and "get the web ui running" turns timing out); 120s lets them
// finish. Override with CLAUDETTE_BASH_TIMEOUT (ms).
export function resolveBashTimeout(env = process.env) {
  const n = Number(env.CLAUDETTE_BASH_TIMEOUT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
}

async function runBash(command, cwd) {
  const timeout = resolveBashTimeout();
  try {
    const { stdout, stderr } = await execFile('bash', ['-c', command], {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    const out = [stdout, stderr].filter(Boolean).join('\n').trim();
    return capBashOutput(out) || '(exit 0, no output)';
  } catch (err) {
    if (err.killed) {
      throw new Error(
        `Command timed out after ${Math.round(timeout / 1000)}s. ` +
        `If it just needs longer (a big build/test), raise CLAUDETTE_BASH_TIMEOUT. ` +
        `If it's a long-running server like "next dev" / "npm start", don't run it here — ` +
        `it never exits, so it can't run in the foreground; start it separately or just build/typecheck.`
      );
    }
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    throw new Error(out || err.message);
  }
}

async function readFile(filePath, cwd, workspace, { offset, limit } = {}) {
  const abs = guardPath(filePath, cwd, workspace);
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // The model frequently guesses non-existent paths (59× in the logs). Point
      // it at discovery tools instead of returning a bare ENOENT it can't act on.
      const dir = path.dirname(filePath) || '.';
      throw new Error(`File not found: '${filePath}'. Don't guess paths — run list_dir on "${dir}" to see what exists, or search_code to find the file by name/content.`);
    }
    throw err;
  }
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter(e => !e.name.startsWith('.') || e.name.startsWith('.persist'))
      .sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name))
      .map(e => e.isDirectory() ? `${e.name}/` : e.name);
    return `Directory: ${filePath}\n${lines.join('\n')}`;
  }
  const content = await fsp.readFile(abs, 'utf8');
  const allLines = content.split('\n');
  const totalLines = allLines.length;

  if (offset != null || limit != null) {
    const startLine = offset != null ? Math.max(1, Number(offset)) : 1;
    const endLine   = limit  != null ? startLine + Number(limit) - 1 : totalLines;
    const slice = allLines.slice(startLine - 1, endLine);
    const note  = endLine < totalLines ? `\n\n[lines ${startLine}–${Math.min(endLine, totalLines)} of ${totalLines}]` : '';
    return slice.join('\n') + note;
  }

  const LIMIT = 80_000;
  if (content.length > LIMIT) {
    return content.slice(0, LIMIT) + `\n\n[truncated — showing first ${LIMIT} of ${content.length} chars]`;
  }
  return content;
}

async function writeFile(filePath, content, cwd, workspace) {
  const abs = guardPath(filePath, cwd, workspace);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  // Models sometimes double-escape newlines/tabs (\\n → \n literal) in JSON content.
  // If the content has no real newlines but has literal \n sequences, unescape them.
  const realNewlines = (content.match(/\n/g) ?? []).length;
  const escapedNewlines = (content.match(/\\n/g) ?? []).length;
  if (realNewlines === 0 && escapedNewlines >= 2) {
    content = content
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  await fsp.writeFile(abs, content, 'utf8');
  const lines = content.split('\n').length;
  return `Wrote ${content.length} chars (${lines} lines) to ${filePath}`;
}

async function strReplace(filePath, oldStr, newStr, cwd, workspace) {
  const abs = guardPath(filePath, cwd, workspace);
  const current = await fsp.readFile(abs, 'utf8');
  if (oldStr === newStr) {
    throw new Error(`No changes: old_str and new_str are identical in ${filePath}`);
  }
  if (!current.includes(oldStr)) {
    throw new Error(`old_str not found in ${filePath}.${similarLinesHint(current, oldStr)}`);
  }
  const occurrences = current.split(oldStr).length - 1;
  if (occurrences > 1) {
    throw new Error(`old_str appears ${occurrences} times in ${filePath} — make it more specific`);
  }
  await fsp.writeFile(abs, current.replace(oldStr, newStr), 'utf8');
  return `Replaced 1 occurrence in ${filePath}`;
}

// On a failed match, surface file lines sharing old_str's first token so the model can recover.
function similarLinesHint(content, oldStr) {
  const firstToken = String(oldStr).trim().split(/\s+/)[0];
  if (!firstToken || firstToken.length < 2) return '';
  const matches = content.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes(firstToken))
    .slice(0, 5);
  if (!matches.length) return '';
  return '\nPossible matching lines:\n' + matches.map(m => `  ${m.n}: ${m.line}`).join('\n');
}

async function runGlob(pattern, cwd) {
  // Belt and braces: `glob` is auto-approved (no permission prompt), so refuse
  // command-substitution syntax outright before bash ever sees it.
  if (pattern.includes('`') || pattern.includes('$(')) return '(no matches)';
  // bash globstar handles ** reliably, but the pattern is model-controlled, so it
  // must never be interpolated into the script text — `$(...)` and backticks would
  // execute. Passed as a positional parameter it stays data: `files=($1)` still
  // word-splits and glob-expands, while bash does not re-run command substitution
  // on parameter expansion.
  const script = `shopt -s globstar nullglob dotglob 2>/dev/null; files=($1); printf '%s\\n' "\${files[@]}"`;
  try {
    const { stdout } = await execFile('bash', ['-c', script, 'glob', pattern], { cwd, timeout: 10_000 });
    const files = stdout.trim().split('\n')
      .filter(f => f && !f.includes('node_modules') && !f.includes('/.git/'));
    if (!files.length) return '(no matches)';
    return files.length > 200 ? files.slice(0, 200).join('\n') + `\n… (${files.length - 200} more)` : files.join('\n');
  } catch {
    return '(no matches)';
  }
}

async function listDir(targetPath, depth, cwd, workspace) {
  const abs = guardPath(targetPath, cwd, workspace);
  const stat = await fsp.stat(abs);
  if (!stat.isDirectory()) {
    throw new Error(`${targetPath} is not a directory`);
  }
  const maxDepth = Number.isFinite(depth) ? Math.max(0, Math.min(5, depth)) : 1;
  const lines = [`Directory: ${targetPath}`];
  await walkDir(abs, path.relative(workspace, abs) || '.', 0);
  return lines.join('\n');

  async function walkDir(dirAbs, label, level) {
    const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    const visible = entries
      .filter(entry => !entry.name.startsWith('.git'))
      .sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name));
    for (const entry of visible) {
      const prefix = `${'  '.repeat(level)}- `;
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory() && level < maxDepth) {
        await walkDir(path.join(dirAbs, entry.name), `${label}/${entry.name}`, level + 1);
      }
    }
  }
}

async function runGrep(pattern, searchPath, include, cwd) {
  const args = ['-r', '-n', '--color=never', '-I'];
  if (include) args.push(`--include=${include}`);
  args.push('--', pattern, searchPath);
  try {
    const { stdout } = await execFile('grep', args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (!lines.length) return '(no matches)';
    if (lines.length > 60) return lines.slice(0, 60).join('\n') + `\n… (${lines.length - 60} more matches)`;
    return lines.join('\n');
  } catch (err) {
    if (err.code === 1) return '(no matches)';
    throw err;
  }
}

async function runSearchCode(pattern, searchPath, include, cwd, workspace) {
  const abs = guardPath(searchPath, cwd, workspace);
  const relative = path.relative(cwd, abs) || '.';
  try {
    const args = ['--line-number', '--no-heading', '--color=never'];
    if (include) args.push('--glob', include);
    args.push(pattern, relative);
    const { stdout } = await execFile('rg', args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (!lines.length) return '(no matches)';
    return lines.length > 80 ? lines.slice(0, 80).join('\n') + `\n… (${lines.length - 80} more matches)` : lines.join('\n');
  } catch (err) {
    if (err.code === 1) return '(no matches)';
    return runGrep(pattern, relative, include, cwd);
  }
}

// Loopback, private, and link-local ranges. fetch_url is auto-approved, so a
// model-chosen URL must not be able to reach the host's own network or a cloud
// metadata endpoint (169.254.169.254).
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;          // 0.0.0.0/8, 10/8, loopback
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
    if (a === 192 && b === 168) return true;                    // 192.168/16
    if (a === 169 && b === 254) return true;                    // link-local / metadata
    return false;
  }
  const ipv6 = ip.toLowerCase();
  if (ipv6 === '::1' || ipv6 === '::') return true;             // loopback, unspecified
  if (/^f[cd]/.test(ipv6) || ipv6.startsWith('fe80')) return true; // unique-local, link-local
  const mapped = ipv6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped, e.g. ::ffff:127.0.0.1
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

// Resolve first: a public hostname can point at a private IP, so the hostname
// alone proves nothing.
async function assertPublicHost(parsed) {
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // URL keeps [] around IPv6 literals
  let address;
  try {
    ({ address } = await dns.lookup(host));
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (isPrivateAddress(address)) {
    throw new Error(`Refusing to fetch ${host} — it resolves to a private or loopback address (${address}). fetch_url only reaches public hosts.`);
  }
}

async function fetchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }

  // Follow redirects by hand so every hop gets the same private-address check —
  // otherwise a public URL could just 302 to http://169.254.169.254/.
  let response;
  for (let hop = 0; ; hop++) {
    if (hop > 5) throw new Error('Too many redirects');
    await assertPublicHost(parsed);
    response = await fetch(parsed, {
      headers: { 'User-Agent': 'ollama-code/1.0' },
      redirect: 'manual',
    });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) break;
    parsed = new URL(location, parsed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http and https URLs are allowed');
    }
  }
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  const text = contentType.includes('html')
    ? raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : raw.trim();
  const LIMIT = 50_000;
  const body = text.length > LIMIT ? `${text.slice(0, LIMIT)}\n\n[truncated]` : text;
  return `URL: ${parsed.toString()}\nContent-Type: ${contentType || 'unknown'}\n\n${body}`;
}

async function patchFile(filePath, args, cwd, workspace) {
  const abs = guardPath(filePath, cwd, workspace);
  let content = await fsp.readFile(abs, 'utf8');
  const patches = Array.isArray(args.patches) && args.patches.length
    ? args.patches
    : [{ old_str: args.old_str, new_str: args.new_str ?? '' }];

  if (!patches[0]?.old_str) {
    throw new Error('patch_file requires either patches[] or old_str/new_str');
  }

  let applied = 0;
  for (const patch of patches) {
    const { old_str: oldStr, new_str: newStr = '' } = patch;
    // Same recovery-oriented errors as str_replace — failed patches were a common
    // dead end in the logs (the model retried blindly instead of fixing the patch).
    if (oldStr === newStr) {
      throw new Error(`Patch ${applied + 1}: no changes — old_str and new_str are identical in ${filePath}. Put the UPDATED text in new_str (it must differ from old_str).`);
    }
    if (!content.includes(oldStr)) {
      throw new Error(`Patch ${applied + 1}: old_str not found in ${filePath}.${similarLinesHint(content, oldStr)}`);
    }
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences > 1) {
      throw new Error(`Patch ${applied + 1}: old_str appears ${occurrences} times in ${filePath} — include surrounding lines to make it unique.`);
    }
    content = content.replace(oldStr, newStr);
    applied += 1;
  }

  await fsp.writeFile(abs, content, 'utf8');
  return `Applied ${applied} patch${applied === 1 ? '' : 'es'} to ${filePath}`;
}

// Cap bash output before it enters the model context. Large command dumps (e.g.
// a multi-megabyte API response) would otherwise be re-sent on every subsequent
// tool iteration, multiplying token cost. Keep the head and tail (errors and
// summaries usually live at the end). Override with CLAUDETTE_BASH_OUTPUT_CHARS.
export function capBashOutput(text) {
  const limit = Number(process.env.CLAUDETTE_BASH_OUTPUT_CHARS ?? 16_000);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  const omitted = text.length - limit;
  return `${text.slice(0, head)}\n\n… [bash output truncated — ${omitted} chars omitted] …\n\n${text.slice(text.length - tail)}`;
}
