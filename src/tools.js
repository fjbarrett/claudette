import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';

const execFile = promisify(_execFile);

// Workspace boundary check using relative path
function guardPath(filePath, cwd, workspace) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`Missing required 'path' argument (got: ${JSON.stringify(filePath)})`);
  }
  const abs = path.resolve(cwd, filePath);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path '${filePath}' is outside the workspace`);
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
      description: 'Read a file\'s contents. Returns the full text. Prefer this before editing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
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
      name: 'grep',
      description: 'Search for a regex pattern in files. Returns matching lines with file:line context.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex search pattern' },
          path:    { type: 'string', description: 'File or directory to search (default: .)' },
          include: { type: 'string', description: 'Glob to filter files, e.g. "*.js"' },
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

export async function executeTool(name, args, { cwd, workspace }) {
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
      if (!cmd) throw new Error("bash: missing required argument 'command'");
      return runBash(cmd, cwd);
    }
    case 'read_file': {
      if (!args.path) return 'Error: read_file requires {"path": "relative/path/to/file"}';
      return readFile(args.path, cwd, workspace);
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
      return listDir(args.path ?? '.', Number(args.depth ?? 1), cwd, workspace);
    }
    case 'search_code': {
      if (!args.pattern) return 'Error: search_code requires {"pattern": "search regex", "path": "optional/dir"}';
      return runSearchCode(args.pattern, args.path ?? '.', args.include, cwd, workspace);
    }
    case 'grep': {
      if (!args.pattern) return 'Error: grep requires {"pattern": "search regex", "path": "optional/dir"}';
      return runGrep(args.pattern, args.path ?? '.', args.include, cwd);
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

async function runBash(command, cwd) {
  try {
    const { stdout, stderr } = await execFile('bash', ['-c', command], {
      cwd,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const out = [stdout, stderr].filter(Boolean).join('\n').trim();
    return out || '(exit 0, no output)';
  } catch (err) {
    if (err.killed) throw new Error('Command timed out after 30s');
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    throw new Error(out || err.message);
  }
}

async function readFile(filePath, cwd, workspace) {
  const abs = guardPath(filePath, cwd, workspace);
  const stat = await fsp.stat(abs);
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter(e => !e.name.startsWith('.') || e.name.startsWith('.persist'))
      .sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name))
      .map(e => e.isDirectory() ? `${e.name}/` : e.name);
    return `Directory: ${filePath}\n${lines.join('\n')}`;
  }
  const content = await fsp.readFile(abs, 'utf8');
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
  if (!current.includes(oldStr)) {
    throw new Error(`old_str not found in ${filePath}`);
  }
  const occurrences = current.split(oldStr).length - 1;
  if (occurrences > 1) {
    throw new Error(`old_str appears ${occurrences} times in ${filePath} — make it more specific`);
  }
  await fsp.writeFile(abs, current.replace(oldStr, newStr), 'utf8');
  return `Replaced 1 occurrence in ${filePath}`;
}

async function runGlob(pattern, cwd) {
  // bash globstar handles ** reliably
  const script = `shopt -s globstar nullglob dotglob 2>/dev/null; files=(${pattern}); printf '%s\\n' "\${files[@]}"`;
  try {
    const { stdout } = await execFile('bash', ['-c', script], { cwd, timeout: 10_000 });
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

  const response = await fetch(parsed, {
    headers: { 'User-Agent': 'ollama-code/1.0' },
  });
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
    if (!content.includes(oldStr)) {
      throw new Error(`Patch ${applied + 1}: old_str not found in ${filePath}`);
    }
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences > 1) {
      throw new Error(`Patch ${applied + 1}: old_str appears ${occurrences} times in ${filePath}`);
    }
    content = content.replace(oldStr, newStr);
    applied += 1;
  }

  await fsp.writeFile(abs, content, 'utf8');
  return `Applied ${applied} patch${applied === 1 ? '' : 'es'} to ${filePath}`;
}
