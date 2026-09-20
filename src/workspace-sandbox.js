import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { attachBashBroker } from './bash-broker.js';

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function resolveBashNetworkAccess(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--network')) return true;
  return TRUE_VALUES.has(String(env.CLAUDETTE_BASH_NETWORK ?? '').trim().toLowerCase());
}

export function resolveSandboxWorkspace(argv = process.argv.slice(2), cwd = process.cwd()) {
  const index = argv.indexOf('--cwd');
  const requested = index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('-')
    ? argv[index + 1]
    : cwd;
  return path.resolve(cwd, requested);
}

export function workspaceSandboxEnabled(env = process.env, platform = process.platform) {
  if (env.CLAUDETTE_SANDBOXED === '1') return false;
  const unsafe = String(env.CLAUDETTE_UNSAFE_DISABLE_SANDBOX ?? '').trim().toLowerCase();
  if (unsafe === '1' || TRUE_VALUES.has(unsafe)) {
    console.warn('[claudette] CLAUDETTE_UNSAFE_DISABLE_SANDBOX enabled — workspace sandbox disabled.');
    return false;
  }
  const configured = env.CLAUDETTE_WORKSPACE_SANDBOX;
  if (configured != null) return !FALSE_VALUES.has(String(configured).trim().toLowerCase());
  if (platform !== 'darwin') return false;
  // Test subprocesses exercise CLI protocols and temp workspaces directly. Keep disabled in test by default,
  // but explicit CLAUDETTE_WORKSPACE_SANDBOX=1 re-enables even in test.
  if (env.NODE_ENV === 'test') return false;
  return true;
}

export function buildWorkspaceSandboxProfile() {
  const readableFilters = `
      (literal "/")
      (literal "/etc")
      (literal "/var")
      (literal "/dev/null")
      (literal (param "TTY_PATH"))
      (literal (param "HOST_ROOT"))
      (literal (param "HOST_HOME"))
      (literal (param "PACKAGE_PARENT"))
      (subpath (param "WORKSPACE"))
      (subpath (param "PACKAGE_ROOT"))
      (subpath (param "NODE_RUNTIME"))
      (subpath "/System")
      (subpath "/usr")
      (subpath "/bin")
      (subpath "/sbin")
      (subpath "/Library")
      (subpath "/opt/homebrew")
      (subpath "/private/etc")`;
  const readable = `(require-any ${readableFilters})`;
  const metadataReadable = `(require-any ${readableFilters}
      (subpath (param "HOST_HOME"))
      (subpath "/private"))`;
  return `(version 1)
(allow default)
(deny file-read-data (require-not ${readable}))
(deny file-read-metadata (require-not ${metadataReadable}))
(deny file-write*
  (require-not
    (require-any
      (literal "/dev/null")
      (literal (param "TTY_PATH"))
      (subpath (param "WORKSPACE")))))
(deny appleevent-send)`;
}

function detectTtyPath() {
  try {
    const value = execFileSync('/usr/bin/tty', [], {
      stdio: [0, 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return value.startsWith('/dev/') ? value : '/dev/null';
  } catch {
    return '/dev/null';
  }
}

function forwardSignals(child) {
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      try { child.kill(signal); } catch {}
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function ensurePrivateDirectory(root, ...parts) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      await fsp.mkdir(current, { mode: 0o700 });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing unsafe Claudette control path: ${current}`);
    }
    const resolved = await fsp.realpath(current);
    if (!isWithin(root, resolved)) {
      throw new Error(`Claudette control path escapes the workspace: ${current}`);
    }

    // O_NOFOLLOW closes the final-component symlink race between lstat/chmod.
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

export async function prepareWorkspaceControlDirs(workspace) {
  const root = await fsp.realpath(workspace);
  const controlRoot = await ensurePrivateDirectory(root, '.claudette');
  const stateRoot = await ensurePrivateDirectory(root, '.claudette', 'state');
  const tempRoot = await ensurePrivateDirectory(root, '.claudette', 'tmp');
  const homeRoot = await ensurePrivateDirectory(root, '.claudette', 'home');
  const binRoot = await ensurePrivateDirectory(root, '.claudette', 'bin');
  return { controlRoot, stateRoot, tempRoot, homeRoot, binRoot };
}

export async function relaunchInWorkspaceSandbox({
  argv = process.argv.slice(2),
  entryPath,
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
} = {}) {
  if (!workspaceSandboxEnabled(env, platform)) return null;
  if (!entryPath) throw new Error('Sandbox launch requires the CLI entry path.');

  const requested = resolveSandboxWorkspace(argv, cwd);
  const stat = await fsp.stat(requested);
  if (!stat.isDirectory()) throw new Error(`Sandbox workspace is not a directory: ${requested}`);
  const workspace = await fsp.realpath(requested);
  const packageRoot = await fsp.realpath(path.dirname(entryPath));
  const nodeRuntime = await fsp.realpath(path.dirname(path.dirname(process.execPath)));
  const hostHome = await fsp.realpath(env.HOME);
  const hostRoot = path.dirname(hostHome);
  const packageParent = path.dirname(packageRoot);
  const { stateRoot, tempRoot, homeRoot, binRoot } = await prepareWorkspaceControlDirs(workspace);
  const allowBashNetwork = resolveBashNetworkAccess(argv, env);
  // Prepare wrappers and capture the trusted workspace/environment before the
  // sandboxed child exists. After launch, IPC can request only this executor.
  const { createBashBrokerExecutor } = await import('./tools.js');
  const executeBash = await createBashBrokerExecutor({
    workspace,
    env,
    wrapperBin: binRoot,
    allowNetwork: allowBashNetwork,
  });

  const childEnv = {
    ...env,
    CLAUDETTE_SANDBOXED: '1',
    CLAUDETTE_SANDBOX_ROOT: workspace,
    CLAUDETTE_BASH_SANDBOX: '1',
    CLAUDETTE_BASH_BROKER: '1',
    CLAUDETTE_BASH_NETWORK: allowBashNetwork ? '1' : '0',
    CLAUDETTE_DATA_DIR: stateRoot,
    CLAUDETTE_USAGE_DIR: path.join(stateRoot, 'usage'),
    HOME: homeRoot,
    TMPDIR: tempRoot,
    PATH: `${path.dirname(process.execPath)}:${env.PATH ?? ''}`,
  };
  const childArgv = [...argv];
  const childCwdIndex = childArgv.indexOf('--cwd');
  if (childCwdIndex !== -1 && childArgv[childCwdIndex + 1]) {
    childArgv[childCwdIndex + 1] = workspace;
  }
  const sandboxArgs = [
    '-D', `WORKSPACE=${workspace}`,
    '-D', `PACKAGE_ROOT=${packageRoot}`,
    '-D', `NODE_RUNTIME=${nodeRuntime}`,
    '-D', `HOST_ROOT=${hostRoot}`,
    '-D', `HOST_HOME=${hostHome}`,
    '-D', `PACKAGE_PARENT=${packageParent}`,
    '-D', `TTY_PATH=${detectTtyPath()}`,
    '-p', buildWorkspaceSandboxProfile(),
    process.execPath,
    entryPath,
    ...childArgv,
  ];

  process.stderr.write(`\x1b[90m[sandbox] confined to ${workspace}\x1b[0m\n`);
  if (allowBashNetwork) {
    process.stderr.write('\x1b[33m[sandbox] outbound Bash network enabled by explicit request\x1b[0m\n');
  }
  const child = spawn('/usr/bin/sandbox-exec', sandboxArgs, {
    cwd: workspace,
    env: childEnv,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const closeBashBroker = attachBashBroker(child, { workspace, execute: executeBash });
  child.once('disconnect', closeBashBroker);
  const removeSignalHandlers = forwardSignals(child);
  return new Promise((resolve, reject) => {
    child.once('error', err => {
      closeBashBroker();
      removeSignalHandlers();
      reject(err);
    });
    child.once('exit', (code, signal) => {
      closeBashBroker();
      removeSignalHandlers();
      resolve({ code: code ?? (signal ? 1 : 0), signal, workspace, stateRoot });
    });
  });
}
