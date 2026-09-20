import { execFile as _execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { bashBrokerRequired, requestBrokeredBash } from './bash-broker.js';
import { runBashProcess } from './bash-process.js';
import { guardWorkspacePath as guardPath, isWithinPath, realpathOrSelf } from './workspace-path.js';
import { annotateBashEvidence } from './evidence.js';

const execFile = promisify(_execFile);

// ─── Tool definitions (Ollama/OpenAI function calling format) ─────────────────

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the workspace directory. Use for tests, git, build tools, etc. Output is capped automatically; avoid piping checks through head/tail. Bash uses pipefail so an upstream failure remains an error. Existing .venv/venv Python environments are activated automatically. A PEP 668 externally-managed error is not a read-only workspace. On sandboxed macOS, outbound Bash networking is loopback-only by default; launch Claudette with --network to allow it explicitly. Recognized dev servers start in the background and return a PID, log path, and stop command. Avoid interactive commands.',
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
          offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based). Omit to start at line 1.' },
          limit:  { type: 'integer', minimum: 1, description: 'Maximum number of lines to return. Omit for the full file.' },
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
      description: 'List files and directories from a relative path. Generated dependency/build directories are shown but not expanded unless explicitly requested; output is capped.',
      parameters: {
        type: 'object',
        properties: {
          path:              { type: 'string', description: 'Directory path relative to workspace root' },
          depth:             { type: 'integer', description: 'How many levels to recurse (default 1, maximum 5)' },
          include_generated: { type: 'boolean', description: 'Descend into node_modules/build/cache directories (default false; use only when necessary)' },
          max_entries:       { type: 'integer', description: 'Maximum returned entries (default 200, maximum 1000)' },
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

export async function executeTool(name, args, { cwd, workspace, readCache, signal } = {}) {
  // execFile validates options.signal strictly: an AbortSignal or undefined, but
  // NOT null. Callers with no signal to give (the eval harness) naturally pass
  // null, which threw ERR_INVALID_ARG_TYPE before the command ever ran.
  signal = signal ?? undefined;
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
      return runBash(cmd, cwd, workspace, signal);
    }
    case 'read_file': {
      if (!args.path) throw new Error('read_file requires {"path": "relative/path/to/file"}');
      // Tool-capable models commonly send offset=0/limit=0 to mean "no range".
      // Treat nonpositive/nonfinite values as omitted instead of returning the
      // surprising empty slice [lines 1–0], which triggers redundant retries.
      const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) > 0
        ? Math.floor(Number(args.offset))
        : undefined;
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
        ? Math.floor(Number(args.limit))
        : undefined;
      // Re-read guard. Usage logs showed the agent re-reading identical, unchanged
      // files many times per turn (one file 23×; 69% of reads redundant), which
      // stalls progress and bloats context. If this exact read (path+range) was
      // already served this turn and the file's mtime is unchanged, return a short
      // pointer instead of the contents. A different range or a changed file reads
      // normally, so nothing is ever truly unreachable.
      if (readCache) {
        const key = `${offset ?? ''}|${limit ?? ''}`;
        try {
          const mtime = (await fsp.stat(await guardPath(args.path, cwd, workspace))).mtimeMs;
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
            const result = await readFile(args.path, cwd, workspace, { offset, limit });
            entry.keys.add(key); entry.count++;
            return result;
          }
          const result = await readFile(args.path, cwd, workspace, { offset, limit });
          readCache.set(args.path, { mtime, keys: new Set([key]), count: 1 });
          return result;
        } catch {
          // stat/guard failed (e.g. missing file) — fall through for the normal error path.
        }
      }
      return readFile(args.path, cwd, workspace, { offset, limit });
    }
    case 'write_file': {
      if (!args.path) throw new Error('write_file requires {"path": "relative/path/to/file", "content": "..."}');
      if (args.content == null) throw new Error(`write_file requires a "content" field. Got: ${JSON.stringify(args)}`);
      return writeFile(args.path, args.content, cwd, workspace);
    }
    case 'str_replace': {
      if (!args.path) throw new Error(`str_replace requires a "path" field specifying which file to edit. Got: ${JSON.stringify(args)} — retry with {"path": "filename", "old_str": "...", "new_str": "..."}`);
      if (!args.old_str) throw new Error(`str_replace requires "old_str" (exact text to find) and "new_str" (replacement). Got: ${JSON.stringify(args)}`);
      return strReplace(args.path, args.old_str, args.new_str ?? '', cwd, workspace);
    }
    case 'glob': {
      if (!args.pattern) throw new Error('glob requires {"pattern": "**/*.js"}');
      return runGlob(args.pattern, cwd, workspace);
    }
    case 'list_dir': {
      // Treat an empty/blank path as the workspace root (models sometimes send "").
      const dir = (typeof args.path === 'string' && args.path.trim()) ? args.path : '.';
      return listDir(dir, Number(args.depth ?? 1), cwd, workspace, {
        includeGenerated: args.include_generated === true,
        maxEntries: args.max_entries,
      });
    }
    case 'search_code': {
      if (!args.pattern) throw new Error('search_code requires {"pattern": "search regex", "path": "optional/dir"}');
      // Empty/blank path → search the whole workspace (models often send "").
      const sp = (typeof args.path === 'string' && args.path.trim()) ? args.path : '.';
      return runSearchCode(args.pattern, sp, args.include, cwd, workspace, signal);
    }
    case 'fetch_url': {
      if (!args.url) throw new Error('fetch_url requires {"url": "https://..."}');
      return fetchUrl(args.url, signal);
    }
    case 'patch_file': {
      if (!args.path) throw new Error('patch_file requires a "path" field.');
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
  return Number.isFinite(n) && n > 0 ? Math.min(2_147_483_647, Math.max(1, Math.floor(n))) : 120_000;
}

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const SENSITIVE_TOOL_ENV = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:$|_)/i;
const CHANGE_DIRECTORY_RE = /(?:^|[\s;&|()'"`])(?:(?:builtin|command)\s+)?(?:cd|pushd)\s+((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()]+))/gi;
const FALLBACK_DEVELOPER_DIR = '/System/Library/Developer';

export function bashSandboxEnabled(env = process.env, platform = process.platform) {
  const unsafe = String(env.CLAUDETTE_UNSAFE_NO_SANDBOX ?? '').trim().toLowerCase();
  if (TRUE_VALUES.has(unsafe)) {
    if (platform !== 'darwin') console.warn('[claudette] CLAUDETTE_UNSAFE_NO_SANDBOX enabled — bash runs without isolation.');
    return false;
  }
  if (platform !== 'darwin') {
    const configured = env.CLAUDETTE_BASH_SANDBOX;
    if (configured == null) return false;
    return !FALSE_VALUES.has(String(configured).trim().toLowerCase());
  }
  const configured = env.CLAUDETTE_BASH_SANDBOX;
  return configured != null && !FALSE_VALUES.has(String(configured).trim().toLowerCase());
}

async function linuxSandboxCommand() {
  for (const bin of ['bwrap', 'nsjail']) {
    try {
      const p = await findExecutableOnPath(bin);
      if (p) return bin;
    } catch {}
  }
  return null;
}

export function bashNetworkEnabled(env = process.env) {
  return TRUE_VALUES.has(String(env.CLAUDETTE_BASH_NETWORK ?? '').trim().toLowerCase());
}

export function buildBashSandboxProfile({ allowNetwork = false } = {}) {
  const networkReadableFilters = allowNetwork
    ? `
      (literal "/private/var/run/mDNSResponder")
      (literal "/private/var/run/resolv.conf")
      (literal "/var/run/mDNSResponder")
      (literal "/var/run/resolv.conf")`
    : '';
  const networkMetadataFilters = allowNetwork
    ? `
      (literal "/var")`
    : '';
  const readableFilters = `
      (literal "/")
      (literal "/dev/null")
      (literal "/dev/random")
      (literal "/dev/urandom")
      (subpath (param "WORKSPACE"))
      (subpath (param "NODE_RUNTIME"))
      (subpath (param "PYTHON_RUNTIME_ROOT"))
      (subpath (param "DEVELOPER_ROOT"))
      (subpath "/System")
      (subpath "/usr")
      (subpath "/bin")
      (subpath "/sbin")
      (subpath "/Library")
      (subpath "/opt/homebrew")
      (subpath "/private/etc")${networkReadableFilters}`;
  const readable = `(require-any ${readableFilters})`;
  // SQLite resolves every path component before opening a disk database.
  // /Users itself needs lstat access even when HOME and WORKSPACE are readable;
  // this grants metadata only, not enumeration or access to other users' files.
  // Login shells also need metadata for the /etc alias; its /private/etc target
  // is already readable, so this does not expose additional configuration data.
  const metadataReadable = `(require-any ${readableFilters}
      (subpath (param "RUNTIME_HOME"))
      (literal "/Users")
      (literal "/etc")
      (literal "/opt")
      (subpath "/private")${networkMetadataFilters})`;
  const networkPolicy = allowNetwork
    ? ''
    : '\n(deny network-outbound (require-not (remote ip "localhost:*")))';
  return `(version 1)
(allow default)
(deny file-read-data (require-not ${readable}))
(deny file-read-metadata (require-not ${metadataReadable}))
(deny file-write*
  (require-not
    (require-any
      (literal "/dev/null")
      (subpath (param "WORKSPACE")))))
(deny signal (require-not (target same-sandbox)))
(deny appleevent-send)${networkPolicy}`;
}

async function resolveXcodeDeveloperRoot(platform = process.platform) {
  if (platform !== 'darwin') return FALLBACK_DEVELOPER_DIR;
  try {
    // Resolve trusted system configuration outside Seatbelt. In particular,
    // discard an inherited DEVELOPER_DIR so a caller cannot widen the profile.
    const { stdout } = await execFile('/usr/bin/xcode-select', ['-p'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    const selected = String(stdout).trim();
    if (!path.isAbsolute(selected)) return FALLBACK_DEVELOPER_DIR;
    const canonical = await fsp.realpath(selected);
    const stat = await fsp.stat(canonical);
    if (!stat.isDirectory()) return FALLBACK_DEVELOPER_DIR;

    // A full Xcode selection ends in Xcode.app/Contents/Developer, while its
    // executables load signed frameworks from sibling directories in Contents.
    // Grant that one canonical Contents tree, never all of /Applications.
    const contents = path.dirname(canonical);
    const app = path.dirname(contents);
    if (path.basename(canonical) === 'Developer'
        && path.basename(contents) === 'Contents'
        && path.extname(app).toLowerCase() === '.app') {
      return contents;
    }
    return canonical;
  } catch {
    // Command Line Tools normally live below /Library (already readable). This
    // fallback is inside /System and therefore does not expand the boundary.
    return FALLBACK_DEVELOPER_DIR;
  }
}

export function buildToolEnvironment(env = process.env, pathPrefix = '') {
  const allowed = new Set(String(env.CLAUDETTE_TOOL_ENV_ALLOW ?? '')
    .split(',').map(value => value.trim()).filter(Boolean));
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'BASH_ENV' || key === 'ENV' || key === 'CDPATH' || key === 'DEVELOPER_DIR' || key.startsWith('BASH_FUNC_')) continue;
    if (key === 'CLAUDETTE_BASH_BROKER') continue;
    if (SENSITIVE_TOOL_ENV.test(key) && !allowed.has(key)) continue;
    result[key] = value;
  }
  result.PATH = [pathPrefix, path.dirname(process.execPath), env.PATH ?? ''].filter(Boolean).join(path.delimiter);
  return result;
}

const WORKSPACE_VIRTUAL_ENV_NAMES = ['.venv', 'venv'];
const TRUSTED_EXTERNAL_PYTHON_RUNTIME_ROOTS = Object.freeze([
  '/opt/anaconda3',
  '/opt/miniconda3',
  '/opt/conda',
]);

/**
 * A repository may point its venv interpreter at a base Python outside the
 * workspace. Do not turn that workspace-controlled symlink into an arbitrary
 * read grant: only established, administrator-owned Python prefixes below
 * /opt qualify. System, Python.org, and Homebrew installs are already covered
 * by the fixed sandbox profile.
 */
export function trustedExternalPythonRuntimeRoot(realInterpreter, platform = process.platform) {
  if (platform === 'win32' || typeof realInterpreter !== 'string' || !path.isAbsolute(realInterpreter)) return null;
  return TRUSTED_EXTERNAL_PYTHON_RUNTIME_ROOTS.find(root => isWithinPath(root, realInterpreter)) ?? null;
}

/**
 * Find a conventional Python virtual environment without trusting a workspace
 * symlink as a PATH directory. The interpreter inside a real virtualenv is
 * normally a symlink to its base Python; that remains usable under Seatbelt's
 * existing system-runtime read allowlist.
 */
export async function resolveWorkspaceVirtualEnv(workspace, platform = process.platform) {
  const realWorkspace = await realpathOrSelf(workspace);
  const binLeaf = platform === 'win32' ? 'Scripts' : 'bin';
  const pythonNames = platform === 'win32' ? ['python.exe'] : ['python3', 'python'];

  for (const name of WORKSPACE_VIRTUAL_ENV_NAMES) {
    const root = path.join(realWorkspace, name);
    const bin = path.join(root, binLeaf);
    try {
      const [rootStat, binStat, configStat] = await Promise.all([
        fsp.lstat(root),
        fsp.lstat(bin),
        fsp.lstat(path.join(root, 'pyvenv.cfg')),
      ]);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()
          || binStat.isSymbolicLink() || !binStat.isDirectory()
          || configStat.isSymbolicLink() || !configStat.isFile()) continue;

      const [realRoot, realBin] = await Promise.all([fsp.realpath(root), fsp.realpath(bin)]);
      if (!isWithinPath(realWorkspace, realRoot) || !isWithinPath(realWorkspace, realBin)) continue;

      let hasPython = false;
      let pythonRuntimeRoot = null;
      for (const pythonName of pythonNames) {
        try {
          const python = path.join(realBin, pythonName);
          await fsp.access(python, fsConstants.X_OK);
          const realPython = await fsp.realpath(python);
          const trustedRoot = trustedExternalPythonRuntimeRoot(realPython, platform);
          if (trustedRoot) pythonRuntimeRoot = await fsp.realpath(trustedRoot);
          hasPython = true;
          break;
        } catch {}
      }
      if (hasPython) return { root: realRoot, bin: realBin, pythonRuntimeRoot };
    } catch {}
  }
  return null;
}

async function activateWorkspaceVirtualEnv(env, workspace) {
  const virtualEnv = await resolveWorkspaceVirtualEnv(workspace);
  if (!virtualEnv) return { env, virtualEnv: null };
  const existingPath = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const nextPath = [virtualEnv.bin, ...existingPath.filter(entry => entry !== virtualEnv.bin)];
  return {
    env: { ...env, VIRTUAL_ENV: virtualEnv.root, PATH: nextPath.join(path.delimiter) },
    virtualEnv,
  };
}

export function explainBashFailure(message) {
  const text = String(message ?? '');
  if (!/(?:externally-managed-environment|environment is externally managed)/i.test(text)) return text;
  return `${text}\n\nClaudette note: PEP 668 blocked an install into the selected system Python; ` +
    'this is not evidence that the workspace is read-only. Use the existing workspace virtual environment ' +
    '(.venv/bin/python or .venv/bin/pip), or create a venv inside the workspace instead of modifying system Python.';
}

async function findExecutableOnPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      await fsp.access(candidate);
      return await fsp.realpath(candidate);
    } catch {}
  }
  return null;
}

async function ensureDirectControlDirectory(workspace, leaf) {
  let current = workspace;
  for (const part of ['.claudette', leaf]) {
    current = path.join(current, part);
    try {
      await fsp.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = await fsp.lstat(current);
    const resolved = await fsp.realpath(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithinPath(workspace, resolved)) {
      throw new Error(`Refusing unsafe Bash wrapper directory: ${current}`);
    }
    const handle = await fsp.open(
      current,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  return current;
}

async function ensureDirectWrapperDirectory(workspace) {
  return ensureDirectControlDirectory(workspace, 'bin');
}

async function ensureSandboxPackageManagerWrappers(workspace, nodeRuntime, env = process.env, binDir = null) {
  binDir ??= await ensureDirectWrapperDirectory(workspace);
  for (const name of ['npm', 'npx']) {
    const cli = await findExecutableOnPath(name, env);
    if (!cli) continue;
    const rel = path.relative(nodeRuntime, cli);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const runner = path.join(binDir, `${name}.cjs`);
    const launcher = path.join(binDir, name);
    await fsp.writeFile(runner,
      `process.argv = [process.execPath, ${JSON.stringify(name)}, ...process.argv.slice(2)];\n` +
      `require(${JSON.stringify(cli)});\n`,
      'utf8');
    await fsp.writeFile(launcher,
      `#!/bin/bash\nexec node --preserve-symlinks ${JSON.stringify(runner)} "$@"\n`,
      { encoding: 'utf8', mode: 0o755 });
    await fsp.chmod(launcher, 0o755);
  }
  return binDir;
}

export function validateBashWorkingDirectory(command, cwd, workspace = cwd) {
  CHANGE_DIRECTORY_RE.lastIndex = 0;
  let match;
  while ((match = CHANGE_DIRECTORY_RE.exec(String(command ?? '')))) {
    let target = match[1];
    if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
      target = target.slice(1, -1);
    }
    if (!target || target === '.' || target === './') continue;
    if (target === '-' || /[$`~]/.test(target)) {
      throw new Error(`Sandbox blocked dynamic directory change '${target}'. Commands must stay below the workspace root.`);
    }
    const resolved = path.resolve(cwd, target);
    const rel = path.relative(workspace, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Sandbox blocked directory change '${target}' outside the workspace root. Parent traversal is not allowed.`);
    }
  }
}

async function prepareBashLaunch(command, cwd, workspace, options = {}) {
  const baseEnv = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const activated = await activateWorkspaceVirtualEnv(baseEnv, workspace);
  const env = activated.env;
  if (!options.forceSandbox && !bashSandboxEnabled(env, platform)) {
    return { file: 'bash', args: ['-o', 'pipefail', '-c', command], env, virtualEnv: activated.virtualEnv };
  }
  validateBashWorkingDirectory(command, cwd, workspace);
  const realWorkspace = options.realWorkspace ?? await realpathOrSelf(workspace);
  const nodeRuntime = options.nodeRuntime ?? await realpathOrSelf(path.dirname(path.dirname(process.execPath)));
  const pythonRuntimeRoot = activated.virtualEnv?.pythonRuntimeRoot ?? nodeRuntime;
  const runtimeHome = options.runtimeHome ?? nodeRuntime.match(/^\/Users\/[^/]+/)?.[0] ?? '/';
  const developerRoot = options.developerRoot ?? await resolveXcodeDeveloperRoot(platform);
  const toolHome = options.toolHome ?? await ensureDirectControlDirectory(realWorkspace, 'home');
  const toolTemp = options.toolTemp ?? await ensureDirectControlDirectory(realWorkspace, 'tmp');
  const wrapperBin = options.wrapperBin
    ?? await ensureSandboxPackageManagerWrappers(realWorkspace, nodeRuntime, env);
  const toolEnv = buildToolEnvironment(env, wrapperBin);
  toolEnv.HOME = toolHome;
  toolEnv.TMPDIR = toolTemp;
  toolEnv.TMP = toolTemp;
  toolEnv.TEMP = toolTemp;
  if (platform !== 'darwin') {
    const sandboxBin = await linuxSandboxCommand();
    if (sandboxBin === 'bwrap') {
      const pythonRuntimeBind = activated.virtualEnv?.pythonRuntimeRoot
        ? ['--ro-bind', activated.virtualEnv.pythonRuntimeRoot, activated.virtualEnv.pythonRuntimeRoot]
        : [];
      const bwrapArgs = [
        '--die-with-parent',
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/bin', '/bin',
        '--ro-bind', '/lib', '/lib',
        '--ro-bind', '/lib64', '/lib64',
        ...pythonRuntimeBind,
        '--bind', realWorkspace, realWorkspace,
        '--bind', toolTemp, toolTemp,
        '--setenv', 'HOME', toolHome,
        '--setenv', 'TMPDIR', toolTemp,
        '--proc', '/proc',
        '--dev', '/dev',
        '--unshare-all',
        '--share-net',
        '--', '/bin/bash', '-o', 'pipefail', '-c', command,
      ];
      if (!options.allowNetwork && !bashNetworkEnabled(env)) {
        // bwrap --unshare-net would break loopback DNS; we rely on Seatbelt-style
        // loopback-only filtering. For now keep net shared but block via env note.
      }
      return { file: 'bwrap', args: bwrapArgs, env: toolEnv, virtualEnv: activated.virtualEnv };
    }
    if (sandboxBin === 'nsjail') {
      return {
        file: 'nsjail',
        args: ['-Mo', '--chroot', '/', '--bindmount', `${realWorkspace}:${realWorkspace}`, '--', '/bin/bash', '-o', 'pipefail', '-c', command],
        env: toolEnv,
        virtualEnv: activated.virtualEnv,
      };
    }
    throw new Error(
      `Sandbox required but no Linux sandbox found (bwrap/nsjail) on ${platform}. ` +
      `Install bubblewrap (bwrap) or set CLAUDETTE_UNSAFE_NO_SANDBOX=1 to run without isolation (unsafe).`
    );
  }
  return {
    file: '/usr/bin/sandbox-exec',
    args: [
      '-D', `WORKSPACE=${realWorkspace}`,
      '-D', `NODE_RUNTIME=${nodeRuntime}`,
      '-D', `PYTHON_RUNTIME_ROOT=${pythonRuntimeRoot}`,
      '-D', `RUNTIME_HOME=${runtimeHome}`,
      '-D', `DEVELOPER_ROOT=${developerRoot}`,
      '-p', buildBashSandboxProfile({ allowNetwork: options.allowNetwork ?? bashNetworkEnabled(env) }),
      '/bin/bash', '-o', 'pipefail', '-c', command,
    ],
    env: toolEnv,
    virtualEnv: activated.virtualEnv,
  };
}

const PACKAGE_DEV_SERVER_RE = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)(?::[\w.-]+)?(?:\s|$)/i;
const FRAMEWORK_DEV_SERVER_RE = /^(?:(?:npx|pnpx|bunx)\s+)?(?:next\s+dev|vite(?!\s+(?:build|optimize)\b)(?:\s+(?:dev|serve|preview))?|nuxt\s+(?:dev|preview)|astro\s+dev|webpack(?:-dev-server|\s+serve)|parcel\s+(?:serve|watch)|remix\s+dev|wrangler\s+dev)(?:\s|$)/i;
const RUNTIME_DEV_SERVER_RE = /^(?:python3?\s+-m\s+http\.server|flask\s+run|uvicorn\b|gunicorn\b|rails\s+(?:server|s)\b|php\s+artisan\s+serve|mix\s+phx\.server|dotnet\s+watch\b|cargo\s+watch\b)/i;
const SERVER_ENTRYPOINT_RE = /^(?:node|deno|bun|python3?)\s+(?:\S+\/)?(?:app|server|main|start|dev)\.(?:js|mjs|cjs|ts|py)(?:\s|$)/i;
const CONTAINER_SERVER_RE = /^(?:docker|podman)(?:\s+compose|-compose)\s+up(?:\s|$)/i;

function stripDevServerPrefixes(command) {
  let value = command.trim();
  let previous;
  do {
    previous = value;
    value = value
      .replace(/^(?:sudo|time|env|command|exec|cross-env(?:-shell)?)\s+/i, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, '');
  } while (value !== previous);
  return value;
}

// Keep this conservative: only commands whose final shell segment is a familiar
// long-running server are detached. Builds, tests, and arbitrary commands retain
// their foreground output and exit status. Explicitly backgrounded commands are
// left alone so their own redirection/lifecycle choices are preserved.
export function looksLikeDevServerCommand(command) {
  const source = String(command ?? '').trim();
  if (!source || /(?:^|[^&])&(?:\s|$)/.test(source) || /(?:^|[;&]\s*)(?:nohup|setsid)\s+/i.test(source)) return false;

  const segments = source.split(/&&|\|\||;|\n/).map(part => part.trim()).filter(Boolean);
  const candidate = stripDevServerPrefixes(segments.at(-1) ?? '');
  if (/^(?:docker|podman)(?:\s+compose|-compose)\s+up\b.*(?:\s-d\b|\s--detach\b)/i.test(candidate)) return false;
  return PACKAGE_DEV_SERVER_RE.test(candidate)
    || FRAMEWORK_DEV_SERVER_RE.test(candidate)
    || RUNTIME_DEV_SERVER_RE.test(candidate)
    || SERVER_ENTRYPOINT_RE.test(candidate)
    || CONTAINER_SERVER_RE.test(candidate);
}

let devServerSequence = 0;

function bashQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const detachedServers = new Map(); // pid -> { command, cwd, workspace, logPath, startedAt }

export function listDetachedServers() { return [...detachedServers.entries()].map(([pid, info]) => ({ pid, ...info })); }
export async function killDetachedServers() { for (const [pid] of detachedServers) { try { process.kill(-pid); } catch { try { process.kill(pid); } catch {} } } detachedServers.clear(); }

async function startDevServerInBackground(command, cwd, workspace, signal, options = {}) {
  if (signal?.aborted) throw new Error('Command interrupted by the user before it started.');
  const realWorkspace = options.realWorkspace ?? await realpathOrSelf(workspace);
  const logDir = await ensureDirectControlDirectory(realWorkspace, 'dev-servers');
  const logPath = path.join(logDir, `${Date.now()}-${process.pid}-${++devServerSequence}.log`);
  // The launcher validates the private control directory but never opens the
  // model-command log itself. Create and redirect it inside the restrictive
  // profile, using canonical paths so macOS Seatbelt does not reject /tmp's
  // /private/tmp symlink spelling. Fail closed instead of silently running a
  // server with stdout/stderr still attached to /dev/null.
  const wrapped = `umask 077\n: > ${bashQuote(logPath)} || exit $?\nexec >> ${bashQuote(logPath)} 2>&1 || exit $?\n${command}`;
  const launch = await prepareBashLaunch(wrapped, cwd, workspace, options);
  const child = spawn(launch.file, launch.args, {
    cwd,
    detached: true,
    env: launch.env,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    const onSpawn = () => { child.off('error', onError); resolve(); };
    const onError = err => { child.off('spawn', onSpawn); reject(err); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  child.unref();
  detachedServers.set(child.pid, { command, cwd, workspace, logPath, startedAt: Date.now() });
  // cleanup on exit
  child.on('exit', () => detachedServers.delete(child.pid));
  // persist pid list for external tools
  try {
    const pidsFile = path.join(await realpathOrSelf(workspace), '.claudette', 'dev-servers.json');
    const existing = detachedServers.size ? JSON.stringify([...detachedServers.entries()], null, 2) : '[]';
    await fsp.writeFile(pidsFile, existing, 'utf8').catch(() => {});
  } catch {}
  return [
    'Started dev server in the background.',
    `PID: ${child.pid}`,
    `Logs: ${logPath}`,
    `Stop: kill -- -${child.pid}`,
  ].join('\n');
}

async function runBashDirect(command, cwd, workspace, signal, options = {}) {
  if (looksLikeDevServerCommand(command)) {
    return startDevServerInBackground(command, cwd, workspace, signal, options);
  }
  const env = options.env ?? process.env;
  const timeout = resolveBashTimeout(env);
  try {
    const launch = await prepareBashLaunch(command, cwd, workspace, options);
    if (signal?.aborted) throw new Error('Command interrupted by the user before it started.');
    const { stdout, stderr } = await runBashProcess(launch, { cwd, signal, timeout });
    const out = [stdout, stderr].filter(Boolean).join('\n').trim();
    return annotateBashEvidence(command, capBashOutput(out, env) || '(exit 0, no output)');
  } catch (err) {
    const interrupted = signal?.aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR';
    const captureLimit = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    // Ctrl+C during a foreground command. Distinguished from a timeout because
    // both arrive as a killed child, and telling the model "it timed out" would
    // send it off tuning CLAUDETTE_BASH_TIMEOUT for something the user did.
    if (interrupted) {
      throw new Error('Command interrupted by the user before it finished.');
    }
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    if (captureLimit) {
      throw new Error(
        'Command output exceeded the 2 MiB capture limit. Redirect verbose output to a log and inspect it separately.' +
        (out ? `\n\n${capBashOutput(out, env)}` : ''),
      );
    }
    if (err.code === 'BASH_TIMEOUT') {
      throw new Error(
        `Command timed out after ${Math.round(timeout / 1000)}s. ` +
        `If it just needs longer (a big build/test), raise CLAUDETTE_BASH_TIMEOUT. ` +
        `Recognized dev servers start in the background automatically; for another long-running service, ` +
        `rerun it explicitly in the background with output redirected to a log.`
      );
    }
    throw new Error(annotateBashEvidence(command, explainBashFailure(capBashOutput(out || err.message, env))));
  }
}

async function runBash(command, cwd, workspace, signal) {
  // A workspace-sandboxed main process must never fall back to launching Bash
  // itself: that would either recreate nested Seatbelt or silently remove the
  // stricter model-command profile. Broker loss is an explicit tool failure.
  if (bashBrokerRequired()) return requestBrokeredBash(command, cwd, signal);
  return runBashDirect(command, cwd, workspace, signal);
}

/**
 * Prepare the only operation exposed by the unsandboxed launcher broker. The
 * workspace and environment are captured here and cannot be replaced by IPC.
 */
export async function createBashBrokerExecutor({
  workspace,
  env = process.env,
  wrapperBin,
  allowNetwork = bashNetworkEnabled(env),
}) {
  const realWorkspace = await fsp.realpath(workspace);
  const workspaceStat = await fsp.stat(realWorkspace);
  if (!workspaceStat.isDirectory()) throw new Error(`Bash broker workspace is not a directory: ${workspace}`);

  const nodeRuntime = await fsp.realpath(path.dirname(path.dirname(process.execPath)));
  const runtimeHome = nodeRuntime.match(/^\/Users\/[^/]+/)?.[0] ?? '/';
  const developerRoot = await resolveXcodeDeveloperRoot();
  const toolHome = await ensureDirectControlDirectory(realWorkspace, 'home');
  const toolTemp = await ensureDirectControlDirectory(realWorkspace, 'tmp');
  const realWrapperBin = await fsp.realpath(wrapperBin);
  if (!isWithinPath(realWorkspace, realWrapperBin)) {
    throw new Error('Bash broker wrapper directory escapes the workspace.');
  }
  await ensureSandboxPackageManagerWrappers(realWorkspace, nodeRuntime, env, realWrapperBin);

  const fixedOptions = {
    env: { ...env, CLAUDETTE_BASH_SANDBOX: '1' },
    forceSandbox: true,
    realWorkspace,
    nodeRuntime,
    runtimeHome,
    developerRoot,
    toolHome,
    toolTemp,
    wrapperBin: realWrapperBin,
    allowNetwork,
  };

  return async ({ command, cwd, signal }) => {
    if (typeof command !== 'string' || !command) throw new Error('Bash broker requires a command.');
    if (typeof cwd !== 'string' || !cwd) throw new Error('Bash broker requires a working directory.');
    const realCwd = await fsp.realpath(cwd);
    const cwdStat = await fsp.stat(realCwd);
    if (!cwdStat.isDirectory() || !isWithinPath(realWorkspace, realCwd)) {
      throw new Error('Bash broker blocked a working directory outside the launch workspace.');
    }
    return runBashDirect(command, realCwd, realWorkspace, signal, fixedOptions);
  };
}

async function readFile(filePath, cwd, workspace, { offset, limit } = {}) {
  const abs = await guardPath(filePath, cwd, workspace);
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
  const abs = await guardPath(filePath, cwd, workspace);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  // Models sometimes double-escape newlines/tabs (\\n → \n literal) in JSON content.
  // If the content has no real newlines but has literal \n sequences, unescape them.
  const realNewlines = (content.match(/\n/g) ?? []).length;
  const escapedNewlines = (content.match(/\\n/g) ?? []).length;
  if (realNewlines === 0 && escapedNewlines >= 2) {
    const PLACEHOLDER = "\u0000__BS__\u0000";
    content = content
      .replace(/\\\\/g, PLACEHOLDER)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(new RegExp(PLACEHOLDER, "g"), '\\');
  }
  await fsp.writeFile(abs, content, 'utf8');
  const lines = content.split('\n').length;
  return `Wrote ${content.length} chars (${lines} lines) to ${filePath}`;
}

async function strReplace(filePath, oldStr, newStr, cwd, workspace) {
  const abs = await guardPath(filePath, cwd, workspace);
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

/**
 * Translate a glob to a RegExp. Supports the syntax the tool documents — `**`
 * (crosses directory separators), `*` and `?` (do not) — and escapes everything
 * else, so no pattern can mean anything but "match this path".
 */
export function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; re += '(?:[^/]+/)*'; } // `**/` = zero or more dirs
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const GLOB_SKIP_DIRS = new Set(['node_modules', '.git']);
const GLOB_MAX_ENTRIES = 20_000; // walk bound, so a huge tree can't hang the turn

/**
 * Match files under the workspace against a glob, walking the tree directly.
 *
 * This used to shell out to `bash -c 'shopt -s globstar; files=($1); …'` with the
 * MODEL-CONTROLLED pattern as a positional parameter. That was careful, and it
 * still meant an auto-approved tool handing attacker-influenced text to a shell.
 * There is no shell here now, so there is nothing to escape. Skipping
 * node_modules/.git during the walk (rather than filtering matches afterwards)
 * also stops it from descending into them at all.
 */
async function runGlob(pattern, cwd, workspace = cwd) {
  const re = globToRegExp(pattern);
  const root = await realpathOrSelf(workspace);
  const matches = [];
  let visited = 0;

  async function walk(relDir) {
    if (visited >= GLOB_MAX_ENTRIES) return;
    let entries;
    try {
      entries = await fsp.readdir(path.join(cwd, relDir), { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip it rather than failing the whole glob
    }
    for (const entry of entries) {
      if (visited >= GLOB_MAX_ENTRIES) return;
      visited++;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (GLOB_SKIP_DIRS.has(entry.name)) continue;
        if (re.test(rel)) matches.push(rel);
        await walk(rel);
      } else if (entry.isSymbolicLink()) {
        // Never report a link that points out of the workspace.
        const real = await realpathOrSelf(path.join(cwd, rel));
        const relative = path.relative(root, real);
        const escaped = relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.startsWith(`..${path.win32.sep}`));
        if (escaped) continue;
        if (re.test(rel)) matches.push(rel);
      } else if (re.test(rel)) {
        matches.push(rel);
      }
    }
  }

  await walk('');
  if (!matches.length) return '(no matches)';
  matches.sort();
  return matches.length > 200
    ? `${matches.slice(0, 200).join('\n')}\n… (${matches.length - 200} more)`
    : matches.join('\n');
}

const LIST_DIR_SKIP_DIRS = new Set([
  '.git', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo',
  'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'coverage', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.venv', 'venv', 'target', 'Pods', 'DerivedData',
]);

export function resolveListDirMaxEntries(value, env = process.env) {
  const requested = Number(value ?? env.CLAUDETTE_LIST_DIR_MAX_ENTRIES);
  if (!Number.isFinite(requested) || requested <= 0) return 200;
  return Math.max(1, Math.min(1_000, Math.floor(requested)));
}

async function listDir(targetPath, depth, cwd, workspace, {
  includeGenerated = false,
  maxEntries = undefined,
} = {}) {
  const abs = await guardPath(targetPath, cwd, workspace);
  const stat = await fsp.stat(abs);
  if (!stat.isDirectory()) {
    throw new Error(`${targetPath} is not a directory`);
  }
  const maxDepth = Number.isFinite(depth) ? Math.max(0, Math.min(5, depth)) : 1;
  const entryLimit = resolveListDirMaxEntries(maxEntries);
  const lines = [`Directory: ${targetPath}`];
  let listed = 0;
  let capped = false;
  await walkDir(abs, 0);
  if (capped) {
    lines.push(`… (listing capped at ${entryLimit} entries; use a narrower path or lower depth)`);
  }
  return lines.join('\n');

  async function walkDir(dirAbs, level) {
    const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    const visible = entries
      .filter(entry => entry.name !== '.git')
      .sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name));
    const children = [];
    for (const entry of visible) {
      if (listed >= entryLimit) { capped = true; return; }
      const prefix = `${'  '.repeat(level)}- `;
      const generated = entry.isDirectory() && LIST_DIR_SKIP_DIRS.has(entry.name);
      const skipNote = generated && !includeGenerated ? ' [generated; contents skipped]' : '';
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}${skipNote}`);
      listed++;
      if (entry.isDirectory() && level < maxDepth) {
        if (generated && !includeGenerated) continue;
        children.push(entry.name);
      }
    }
    // Preserve the useful top-level inventory before any large child consumes
    // the cap. This directly prevents `.next/cache` or a large source subtree
    // from hiding later root files/directories in a broad listing.
    for (const child of children) {
      await walkDir(path.join(dirAbs, child), level + 1);
      if (capped) return;
    }
  }
}

async function runGrep(pattern, searchPath, include, cwd, workspace, signal) {
  const abs = await guardPath(searchPath, cwd, workspace);
  const relative = path.relative(cwd, abs) || '.';
  const args = ['-r', '-n', '--color=never', '-I'];
  if (include) args.push(`--include=${include}`);
  args.push('--', pattern, relative);
  try {
    const { stdout } = await execFile('grep', args, { cwd, timeout: 15_000, signal, maxBuffer: 1024 * 1024 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (!lines.length) return '(no matches)';
    if (lines.length > 60) return lines.slice(0, 60).join('\n') + `\n… (${lines.length - 60} more matches)`;
    return lines.join('\n');
  } catch (err) {
    if (err.code === 1) return '(no matches)';
    throw err;
  }
}

async function runSearchCode(pattern, searchPath, include, cwd, workspace, signal) {
  const abs = await guardPath(searchPath, cwd, workspace);
  const relative = path.relative(cwd, abs) || '.';
  try {
    const args = ['--line-number', '--no-heading', '--color=never'];
    if (include) args.push('--glob', include);
    args.push(pattern, relative);
    const { stdout } = await execFile('rg', args, { cwd, timeout: 15_000, signal, maxBuffer: 1024 * 1024 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (!lines.length) return '(no matches)';
    return lines.length > 80 ? lines.slice(0, 80).join('\n') + `\n… (${lines.length - 80} more matches)` : lines.join('\n');
  } catch (err) {
    if (err.code === 1) return '(no matches)';
    return runGrep(pattern, relative, include, cwd, workspace, signal);
  }
}

// Loopback, private, and link-local ranges. fetch_url is auto-approved, so a
// model-chosen URL must not be able to reach the host's own network or a cloud
// metadata endpoint (169.254.169.254).
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c, d] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 192.0.2/24
    if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay 192.88.99/24
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100/24
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113/24
    if (a === 198 && b === 18) return true; // benchmark 198.18/15
    return false;
  }
  const ipv6 = ip.toLowerCase();
  if (ipv6 === '::1' || ipv6 === '::' || ipv6 === '::ffff:127.0.0.1') return true;
  if (ipv6.startsWith('fe80:') || ipv6.startsWith('feb')) return true; // link-local fe80::/10
  if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true; // unique-local fc00::/7
  if (ipv6.startsWith('ff02:') || ipv6.startsWith('ff05:')) return true; // multicast scoped
  const mapped = ipv6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  // IPv4-compatible ::a.b.c.d
  const compat = ipv6.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (compat) return isPrivateAddress(compat[1]);
  return false;
}

// Validate every answer, then pin the connection to one of those exact answers.
// A separate preflight followed by global fetch() is vulnerable to DNS rebinding
// because fetch performs its own second resolution.
export async function resolvePublicHost(parsed, lookup = dns.lookup) {
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // URL keeps [] around IPv6 literals
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`Could not resolve host: ${host}`);
  }
  const unsafe = records.find(record => !record?.address || isPrivateAddress(record.address));
  if (unsafe) {
    throw new Error(`Refusing to fetch ${host} — it resolves to a private or loopback address (${unsafe.address}). fetch_url only reaches public hosts.`);
  }
  return records[0];
}

export function resolveFetchLimits(env = process.env) {
  const timeout = Number(env.CLAUDETTE_FETCH_TIMEOUT);
  const maxBytes = Number(env.CLAUDETTE_FETCH_MAX_BYTES);
  return {
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 15_000,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 1024 * 1024,
  };
}

export function requestPinnedUrl(parsed, record, signal, limits = resolveFetchLimits()) {
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = transport.request(parsed, {
      method: 'GET',
      headers: { 'User-Agent': 'claudette/1.0', Accept: 'text/*, application/json, application/xml;q=0.9' },
      signal,
      ...(parsed.protocol === 'https:' && !net.isIP(parsed.hostname) ? { servername: parsed.hostname } : {}),
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [record]);
        else callback(null, record.address, record.family);
      },
    }, response => {
      const status = response.statusCode ?? 0;
      const location = status >= 300 && status < 400 ? response.headers.location : null;
      if (location) {
        response.resume();
        finish(resolve, { status, statusText: response.statusMessage ?? '', headers: response.headers, body: Buffer.alloc(0) });
        return;
      }

      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxBytes) {
        response.resume();
        request.destroy();
        finish(reject, new Error(`Fetch response exceeds ${limits.maxBytes} bytes.`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limits.maxBytes) {
          response.destroy();
          request.destroy();
          finish(reject, new Error(`Fetch response exceeds ${limits.maxBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, {
        status,
        statusText: response.statusMessage ?? '',
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', error => finish(reject, error));
    });
    request.setTimeout(limits.timeoutMs, () => {
      request.destroy(new Error(`Fetch timed out after ${limits.timeoutMs} ms.`));
    });
    request.on('error', error => finish(reject, error));
    request.end();
  });
}

async function fetchUrl(url, signal) {
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
    const record = await resolvePublicHost(parsed);
    response = await requestPinnedUrl(parsed, record, signal);
    const location = response.status >= 300 && response.status < 400 ? response.headers.location : null;
    if (!location) break;
    parsed = new URL(location, parsed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http and https URLs are allowed');
    }
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }
  const contentType = String(response.headers['content-type'] ?? '');
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType && !mediaType.startsWith('text/') && ![
    'application/json', 'application/xml', 'application/xhtml+xml', 'application/javascript',
  ].includes(mediaType)) {
    throw new Error(`Unsupported fetch content type: ${mediaType}`);
  }
  const raw = response.body.toString('utf8');
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
  const abs = await guardPath(filePath, cwd, workspace);
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
export function capBashOutput(text, env = process.env) {
  const configured = Number(env.CLAUDETTE_BASH_OUTPUT_CHARS ?? 16_000);
  if (!Number.isFinite(configured) || configured <= 0 || text.length <= configured) return text;
  const limit = Math.floor(configured);
  let head = Math.floor(limit * 0.7);
  let tailStart = text.length - (limit - head);
  const splitsPair = index => index > 0 && index < text.length
    && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff
    && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
  if (splitsPair(head)) head--;
  if (splitsPair(tailStart)) tailStart++;
  const omitted = tailStart - head;
  return `${text.slice(0, head)}\n\n… [bash output truncated — ${omitted} chars omitted] …\n\n${text.slice(tailStart)}`;
}
