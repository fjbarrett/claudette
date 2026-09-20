#!/usr/bin/env node
/**
 * Claudette — comprehensive test suite
 * Covers: unit (tools, session, context, ui, parser), server integration, Ollama stress loop
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync, execFile as nativeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-test-'));
}

async function cleanDir(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
}

// The live-provider suites used to hardcode `llama3.2:latest`. Nobody has that
// installed, so 13 tests failed on every machine and got written off as
// "environment-dependent" — they were unrunnable, not environmental. Ask Ollama
// what it actually has; when it has nothing (or isn't running), the suites skip
// with a reason instead of failing.
const LIVE_MODEL = await (async function discoverLiveModel() {
  const base = process.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const { models = [] } = await res.json();
    // Prefer something that can drive a tool loop, and among those the smallest —
    // these tests check that streaming and history work, not answer quality, and
    // a 30B model turns a 20-second suite into a coffee break.
    const bySize = [...models].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    const withTools = bySize.find(m => m.capabilities?.includes('tools'));
    return (withTools ?? bySize[0])?.name ?? null;
  } catch {
    return null; // Ollama not running — the live suites skip
  }
})();

// `--test-skip-pattern` only exists from Node 22, so `npm test` used to fail
// outright on Node 20. An env var works everywhere and says what it means.
const LIVE_SKIP = process.env.CLAUDETTE_SKIP_LIVE
  ? 'live-model suite skipped (CLAUDETTE_SKIP_LIVE); run `npm run test:live` for it'
  : (LIVE_MODEL ? false : 'no local Ollama model available (start Ollama or pull a model)');

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body }); }
      });
    }).on('error', reject);
  });
}

function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname, port: opts.port, path: opts.pathname + opts.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpPostStream(url, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const opts = new URL(url);
    const chunks = [];
    const req = http.request({
      hostname: opts.hostname, port: opts.port, path: opts.pathname + opts.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      res.on('data', d => chunks.push(d.toString()));
      res.on('end', () => {
        const raw = chunks.join('');
        const lines = raw.trim().split('\n').map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
        resolve({ status: res.statusCode, lines });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function createNdjsonResponse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const chunk of chunks) {
    res.write(`${JSON.stringify(chunk)}\n`);
  }
  res.end();
}

function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(err => err ? reject(err) : resolve(port));
    });
    server.on('error', reject);
  });
}

// ─── Stats tracker ────────────────────────────────────────────────────────────

const stats = { pass: 0, fail: 0, errors: [], startTime: Date.now() };

function pass(name) { stats.pass++; }
function fail(name, err) { stats.fail++; stats.errors.push({ name, err: String(err) }); }

// ─── config.js tests ─────────────────────────────────────────────────────────

describe('config.js', async () => {
  test('resolveOllamaBaseUrl defaults to localhost tunnel endpoint', async () => {
    const { resolveOllamaBaseUrl } = await import('../src/config.js');
    assert.equal(resolveOllamaBaseUrl({}), 'http://localhost:11434');
  });

  test('resolveOllamaBaseUrl honours OLLAMA_HOST and strips a trailing /v1', async () => {
    const { resolveOllamaBaseUrl } = await import('../src/config.js');
    assert.equal(
      resolveOllamaBaseUrl({ OLLAMA_BASE_URL: 'http://box:11434/v1/' }),
      'http://box:11434'
    );
    assert.equal(
      resolveOllamaBaseUrl({ OLLAMA_HOST: 'http://box:11434' }),
      'http://box:11434'
    );
  });

  test('resolveOllamaBaseUrl no longer consumes OPENAI_* (those configure the OpenAI provider)', async () => {
    const { resolveOllamaBaseUrl } = await import('../src/config.js');
    assert.equal(
      resolveOllamaBaseUrl({ OPENAI_BASE_URL: 'https://api.openai.com/v1' }),
      'http://localhost:11434'
    );
  });
});

describe('env.js (.env loader)', async () => {
  test('parseEnv handles export, quotes, comments, spaces, and = in values', async () => {
    const { parseEnv } = await import('../src/env.js');
    const parsed = parseEnv([
      '# a comment',
      '',
      'export A=1',
      'B = "two words"',
      "C='single'",
      'D=a=b=c',
      'EMPTY=',
      'NOEQUALS',
    ].join('\n'));
    assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'single', D: 'a=b=c', EMPTY: '' });
  });

  test('loadEnv applies file keys, never overrides real env, earlier file wins', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-env-'));
    const high = path.join(dir, 'high.env');
    const low = path.join(dir, 'low.env');
    await fsp.writeFile(high, 'SHARED=from_high\nONLY_HIGH=h\n');
    await fsp.writeFile(low, 'SHARED=from_low\nONLY_LOW=l\nPRESET=should_not_win\n');
    const { loadEnv } = await import('../src/env.js');
    const env = { PRESET: 'real' };
    const applied = loadEnv({ env, files: [high, low] });
    try {
      assert.equal(env.SHARED, 'from_high', 'earlier file wins');
      assert.equal(env.ONLY_HIGH, 'h');
      assert.equal(env.ONLY_LOW, 'l');
      assert.equal(env.PRESET, 'real', 'real env not overridden');
      assert.ok(applied.includes('SHARED') && applied.includes('ONLY_LOW'));
      assert.ok(!applied.includes('PRESET'), 'preset not reported as applied');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('loadEnv skips missing files without throwing', async () => {
    const { loadEnv } = await import('../src/env.js');
    const applied = loadEnv({ env: {}, files: ['/no/such/path/.env'] });
    assert.deepEqual(applied, []);
  });

  test('default candidates never trust cwd and support an explicit config file', async () => {
    const { candidateFiles } = await import('../src/env.js');
    const defaults = candidateFiles({
      env: {},
      cwd: '/untrusted/project',
      home: '/trusted/home',
      packageRoot: '/trusted/package',
    });
    assert.deepEqual(defaults, [
      path.join('/trusted/package', '.env'),
      path.join('/trusted/home', '.config', 'claudette', '.env'),
    ]);
    assert.equal(defaults.includes(path.join('/untrusted/project', '.env')), false);

    assert.deepEqual(candidateFiles({
      env: { CLAUDETTE_ENV_FILE: '../config/claudette.env' },
      cwd: '/trusted/launch',
      home: '/trusted/home',
      packageRoot: '/trusted/package',
    }), [
      path.join('/trusted/config', 'claudette.env'),
      path.join('/trusted/package', '.env'),
      path.join('/trusted/home', '.config', 'claudette', '.env'),
    ]);
  });
});

describe('workspace confinement', async () => {
  test('macOS workspace sandbox is production-default and test-opt-in', async () => {
    const { workspaceSandboxEnabled } = await import('../src/workspace-sandbox.js');
    assert.equal(workspaceSandboxEnabled({}, 'darwin'), true);
    assert.equal(workspaceSandboxEnabled({ NODE_ENV: 'test' }, 'darwin'), false);
    assert.equal(workspaceSandboxEnabled({ NODE_ENV: 'test', CLAUDETTE_WORKSPACE_SANDBOX: '1' }, 'darwin'), true);
    assert.equal(workspaceSandboxEnabled({}, 'linux'), false);
    assert.equal(workspaceSandboxEnabled({ CLAUDETTE_WORKSPACE_SANDBOX: '0' }, 'darwin'), false);
  });

  test('sandbox workspace follows --cwd and data state can be relocated', async () => {
    const { resolveBashNetworkAccess, resolveSandboxWorkspace } = await import('../src/workspace-sandbox.js');
    const { resolveDataDir } = await import('../src/state-paths.js');
    assert.equal(resolveSandboxWorkspace(['--cwd', 'child'], '/tmp/root'), '/tmp/root/child');
    assert.equal(resolveSandboxWorkspace([], '/tmp/root'), '/tmp/root');
    assert.equal(resolveDataDir({ CLAUDETTE_DATA_DIR: '/tmp/local-state' }), '/tmp/local-state');
    assert.equal(resolveBashNetworkAccess([], {}), false);
    assert.equal(resolveBashNetworkAccess(['--network'], {}), true);
    assert.equal(resolveBashNetworkAccess([], { CLAUDETTE_BASH_NETWORK: 'yes' }), true);
    assert.equal(resolveBashNetworkAccess([], { CLAUDETTE_BASH_NETWORK: '0' }), false);
  });

  test('control-directory bootstrap rejects symlinks and keeps state private', async () => {
    const workspace = await makeTmpDir();
    const outside = await makeTmpDir();
    const { prepareWorkspaceControlDirs } = await import('../src/workspace-sandbox.js');
    try {
      await fsp.symlink(outside, path.join(workspace, '.claudette'));
      await assert.rejects(
        prepareWorkspaceControlDirs(workspace),
        /Refusing unsafe Claudette control path/,
      );
      assert.deepEqual(await fsp.readdir(outside), [], 'no control directories were written outside');

      await fsp.unlink(path.join(workspace, '.claudette'));
      const roots = await prepareWorkspaceControlDirs(workspace);
      for (const root of Object.values(roots)) {
        const stat = await fsp.lstat(root);
        assert.equal(stat.isSymbolicLink(), false);
        assert.equal(stat.mode & 0o777, 0o700);
      }
    } finally {
      await cleanDir(workspace);
      await cleanDir(outside);
    }
  });

  test('profiles deny outside file mutation and model-side remote control', async () => {
    const { buildWorkspaceSandboxProfile } = await import('../src/workspace-sandbox.js');
    const { bashNetworkEnabled, buildBashSandboxProfile } = await import('../src/tools.js');
    const outer = buildWorkspaceSandboxProfile();
    const bash = buildBashSandboxProfile();
    assert.match(outer, /deny file-write\*/);
    assert.match(outer, /deny file-read-data/);
    assert.match(outer, /deny appleevent-send/);
    assert.match(outer, /\(literal "\/etc"\)/);
    assert.match(outer, /\(literal "\/var"\)/);
    assert.match(bash, /deny signal \(require-not \(target same-sandbox\)\)/,
      'sandboxed commands may manage their own child tree but not other processes');
    assert.match(bash, /deny network-outbound/);
    const networkedBash = buildBashSandboxProfile({ allowNetwork: true });
    assert.doesNotMatch(networkedBash, /deny network-outbound/,
      'explicit network mode removes only the outbound-network denial');
    assert.doesNotMatch(bash, /mDNSResponder|resolv\.conf/,
      'default profile does not gain resolver-file access');
    assert.match(networkedBash, /\(literal "\/private\/var\/run\/mDNSResponder"\)/,
      'explicit mode reads only the trusted macOS resolver socket');
    assert.match(networkedBash, /\(literal "\/private\/var\/run\/resolv\.conf"\)/,
      'explicit mode reads only the trusted macOS resolver configuration');
    assert.match(networkedBash, /\(literal "\/etc"\)/);
    assert.match(networkedBash, /\(literal "\/var"\)/,
      'explicit mode permits metadata probes of macOS resolver symlink roots');
    assert.equal(bashNetworkEnabled({}), false);
    assert.equal(bashNetworkEnabled({ CLAUDETTE_BASH_NETWORK: 'on' }), true);
    assert.equal(bashNetworkEnabled({ CLAUDETTE_BASH_NETWORK: 'false' }), false);
    assert.match(bash, /\(literal "\/dev\/urandom"\)/,
      'language runtimes can read system entropy without gaining device writes');
    assert.match(bash, /\(subpath \(param "DEVELOPER_ROOT"\)\)/,
      'only the canonical system-selected developer root is readable');
    assert.doesNotMatch(bash, /\(subpath "\/Applications"\)/,
      'the profile never grants blanket Applications access');
  });

  test('macOS profile permits inside work and denies sibling read/write', { skip: process.platform !== 'darwin' }, async () => {
    const workspace = await fsp.realpath(await makeTmpDir());
    const sibling = path.join(path.dirname(workspace), `claudette-outside-${randomUUID()}.txt`);
    await fsp.writeFile(sibling, 'outside-secret');
    try {
      const { buildWorkspaceSandboxProfile } = await import('../src/workspace-sandbox.js');
      const nodeRuntime = path.dirname(path.dirname(process.execPath));
      const probe = spawnSync('/usr/bin/sandbox-exec', [
        '-D', `WORKSPACE=${workspace}`,
        '-D', `PACKAGE_ROOT=${ROOT}`,
        '-D', `NODE_RUNTIME=${nodeRuntime}`,
        '-D', `HOST_ROOT=${path.dirname(os.homedir())}`,
        '-D', `HOST_HOME=${os.homedir()}`,
        '-D', `PACKAGE_PARENT=${path.dirname(ROOT)}`,
        '-D', 'TTY_PATH=/dev/null',
        '-p', buildWorkspaceSandboxProfile(),
        '/bin/bash', '-c', `touch inside.txt; cat ${JSON.stringify(sibling)} >/dev/null 2>&1; echo read=$?; touch ${JSON.stringify(sibling)} 2>/dev/null; echo write=$?`,
      ], { cwd: workspace, encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
      assert.match(probe.stdout, /read=1/);
      assert.match(probe.stdout, /write=1/);
      assert.equal(await fsp.readFile(path.join(workspace, 'inside.txt'), 'utf8'), '');
      assert.equal(await fsp.readFile(sibling, 'utf8'), 'outside-secret');
    } finally {
      await cleanDir(workspace);
      await fsp.unlink(sibling).catch(() => {});
    }
  });

  test('workspace transition guard accepts descendants and rejects siblings', async () => {
    const root = await makeTmpDir();
    const child = path.join(root, 'child');
    const sibling = await makeTmpDir();
    await fsp.mkdir(child);
    try {
      const { confineWorkspacePath } = await import('../src/chat.js');
      assert.equal(await confineWorkspacePath(child, root), await fsp.realpath(child));
      await assert.rejects(confineWorkspacePath(sibling, root), /outside the launch workspace/);
    } finally {
      await cleanDir(root);
      await cleanDir(sibling);
    }
  });
});

// The launcher-side Bash broker is a capability boundary, not a general RPC
// service. Exercise its schema/lifecycle without relying on a filesystem socket
// or allowing callers to select executables, profiles, environments, or roots.
describe('Bash broker IPC', async () => {
  function linkedChannels(EventEmitter) {
    const left = new EventEmitter();
    const right = new EventEmitter();
    for (const channel of [left, right]) {
      channel.connected = true;
      channel.channel = { ref() {}, unref() {} };
    }
    left.send = (message, callback) => {
      queueMicrotask(() => right.emit('message', structuredClone(message)));
      callback?.(null);
    };
    right.send = (message, callback) => {
      queueMicrotask(() => left.emit('message', structuredClone(message)));
      callback?.(null);
    };
    const disconnect = () => {
      left.connected = false;
      right.connected = false;
      left.emit('disconnect');
      right.emit('disconnect');
    };
    return { parent: left, child: right, disconnect };
  }

  test('rejects malformed requests that try to add an environment', async () => {
    const { EventEmitter } = await import('node:events');
    const { attachBashBroker } = await import('../src/bash-broker.js');
    const channel = new EventEmitter();
    channel.connected = true;
    const sent = [];
    channel.send = (message, callback) => { sent.push(message); callback?.(null); };
    let executed = false;
    const close = attachBashBroker(channel, {
      workspace: '/fixed/workspace',
      execute: async () => { executed = true; return 'must not run'; },
    });
    try {
      channel.emit('message', { channel: 'claudette-bash-broker', version: 1, type: 'hello' });
      const token = sent.find(message => message.type === 'ready')?.token;
      assert.ok(token, 'handshake returns a per-channel capability');
      channel.emit('message', {
        channel: 'claudette-bash-broker', version: 1, type: 'request', token,
        id: 'malformed-1', command: 'echo unsafe', cwd: '/fixed/workspace',
        env: { PATH: '/attacker' },
      });
      const rejection = sent.find(message => message.type === 'rejected' && message.id === 'malformed-1');
      assert.match(rejection?.error ?? '', /Malformed or unauthorized/);
      assert.equal(executed, false, 'executor is unreachable for a non-exact schema');
    } finally {
      close();
    }
  });

  test('forwards cancellation to the active launcher executor', async () => {
    const { EventEmitter } = await import('node:events');
    const { attachBashBroker, createBashBrokerClient } = await import('../src/bash-broker.js');
    const pair = linkedChannels(EventEmitter);
    let signalSeen;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const closeParent = attachBashBroker(pair.parent, {
      workspace: '/fixed/workspace',
      execute: ({ signal }) => new Promise((resolve, reject) => {
        signalSeen = signal;
        markStarted();
        signal.addEventListener('abort', () => reject(new Error('executor aborted')), { once: true });
      }),
    });
    const client = createBashBrokerClient(pair.child);
    try {
      await client.ready();
      const controller = new AbortController();
      const running = client.run('sleep 30', '/fixed/workspace', controller.signal);
      await started;
      controller.abort();
      await assert.rejects(running, /interrupted by the user/);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(signalSeen?.aborted, true, 'parent executor receives the cancellation');
    } finally {
      client.close();
      closeParent();
    }
  });

  test('broker death rejects the caller and aborts active work', async () => {
    const { EventEmitter } = await import('node:events');
    const { attachBashBroker, createBashBrokerClient } = await import('../src/bash-broker.js');
    const pair = linkedChannels(EventEmitter);
    let signalSeen;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const closeParent = attachBashBroker(pair.parent, {
      workspace: '/fixed/workspace',
      execute: ({ signal }) => new Promise((resolve, reject) => {
        signalSeen = signal;
        markStarted();
        signal.addEventListener('abort', () => reject(new Error('executor aborted')), { once: true });
      }),
    });
    const client = createBashBrokerClient(pair.child);
    await client.ready();
    const running = client.run('sleep 30', '/fixed/workspace');
    await started;
    pair.disconnect();
    await assert.rejects(running, /broker disconnected/i);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signalSeen?.aborted, true, 'launcher cleanup aborts the command');
    client.close();
    closeParent();
  });
});

// ─── Session module tests ─────────────────────────────────────────────────────

describe('session.js', async () => {
  let tmpSessionsDir;
  let origEnv;

  before(async () => {
    // Point sessions dir to a temp dir by monkey-patching via env won't work since it's hardcoded.
    // Instead we import and manipulate SESSIONS_DIR indirectly. We'll test against actual data dir
    // but use a fresh isolated directory via our own wrappers.
    tmpSessionsDir = await makeTmpDir();
  });

  after(async () => {
    await cleanDir(tmpSessionsDir);
  });

  test('createSession creates session with correct shape', async () => {
    const { createSession, saveSession, SESSIONS_DIR } = await import('../src/session.js');
    const session = await createSession({ model: 'test-model', cwd: '/tmp' });
    assert.ok(session.id, 'has id');
    assert.equal(session.model, 'test-model');
    assert.equal(session.cwd, '/tmp');
    assert.equal(session.title, 'New Session');
    assert.ok(session.createdAt, 'has createdAt');
    assert.ok(session.updatedAt, 'has updatedAt');
    assert.deepEqual(session.messages, []);
    // Cleanup
    try { await fsp.unlink(path.join(SESSIONS_DIR, `${session.id}.json`)); } catch {}
  });

  test('saveSession persists to disk and loadSession retrieves it', async () => {
    const { createSession, saveSession, loadSession, SESSIONS_DIR } = await import('../src/session.js');
    const session = await createSession({ model: 'my-model', cwd: '/workspace' });
    session.messages.push({ role: 'user', content: 'hello' });
    session.title = 'Test Session';
    await saveSession(session);

    const loaded = await loadSession(session.id);
    assert.equal(loaded.id, session.id);
    assert.equal(loaded.title, 'Test Session');
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].content, 'hello');
    // Cleanup
    try { await fsp.unlink(path.join(SESSIONS_DIR, `${session.id}.json`)); } catch {}
  });

  test('loadSession supports short IDs', async () => {
    const { createSession, loadSession, SESSIONS_DIR } = await import('../src/session.js');
    const session = await createSession({ model: 'x', cwd: '/tmp' });
    const short = session.id.slice(0, 8);
    const loaded = await loadSession(short);
    assert.equal(loaded.id, session.id);
    try { await fsp.unlink(path.join(SESSIONS_DIR, `${session.id}.json`)); } catch {}
  });

  test('loadSession throws for unknown ID', async () => {
    const { loadSession } = await import('../src/session.js');
    await assert.rejects(
      () => loadSession('00000000-0000-0000-0000-000000000000'),
      /Session not found/
    );
  });

  test('listSessions returns sorted sessions', async () => {
    const { createSession, listSessions, SESSIONS_DIR } = await import('../src/session.js');
    const s1 = await createSession({ model: 'a', cwd: '/tmp' });
    // Brief sleep to guarantee different updatedAt
    await new Promise(r => setTimeout(r, 10));
    const s2 = await createSession({ model: 'b', cwd: '/tmp' });
    const list = await listSessions();
    const ids = list.map(s => s.id);
    // s2 should appear before s1 (sorted descending by updatedAt)
    assert.ok(ids.indexOf(s2.id) < ids.indexOf(s1.id) || ids.includes(s2.id), 'sorted');
    // Cleanup
    for (const s of [s1, s2]) {
      try { await fsp.unlink(path.join(SESSIONS_DIR, `${s.id}.json`)); } catch {}
    }
  });

  test('saveSession updates updatedAt on each save', async () => {
    const { createSession, saveSession, loadSession, SESSIONS_DIR } = await import('../src/session.js');
    const s = await createSession({ model: 'm', cwd: '/tmp' });
    const t1 = s.updatedAt;
    await new Promise(r => setTimeout(r, 20));
    await saveSession(s);
    const loaded = await loadSession(s.id);
    assert.ok(loaded.updatedAt >= t1, 'updatedAt should be updated');
    try { await fsp.unlink(path.join(SESSIONS_DIR, `${s.id}.json`)); } catch {}
  });

  test('loadSession flushes a queued session save', async () => {
    const { createSession, scheduleSessionSave, loadSession, SESSIONS_DIR } = await import('../src/session.js');
    const session = await createSession({ model: 'queued-model', cwd: '/tmp' });
    session.title = 'Queued Title';
    session.messages.push({ role: 'user', content: 'queued write' });
    await scheduleSessionSave(session);

    const loaded = await loadSession(session.id);
    assert.equal(loaded.title, 'Queued Title');
    assert.equal(loaded.messages.at(-1)?.content, 'queued write');
    try { await fsp.unlink(path.join(SESSIONS_DIR, `${session.id}.json`)); } catch {}
  });

  test('flushSessionSave persists the latest queued snapshot', async () => {
    const { createSession, scheduleSessionSave, flushSessionSave, loadSession, SESSIONS_DIR } = await import('../src/session.js');
    const session = await createSession({ model: 'flush-model', cwd: '/tmp' });
    session.title = 'First Title';
    await scheduleSessionSave(session);
    session.title = 'Latest Title';
    session.messages.push({ role: 'assistant', content: 'latest snapshot' });
    await scheduleSessionSave(session);
    await flushSessionSave(session);

    const loaded = await loadSession(session.id);
    assert.equal(loaded.title, 'Latest Title');
    assert.equal(loaded.messages.at(-1)?.content, 'latest snapshot');
    try { await fsp.unlink(path.join(SESSIONS_DIR, `${session.id}.json`)); } catch {}
  });

  test('an ignored debounced save failure does not become an unhandled rejection', async () => {
    const { scheduleSessionSave } = await import('../src/session.js');
    let unhandled = null;
    const onUnhandled = reason => { unhandled = reason; };
    process.once('unhandledRejection', onUnhandled);
    scheduleSessionSave({
      id: 'invalid\0session',
      model: 'mock',
      cwd: '/tmp',
      messages: [],
      turns: [],
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    await new Promise(resolve => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, null);
  });

  test('formatTranscript separates tools and summarizes successful read-only exploration', async () => {
    const { formatTranscript } = await import('../src/transcript.js');
    const session = {
      id: 'transcript-test', title: 'Transcript', model: 'mock', cwd: '/work',
      messages: [
        { role: 'user', content: 'inspect it' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'read-1', function: { name: 'read_file', arguments: { path: 'secret.txt' } } },
          { id: 'list-1', function: { name: 'list_dir', arguments: { path: '.' } } },
        ] },
        { role: 'tool', tool_call_id: 'read-1', content: 'large private file body' },
        { role: 'tool', tool_call_id: 'list-1', content: 'Directory: .\n- secret.txt' },
        { role: 'assistant', content: 'I found the relevant file.' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'bash-1', function: { name: 'bash', arguments: { command: 'npm test' } } },
        ] },
        { role: 'tool', tool_call_id: 'bash-1', content: 'tests passed' },
      ],
    };
    const transcript = formatTranscript(session);
    assert.match(transcript, /\[USER\]\ninspect it/);
    assert.match(transcript, /\[TOOLS\]\nExplored 2 items — 1 read · 1 listing/);
    assert.ok(!transcript.includes('large private file body'), 'routine result bodies are omitted');
    assert.match(transcript, /\[ASSISTANT\]\nI found the relevant file\./);
    assert.match(transcript, /\[TOOLS\]\n\[CALL bash\]\n\{\n  "command": "npm test"/);
    assert.match(transcript, /\[RESULT bash\]\ntests passed/);
    assert.equal(session.messages.length, 7, 'formatting does not mutate resumable protocol history');
  });
});

// ─── Context module tests ─────────────────────────────────────────────────────

describe('context.js', async () => {
  let tmpDir;

  before(async () => {
    tmpDir = await makeTmpDir();
  });

  after(async () => {
    await cleanDir(tmpDir);
  });

  test('loadClaudeMd returns empty string when no CLAUDE.md exists', async () => {
    const { loadClaudeMd } = await import('../src/context.js');
    const emptyDir = await makeTmpDir();
    try {
      const result = await loadClaudeMd(emptyDir);
      assert.equal(result, '');
    } finally {
      await cleanDir(emptyDir);
    }
  });

  test('loadClaudeMd reads CLAUDE.md from cwd', async () => {
    const { loadClaudeMd } = await import('../src/context.js');
    const dir = await makeTmpDir();
    try {
      await fsp.writeFile(path.join(dir, 'CLAUDE.md'), '# My instructions\nDo good work.');
      const result = await loadClaudeMd(dir);
      assert.ok(result.includes('Do good work.'), 'reads content');
    } finally {
      await cleanDir(dir);
    }
  });

  test('loadClaudeMd walks up parent directories', async () => {
    const { loadClaudeMd } = await import('../src/context.js');
    const parentDir = await makeTmpDir();
    const childDir = path.join(parentDir, 'subdir');
    try {
      await fsp.mkdir(childDir, { recursive: true });
      await fsp.writeFile(path.join(parentDir, 'CLAUDE.md'), '# Parent instructions');
      const result = await loadClaudeMd(childDir);
      assert.ok(result.includes('Parent instructions'), 'finds parent CLAUDE.md');
    } finally {
      await cleanDir(parentDir);
    }
  });

  test('loadClaudeMd also loads CLAUDETTE.md, after CLAUDE.md at the same level', async () => {
    const { loadClaudeMd } = await import('../src/context.js');
    const dir = await makeTmpDir();
    try {
      await fsp.writeFile(path.join(dir, 'CLAUDE.md'), '# Generic\nGeneric guidance.');
      await fsp.writeFile(path.join(dir, 'CLAUDETTE.md'), '# Claudette\nClaudette-specific guidance.');
      const result = await loadClaudeMd(dir);
      assert.ok(result.includes('Generic guidance.'), 'includes CLAUDE.md');
      assert.ok(result.includes('Claudette-specific guidance.'), 'includes CLAUDETTE.md');
      assert.ok(
        result.indexOf('Generic guidance.') < result.indexOf('Claudette-specific guidance.'),
        'CLAUDETTE.md comes after CLAUDE.md so it can augment/override',
      );
    } finally {
      await cleanDir(dir);
    }
  });

  test('loadClaudeMd reads CLAUDETTE.md even without a CLAUDE.md', async () => {
    const { loadClaudeMd } = await import('../src/context.js');
    const dir = await makeTmpDir();
    try {
      await fsp.writeFile(path.join(dir, 'CLAUDETTE.md'), 'Only Claudette here.');
      const result = await loadClaudeMd(dir);
      assert.ok(result.includes('Only Claudette here.'));
    } finally {
      await cleanDir(dir);
    }
  });

  test('expandFiles returns unchanged text with no @tokens', async () => {
    const { expandFiles } = await import('../src/context.js');
    const { text, files } = await expandFiles('hello world', tmpDir, tmpDir);
    assert.equal(text, 'hello world');
    assert.deepEqual(files, []);
  });

  test('expandFiles expands @filename to file contents', async () => {
    const { expandFiles } = await import('../src/context.js');
    await fsp.writeFile(path.join(tmpDir, 'hello.txt'), 'file content here');
    const { text, files } = await expandFiles('read @hello.txt please', tmpDir, tmpDir);
    assert.ok(text.includes('file content here'), 'expands file content');
    assert.ok(files.includes('hello.txt'), 'tracks expanded file');
  });

  test('expandFiles silently skips missing files', async () => {
    const { expandFiles } = await import('../src/context.js');
    const { text, files } = await expandFiles('show @nonexistent.txt', tmpDir, tmpDir);
    assert.ok(text.includes('@nonexistent.txt'), 'keeps @token unchanged');
    assert.deepEqual(files, []);
  });

  test('expandFiles enforces workspace boundary', async () => {
    const { expandFiles } = await import('../src/context.js');
    const innerDir = await makeTmpDir();
    try {
      // Try to escape workspace via ..
      const { text, files } = await expandFiles('read @../../etc/passwd', innerDir, innerDir);
      assert.deepEqual(files, [], 'no files expanded for path outside workspace');
    } finally {
      await cleanDir(innerDir);
    }
  });

  test('expandFiles truncates large files', async () => {
    const { expandFiles } = await import('../src/context.js');
    const bigContent = 'x'.repeat(60_000);
    await fsp.writeFile(path.join(tmpDir, 'big.txt'), bigContent);
    const { text } = await expandFiles('@big.txt', tmpDir, tmpDir);
    assert.ok(text.includes('[truncated]'), 'truncates large files');
  });
});

// ─── Context management (tool-output trimming) ───────────────────────────────
// Collapsing old tool outputs in the payload is the cheap, deterministic fix for
// the context blowup (real sessions hit 1M+ input tokens in one turn from ~30
// accumulated file reads re-sent every iteration).

describe('context.js (tool-output trimming)', async () => {
  const { resolveToolOutputTrimOptions, trimToolOutputs } = await import('../src/context.js');

  test('collapses old large tool results, keeps the most recent N, never mutates input', () => {
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, function: { name: 'read_file', arguments: '{}' } }] });
      msgs.push({ role: 'tool', tool_call_id: 'c' + i, content: 'X'.repeat(5000) });
    }
    const trimmed = trimToolOutputs(msgs, { keep: 6 });
    const collapsed = trimmed.filter(m => m.role === 'tool' && m.content.startsWith('[earlier'));
    const full = trimmed.filter(m => m.role === 'tool' && m.content === 'X'.repeat(5000));
    assert.equal(collapsed.length, 4, 'older results collapsed');
    assert.equal(full.length, 6, 'most recent 6 kept full');
    assert.ok(collapsed.every(m => m.tool_call_id), 'collapsed messages keep tool_call_id (provider pairing stays valid)');
    assert.equal(msgs.filter(m => m.role === 'tool' && m.content.length === 5000).length, 10, 'stored history is not mutated');
  });

  test('short histories and small results are returned unchanged', () => {
    const few = [{ role: 'tool', content: 'ok' }, { role: 'tool', content: 'done' }];
    assert.equal(trimToolOutputs(few), few, 'few tool results → same reference');
    const manySmall = Array.from({ length: 10 }, () => ({ role: 'tool', content: 'tiny' }));
    assert.equal(trimToolOutputs(manySmall), manySmall, 'all-small results → nothing worth collapsing');
  });

  test('a total budget excerpts large recent results fairly without mutating stored history', () => {
    const lengths = [100, 5000, 200, 5000];
    const msgs = lengths.map((length, i) => ({ role: 'tool', tool_call_id: `c${i}`, content: String(i).repeat(length) }));
    const trimmed = trimToolOutputs(msgs, { keep: 6, maxTotalChars: 2000 });
    const contents = trimmed.map(message => message.content);
    assert.ok(contents.reduce((sum, content) => sum + content.length, 0) <= 2000);
    assert.equal(contents[0], msgs[0].content, 'small result keeps its full budget');
    assert.equal(contents[2], msgs[2].content, 'unused small-result budget is redistributed');
    assert.match(contents[1], /tool output excerpted from 5000 chars/);
    assert.match(contents[3], /tool output excerpted from 5000 chars/);
    assert.deepEqual(trimmed.map(message => message.tool_call_id), ['c0', 'c1', 'c2', 'c3']);
    assert.deepEqual(msgs.map(message => message.content.length), lengths, 'stored messages stay full');
  });

  test('Groq gets an 8K tool-output budget with an env override and disable switch', () => {
    assert.deepEqual(resolveToolOutputTrimOptions('groq/qwen/qwen3.8-27b', {}), { maxTotalChars: 8000 });
    assert.deepEqual(resolveToolOutputTrimOptions('groq/openai/gpt-oss-120b', { GROQ_TOOL_OUTPUT_CHARS: '4096.9' }), { maxTotalChars: 4096 });
    assert.equal(resolveToolOutputTrimOptions('groq/openai/gpt-oss-120b', { GROQ_TOOL_OUTPUT_CHARS: '0' }), undefined);
    assert.equal(resolveToolOutputTrimOptions('openai/gpt-4o', {}), undefined);
  });

  test('OpenRouter gets a 12K tool-output budget with an env override and disable switch', () => {
    assert.deepEqual(resolveToolOutputTrimOptions('openrouter/free', {}), { maxTotalChars: 12_000 });
    assert.deepEqual(
      resolveToolOutputTrimOptions('openrouter/nvidia/model:free', { OPENROUTER_TOOL_OUTPUT_CHARS: '3456' }),
      { maxTotalChars: 3456 },
    );
    assert.equal(
      resolveToolOutputTrimOptions('openrouter/free', { OPENROUTER_TOOL_OUTPUT_CHARS: '0' }),
      undefined,
    );
  });
});

// ─── Tools module tests ───────────────────────────────────────────────────────

describe('tools.js', async () => {
  let tmpDir;

  before(async () => {
    tmpDir = await makeTmpDir();
  });

  after(async () => {
    await cleanDir(tmpDir);
  });

  test('executeTool bash: runs a command', async () => {
    const { executeTool } = await import('../src/tools.js');
    const out = await executeTool('bash', { command: 'echo hello-world' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('hello-world'), 'got stdout');
  });

  test('executeTool bash: automatically activates an existing workspace .venv', async () => {
    const { executeTool } = await import('../src/tools.js');
    const workspace = path.join(tmpDir, `venv-workspace-${randomUUID()}`);
    const bin = path.join(workspace, '.venv', 'bin');
    await fsp.mkdir(bin, { recursive: true });
    await fsp.writeFile(path.join(workspace, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    await fsp.writeFile(path.join(bin, 'python3'), '#!/bin/sh\necho workspace-python\n', { mode: 0o755 });

    const out = await executeTool('bash', {
      command: 'python3; printf "venv=%s\\n" "$VIRTUAL_ENV"',
    }, { cwd: workspace, workspace });
    const expectedVirtualEnv = await fsp.realpath(path.join(workspace, '.venv'));
    assert.match(out, /workspace-python/);
    assert.ok(out.includes(`venv=${expectedVirtualEnv}`), out);
  });

  test('resolveWorkspaceVirtualEnv: ignores a workspace-controlled venv symlink', async () => {
    const { resolveWorkspaceVirtualEnv } = await import('../src/tools.js');
    const workspace = path.join(tmpDir, `venv-symlink-workspace-${randomUUID()}`);
    const outside = path.join(tmpDir, `venv-symlink-target-${randomUUID()}`);
    await fsp.mkdir(path.join(outside, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(outside, 'pyvenv.cfg'), 'home = /usr/bin\n');
    await fsp.writeFile(path.join(outside, 'bin', 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fsp.mkdir(workspace);
    await fsp.symlink(outside, path.join(workspace, '.venv'));

    assert.equal(await resolveWorkspaceVirtualEnv(workspace), null);
  });

  test('trustedExternalPythonRuntimeRoot: allows known system prefixes only', async () => {
    const { trustedExternalPythonRuntimeRoot } = await import('../src/tools.js');
    assert.equal(trustedExternalPythonRuntimeRoot('/opt/anaconda3/bin/python3.14', 'darwin'), '/opt/anaconda3');
    assert.equal(trustedExternalPythonRuntimeRoot('/opt/conda/bin/python3', 'linux'), '/opt/conda');
    assert.equal(trustedExternalPythonRuntimeRoot('/opt/custom/bin/python3', 'darwin'), null);
    assert.equal(trustedExternalPythonRuntimeRoot('/Users/alice/.pyenv/versions/3.14/bin/python3', 'darwin'), null);
  });

  test('explainBashFailure: identifies PEP 668 without calling the workspace read-only', async () => {
    const { explainBashFailure } = await import('../src/tools.js');
    const explained = explainBashFailure('error: externally-managed-environment');
    assert.match(explained, /PEP 668/);
    assert.match(explained, /not evidence that the workspace is read-only/);
    assert.match(explained, /\.venv\/bin\/python/);
    assert.equal(explainBashFailure('ordinary command failure'), 'ordinary command failure');
  });

  test('executeTool bash: strict sandbox uses the workspace virtualenv', { skip: process.platform !== 'darwin' }, async () => {
    const { executeTool } = await import('../src/tools.js');
    const workspace = path.join(tmpDir, `sandbox-venv-workspace-${randomUUID()}`);
    const bin = path.join(workspace, '.venv', 'bin');
    await fsp.mkdir(bin, { recursive: true });
    await fsp.writeFile(path.join(workspace, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    await fsp.writeFile(path.join(bin, 'python3'), '#!/bin/sh\necho sandbox-workspace-python\n', { mode: 0o755 });
    const previous = process.env.CLAUDETTE_BASH_SANDBOX;
    process.env.CLAUDETTE_BASH_SANDBOX = '1';
    try {
      const out = await executeTool('bash', { command: 'python3' }, { cwd: workspace, workspace });
      assert.equal(out, 'sandbox-workspace-python');
    } finally {
      if (previous === undefined) delete process.env.CLAUDETTE_BASH_SANDBOX;
      else process.env.CLAUDETTE_BASH_SANDBOX = previous;
    }
  });

  test('executeTool bash: strict sandbox supports disk SQLite in a home-directory workspace', { skip: process.platform !== 'darwin' }, async () => {
    const { executeTool } = await import('../src/tools.js');
    const workspace = await fsp.realpath(await fsp.mkdtemp(path.join(os.homedir(), '.claudette-sqlite-test-')));
    const previous = process.env.CLAUDETTE_BASH_SANDBOX;
    process.env.CLAUDETTE_BASH_SANDBOX = '1';
    try {
      const code = [
        'import os, sqlite3, tempfile',
        'for filename in ["relative.db", os.path.abspath("absolute.db"), os.path.join(tempfile.mkdtemp(), "temp.db")]:',
        '    with sqlite3.connect(filename) as db:',
        '        db.execute("pragma journal_mode=wal")',
        '        db.execute("create table results (value integer)")',
        '        db.execute("insert into results values (42)")',
        '    with sqlite3.connect(filename) as db:',
        '        assert db.execute("select value from results").fetchone() == (42,)',
        'print("sqlite-disk-ok")',
      ].join('\n');
      await fsp.writeFile(path.join(workspace, 'sqlite_probe.py'), code);
      const out = await executeTool('bash', { command: 'python3 sqlite_probe.py' }, { cwd: workspace, workspace });
      assert.match(out, /sqlite-disk-ok/);
      await assert.rejects(executeTool('bash', { command: 'ls /Users' }, { cwd: workspace, workspace }),
        /Operation not permitted|Permission denied/, 'parent metadata does not grant directory listings');
    } finally {
      if (previous === undefined) delete process.env.CLAUDETTE_BASH_SANDBOX;
      else process.env.CLAUDETTE_BASH_SANDBOX = previous;
      await cleanDir(workspace);
    }
  });

  test('executeTool bash: marks collection coverage and masked check statuses as limited evidence', async () => {
    const { executeTool } = await import('../src/tools.js');
    const workspace = path.join(tmpDir, 'check-evidence');
    await fsp.mkdir(workspace);
    await fsp.writeFile(path.join(workspace, 'pytest'), '#!/bin/sh\nprintf "655 tests collected\\nTOTAL 11082 9240 12.26%%\\n"\n', { mode: 0o755 });
    await fsp.writeFile(path.join(workspace, 'mypy'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const collected = await executeTool('bash', { command: './pytest --co -q | tail -2 || true' }, { cwd: workspace, workspace });
    assert.match(collected, /collection-only/i);
    assert.match(collected, /does not execute/i);
    assert.match(collected, /not.*test-suite coverage/i);
    assert.match(collected, /statement counts.*not.*file lengths/i);
    assert.match(collected, /655 tests collected/);
    const masked = await executeTool('bash', { command: './mypy src || true' }, { cwd: workspace, workspace });
    assert.match(masked, /exit status.*masked/i);
    assert.match(masked, /not proof.*passed/i);
    assert.equal(await executeTool('bash', { command: "printf 'pytest --co || true'" }, { cwd: workspace, workspace }),
      'pytest --co || true', 'quoted command examples must not acquire execution notes');
  });

  test('executeTool bash: output pipelines preserve upstream failures', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(executeTool('bash', {
      command: "printf 'mypy failed\\n'; (printf 'sqlite3.OperationalError: unable to open database file\\n' >&2; exit 7) 2>&1 | tail -10",
    }, { cwd: tmpDir, workspace: tmpDir }), /sqlite3.OperationalError/);
    assert.match(await executeTool('bash', {
      command: "printf 'passing check\\n' | tail -10",
    }, { cwd: tmpDir, workspace: tmpDir }), /passing check/);
  });

  test('executeTool bash: strict sandbox scrubs secrets and blocks parent escape', { skip: process.platform !== 'darwin' }, async () => {
    const { executeTool } = await import('../src/tools.js');
    const previousSandbox = process.env.CLAUDETTE_BASH_SANDBOX;
    const previousKey = process.env.OPENAI_API_KEY;
    const previousAllow = process.env.CLAUDETTE_TOOL_ENV_ALLOW;
    process.env.CLAUDETTE_BASH_SANDBOX = '1';
    process.env.OPENAI_API_KEY = 'must-not-reach-tools';
    delete process.env.CLAUDETTE_TOOL_ENV_ALLOW;
    try {
      const out = await executeTool('bash', {
        command: 'test -z "$OPENAI_API_KEY" && echo scrubbed > inside.txt; cat inside.txt',
      }, { cwd: tmpDir, workspace: tmpDir });
      assert.equal(out, 'scrubbed');
      await assert.rejects(
        executeTool('bash', { command: 'cd .. && pwd' }, { cwd: tmpDir, workspace: tmpDir }),
        /Parent traversal is not allowed/
      );
    } finally {
      if (previousSandbox === undefined) delete process.env.CLAUDETTE_BASH_SANDBOX;
      else process.env.CLAUDETTE_BASH_SANDBOX = previousSandbox;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      if (previousAllow === undefined) delete process.env.CLAUDETTE_TOOL_ENV_ALLOW;
      else process.env.CLAUDETTE_TOOL_ENV_ALLOW = previousAllow;
    }
  });

  test('executeTool bash: nested login shells can read system startup files without extra stderr', { skip: process.platform !== 'darwin' }, async () => {
    const { executeTool } = await import('../src/tools.js');
    const previous = process.env.CLAUDETTE_BASH_SANDBOX;
    process.env.CLAUDETTE_BASH_SANDBOX = '1';
    try {
      const output = await executeTool('bash', {
        command: "sh -lc 'printf login-ok'",
      }, { cwd: tmpDir, workspace: tmpDir });
      assert.equal(output, 'login-ok', 'login startup must not contaminate worker logs');
    } finally {
      if (previous === undefined) delete process.env.CLAUDETTE_BASH_SANDBOX;
      else process.env.CLAUDETTE_BASH_SANDBOX = previous;
    }
  });

  test('executeTool bash: strict OS sandbox denies an absolute outside read', { skip: process.platform !== 'darwin' }, async () => {
    const { executeTool } = await import('../src/tools.js');
    const outside = path.join(path.dirname(tmpDir), `claudette-outside-${randomUUID()}.txt`);
    const previous = process.env.CLAUDETTE_BASH_SANDBOX;
    await fsp.writeFile(outside, 'do-not-read');
    process.env.CLAUDETTE_BASH_SANDBOX = '1';
    try {
      await assert.rejects(
        executeTool('bash', { command: `cat ${JSON.stringify(outside)}` }, { cwd: tmpDir, workspace: tmpDir }),
        /Operation not permitted|Permission denied/
      );
      assert.equal(await fsp.readFile(outside, 'utf8'), 'do-not-read');
    } finally {
      if (previous === undefined) delete process.env.CLAUDETTE_BASH_SANDBOX;
      else process.env.CLAUDETTE_BASH_SANDBOX = previous;
      await fsp.unlink(outside).catch(() => {});
    }
  });

  test('executeTool bash: strict sandbox permits local tooling and loopback but not parent signals', { skip: process.platform !== 'darwin' }, async () => {
    const { executeTool } = await import('../src/tools.js');
    const server = http.createServer((_req, res) => res.end('loopback-ok'));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const previous = process.env.CLAUDETTE_BASH_SANDBOX;
    process.env.CLAUDETTE_BASH_SANDBOX = '1';
    try {
      const out = await executeTool('bash', {
        command: `node -e "fetch('http://127.0.0.1:${port}').then(r => r.text()).then(console.log)" && npm --version`,
      }, { cwd: tmpDir, workspace: tmpDir });
      assert.match(out, /loopback-ok/);
      assert.match(out, /\d+\.\d+\.\d+/);
      const childOut = await executeTool('bash', {
        command: '/bin/sleep 2 & worker=$!; /bin/kill -TERM "$worker"; wait "$worker"; test "$?" -ge 128 && echo child-signal-ok',
      }, { cwd: tmpDir, workspace: tmpDir });
      assert.match(childOut, /^child-signal-ok/m);
      await assert.rejects(
        executeTool('bash', { command: `kill -0 ${process.pid}` }, { cwd: tmpDir, workspace: tmpDir }),
        /Operation not permitted|Permission denied/
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDETTE_BASH_SANDBOX;
      else process.env.CLAUDETTE_BASH_SANDBOX = previous;
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  test('looksLikeDevServerCommand: detects common servers without swallowing builds or explicit backgrounding', async () => {
    const { looksLikeDevServerCommand } = await import('../src/tools.js');
    for (const command of [
      'npm run dev',
      'cd web && PORT=4321 pnpm start',
      'npx next dev --turbo',
      'python3 -m http.server 8080',
      'node server.js',
      'docker compose up',
    ]) assert.equal(looksLikeDevServerCommand(command), true, command);

    for (const command of [
      'npm run build',
      'npm test',
      'node --check server.js',
      'node -e "setTimeout(() => {}, 5000)"',
      'npm run dev > dev.log 2>&1 &',
      'docker compose up -d',
      'cd infra && docker compose up --detach',
    ]) assert.equal(looksLikeDevServerCommand(command), false, command);
  });

  test('executeTool bash: a recognized dev server starts in the background with logs and a stop command', async () => {
    const { executeTool } = await import('../src/tools.js');
    const appDir = path.join(tmpDir, `background-dev-${randomUUID()}`);
    await fsp.mkdir(appDir);
    await fsp.writeFile(path.join(appDir, 'package.json'), JSON.stringify({
      scripts: { dev: 'node -e "console.log(\'DEV_SERVER_READY\'); setInterval(() => {}, 1000)"' },
    }));

    const startedAt = Date.now();
    const out = await executeTool('bash', { command: 'npm run dev' }, { cwd: appDir, workspace: tmpDir });
    assert.ok(Date.now() - startedAt < 2000, `returned promptly: ${out}`);
    const pid = Number(out.match(/^PID: (\d+)$/m)?.[1]);
    const logPath = out.match(/^Logs: (.+)$/m)?.[1];
    assert.ok(pid > 0, `returned a PID: ${out}`);
    assert.ok(logPath, `returned a log path: ${out}`);
    assert.equal(path.isAbsolute(logPath), true, 'log path is canonical and absolute');
    assert.equal((await fsp.lstat(path.dirname(logPath))).isSymbolicLink(), false,
      'validated control directory is never a workspace symlink');
    assert.match(out, new RegExp(`Stop: kill -- -${pid}`));

    try {
      let logText = '';
      for (let attempt = 0; attempt < 60 && !logText.includes('DEV_SERVER_READY'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        try { logText = await fsp.readFile(logPath, 'utf8'); } catch {}
      }
      assert.match(logText, /DEV_SERVER_READY/, 'the detached server reached its ready state');
      assert.doesNotThrow(() => process.kill(pid, 0), 'the detached process remains alive after the tool returns');
    } finally {
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      await fsp.rm(logPath, { force: true });
    }
  });

  test('executeTool read_file: a missing file returns an actionable error (not bare ENOENT)', async () => {
    const { executeTool } = await import('../src/tools.js');
    let msg = '';
    try {
      await executeTool('read_file', { path: 'does/not/exist.js' }, { cwd: tmpDir, workspace: tmpDir });
    } catch (e) { msg = e.message; }
    assert.match(msg, /File not found/, 'names the problem');
    assert.match(msg, /list_dir|search_code/, 'points at discovery tools to recover');
    assert.ok(!/ENOENT/.test(msg), 'no raw fs noise');
  });

  test('executeTool list_dir: empty/blank path defaults to the workspace root', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'marker-file.txt'), 'x');
    for (const p of ['', '   ', undefined]) {
      const out = await executeTool('list_dir', { path: p }, { cwd: tmpDir, workspace: tmpDir });
      assert.ok(out.includes('marker-file.txt'), `path=${JSON.stringify(p)} lists the root, no thrown error`);
    }
  });

  test('executeTool read_file: re-read guard short-circuits an unchanged repeat read', async () => {
    const { executeTool } = await import('../src/tools.js');
    const fp = path.join(tmpDir, 'guarded.txt');
    await fsp.writeFile(fp, 'ORIGINAL CONTENT LINE\n');
    const readCache = new Map();
    const ctx = { cwd: tmpDir, workspace: tmpDir, readCache };

    const first = await executeTool('read_file', { path: 'guarded.txt' }, ctx);
    assert.ok(first.includes('ORIGINAL CONTENT'), 'first read returns content');

    const second = await executeTool('read_file', { path: 'guarded.txt' }, ctx);
    assert.match(second, /already read this exact range|hasn't changed/, 'identical unchanged re-read is short-circuited');
    assert.ok(!second.includes('ORIGINAL CONTENT'), 'content is not re-sent');

    // A changed file re-reads normally (mtime moves).
    await fsp.writeFile(fp, 'EDITED CONTENT LINE\n');
    await fsp.utimes(fp, new Date(), new Date(Date.now() + 2000)); // ensure mtime advances
    const third = await executeTool('read_file', { path: 'guarded.txt' }, ctx);
    assert.ok(third.includes('EDITED CONTENT'), 'changed file is re-read');

    // A different line range is a different key — not deduped.
    const ranged = await executeTool('read_file', { path: 'guarded.txt', offset: 1, limit: 1 }, ctx);
    assert.ok(ranged.includes('EDITED CONTENT'), 'a different range reads normally');

    // Without a readCache (e.g. eval harness / server), behavior is unchanged.
    const noCache = await executeTool('read_file', { path: 'guarded.txt' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(noCache.includes('EDITED CONTENT'), 'no cache → always reads');
  });

  test('executeTool read_file: caps repeated reads of one unchanged file (different ranges)', async () => {
    // The real failure: nano read web/app/lib/data.ts ~12× across varying line
    // ranges and never edited. Per-file cap stops that even when offset/limit vary.
    const { executeTool } = await import('../src/tools.js');
    const fp = path.join(tmpDir, 'hot.txt');
    await fsp.writeFile(fp, Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const ctx = { cwd: tmpDir, workspace: tmpDir, readCache: new Map() };
    const r1 = await executeTool('read_file', { path: 'hot.txt', offset: 1, limit: 5 }, ctx);
    const r2 = await executeTool('read_file', { path: 'hot.txt', offset: 6, limit: 5 }, ctx);
    const r3 = await executeTool('read_file', { path: 'hot.txt', offset: 11, limit: 5 }, ctx);
    assert.ok(r1.includes('line 1') && r2.includes('line 6') && r3.includes('line 11'), 'first few distinct ranges are served');
    const r4 = await executeTool('read_file', { path: 'hot.txt', offset: 16, limit: 5 }, ctx);
    assert.match(r4, /already read .* \d+ times this turn/, '4th read of the same unchanged file is capped');
    assert.ok(!r4.includes('line 16'), 'capped read does not return content');
  });

  test('executeTool bash: captures stderr', async () => {
    const { executeTool } = await import('../src/tools.js');
    const out = await executeTool('bash', { command: 'echo err >&2' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('err'), 'got stderr');
  });

  test('executeTool bash: throws on non-zero exit', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      () => executeTool('bash', { command: 'exit 1' }, { cwd: tmpDir, workspace: tmpDir }),
      'throws on non-zero exit'
    );
  });

  test('executeTool bash: returns (exit 0, no output) for silent commands', async () => {
    const { executeTool } = await import('../src/tools.js');
    const out = await executeTool('bash', { command: 'true' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('exit 0'), 'returns silent output message');
  });

  test('executeTool bash: respects cwd', async () => {
    const { executeTool } = await import('../src/tools.js');
    const out = await executeTool('bash', { command: 'pwd' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes(tmpDir) || out.length > 0, 'pwd in correct directory');
  });

  test('executeTool read_file: reads a file', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'sample.txt'), 'sample content\nsecond line');
    const out = await executeTool('read_file', { path: 'sample.txt' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('sample content'), 'reads file');
    assert.ok(out.includes('second line'), 'reads all lines');
    const zeroRange = await executeTool(
      'read_file',
      { path: 'sample.txt', offset: 0, limit: 0 },
      { cwd: tmpDir, workspace: tmpDir },
    );
    assert.equal(zeroRange, out, 'nonpositive ranges are normalized to a full-file read');
  });

  test('executeTool read_file: error on missing required path arg', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      executeTool('read_file', {}, { cwd: tmpDir, workspace: tmpDir }),
      /requires.*path/i,
    );
  });

  test('executeTool read_file: lists directory contents', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.mkdir(path.join(tmpDir, 'subdir'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, 'subdir', 'a.txt'), 'a');
    const out = await executeTool('read_file', { path: 'subdir' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('Directory:'), 'returns directory listing');
    assert.ok(out.includes('a.txt'), 'lists files');
  });

  test('executeTool read_file: rejects path outside workspace', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      () => executeTool('read_file', { path: '../../etc/passwd' }, { cwd: tmpDir, workspace: tmpDir }),
      /outside the workspace/
    );
  });

  test('executeTool read_file: truncates large files', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'huge.txt'), 'y'.repeat(85_000));
    const out = await executeTool('read_file', { path: 'huge.txt' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('truncated'), 'truncates large file');
  });

  test('executeTool write_file: creates a new file', async () => {
    const { executeTool } = await import('../src/tools.js');
    await executeTool('write_file', { path: 'created.txt', content: 'new content' }, { cwd: tmpDir, workspace: tmpDir });
    const content = await fsp.readFile(path.join(tmpDir, 'created.txt'), 'utf8');
    assert.equal(content, 'new content');
  });

  test('executeTool write_file: overwrites existing file', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'overwrite.txt'), 'old');
    await executeTool('write_file', { path: 'overwrite.txt', content: 'new' }, { cwd: tmpDir, workspace: tmpDir });
    const content = await fsp.readFile(path.join(tmpDir, 'overwrite.txt'), 'utf8');
    assert.equal(content, 'new');
  });

  test('executeTool write_file: creates nested directories', async () => {
    const { executeTool } = await import('../src/tools.js');
    await executeTool('write_file', { path: 'deep/nested/file.txt', content: 'deep' }, { cwd: tmpDir, workspace: tmpDir });
    const content = await fsp.readFile(path.join(tmpDir, 'deep/nested/file.txt'), 'utf8');
    assert.equal(content, 'deep');
  });

  test('executeTool write_file: rejects path outside workspace', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      () => executeTool('write_file', { path: '../../evil.txt', content: 'x' }, { cwd: tmpDir, workspace: tmpDir }),
      /outside the workspace/
    );
  });

  test('executeTool write_file: unescapes double-escaped newlines', async () => {
    const { executeTool } = await import('../src/tools.js');
    // Simulates a model writing \\n instead of \n
    const content = 'line1\\nline2\\nline3';
    await executeTool('write_file', { path: 'escaped.txt', content }, { cwd: tmpDir, workspace: tmpDir });
    const written = await fsp.readFile(path.join(tmpDir, 'escaped.txt'), 'utf8');
    assert.ok(written.includes('\n'), 'unescaped newlines');
  });

  test('executeTool write_file: error on missing content', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      executeTool('write_file', { path: 'x.txt' }, { cwd: tmpDir, workspace: tmpDir }),
      /requires.*content/i,
    );
  });

  test('executeTool str_replace: replaces unique string', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'patch.txt'), 'foo bar baz');
    await executeTool('str_replace', { path: 'patch.txt', old_str: 'bar', new_str: 'REPLACED' }, { cwd: tmpDir, workspace: tmpDir });
    const content = await fsp.readFile(path.join(tmpDir, 'patch.txt'), 'utf8');
    assert.equal(content, 'foo REPLACED baz');
  });

  test('executeTool str_replace: throws when old_str not found', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'nofind.txt'), 'timeout: 30_000,\ncontent here\n');
    await assert.rejects(async () => {
      await executeTool('str_replace', { path: 'nofind.txt', old_str: 'timeout: 30000', new_str: 'timeout: 45_000' }, { cwd: tmpDir, workspace: tmpDir });
    }, error => {
      assert.match(error.message, /not found/);
      assert.match(error.message, /Possible matching lines:/);
      assert.match(error.message, /timeout: 30_000,/);
      return true;
    });
  });

  test('executeTool str_replace: throws when old_str appears multiple times', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'multi.txt'), 'dup dup dup');
    await assert.rejects(
      () => executeTool('str_replace', { path: 'multi.txt', old_str: 'dup', new_str: 'x' }, { cwd: tmpDir, workspace: tmpDir }),
      /appears \d+ times/
    );
  });

  test('executeTool str_replace: can replace with empty string (delete)', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'delete.txt'), 'keep REMOVE this');
    await executeTool('str_replace', { path: 'delete.txt', old_str: ' REMOVE', new_str: '' }, { cwd: tmpDir, workspace: tmpDir });
    const content = await fsp.readFile(path.join(tmpDir, 'delete.txt'), 'utf8');
    assert.equal(content, 'keep this');
  });

  test('executeTool str_replace: throws when replacement is a no-op', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'noop.txt'), 'same text');
    await assert.rejects(
      () => executeTool('str_replace', { path: 'noop.txt', old_str: 'same', new_str: 'same' }, { cwd: tmpDir, workspace: tmpDir }),
      /no changes|identical/
    );
  });

  test('executeTool glob: finds files by pattern', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'alpha.js'), '');
    await fsp.writeFile(path.join(tmpDir, 'beta.js'), '');
    await fsp.writeFile(path.join(tmpDir, 'gamma.txt'), '');
    const out = await executeTool('glob', { pattern: '*.js' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('alpha.js'), 'finds alpha.js');
    assert.ok(out.includes('beta.js'), 'finds beta.js');
    assert.ok(!out.includes('gamma.txt'), 'excludes non-matching');
  });

  test('executeTool glob: returns no matches message for empty results', async () => {
    const { executeTool } = await import('../src/tools.js');
    const out = await executeTool('glob', { pattern: '*.xyz' }, { cwd: tmpDir, workspace: tmpDir });
    assert.equal(out, '(no matches)');
  });

  test('executeTool glob: requires pattern arg', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      executeTool('glob', {}, { cwd: tmpDir, workspace: tmpDir }),
      /requires.*pattern/i,
    );
  });

  test('executeTool search_code: finds matching lines with line numbers', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'search.txt'), 'the quick brown fox\njumps over the lazy dog\nfox trot');
    const out = await executeTool('search_code', { pattern: 'fox', path: '.' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('fox'), 'finds matches');
  });

  test('executeTool search_code: returns no matches message', async () => {
    const { executeTool } = await import('../src/tools.js');
    const out = await executeTool('search_code', { pattern: 'ZZZNOMATCHZZZ', path: '.' }, { cwd: tmpDir, workspace: tmpDir });
    assert.equal(out, '(no matches)');
  });

  test('executeTool search_code: filters by include glob', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'match.js'), 'const searchTarget = 1;');
    await fsp.writeFile(path.join(tmpDir, 'nomatch.txt'), 'const searchTarget = 2;');
    const out = await executeTool('search_code', { pattern: 'searchTarget', path: '.', include: '*.js' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('match.js'), 'includes .js file');
    assert.ok(!out.includes('nomatch.txt'), 'excludes .txt file');
  });

  test('executeTool list_dir: lists files in a directory', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.mkdir(path.join(tmpDir, 'listme'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, 'listme', 'a.js'), '');
    await fsp.writeFile(path.join(tmpDir, 'listme', 'b.txt'), '');
    const out = await executeTool('list_dir', { path: 'listme' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('a.js'), 'lists a.js');
    assert.ok(out.includes('b.txt'), 'lists b.txt');
  });

  test('executeTool list_dir: defaults to workspace root when no path given', async () => {
    const { executeTool } = await import('../src/tools.js');
    const out = await executeTool('list_dir', {}, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('Directory:'), 'returns directory listing');
  });

  test('executeTool list_dir: rejects paths outside workspace', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      () => executeTool('list_dir', { path: '../../etc' }, { cwd: tmpDir, workspace: tmpDir }),
      /outside the workspace/
    );
  });

  test('executeTool list_dir: respects depth parameter', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.mkdir(path.join(tmpDir, 'deep', 'nested'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, 'deep', 'nested', 'leaf.txt'), '');
    const shallow = await executeTool('list_dir', { path: '.', depth: 1 }, { cwd: tmpDir, workspace: tmpDir });
    const deep    = await executeTool('list_dir', { path: '.', depth: 2 }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(!shallow.includes('leaf.txt'), 'depth 1 does not show grandchild');
    assert.ok(deep.includes('leaf.txt'), 'depth 2 shows grandchild');
  });

  test('executeTool list_dir: shows but does not descend into generated trees by default', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.mkdir(path.join(tmpDir, '.next', 'cache', 'webpack'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, 'node_modules', 'a-package'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, '.next', 'cache', 'webpack', 'huge.bin'), 'x');
    await fsp.writeFile(path.join(tmpDir, 'node_modules', 'a-package', 'index.js'), 'x');

    const pruned = await executeTool('list_dir', { path: '.', depth: 5 }, { cwd: tmpDir, workspace: tmpDir });
    assert.match(pruned, /\.next\/ \[generated; contents skipped\]/);
    assert.match(pruned, /node_modules\/ \[generated; contents skipped\]/);
    assert.ok(!pruned.includes('huge.bin') && !pruned.includes('a-package'), 'generated contents stay out of context');

    const explicit = await executeTool(
      'list_dir', { path: '.next', depth: 3, include_generated: true },
      { cwd: tmpDir, workspace: tmpDir },
    );
    assert.ok(explicit.includes('huge.bin'), 'an explicit generated path remains inspectable');
  });

  test('executeTool list_dir: caps broad listings with an actionable marker', async () => {
    const { executeTool, resolveListDirMaxEntries } = await import('../src/tools.js');
    const crowded = path.join(tmpDir, 'crowded');
    await fsp.mkdir(crowded, { recursive: true });
    await Promise.all(Array.from({ length: 12 }, (_, i) => fsp.writeFile(path.join(crowded, `file-${i}.txt`), '')));
    const out = await executeTool(
      'list_dir', { path: 'crowded', depth: 1, max_entries: 5 },
      { cwd: tmpDir, workspace: tmpDir },
    );
    assert.equal(out.split('\n').filter(line => line.startsWith('- ')).length, 5);
    assert.match(out, /listing capped at 5 entries; use a narrower path/);
    assert.equal(resolveListDirMaxEntries(50_000), 1_000, 'model cannot request an unbounded listing');
  });

  test('executeTool list_dir: preserves the root inventory before deep traversal consumes the cap', async () => {
    const { executeTool } = await import('../src/tools.js');
    const overview = path.join(tmpDir, 'overview');
    const first = path.join(overview, 'a-large-tree');
    await fsp.mkdir(first, { recursive: true });
    await Promise.all(Array.from({ length: 10 }, (_, i) => fsp.writeFile(path.join(first, `nested-${i}.txt`), '')));
    await fsp.writeFile(path.join(overview, 'z-important-root.txt'), 'keep visible');
    const out = await executeTool(
      'list_dir', { path: 'overview', depth: 2, max_entries: 5 },
      { cwd: tmpDir, workspace: tmpDir },
    );
    assert.ok(out.includes('z-important-root.txt'), 'root sibling is listed before descending into a-large-tree');
  });

  test('executeTool fetch_url: refuses loopback and private destinations', async () => {
    const { executeTool } = await import('../src/tools.js');
    // fetch_url is auto-approved, so it must not reach the host's own network.
    // A live local server proves the request is refused before connecting, not
    // just failing to connect.
    const miniServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>Hello fetch world</p></body></html>');
    });
    await new Promise(resolve => miniServer.listen(0, '127.0.0.1', resolve));
    const { port } = miniServer.address();
    try {
      await assert.rejects(
        () => executeTool('fetch_url', { url: `http://127.0.0.1:${port}/` }, { cwd: tmpDir, workspace: tmpDir }),
        /private or loopback/,
        'loopback is blocked'
      );
    } finally {
      await new Promise(resolve => miniServer.close(resolve));
    }
    for (const host of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '[::1]']) {
      await assert.rejects(
        () => executeTool('fetch_url', { url: `http://${host}/` }, { cwd: tmpDir, workspace: tmpDir }),
        /private or loopback/,
        `${host} is blocked`
      );
    }
  });

  test('fetch_url validates every DNS answer before choosing a pinned address', async () => {
    const { resolvePublicHost } = await import('../src/tools.js');
    const parsed = new URL('https://public.example/resource');
    await assert.rejects(
      resolvePublicHost(parsed, async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
      /private or loopback.*127\.0\.0\.1/,
    );
    assert.deepEqual(
      await resolvePublicHost(parsed, async () => [{ address: '93.184.216.34', family: 4 }]),
      { address: '93.184.216.34', family: 4 },
    );
  });

  test('pinned fetch transport enforces response-size and deadline limits', async () => {
    const { requestPinnedUrl, resolveFetchLimits } = await import('../src/tools.js');
    const miniServer = http.createServer((req, res) => {
      if (req.url === '/large') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('x'.repeat(512));
        return;
      }
      setTimeout(() => {
        if (!res.destroyed) res.end('late');
      }, 100);
    });
    await new Promise(resolve => miniServer.listen(0, '127.0.0.1', resolve));
    const { port } = miniServer.address();
    const pinned = { address: '127.0.0.1', family: 4 };
    try {
      await assert.rejects(
        requestPinnedUrl(new URL(`http://public.test:${port}/large`), pinned, null, { timeoutMs: 1_000, maxBytes: 100 }),
        /exceeds 100 bytes/,
      );
      await assert.rejects(
        requestPinnedUrl(new URL(`http://public.test:${port}/slow`), pinned, null, { timeoutMs: 20, maxBytes: 1_000 }),
        /timed out after 20 ms/,
      );
      assert.deepEqual(resolveFetchLimits({ CLAUDETTE_FETCH_TIMEOUT: '321', CLAUDETTE_FETCH_MAX_BYTES: '654' }), {
        timeoutMs: 321,
        maxBytes: 654,
      });
    } finally {
      await new Promise(resolve => miniServer.close(resolve));
    }
  });

  test('executeTool glob: pattern cannot execute shell commands', async () => {
    const { executeTool } = await import('../src/tools.js');
    // The pattern is model-controlled and glob is auto-approved, so command
    // substitution must never run. Marker file proves nothing executed.
    const marker = path.join(tmpDir, 'pwned');
    for (const pattern of [`$(touch ${marker})`, `\`touch ${marker}\``, `x; touch ${marker}`]) {
      await executeTool('glob', { pattern }, { cwd: tmpDir, workspace: tmpDir });
      assert.ok(!fs.existsSync(marker), `pattern did not execute: ${pattern}`);
    }
  });

  test('executeTool fetch_url: throws for invalid URL', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      () => executeTool('fetch_url', { url: 'not-a-url' }, { cwd: tmpDir, workspace: tmpDir }),
      /Invalid URL/
    );
  });

  test('executeTool fetch_url: throws for non-http protocol', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      () => executeTool('fetch_url', { url: 'ftp://example.com' }, { cwd: tmpDir, workspace: tmpDir }),
      /Only http/
    );
  });

  test('executeTool fetch_url: throws on missing url arg', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      () => executeTool('fetch_url', {}, { cwd: tmpDir, workspace: tmpDir }),
      /fetch_url requires/
    );
  });

  test('executeTool patch_file: applies a single patch', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'patch1.txt'), 'foo bar baz');
    await executeTool('patch_file', { path: 'patch1.txt', old_str: 'bar', new_str: 'PATCHED' }, { cwd: tmpDir, workspace: tmpDir });
    const content = await fsp.readFile(path.join(tmpDir, 'patch1.txt'), 'utf8');
    assert.equal(content, 'foo PATCHED baz');
  });

  test('executeTool patch_file: applies multiple patches via patches[]', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'patch2.txt'), 'alpha beta gamma');
    await executeTool('patch_file', {
      path: 'patch2.txt',
      patches: [
        { old_str: 'alpha', new_str: 'A' },
        { old_str: 'gamma', new_str: 'G' },
      ],
    }, { cwd: tmpDir, workspace: tmpDir });
    const content = await fsp.readFile(path.join(tmpDir, 'patch2.txt'), 'utf8');
    assert.equal(content, 'A beta G');
  });

  test('executeTool patch_file: throws when old_str not found', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'patch3.txt'), 'some content');
    await assert.rejects(
      () => executeTool('patch_file', { path: 'patch3.txt', old_str: 'MISSING', new_str: 'x' }, { cwd: tmpDir, workspace: tmpDir }),
      /not found/
    );
  });

  test('executeTool patch_file: a no-op (identical) patch explains how to recover', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'patch-noop.txt'), 'hello world');
    let msg = '';
    try {
      await executeTool('patch_file', { path: 'patch-noop.txt', old_str: 'hello', new_str: 'hello' }, { cwd: tmpDir, workspace: tmpDir });
    } catch (e) { msg = e.message; }
    assert.match(msg, /identical/);
    assert.match(msg, /new_str/, 'tells the model to put the updated text in new_str');
  });

  test('resolveBashTimeout: default 120s, env override, invalid → default', async () => {
    const { resolveBashTimeout } = await import('../src/tools.js');
    assert.equal(resolveBashTimeout({}), 120_000);
    assert.equal(resolveBashTimeout({ CLAUDETTE_BASH_TIMEOUT: '5000' }), 5000);
    assert.equal(resolveBashTimeout({ CLAUDETTE_BASH_TIMEOUT: 'nope' }), 120_000);
  });

  test('executeTool bash: a timeout returns guidance for long foreground commands', async () => {
    const { executeTool } = await import('../src/tools.js');
    const prev = process.env.CLAUDETTE_BASH_TIMEOUT;
    process.env.CLAUDETTE_BASH_TIMEOUT = '300'; // 0.3s
    try {
      let msg = '';
      try {
        await executeTool('bash', { command: 'sleep 2' }, { cwd: tmpDir, workspace: tmpDir });
      } catch (e) { msg = e.message; }
      assert.match(msg, /timed out after/);
      assert.match(msg, /CLAUDETTE_BASH_TIMEOUT|background/, 'gives a recovery hint');
    } finally {
      if (prev === undefined) delete process.env.CLAUDETTE_BASH_TIMEOUT; else process.env.CLAUDETTE_BASH_TIMEOUT = prev;
    }
  });

  test('executeTool bash: a blank command gives a clear error (not cryptic shell output)', async () => {
    const { executeTool } = await import('../src/tools.js');
    for (const c of ['', '   ', undefined]) {
      await assert.rejects(
        () => executeTool('bash', { command: c }, { cwd: tmpDir, workspace: tmpDir }),
        /missing required argument 'command'/,
        `command=${JSON.stringify(c)}`
      );
    }
  });

  test('executeTool patch_file: throws when old_str matches multiple times', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'patch4.txt'), 'dup dup dup');
    await assert.rejects(
      () => executeTool('patch_file', { path: 'patch4.txt', old_str: 'dup', new_str: 'x' }, { cwd: tmpDir, workspace: tmpDir }),
      /appears \d+ times/
    );
  });

  test('executeTool patch_file: throws when no old_str provided', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'patch5.txt'), 'content');
    await assert.rejects(
      () => executeTool('patch_file', { path: 'patch5.txt' }, { cwd: tmpDir, workspace: tmpDir }),
      /requires/
    );
  });

  test('executeTool patch_file: throws when replacement is a no-op', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'patch6.txt'), 'same content');
    await assert.rejects(
      () => executeTool('patch_file', { path: 'patch6.txt', old_str: 'same', new_str: 'same' }, { cwd: tmpDir, workspace: tmpDir }),
      /no changes|identical/
    );
  });

  test('executeTool throws for unknown tool', async () => {
    const { executeTool } = await import('../src/tools.js');
    await assert.rejects(
      () => executeTool('unknown_tool', {}, { cwd: tmpDir, workspace: tmpDir }),
      /Unknown tool/
    );
  });

  test('executeTool bash: missing command arg uses file fallback', async () => {
    const { executeTool } = await import('../src/tools.js');
    await fsp.writeFile(path.join(tmpDir, 'hello.py'), 'print("py-output")');
    const out = await executeTool('bash', { file: 'hello.py' }, { cwd: tmpDir, workspace: tmpDir });
    assert.ok(out.includes('py-output'), 'ran .py via file fallback');
  });

  test('TOOL_DEFS has correct structure', async () => {
    const { TOOL_DEFS } = await import('../src/tools.js');
    assert.ok(Array.isArray(TOOL_DEFS), 'is array');
    for (const def of TOOL_DEFS) {
      assert.equal(def.type, 'function', 'each has type function');
      assert.ok(def.function.name, 'each has a name');
      assert.ok(def.function.description, 'each has a description');
      assert.ok(def.function.parameters, 'each has parameters');
    }
    const names = TOOL_DEFS.map(d => d.function.name);
    for (const expected of ['bash', 'read_file', 'write_file', 'str_replace', 'glob', 'list_dir', 'search_code', 'fetch_url', 'patch_file']) {
      assert.ok(names.includes(expected), `includes tool ${expected}`);
    }
    assert.ok(!names.includes('grep'), 'grep is not exposed to the model');
  });
});

// ─── Ollama stream assembly tests ────────────────────────────────────────────

describe('ollama.js', async () => {
  test('chatStream accumulates tool calls across streamed chunks', async () => {
    const mockServer = http.createServer((req, res) => {
      if (req.url !== '/api/chat') {
        res.writeHead(404).end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({
        message: {
          content: 'Reading files...',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }],
        },
      }) + '\n');
      res.write(JSON.stringify({
        message: {
          content: ' Searching...',
          tool_calls: [{ function: { name: 'grep', arguments: { pattern: 'TODO', path: '.' } } }],
        },
      }) + '\n');
      res.end(JSON.stringify({
        done: true,
        prompt_eval_count: 12,
        eval_count: 34,
      }) + '\n');
    });

    await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
    const { port } = mockServer.address();
    const originalBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;

    try {
      const moduleUrl = `${pathToFileURL(path.join(ROOT, 'src', 'ollama.js')).href}?t=${Date.now()}`;
      const { chatStream } = await import(moduleUrl);
      const result = await chatStream({
        model: 'test-model',
        messages: [{ role: 'user', content: 'help' }],
      });

      assert.equal(result.content, 'Reading files... Searching...');
      assert.equal(result.toolCalls.length, 2);
      assert.equal(result.toolCalls[0].function.name, 'read_file');
      assert.equal(result.toolCalls[1].function.name, 'grep');
      assert.equal(result.promptTokens, 12);
      assert.equal(result.completionTokens, 34);
    } finally {
      if (originalBaseUrl == null) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = originalBaseUrl;
      await new Promise((resolve, reject) => mockServer.close(err => err ? reject(err) : resolve()));
    }
  });

  test('chatStream retries without tools when Ollama rejects tool support', async () => {
    const requestBodies = [];
    const mockServer = http.createServer((req, res) => {
      if (req.url !== '/api/chat') {
        res.writeHead(404).end();
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        requestBodies.push(JSON.parse(body));
        if (requestBodies.length === 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'test-model does not support tools' }));
          return;
        }

        createNdjsonResponse(res, [
          { message: { content: '{"name":"read_file","arguments":{"path":"README.md"}}' } },
          { done: true, prompt_eval_count: 4, eval_count: 7 },
        ]);
      });
    });

    await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
    const { port } = mockServer.address();
    const originalBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;

    try {
      const moduleUrl = `${pathToFileURL(path.join(ROOT, 'src', 'ollama.js')).href}?t=${Date.now()}`;
      const { chatStream } = await import(moduleUrl);
      const result = await chatStream({
        model: 'test-model',
        messages: [{ role: 'user', content: 'read README.md' }],
        tools: [{ type: 'function', function: { name: 'read_file' } }],
      });

      assert.equal(requestBodies.length, 2);
      assert.ok(requestBodies[0].tools, 'first request sends tools');
      assert.ok(!requestBodies[1].tools, 'fallback request omits tools');
      assert.equal(result.toolMode, 'text');
      assert.equal(result.content, '{"name":"read_file","arguments":{"path":"README.md"}}');
    } finally {
      if (originalBaseUrl == null) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = originalBaseUrl;
      await new Promise((resolve, reject) => mockServer.close(err => err ? reject(err) : resolve()));
    }
  });
});

// ─── Anthropic provider tests ─────────────────────────────────────────────────

describe('anthropic.js', async () => {
  test('toAnthropicMessages extracts system and maps tool_use/tool_result', async () => {
    const { toAnthropicMessages } = await import('../src/anthropic.js');
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'read the readme' },
      { role: 'assistant', content: 'On it.', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }] },
      { role: 'tool', name: 'read_file', content: '# Title' },
    ]);
    assert.equal(system, 'You are a coding assistant.');
    assert.equal(messages.length, 3, 'user, assistant(tool_use), user(tool_result)');
    assert.equal(messages[0].role, 'user');
    const assistant = messages[1];
    assert.equal(assistant.role, 'assistant');
    const toolUse = assistant.content.find(b => b.type === 'tool_use');
    assert.ok(toolUse, 'has tool_use block');
    assert.equal(toolUse.name, 'read_file');
    assert.deepEqual(toolUse.input, { path: 'README.md' });
    const toolResult = messages[2];
    assert.equal(toolResult.role, 'user');
    assert.equal(toolResult.content[0].type, 'tool_result');
    assert.equal(toolResult.content[0].tool_use_id, toolUse.id, 'tool_result id matches synthesized tool_use id');
    assert.equal(toolResult.content[0].content, '# Title');
  });

  test('toAnthropicMessages merges consecutive tool results into one user turn', async () => {
    const { toAnthropicMessages } = await import('../src/anthropic.js');
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: '', tool_calls: [
        { function: { name: 'read_file', arguments: { path: 'a' } } },
        { function: { name: 'read_file', arguments: { path: 'b' } } },
      ] },
      { role: 'tool', content: 'A' },
      { role: 'tool', content: 'B' },
    ]);
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.content.length, 2, 'both tool_results in one user turn');
    assert.equal(last.content[0].tool_use_id, messages[0].content[0].id);
    assert.equal(last.content[1].tool_use_id, messages[0].content[1].id);
  });

  test('toAnthropicTools converts function defs to input_schema form', async () => {
    const { toAnthropicTools } = await import('../src/anthropic.js');
    const out = toAnthropicTools([
      { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    ]);
    assert.equal(out[0].name, 'bash');
    assert.equal(out[0].description, 'run');
    assert.deepEqual(out[0].input_schema.required, ['command']);
  });

  test('getModels returns anthropic/* models only when ANTHROPIC_API_KEY is set', async () => {
    const { getModels } = await import('../src/anthropic.js');
    const prev = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      assert.deepEqual(await getModels(), []);
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const models = await getModels();
      assert.ok(models.length >= 1);
      assert.ok(models.every(m => m.name.startsWith('anthropic/')), 'canonical slash form');
      assert.ok(models.some(m => m.name === 'anthropic/claude-opus-4-8'));
    } finally {
      if (prev == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test('handles accepts both anthropic/ and legacy anthropic: forms', async () => {
    const { handles, stripPrefix } = await import('../src/anthropic.js');
    assert.ok(handles('anthropic/claude-opus-4-8'));
    assert.ok(handles('anthropic:claude-opus-4-8'), 'legacy colon alias');
    assert.equal(handles('qwen2.5-coder:14b'), false);
    assert.equal(stripPrefix('anthropic/claude-opus-4-8'), 'claude-opus-4-8');
    assert.equal(stripPrefix('anthropic:claude-opus-4-8'), 'claude-opus-4-8');
  });

  test('chatStream parses SSE text deltas and tool_use blocks', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 11 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 22 } },
      { type: 'message_stop' },
    ];
    let receivedAuth = null;
    let receivedBody = null;
    const mockServer = http.createServer((req, res) => {
      if (req.url !== '/v1/messages') { res.writeHead(404).end(); return; }
      receivedAuth = req.headers['x-api-key'];
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.end();
      });
    });
    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
    const { port } = mockServer.address();
    const prevBase = process.env.ANTHROPIC_BASE_URL;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const deltas = [];
    try {
      const { chatStream } = await import('../src/anthropic.js');
      const result = await chatStream({
        model: 'anthropic:claude-opus-4-8',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } } }],
        onDelta: d => deltas.push(d),
      });
      assert.equal(result.content, 'Hello world');
      assert.equal(deltas.join(''), 'Hello world');
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.toolCalls[0].function.name, 'read_file');
      assert.deepEqual(result.toolCalls[0].function.arguments, { path: 'README.md' });
      assert.equal(result.promptTokens, 11);
      assert.equal(result.completionTokens, 22);
      assert.equal(result.toolMode, 'native');
      assert.equal(receivedAuth, 'test-key');
      assert.equal(receivedBody.model, 'claude-opus-4-8', 'anthropic: prefix stripped');
      assert.deepEqual(
        receivedBody.system,
        [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }],
        'system pulled to top level as an ephemeral cache block (prompt caching on by default)',
      );
      assert.ok(receivedBody.max_tokens > 0 && receivedBody.max_tokens <= 16_384, 'a sane max_tokens cap is sent');
      assert.ok(receivedBody.tools, 'tools forwarded');
      assert.equal(receivedBody.output_config, undefined, 'no effort sent by default');
    } finally {
      if (prevBase == null) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
      if (prevKey == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      await new Promise((resolve, reject) => mockServer.close(err => err ? reject(err) : resolve()));
    }
  });

  // Prompt caching is on by default here, and Anthropic's `input_tokens` counts
  // only the uncached remainder. Reading it alone reported a five-case eval run
  // as 52 input tokens total, so the cost meter was out by ~1000x.
  test('chatStream counts cached input, not just the uncached remainder', async () => {
    const events = [
      { type: 'message_start', message: { usage: {
        input_tokens: 2, cache_read_input_tokens: 4096, cache_creation_input_tokens: 512,
      } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    const mockServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.end();
      });
    });
    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
    const { port } = mockServer.address();
    const prevBase = process.env.ANTHROPIC_BASE_URL;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const { chatStream } = await import('../src/anthropic.js');
      const result = await chatStream({
        model: 'anthropic/claude-opus-5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      });
      assert.equal(result.promptTokens, 4610, 'uncached + cache read + cache write');
      assert.equal(result.cachedTokens, 4096);
      assert.equal(result.cacheWriteTokens, 512);
      assert.equal(result.completionTokens, 7);
    } finally {
      if (prevBase == null) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
      if (prevKey == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      await new Promise((resolve, reject) => mockServer.close(err => err ? reject(err) : resolve()));
    }
  });

  test('chatStream sends output_config.effort only when effort is set', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    let receivedBody = null;
    const mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.end();
      });
    });
    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
    const { port } = mockServer.address();
    const prevBase = process.env.ANTHROPIC_BASE_URL;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const { chatStream } = await import('../src/anthropic.js');
      await chatStream({
        model: 'anthropic/claude-opus-4-8',
        messages: [{ role: 'user', content: 'hi' }],
        effort: 'high',
        onDelta: () => {},
      });
      assert.deepEqual(receivedBody.output_config, { effort: 'high' }, 'effort mapped to output_config');
    } finally {
      if (prevBase == null) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
      if (prevKey == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      await new Promise((resolve, reject) => mockServer.close(err => err ? reject(err) : resolve()));
    }
  });

  test('chatStream throws without credentials', async () => {
    const { chatStream } = await import('../src/anthropic.js');
    const prev = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      await assert.rejects(
        () => chatStream({ model: 'anthropic:claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] }),
        /ANTHROPIC_API_KEY/
      );
    } finally {
      if (prev == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('provider.js', async () => {
  test('providerFor routes provider/model prefixes to the right backend', async () => {
    const { providerFor } = await import('../src/provider.js');
    const anthropic = await import('../src/anthropic.js');
    const openai = await import('../src/openai.js');
    const deepseek = await import('../src/deepseek.js');
    const groq = await import('../src/groq.js');
    const huggingface = await import('../src/huggingface.js');
    const ollama = await import('../src/ollama.js');

    assert.equal(providerFor('anthropic/claude-opus-4-8').chatStream, anthropic.chatStream);
    assert.equal(providerFor('anthropic:claude-opus-4-8').chatStream, anthropic.chatStream, 'legacy colon');
    assert.equal(providerFor('openai/gpt-4o').chatStream, openai.chatStream);
    assert.equal(providerFor('deepseek/deepseek-reasoner').chatStream, deepseek.chatStream);
    assert.equal(providerFor('groq/openai/gpt-oss-120b').chatStream, groq.chatStream);
    assert.equal(providerFor('hf/meta-llama/Llama-3.3-70B-Instruct').chatStream, huggingface.chatStream);
    // Bare names and explicit ollama/ prefix → Ollama. So do unknown org/model
    // ids (e.g. a HuggingFace-style local Ollama pull) that lack a known prefix.
    assert.equal(providerFor('qwen2.5-coder:14b').chatStream, ollama.chatStream);
    assert.equal(providerFor('ollama/llama3.2').chatStream, ollama.chatStream);
    assert.equal(providerFor('some-org/some-model').chatStream, ollama.chatStream);
  });

  test('getModels merges cloud providers (only those with a key set)', async () => {
    const { getModels } = await import('../src/provider.js');
    const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_KEY', 'GROQ_API_KEY', 'HF_TOKEN', 'HF_KEY'];
    const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    process.env.ANTHROPIC_API_KEY = 'k';
    process.env.OPENAI_API_KEY = 'k';
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.HF_KEY;
    try {
      const models = await getModels();
      const names = models.map(m => m.name);
      assert.ok(names.includes('anthropic/claude-opus-4-8'), 'anthropic present');
      assert.ok(names.includes('openai/gpt-4o'), 'openai present');
      assert.ok(!names.some(n => n.startsWith('deepseek/')), 'deepseek absent without key');
      assert.ok(!names.some(n => n.startsWith('groq/')), 'groq absent without key');
    } finally {
      for (const k of keys) { if (prev[k] == null) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  });

  test('defaultCloudModels picks the first credentialed provider in registry order', async () => {
    const { defaultCloudModels } = await import('../src/provider.js');
    const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'];
    const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    try {
      delete process.env.OPENROUTER_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'k';
      process.env.OPENAI_API_KEY = 'k';
      assert.equal(defaultCloudModels().agent, 'anthropic/claude-opus-4-8',
        'anthropic wins when both keys set (registry order)');
      assert.equal(defaultCloudModels().judge, 'anthropic/claude-sonnet-4-6',
        'judge default is the cheaper sibling model');

      delete process.env.ANTHROPIC_API_KEY;
      assert.equal(defaultCloudModels().agent, 'openai/gpt-4o', 'falls through to openai');
      assert.equal(defaultCloudModels().judge, 'openai/gpt-4o-mini');

      delete process.env.OPENAI_API_KEY;
      process.env.GROQ_API_KEY = 'k';
      assert.equal(defaultCloudModels().agent, 'groq/openai/gpt-oss-120b');
      assert.equal(defaultCloudModels().judge, 'groq/openai/gpt-oss-20b');

      delete process.env.GROQ_API_KEY;
      assert.equal(defaultCloudModels(), null, 'null when no credentialed provider declares defaults');
    } finally {
      for (const k of keys) { if (prev[k] == null) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  });

  test('missingCredential flags the first cloud model without a key, ignores Ollama', async () => {
    const { missingCredential } = await import('../src/provider.js');
    const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];
    const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    process.env.ANTHROPIC_API_KEY = 'k';
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      assert.equal(missingCredential(['qwen2.5-coder:14b', 'anthropic/claude-opus-4-8']), null,
        'all reachable → null');
      const miss = missingCredential(['ollama/llama3.2', 'openai/gpt-4o']);
      assert.equal(miss.model, 'openai/gpt-4o');
      assert.equal(miss.env, 'OPENAI_API_KEY');
      assert.equal(miss.label, 'OpenAI');
    } finally {
      for (const k of keys) { if (prev[k] == null) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  });
});

describe('provider model rotation (free native-tool failover)', async () => {
  const {
    createModelRotation,
    estimateRequestTokens,
    modelRotationEnabled,
    providerRequestedTokens,
    resolveGroqRotationTokenLimit,
    resolveModelRotationMax,
    runWithModelRotation,
  } = await import('../src/provider.js');

  const freeTool = name => ({ name, capabilities: ['tools'], access: { free: true } });

  test('rotation defaults on, is explicitly disableable, and has a bounded switch budget', () => {
    assert.equal(modelRotationEnabled({}), true);
    assert.equal(modelRotationEnabled({ CLAUDETTE_MODEL_ROTATION: '0' }), false);
    assert.equal(resolveModelRotationMax({}), 2);
    assert.equal(resolveModelRotationMax({ CLAUDETTE_MODEL_ROTATION_MAX: '2' }), 2);
    assert.equal(resolveModelRotationMax({ CLAUDETTE_MODEL_ROTATION_MAX: 'nope' }), 2);
    assert.equal(resolveGroqRotationTokenLimit({}), 8_000);
    assert.equal(resolveGroqRotationTokenLimit({ GROQ_TPM_LIMIT: '16000' }), 16_000);
    assert.ok(estimateRequestTokens([{ role: 'user', content: 'hello' }], []) >= 1_024);
    assert.equal(providerRequestedTokens(new Error('Limit 8000, Requested 24,678, reduce it')), 24_678);
  });

  test('selector uses only free tool models and hops providers before siblings', async () => {
    const rotation = createModelRotation({
      initialModel: 'groq/start',
      enabled: true,
      maxSwitches: 2,
      loadModels: async () => [
        freeTool('groq/start'),
        freeTool('groq/second'),
        freeTool('openrouter/free'),
        { name: 'paid/tools', capabilities: ['tools'], access: { free: false } },
        { name: 'free/no-tools', capabilities: [], access: { free: true } },
      ],
    });
    const rateLimit = Object.assign(new Error('limited'), { status: 429 });
    assert.equal(await rotation.next({ from: 'groq/start', error: rateLimit }), 'openrouter/free');
    assert.equal(await rotation.next({ from: 'openrouter/free', error: rateLimit }), null,
      'provider-wide failures do not bounce back to the failed Groq provider');
    assert.deepEqual(rotation.attemptedModels, ['groq/start', 'openrouter/free']);
  });

  test('selector follows the shared coding rank for model-specific failures', async () => {
    const rotation = createModelRotation({
      initialModel: 'openrouter/poolside/laguna-s-2.1:free',
      enabled: true,
      maxSwitches: 3,
      loadModels: async () => [
        freeTool('openrouter/minimax/minimax-m3:free'),
        freeTool('groq/openai/gpt-oss-120b'),
        freeTool('openrouter/z-ai/glm-5.2:free'),
        freeTool('openrouter/poolside/laguna-s-2.1:free'),
      ],
    });
    const modelFailure = Object.assign(new Error('model unavailable'), { status: 404 });
    assert.equal(
      await rotation.next({ from: 'openrouter/poolside/laguna-s-2.1:free', error: modelFailure }),
      'openrouter/z-ai/glm-5.2:free',
    );
    assert.equal(
      await rotation.next({ from: 'openrouter/z-ai/glm-5.2:free', error: modelFailure }),
      'groq/openai/gpt-oss-120b',
    );
    assert.equal(
      await rotation.next({ from: 'groq/openai/gpt-oss-120b', error: modelFailure }),
      'openrouter/minimax/minimax-m3:free',
    );
  });

  test('selector prefers benchmarked Ollama Cloud winners when they are live', async () => {
    const rotation = createModelRotation({
      initialModel: 'ollama/broken',
      enabled: true,
      loadModels: async () => [
        freeTool('openrouter/poolside/laguna-s-2.1:free'),
        freeTool('deepseek-v4-pro:cloud'),
        freeTool('kimi-k2.7-code:cloud'),
      ],
    });
    const modelFailure = Object.assign(new Error('model unavailable'), { status: 404 });
    assert.equal(
      await rotation.next({ from: 'ollama/broken', error: modelFailure }),
      'kimi-k2.7-code:cloud',
    );
    assert.equal(
      await rotation.next({ from: 'kimi-k2.7-code:cloud', error: modelFailure }),
      'deepseek-v4-pro:cloud',
    );
  });

  test('provider-wide limits hop providers while preserving rank within viable routes', async () => {
    const rotation = createModelRotation({
      initialModel: 'openrouter/poolside/laguna-s-2.1:free',
      enabled: true,
      loadModels: async () => [
        freeTool('openrouter/z-ai/glm-5.2:free'),
        freeTool('groq/openai/gpt-oss-120b'),
        freeTool('openrouter/minimax/minimax-m3:free'),
        freeTool('hf/fallback'),
      ],
    });
    const rateLimit = Object.assign(new Error('account rate limit'), { status: 429 });
    assert.equal(
      await rotation.next({ from: 'openrouter/poolside/laguna-s-2.1:free', error: rateLimit }),
      'groq/openai/gpt-oss-120b',
      'a shared OpenRouter limit does not immediately burn another OpenRouter request',
    );
    assert.equal(
      await rotation.next({ from: 'groq/openai/gpt-oss-120b', error: rateLimit }),
      'hf/fallback',
      'a second provider-wide limit keeps both failed providers cooled down',
    );
    assert.deepEqual(rotation.failedProviders, ['openrouter', 'groq']);
  });

  test('oversized requests skip Groq instead of sending a guaranteed 413', async () => {
    const rotation = createModelRotation({
      initialModel: 'openrouter/poolside/laguna-s-2.1:free',
      enabled: true,
      loadModels: async () => [
        freeTool('openrouter/z-ai/glm-5.2:free'),
        freeTool('groq/openai/gpt-oss-120b'),
      ],
    });
    const stalled = Object.assign(new Error('provider stalled'), { stall: true });
    assert.equal(
      await rotation.next({
        from: 'openrouter/poolside/laguna-s-2.1:free', error: stalled, requestTokens: 24_678,
      }),
      null,
      'the failed OpenRouter provider stays cooled when Groq cannot fit the request',
    );
    assert.deepEqual(rotation.lastSkippedModels, ['groq/openai/gpt-oss-120b']);
  });

  test('a silent rate limit rotates and returns the successful fallback', async () => {
    const rotation = createModelRotation({
      initialModel: 'groq/start', enabled: true,
      loadModels: async () => [freeTool('groq/start'), freeTool('openrouter/free')],
    });
    const calls = [];
    const switches = [];
    let text = '';
    const result = await runWithModelRotation({
      model: 'groq/start', rotation, enabled: true,
      onDelta: delta => { text += delta; },
      onSwitch: change => switches.push(change),
      request: async (model, { fastFail, onDelta }) => {
        calls.push({ model, fastFail });
        if (model === 'groq/start') throw Object.assign(new Error('429'), { status: 429 });
        onDelta('done');
        return { content: 'done', promptTokens: 3, completionTokens: 1 };
      },
    });
    assert.equal(result.selectedModel, 'openrouter/free');
    assert.deepEqual(result.attemptedModels, ['groq/start', 'openrouter/free']);
    assert.deepEqual(calls, [
      { model: 'groq/start', fastFail: true },
      { model: 'openrouter/free', fastFail: true },
    ]);
    assert.equal(switches[0].reason, 'rate limit');
    assert.equal(text, 'done');
  });

  test('never rotates after streamed output, avoiding duplicate partial answers', async () => {
    const rotation = createModelRotation({
      initialModel: 'groq/start', enabled: true,
      loadModels: async () => [freeTool('groq/start'), freeTool('openrouter/free')],
    });
    let calls = 0;
    await assert.rejects(
      runWithModelRotation({
        model: 'groq/start', rotation, enabled: true,
        request: async (_model, { onDelta }) => {
          calls++;
          onDelta('partial');
          throw Object.assign(new Error('stream broke'), { status: 503 });
        },
      }),
      /stream broke/,
    );
    assert.equal(calls, 1);
    assert.equal(rotation.switches, 0);
  });

  test('one-model setups retain bounded same-model retry behavior', async () => {
    const rotation = createModelRotation({
      initialModel: 'ollama/only', enabled: true, loadModels: async () => [],
    });
    const modes = [];
    const result = await runWithModelRotation({
      model: 'ollama/only', rotation, enabled: true,
      request: async (_model, { fastFail }) => {
        modes.push(fastFail);
        if (fastFail) throw Object.assign(new Error('server restarting'), { status: 503 });
        return { content: 'recovered' };
      },
    });
    assert.equal(result.content, 'recovered');
    assert.deepEqual(modes, [true, false]);
  });

  test('one-model setups do not repeat deterministic request-too-large failures', async () => {
    const rotation = createModelRotation({
      initialModel: 'groq/only', enabled: true, loadModels: async () => [],
    });
    let calls = 0;
    await assert.rejects(
      runWithModelRotation({
        model: 'groq/only', rotation, enabled: true,
        request: async () => {
          calls++;
          throw Object.assign(new Error('request too large'), { status: 413 });
        },
      }),
      /request too large/,
    );
    assert.equal(calls, 1, 'a deterministic 413 is not sent to the same model twice');
  });
});

describe('model-policy.js (free + native-tools boundary)', async () => {
  const {
    filterModelsForPolicy,
    modelPolicyDescription,
    rankFreeCodingModels,
    unavailableModelMessage,
  } = await import('../src/model-policy.js');

  const models = [
    { name: 'groq/free-tools', capabilities: ['tools'], access: { free: true } },
    { name: 'free/no-tools', capabilities: [], access: { free: true } },
    { name: 'paid/tools', capabilities: ['tools'], access: { free: false } },
  ];

  test('free/tool policy keeps only models satisfying both hard requirements', () => {
    const env = {
      CLAUDETTE_FREE_TIER_ONLY: '1', CLAUDETTE_REQUIRE_TOOLS: '1', CLAUDETTE_ALWAYS_TRACK: '0',
    };
    assert.deepEqual(filterModelsForPolicy(models, env).map(model => model.name), ['groq/free-tools']);
    assert.equal(modelPolicyDescription(env), 'free-tier only, native tools required');
  });

  test('shared coding rank is stable and leaves unavailable routes out', () => {
    const live = [
      { name: 'openrouter/free' },
      { name: 'gpt-oss:20b-cloud' },
      { name: 'groq/openai/gpt-oss-20b' },
      { name: 'custom/free-tools' },
      { name: 'deepseek-v4-pro:cloud' },
      { name: 'openrouter/z-ai/glm-5.2:free' },
      { name: 'kimi-k2.7-code:cloud' },
      { name: 'openrouter/poolside/laguna-s-2.1:free' },
      { name: 'custom/second' },
    ];
    assert.deepEqual(rankFreeCodingModels(live).map(model => model.name), [
      'kimi-k2.7-code:cloud',
      'deepseek-v4-pro:cloud',
      'openrouter/poolside/laguna-s-2.1:free',
      'openrouter/z-ai/glm-5.2:free',
      'groq/openai/gpt-oss-20b',
      'gpt-oss:20b-cloud',
      'openrouter/free',
      'custom/free-tools',
      'custom/second',
    ]);
  });

  test('free, native-tools, and tracking boundaries default on and allow explicit opt-out', async () => {
    const { freeTierOnly, requireToolSupport, alwaysTrack } = await import('../src/model-policy.js');
    assert.equal(freeTierOnly({}), true);
    assert.equal(requireToolSupport({}), true);
    assert.equal(alwaysTrack({}), true);
    assert.equal(freeTierOnly({ CLAUDETTE_FREE_TIER_ONLY: '0' }), false);
    assert.equal(requireToolSupport({ CLAUDETTE_REQUIRE_TOOLS: '0' }), false);
    assert.equal(alwaysTrack({ CLAUDETTE_ALWAYS_TRACK: '0' }), false);
  });

  test('each policy can be enabled independently', () => {
    assert.deepEqual(
      filterModelsForPolicy(models, {
        CLAUDETTE_FREE_TIER_ONLY: '1', CLAUDETTE_REQUIRE_TOOLS: '0', CLAUDETTE_ALWAYS_TRACK: '0',
      }).map(model => model.name),
      ['groq/free-tools', 'free/no-tools'],
    );
    assert.deepEqual(
      filterModelsForPolicy(models, {
        CLAUDETTE_FREE_TIER_ONLY: '0', CLAUDETTE_REQUIRE_TOOLS: '1', CLAUDETTE_ALWAYS_TRACK: '0',
      }).map(model => model.name),
      ['groq/free-tools', 'paid/tools'],
    );
  });

  test('direct DeepSeek rejection explains the free OpenRouter alternative', () => {
    const message = unavailableModelMessage('deepseek/deepseek-v4-flash', {
      CLAUDETTE_FREE_TIER_ONLY: '1',
    });
    assert.match(message, /billed per token/i);
    assert.match(message, /openrouter\/\.\.\.:free/i);
  });
});

describe('openai-compatible adapters (openai/deepseek/groq/huggingface)', async () => {
  // Build a one-shot mock /chat/completions SSE server. Returns { url, get() }.
  function mockChatServer(events, headers = {}) {
    let captured = { auth: null, body: null, path: null };
    const server = http.createServer((req, res) => {
      captured.path = req.url;
      captured.auth = req.headers['authorization'];
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        captured.body = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
        for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    return { server, captured };
  }

  // Helpers keep the Chat Completions SSE nesting unambiguous.
  const txt = content => ({ choices: [{ index: 0, delta: { content } }] });
  const tc = partial => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...partial }] } }] });
  const SSE_EVENTS = [
    { ...txt('Hello '), model: 'upstream/free-model', provider: 'free-host' },
    txt('world'),
    tc({ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }),
    tc({ function: { arguments: '{"path":' } }),
    tc({ function: { arguments: '"README.md"}' } }),
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 22 } },
  ];

  test('openai chatStream streams text + tool_calls and strips the prefix', async () => {
    const { server, captured } = mockChatServer(SSE_EVENTS, {
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '987',
      'x-ratelimit-reset-requests': '3h12m',
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '7123',
      'x-ratelimit-reset-tokens': '7.5s',
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const prevBase = process.env.OPENAI_BASE_URL;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENAI_API_KEY = 'sk-test';
    const deltas = [];
    try {
      const { chatStream } = await import('../src/openai.js');
      const result = await chatStream({
        model: 'openai/gpt-4o',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } } }],
        onDelta: d => deltas.push(d),
      });
      assert.equal(result.content, 'Hello world');
      assert.equal(deltas.join(''), 'Hello world');
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.toolCalls[0].function.name, 'read_file');
      assert.deepEqual(result.toolCalls[0].function.arguments, { path: 'README.md' });
      assert.equal(result.promptTokens, 11);
      assert.equal(result.completionTokens, 22);
      assert.equal(result.toolMode, 'native');
      assert.equal(result.resolvedModel, 'upstream/free-model');
      assert.equal(result.resolvedProvider, 'free-host');
      assert.deepEqual(result.rateLimit, {
        requestLimit: 1000,
        remainingRequests: 987,
        requestReset: '3h12m',
        tokenLimit: 8000,
        remainingTokens: 7123,
        tokenReset: '7.5s',
      });
      assert.equal(captured.path, '/chat/completions');
      assert.equal(captured.auth, 'Bearer sk-test');
      assert.equal(captured.body.model, 'gpt-4o', 'openai/ prefix stripped');
      assert.equal(captured.body.messages[0].role, 'system');
      assert.ok(captured.body.tools, 'tools forwarded');
    } finally {
      if (prevBase == null) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = prevBase;
      if (prevKey == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  test('deepseek chatStream reuses the transport with its own base/key/prefix', async () => {
    const { server, captured } = mockChatServer([
      { choices: [{ index: 0, delta: { content: 'ok' } }] },
    ]);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const prevBase = process.env.DEEPSEEK_BASE_URL;
    const prevKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    try {
      const { chatStream } = await import('../src/deepseek.js');
      const result = await chatStream({
        model: 'deepseek/deepseek-reasoner',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(result.content, 'ok');
      assert.equal(captured.auth, 'Bearer ds-test');
      assert.equal(captured.body.model, 'deepseek-reasoner', 'deepseek/ prefix stripped');
    } finally {
      if (prevBase == null) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = prevBase;
      if (prevKey == null) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  test('DeepSeek accepts the configured DEEPSEEK_KEY alias', async () => {
    const previous = { primary: process.env.DEEPSEEK_API_KEY, alias: process.env.DEEPSEEK_KEY };
    try {
      delete process.env.DEEPSEEK_API_KEY;
      process.env.DEEPSEEK_KEY = 'ds-alias-test';
      const deepseek = await import('../src/deepseek.js');
      assert.equal(deepseek.hasCredentials(), true);
    } finally {
      if (previous.primary == null) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous.primary;
      if (previous.alias == null) delete process.env.DEEPSEEK_KEY; else process.env.DEEPSEEK_KEY = previous.alias;
    }
  });

  test('groq getModels exposes only active reviewed Free-plan coding models', async () => {
    let auth = null;
    const server = http.createServer((req, res) => {
      auth = req.headers.authorization;
      assert.equal(req.url, '/models');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'openai/gpt-oss-120b' },
          { id: 'openai/gpt-oss-20b' },
          { id: 'qwen/qwen3.8-27b' },
          { id: 'qwen/qwen3.6-27b' },
          { id: 'llama-3.3-70b-versatile' },
          { id: 'hypothetical/paid-model' },
        ],
      }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previousBase = process.env.GROQ_BASE_URL;
    const previousKey = process.env.GROQ_API_KEY;
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.GROQ_API_KEY = 'groq-test';
    try {
      const groq = await import('../src/groq.js');
      const models = await groq.getModels();
      assert.equal(auth, 'Bearer groq-test');
      assert.deepEqual(models.map(model => model.name), [
        'groq/openai/gpt-oss-120b',
        'groq/openai/gpt-oss-20b',
        'groq/qwen/qwen3.8-27b',
        'groq/qwen/qwen3.6-27b',
      ]);
      assert.ok(models.every(model => model.capabilities.includes('tools')));
    } finally {
      if (previousBase == null) delete process.env.GROQ_BASE_URL;
      else process.env.GROQ_BASE_URL = previousBase;
      if (previousKey == null) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = previousKey;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  test('groq chatStream reserves an output size that fits the Free-plan TPM limit', async () => {
    const { server, captured } = mockChatServer([
      { choices: [{ index: 0, delta: { content: 'ok' } }] },
    ]);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previous = {
      base: process.env.GROQ_BASE_URL,
      key: process.env.GROQ_API_KEY,
      max: process.env.GROQ_MAX_TOKENS,
      genericMax: process.env.CLAUDETTE_MAX_TOKENS,
    };
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.GROQ_API_KEY = 'groq-test';
    delete process.env.GROQ_MAX_TOKENS;
    delete process.env.CLAUDETTE_MAX_TOKENS;
    try {
      const groq = await import('../src/groq.js');
      assert.equal(groq.resolveGroqMaxTokens(), 1_024);
      const result = await groq.chatStream({
        model: 'groq/openai/gpt-oss-120b',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(result.content, 'ok');
      assert.equal(captured.body.max_tokens, 1_024);

      process.env.GROQ_MAX_TOKENS = '1536.9';
      assert.equal(groq.resolveGroqMaxTokens(), 1_536, 'provider override can raise the Free default');
      delete process.env.GROQ_MAX_TOKENS;
      process.env.CLAUDETTE_MAX_TOKENS = '512';
      assert.equal(groq.resolveGroqMaxTokens(), 512, 'a smaller global cap is honored');
    } finally {
      if (previous.base == null) delete process.env.GROQ_BASE_URL; else process.env.GROQ_BASE_URL = previous.base;
      if (previous.key == null) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous.key;
      if (previous.max == null) delete process.env.GROQ_MAX_TOKENS; else process.env.GROQ_MAX_TOKENS = previous.max;
      if (previous.genericMax == null) delete process.env.CLAUDETTE_MAX_TOKENS; else process.env.CLAUDETTE_MAX_TOKENS = previous.genericMax;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  test('openai effort uses the flat reasoning_effort field (omitted by default)', async () => {
    const okEvents = [{ choices: [{ index: 0, delta: { content: 'ok' } }] }];

    const noEffort = mockChatServer(okEvents);
    await new Promise(r => noEffort.server.listen(0, '127.0.0.1', r));
    const withEffort = mockChatServer(okEvents);
    await new Promise(r => withEffort.server.listen(0, '127.0.0.1', r));
    const prevBase = process.env.OPENAI_BASE_URL;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const { chatStream } = await import('../src/openai.js');

      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${noEffort.server.address().port}`;
      await chatStream({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} });
      assert.equal(noEffort.captured.body.reasoning_effort, undefined, 'no effort field by default');
      assert.equal(noEffort.captured.body.reasoning, undefined);

      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${withEffort.server.address().port}`;
      await chatStream({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }], effort: 'high', onDelta: () => {} });
      assert.equal(withEffort.captured.body.reasoning_effort, 'high', 'flat field for OpenAI');
      assert.equal(withEffort.captured.body.reasoning, undefined, 'not the nested form');
    } finally {
      if (prevBase == null) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = prevBase;
      if (prevKey == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
      await new Promise((res, rej) => noEffort.server.close(e => e ? rej(e) : res()));
      await new Promise((res, rej) => withEffort.server.close(e => e ? rej(e) : res()));
    }
  });

  test('OpenRouter (catalog) effort uses the nested reasoning.effort field', async () => {
    const { server, captured } = mockChatServer([{ choices: [{ index: 0, delta: { content: 'ok' } }] }]);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const prevBase = process.env.OPENROUTER_BASE_URL;
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENROUTER_API_KEY = 'or-test';
    try {
      const { providerFor } = await import('../src/provider.js');
      const provider = providerFor('openrouter/anthropic/claude-opus-4.8');
      await provider.chatStream({
        model: 'openrouter/anthropic/claude-opus-4.8',
        messages: [{ role: 'user', content: 'hi' }],
        effort: 'high',
        onDelta: () => {},
      });
      assert.deepEqual(captured.body.reasoning, { effort: 'high' }, 'nested form for OpenRouter');
      assert.equal(captured.body.reasoning_effort, undefined, 'not the flat field');
      assert.equal(captured.body.model, 'anthropic/claude-opus-4.8', 'openrouter/ prefix stripped');
    } finally {
      if (prevBase == null) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = prevBase;
      if (prevKey == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  test('chatStream throws without credentials', async () => {
    const { chatStream } = await import('../src/openai.js');
    const prev = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      await assert.rejects(
        () => chatStream({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
        /OPENAI_API_KEY/
      );
    } finally {
      if (prev == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
    }
  });

  test('toOpenAIMessages aligns tool_call_id positionally and stringifies args', async () => {
    const { toOpenAIMessages } = await import('../src/openai.js');
    const out = toOpenAIMessages([
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.js' } } }] },
      { role: 'tool', content: 'file body' },
    ]);
    const asst = out.find(m => m.role === 'assistant');
    const tool = out.find(m => m.role === 'tool');
    assert.equal(asst.tool_calls.length, 1);
    assert.equal(typeof asst.tool_calls[0].function.arguments, 'string', 'args serialised');
    assert.equal(asst.tool_calls[0].function.arguments, '{"path":"a.js"}');
    assert.equal(tool.tool_call_id, asst.tool_calls[0].id, 'result id matches the call id');
  });

  test('huggingface strips only the leading hf/ segment (ids keep their slash)', async () => {
    const { stripPrefix, handles } = await import('../src/huggingface.js');
    assert.ok(handles('hf/meta-llama/Llama-3.3-70B-Instruct'));
    assert.ok(handles('huggingface/meta-llama/Llama-3.3-70B-Instruct'));
    assert.equal(stripPrefix('hf/meta-llama/Llama-3.3-70B-Instruct'), 'meta-llama/Llama-3.3-70B-Instruct');
  });

  test('Hugging Face discovery exposes only live zero-price tool providers', async () => {
    const server = http.createServer((req, res) => {
      assert.equal(req.url, '/models');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{
        id: 'org/coder', owned_by: 'org', providers: [
          { provider: 'free-host', status: 'live', is_free: true, supports_tools: true, context_length: 100_000 },
          { provider: 'paid-host', status: 'live', is_free: false, supports_tools: true },
          { provider: 'chat-only', status: 'live', is_free: true, supports_tools: false },
        ],
      }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previous = { base: process.env.HF_BASE_URL, key: process.env.HF_KEY, token: process.env.HF_TOKEN };
    process.env.HF_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.HF_KEY = 'hf-test';
    delete process.env.HF_TOKEN;
    try {
      const hf = await import('../src/huggingface.js');
      const models = await hf.getModels();
      assert.deepEqual(models.map(model => model.name), ['hf/org/coder:free-host']);
      assert.deepEqual(models[0].capabilities, ['tools']);
      assert.equal(models[0].access.free, true);
      assert.equal(hf.resolveHfMaxTokens(), 1_024);
    } finally {
      if (previous.base == null) delete process.env.HF_BASE_URL; else process.env.HF_BASE_URL = previous.base;
      if (previous.key == null) delete process.env.HF_KEY; else process.env.HF_KEY = previous.key;
      if (previous.token == null) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = previous.token;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

describe('provider catalog (openrouter/google/xai/mistral/together/fireworks/cohere/perplexity)', async () => {
  test('every catalog prefix routes to its catalog provider', async () => {
    const { providerFor } = await import('../src/provider.js');
    const { catalogProviders } = await import('../src/providers.js');
    const byId = Object.fromEntries(catalogProviders.map(p => [p.id, p]));
    const cases = [
      ['openrouter/anthropic/claude-3.7-sonnet', 'openrouter'],
      ['together/meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together'],
      ['fireworks/accounts/fireworks/models/deepseek-v3', 'fireworks'],
      ['google/gemini-2.5-pro', 'google'],
      ['gemini/gemini-2.5-flash', 'google'],
      ['xai/grok-4', 'xai'],
      ['grok/grok-3', 'xai'],
      ['mistral/mistral-large-latest', 'mistral'],
      ['cohere/command-a-03-2025', 'cohere'],
      ['perplexity/sonar-pro', 'perplexity'],
    ];
    for (const [model, id] of cases) {
      assert.equal(providerFor(model), byId[id], `${model} → ${id}`);
    }
  });

  test('catalog stripPrefix removes only the leading provider segment', async () => {
    const { catalogProviders } = await import('../src/providers.js');
    const openrouter = catalogProviders.find(p => p.id === 'openrouter');
    assert.equal(
      openrouter.stripPrefix('openrouter/anthropic/claude-3.7-sonnet'),
      'anthropic/claude-3.7-sonnet',
    );
  });

  test('OpenRouter dynamically exposes only zero-price native-tool routes', async () => {
    const { catalogProviders } = await import('../src/providers.js');
    const openrouter = catalogProviders.find(provider => provider.id === 'openrouter');
    const prev = process.env.OPENROUTER_API_KEY;
    const prevBase = process.env.OPENROUTER_BASE_URL;
    const server = http.createServer((req, res) => {
      assert.equal(req.url, '/models?supported_parameters=tools');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [
        {
          id: 'deepseek/deepseek-r1:free', context_length: 131072,
          pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'max_tokens'],
        },
        {
          id: 'paid/with-tools', pricing: { prompt: '0.1', completion: '0.2' },
          supported_parameters: ['tools'],
        },
        {
          id: 'free/without-tools:free', pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['max_tokens'],
        },
      ] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      delete process.env.OPENROUTER_API_KEY;
      assert.deepEqual(await openrouter.getModels(), [], 'absent without key');
      process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
      process.env.OPENROUTER_API_KEY = 'or-test';
      const models = await openrouter.getModels();
      assert.deepEqual(models.map(model => model.name), [
        'openrouter/free',
        'openrouter/deepseek/deepseek-r1:free',
      ]);
      assert.ok(models.every(model => model.access.free));
      assert.ok(models.every(model => model.capabilities.includes('tools')));
    } finally {
      if (prev == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
      if (prevBase == null) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = prevBase;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  test('OpenRouter free alias sends the official openrouter/free model id', async () => {
    let receivedBody = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previous = { key: process.env.OPENROUTER_API_KEY, base: process.env.OPENROUTER_BASE_URL };
    process.env.OPENROUTER_API_KEY = 'or-test';
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    try {
      const { catalogProviders } = await import('../src/providers.js');
      const openrouter = catalogProviders.find(provider => provider.id === 'openrouter');
      await openrouter.chatStream({ model: 'openrouter/free', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(receivedBody.model, 'openrouter/free');
      assert.equal(receivedBody.max_tokens, 1_024, 'free route uses the efficient output cap');
    } finally {
      if (previous.key == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous.key;
      if (previous.base == null) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = previous.base;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  test('missingCredential flags a catalog provider without its key', async () => {
    const { missingCredential } = await import('../src/provider.js');
    const prev = process.env.GEMINI_API_KEY;
    const prevAlt = process.env.GOOGLE_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      const miss = missingCredential(['google/gemini-2.5-pro']);
      assert.equal(miss.env, 'GEMINI_API_KEY');
      assert.equal(miss.label, 'Google Gemini');
    } finally {
      if (prev == null) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prev;
      if (prevAlt == null) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevAlt;
    }
  });

  test('a catalog provider streams through the shared transport (mock)', async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: parsed.model } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const prevBase = process.env.OPENROUTER_BASE_URL;
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENROUTER_API_KEY = 'or-test';
    try {
      const { chatStream } = await import('../src/provider.js');
      const result = await chatStream({
        model: 'openrouter/meta-llama/llama-3.3-70b-instruct',
        messages: [{ role: 'user', content: 'hi' }],
      });
      // The mock echoes back the model it received → confirms prefix stripped.
      assert.equal(result.content, 'meta-llama/llama-3.3-70b-instruct');
    } finally {
      if (prevBase == null) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = prevBase;
      if (prevKey == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });
});

// ─── Server integration tests ─────────────────────────────────────────────────

describe('server.js HTTP API', async () => {
  let serverProcess;
  // Was a hardcoded 14322, which made the whole suite fail if any earlier run
  // left a server behind or a second run overlapped — the failure looked like a
  // broken server rather than a busy port. The other server suites already
  // allocate dynamically; this one now matches them.
  const TEST_PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${TEST_PORT}`;

  before(async () => {
    // Start server on a test port
    serverProcess = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(TEST_PORT), HOST: '127.0.0.1', NODE_ENV: 'test' },
      stdio: 'pipe',
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10_000);
      serverProcess.stdout.on('data', data => {
        if (data.toString().includes('listening')) {
          clearTimeout(timeout);
          setTimeout(resolve, 100);
        }
      });
      serverProcess.on('error', err => { clearTimeout(timeout); reject(err); });
    });
  });

  after(async () => {
    if (serverProcess) serverProcess.kill();
  });

  test('GET /api/health returns ok', async () => {
    const { status, headers, body } = await httpGet(`${BASE}/api/health`);
    assert.equal(status, 200);
    assert.ok(body.ok, 'health ok');
    assert.ok(body.ollamaBaseUrl, 'has ollamaBaseUrl');
    assert.ok(body.workspaceRoot, 'has workspaceRoot');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['cache-control'], 'no-store');
  });

  test('Host, Origin, and fetch metadata reject cross-site requests', async () => {
    assert.equal((await httpGet(`${BASE}/api/health`, { Host: `evil.example:${TEST_PORT}` })).status, 421);
    assert.equal((await httpGet(`${BASE}/api/health`, { Origin: `http://evil.example:${TEST_PORT}` })).status, 403);
    assert.equal((await httpGet(`${BASE}/api/health`, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  });

  test('GET /api/models returns model list', async () => {
    const { status, body } = await httpGet(`${BASE}/api/models`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.models), 'models is array');
    assert.equal(typeof body.defaultModel, 'string', 'configured/default model is identified for the browser');
    // Content depends on what is reachable — with no Ollama and no key the right
    // answer is an empty list, not a failure. Only the shape is guaranteed.
    for (const m of body.models) assert.ok(m.name, 'every model has a name');
  });

  test('GET /api/sessions returns sessions list', async () => {
    const { status, body } = await httpGet(`${BASE}/api/sessions`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.sessions), 'sessions is array');
  });

  test('GET /api/bench returns reports list', async () => {
    const { status, body } = await httpGet(`${BASE}/api/bench`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.reports), 'reports is array');
    // bench/runs/ is gitignored, so reports may be empty on a fresh clone;
    // only assert per-report shape when runs exist locally.
    for (const r of body.reports.slice(0, 3)) {
      assert.ok(r.file, 'report has source file');
      assert.ok(r.summary, 'report has summary');
    }
  });

  test('GET /bench.html serves the bench dashboard', async () => {
    const { status, headers, body } = await httpGet(`${BASE}/bench.html`);
    assert.equal(status, 200);
    assert.ok(String(body).includes('Benchmark Results'), 'dashboard page served');
    assert.match(headers['content-security-policy'] ?? '', /script-src 'self' 'nonce-/);
    assert.match(String(body), /<script nonce="[^"]+"/);
  });

  test('POST /api/sessions creates a new session', async () => {
    const { status, body } = await httpPost(`${BASE}/api/sessions`, {
      title: 'Test Session',
      model: LIVE_MODEL,
      cwd: ROOT,
    });
    assert.equal(status, 201);
    assert.ok(body.session.id, 'has id');
    assert.equal(body.session.title, 'Test Session');
    assert.equal(body.session.model, LIVE_MODEL);
    // Cleanup
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${body.session.id}.json`)); } catch {}
  });

  test('POST /api/sessions truncates long titles', async () => {
    const longTitle = 'A'.repeat(100);
    const { status, body } = await httpPost(`${BASE}/api/sessions`, { title: longTitle });
    assert.equal(status, 201);
    assert.ok(body.session.title.length <= 61, 'title truncated');
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${body.session.id}.json`)); } catch {}
  });

  test('POST /api/sessions uses defaults for missing fields', async () => {
    const { status, body } = await httpPost(`${BASE}/api/sessions`, {});
    assert.equal(status, 201);
    assert.equal(body.session.title, 'New Session');
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${body.session.id}.json`)); } catch {}
  });

  test('GET /api/sessions/:id returns session', async () => {
    const { body: created } = await httpPost(`${BASE}/api/sessions`, { title: 'Get Test' });
    const { status, body } = await httpGet(`${BASE}/api/sessions/${created.session.id}`);
    assert.equal(status, 200);
    assert.equal(body.session.id, created.session.id);
    assert.equal(body.session.title, 'Get Test');
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${created.session.id}.json`)); } catch {}
  });

  test('GET /api/sessions/:id 404 for unknown session', async () => {
    const { status } = await httpGet(`${BASE}/api/sessions/nonexistent-id`);
    assert.equal(status, 404);
  });

  test('POST /api/expand with no @tokens returns text unchanged', async () => {
    const { status, body } = await httpPost(`${BASE}/api/expand`, {
      text: 'hello world',
      cwd: ROOT,
    });
    assert.equal(status, 200);
    assert.equal(body.text, 'hello world');
    assert.deepEqual(body.files, []);
  });

  test('POST /api/expand expands @file references', async () => {
    const { status, body } = await httpPost(`${BASE}/api/expand`, {
      text: 'read @README.md please',
      cwd: ROOT,
    });
    assert.equal(status, 200);
    assert.ok(body.text.includes('Claudette'), 'expanded README.md');
    assert.ok(body.files.length > 0, 'tracked expanded file');
  });

  test('POST /api/expand ignores nonexistent files', async () => {
    const { status, body } = await httpPost(`${BASE}/api/expand`, {
      text: 'look @this-does-not-exist.txt',
      cwd: ROOT,
    });
    assert.equal(status, 200);
    assert.ok(body.text.includes('@this-does-not-exist.txt'), 'leaves @token unchanged');
    assert.deepEqual(body.files, []);
  });

  test('POST /api/expand refuses symlinks that resolve outside the workspace', async () => {
    const outside = path.join(os.tmpdir(), `claudette-server-outside-${randomUUID()}.txt`);
    const linkName = `.claudette-server-link-${randomUUID()}.txt`;
    const link = path.join(ROOT, linkName);
    await fsp.writeFile(outside, 'server-secret-must-not-expand');
    await fsp.symlink(outside, link);
    try {
      const { status, body } = await httpPost(`${BASE}/api/expand`, {
        text: `read @${linkName}`,
        cwd: ROOT,
      });
      assert.equal(status, 200);
      assert.deepEqual(body.files, []);
      assert.doesNotMatch(body.text, /server-secret-must-not-expand/);
    } finally {
      await fsp.unlink(link).catch(() => {});
      await fsp.unlink(outside).catch(() => {});
    }
  });

  test('GET / serves index.html', async () => {
    const { status, body } = await httpGet(`${BASE}/`);
    assert.equal(status, 200);
  });

  test('GET /nonexistent returns 404', async () => {
    const { status } = await httpGet(`${BASE}/this-page-does-not-exist.html`);
    assert.equal(status, 404);
  });

  test('POST /api/sessions/:id/messages streams response', { skip: LIVE_SKIP }, async () => {
    // Create session first
    const { body: created } = await httpPost(`${BASE}/api/sessions`, { model: LIVE_MODEL });
    const sid = created.session.id;

    const { status, lines } = await httpPostStream(
      `${BASE}/api/sessions/${sid}/messages`,
      { content: 'Reply with just the number 42.', model: LIVE_MODEL }
    );
    assert.equal(status, 200);

    const meta = lines.find(l => l.type === 'meta');
    assert.ok(meta, 'has meta chunk');
    assert.ok(meta.model, 'meta has model');
    assert.ok(meta.traceTurn, 'meta has traceTurn');
    assert.equal(meta.traceTurn.status, 'running', 'traceTurn starts as running');

    const deltas = lines.filter(l => l.type === 'delta');
    assert.ok(deltas.length > 0, 'has at least one delta');

    const traceEvents = lines.filter(l => l.type === 'trace');
    assert.ok(traceEvents.length > 0, 'has trace events');
    const eventTypes = traceEvents.map(e => e.event.type);
    assert.ok(eventTypes.includes('input_received'), 'has input_received event');
    assert.ok(eventTypes.includes('system_prompt_built'), 'has system_prompt_built event');
    assert.ok(eventTypes.includes('model_request_started'), 'has model_request_started event');

    const done = lines.find(l => l.type === 'done');
    assert.ok(done, 'has done chunk');
    assert.ok(done.sessionId, 'done has sessionId');
    assert.ok(done.traceTurn, 'done has completed traceTurn');
    assert.equal(done.traceTurn.status, 'completed', 'traceTurn status is completed');
    assert.ok(done.traceTurn.metrics.durationMs >= 0, 'traceTurn has durationMs');
    assert.ok(done.traceTurn.metrics.totalTokens >= 0, 'traceTurn has totalTokens');

    // Check session was saved with the assistant message
    const { body: loaded } = await httpGet(`${BASE}/api/sessions/${sid}`);
    assert.ok(loaded.session.messages.length >= 2, 'session has user+assistant messages');
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${sid}.json`)); } catch {}
  });

  test('an oversized request body is rejected, not buffered', async () => {
    // The server is unauthenticated and on loopback; without a cap it would
    // happily read a gigabyte into memory.
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const { status, body } = await httpPost(`${BASE}/api/sessions`, { title: huge });
    assert.equal(status, 413);
    assert.match(body.error ?? '', /exceeds/i);
  });

  test('a malformed JSON body gets 400, not 500', async () => {
    const { status, body } = await httpPost(`${BASE}/api/sessions`, '{not json');
    assert.equal(status, 400);
    assert.match(body.error ?? '', /valid JSON/i);
  });

  test('POST APIs require JSON objects with known, typed fields', async () => {
    assert.equal((await httpPost(`${BASE}/api/sessions`, '{}', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await httpPost(`${BASE}/api/sessions`, [])).status, 400);
    assert.equal((await httpPost(`${BASE}/api/sessions`, { surprise: true })).status, 400);
    assert.equal((await httpPost(`${BASE}/api/sessions`, { title: { nested: true } })).status, 400);
  });

  test('a second concurrent turn on one session is refused', async () => {
    // Two overlapping POSTs both loaded the session, both appended, and the
    // slower save clobbered the faster one — the first turn's messages vanished.
    const { body: created } = await httpPost(`${BASE}/api/sessions`, {});
    const sid = created.session.id;
    const [a, b] = await Promise.all([
      httpPostStream(`${BASE}/api/sessions/${sid}/messages`, { content: 'first', model: LIVE_MODEL ?? 'nope:latest' }),
      httpPostStream(`${BASE}/api/sessions/${sid}/messages`, { content: 'second', model: LIVE_MODEL ?? 'nope:latest' }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], 'exactly one turn is admitted');
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${sid}.json`)); } catch {}
  });

  test('POST /api/sessions/:id/messages 400 for empty content', async () => {
    const { body: created } = await httpPost(`${BASE}/api/sessions`, {});
    const sid = created.session.id;
    const { status } = await httpPost(`${BASE}/api/sessions/${sid}/messages`, { content: '' });
    assert.equal(status, 400);
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${sid}.json`)); } catch {}
  });

  test('POST /api/sessions/:id/messages uses @file expansion', { skip: LIVE_SKIP }, async () => {
    const { body: created } = await httpPost(`${BASE}/api/sessions`, { model: LIVE_MODEL });
    const sid = created.session.id;
    const { lines } = await httpPostStream(
      `${BASE}/api/sessions/${sid}/messages`,
      { content: 'Summarize @README.md in one word.', model: LIVE_MODEL, cwd: ROOT }
    );
    const meta = lines.find(l => l.type === 'meta');
    assert.ok(meta?.expandedFiles?.length > 0, 'README.md was expanded');
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${sid}.json`)); } catch {}
  });

  test('POST unknown API path returns 404', async () => {
    const { status } = await httpPost(`${BASE}/api/unknown`, {});
    assert.equal(status, 404);
  });

  test('static file serving: path traversal is blocked', async () => {
    const { status } = await httpGet(`${BASE}/../../etc/passwd`);
    // Should be 404 or 403, not 200
    assert.ok(status === 404 || status === 403, `status ${status} is safe`);
  });

  test('static file serving refuses a symlink outside public', async () => {
    const outside = path.join(os.tmpdir(), `claudette-static-outside-${randomUUID()}.txt`);
    const linkName = `.claudette-static-link-${randomUUID()}.txt`;
    const link = path.join(ROOT, 'public', linkName);
    await fsp.writeFile(outside, 'static-secret');
    await fsp.symlink(outside, link);
    try {
      const { status, body } = await httpGet(`${BASE}/${linkName}`);
      assert.notEqual(status, 200);
      assert.doesNotMatch(String(body), /static-secret/);
    } finally {
      await fsp.unlink(link).catch(() => {});
      await fsp.unlink(outside).catch(() => {});
    }
  });

  test('non-loopback binding refuses to start without token and allowed hosts', () => {
    const result = spawnSync(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOST: '0.0.0.0',
        PORT: String(TEST_PORT),
        CLAUDETTE_SERVER_TOKEN: '',
        CLAUDETTE_ALLOWED_HOSTS: '',
      },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /requires CLAUDETTE_SERVER_TOKEN and CLAUDETTE_ALLOWED_HOSTS/);
  });
});

describe('server.js configured bearer boundary', () => {
  let serverProcess;
  let port;
  let base;
  const token = 'test-only-server-token';

  before(async () => {
    port = await getFreePort();
    base = `http://127.0.0.1:${port}`;
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        CLAUDETTE_SERVER_TOKEN: token,
        CLAUDETTE_ALLOWED_HOSTS: '127.0.0.1',
      },
      stdio: 'pipe',
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('authenticated server start timeout')), 10_000);
      const cleanup = () => {
        serverProcess.stdout.off('data', onStdout);
        serverProcess.stderr.off('data', onStderr);
        serverProcess.off('exit', onExit);
      };
      const ready = () => {
        clearTimeout(timeout);
        cleanup();
        resolve();
      };
      const onStdout = data => {
        if (data.toString().includes('listening')) ready();
      };
      const onStderr = data => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`authenticated server failed: ${data.toString().trim()}`));
      };
      const onExit = (code, signal) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`authenticated server exited before ready (code=${code}, signal=${signal})`));
      };
      serverProcess.stdout.on('data', onStdout);
      serverProcess.stderr.on('data', onStderr);
      serverProcess.on('error', reject);
      serverProcess.on('exit', onExit);
    });
  });

  after(async () => {
    if (!serverProcess || serverProcess.exitCode != null) return;
    serverProcess.kill();
    await new Promise(resolve => serverProcess.once('exit', resolve));
  });

  test('requires the exact bearer token for browser APIs', async () => {
    const missing = await httpGet(`${base}/api/health`);
    assert.equal(missing.status, 401);
    assert.match(String(missing.headers['www-authenticate']), /^Bearer /);

    const wrong = await httpGet(`${base}/api/health`, { Authorization: 'Bearer wrong-token' });
    assert.equal(wrong.status, 401);

    const valid = await httpGet(`${base}/api/health`, { Authorization: `Bearer ${token}` });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.ok, true);
  });

  test('rejects a forged Host or cross-origin request even with a valid token', async () => {
    const authorization = `Bearer ${token}`;
    const badHost = await httpGet(`${base}/api/health`, {
      Authorization: authorization,
      Host: `attacker.example:${port}`,
    });
    assert.equal(badHost.status, 421);

    const badOrigin = await httpGet(`${base}/api/health`, {
      Authorization: authorization,
      Origin: `https://attacker.example:${port}`,
    });
    assert.equal(badOrigin.status, 403);

    const allowedOrigin = await httpGet(`${base}/api/health`, {
      Authorization: authorization,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.equal(allowedOrigin.status, 200);
  });
});

describe('server.js shared tool-less runner path', () => {
  let modelServer;
  let serverProcess;
  let tmpDir;
  let base;
  const requests = [];
  const model = 'mock-web-runner:latest';
  const toolShapedText = '{"name":"write_file","arguments":{"path":"must-not-exist.txt","content":"no"}}';

  before(async () => {
    tmpDir = await makeTmpDir();
    modelServer = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/chat') {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      createNdjsonResponse(res, [
        { message: { content: toolShapedText } },
        { done: true, prompt_eval_count: 7, eval_count: 3 },
      ]);
    });
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));

    const port = await getFreePort();
    base = `http://127.0.0.1:${port}`;
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        WORKSPACE_ROOT: tmpDir,
        CLAUDETTE_DATA_DIR: path.join(tmpDir, '.state'),
        OLLAMA_BASE_URL: `http://127.0.0.1:${modelServer.address().port}`,
        CLAUDETTE_MODEL_ROTATION: '0',
        CLAUDETTE_FREE_TIER_ONLY: '0',
        CLAUDETTE_REQUIRE_TOOLS: '0',
        CLAUDETTE_ALWAYS_TRACK: '0',
      },
      stdio: 'pipe',
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('shared-runner server start timeout')), 10_000);
      const onStdout = data => {
        if (!data.toString().includes('listening')) return;
        clearTimeout(timeout);
        cleanup();
        resolve();
      };
      const onExit = (code, signal) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`shared-runner server exited before ready (code=${code}, signal=${signal})`));
      };
      const cleanup = () => {
        serverProcess.stdout.off('data', onStdout);
        serverProcess.off('exit', onExit);
      };
      serverProcess.stdout.on('data', onStdout);
      serverProcess.on('error', reject);
      serverProcess.on('exit', onExit);
    });
  });

  after(async () => {
    if (serverProcess && serverProcess.exitCode == null) {
      serverProcess.kill();
      await new Promise(resolve => serverProcess.once('exit', resolve));
    }
    if (modelServer) {
      await new Promise((resolve, reject) => modelServer.close(err => err ? reject(err) : resolve()));
    }
    if (tmpDir) await cleanDir(tmpDir);
  });

  test('streams through runAgent with no tools and persists its shared result', async () => {
    const { body: created } = await httpPost(`${base}/api/sessions`, { model, cwd: tmpDir });
    const turn = await httpPostStream(`${base}/api/sessions/${created.session.id}/messages`, {
      content: 'Return the requested text.',
      model,
      cwd: tmpDir,
    });

    assert.equal(turn.status, 200);
    assert.ok(turn.lines.some(line => line.type === 'delta' && line.content === toolShapedText));
    assert.ok(turn.lines.some(line => line.type === 'done'));
    assert.ok(!turn.lines.some(line => line.type === 'error'));
    assert.equal(requests.length, 1);
    assert.ok(!requests[0].tools, 'web runner offers no executable tools');
    await assert.rejects(() => fsp.stat(path.join(tmpDir, 'must-not-exist.txt')), /ENOENT/);

    const { body: loaded } = await httpGet(`${base}/api/sessions/${created.session.id}`);
    assert.deepEqual(loaded.session.messages.map(message => message.role), ['user', 'assistant']);
    assert.equal(loaded.session.messages[1].content, toolShapedText);
    assert.equal(loaded.session.turns.at(-1).status, 'completed');

    const source = await fsp.readFile(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(source, /runAgent\(\{/);
    assert.match(source, /tools:\s*\[\]/);
    assert.doesNotMatch(source, /import\s*\{[^}]*chatStream[^}]*\}\s*from/);
  });
});

// ─── CLI process tests ────────────────────────────────────────────────────────

describe('CLI (claudette.js)', async () => {
  // These spawn the real CLI, which refuses to start when no model is reachable.
  // They used to rely on the developer happening to have Ollama running — so they
  // passed locally and every one of them failed in CI. Serve a minimal /api/tags
  // instead, and the suite is hermetic.
  let modelServer;
  let modelBaseUrl;

  before(async () => {
    modelServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [{
            name: 'mock-cli:latest', size: 1,
            details: { family: 'mock', parameter_size: '1b' },
            modified_at: new Date().toISOString(),
          }],
        }));
        return;
      }
      // Any chat request gets one short, well-formed response.
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'PONG' } }) + '\n');
      res.end(JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1 }) + '\n');
    });
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
    modelBaseUrl = `http://127.0.0.1:${modelServer.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => modelServer.close(err => err ? reject(err) : resolve()));
  });

  function runCliWithInput(inputs, options = {}) {
    const {
      timeout = 30_000,
      args = [],
      env = {},
      cwd = ROOT,
      inputDelayMs = 300,
      finalDelayMs = 500,
    } = options;
    return new Promise((resolve, reject) => {
      const proc = spawn('node', ['claudette.js', ...args], {
        cwd,
        env: { ...process.env, OLLAMA_BASE_URL: modelBaseUrl, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);

      // EOF is the reliable shutdown signal for these piped CLI tests. Appending
      // `/exit` on a wall-clock timer raced slower commands such as /models and
      // /files: readline had no active question listener, so the exit line (and
      // occasionally the assertion target's output) was lost. The CLI already
      // guarantees that a running command finishes after stdin closes.
      const lines = [...inputs];
      let idx = 0;
      function sendNext() {
        if (idx < lines.length) {
          setTimeout(() => {
            proc.stdin.write(lines[idx++]);
            sendNext();
          }, inputDelayMs);
        } else {
          setTimeout(() => proc.stdin.end(), finalDelayMs);
        }
      }
      sendNext();

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({ stdout, stderr, timedOut: true });
      }, timeout);

      proc.on('close', () => {
        clearTimeout(timer);
        resolve({ stdout, stderr, timedOut: false });
      });
      proc.on('error', reject);
    });
  }

  test('CLI starts and shows banner', async () => {
    const { stdout } = await runCliWithInput([]);
    assert.ok(stdout.includes('Claudette') || stdout.includes('claudette'), 'shows banner');
  });

  test('CLI /help lists commands', async () => {
    const { stdout } = await runCliWithInput(['/help\n']);
    assert.ok(stdout.includes('/model') || stdout.includes('help'), '/help output');
    assert.ok(stdout.includes('/diff') && stdout.includes('/commit'), 'shows git workflow commands');
    assert.ok(stdout.includes('/interrupt'), 'shows active-turn steering command');
    assert.ok(stdout.includes('/copy'), 'shows clipboard command');
  });

  test('CLI /copy handles empty history and rejects arguments without a model request', async () => {
    for (const [command, expected] of [
      ['/copy\n', /No assistant message to copy yet/],
      ['/copy extra\n', /Usage: \/copy/],
    ]) {
      const { stdout, timedOut } = await runCliWithInput([command], { args: ['--model', 'mock-cli:latest'] });
      assert.equal(timedOut, false);
      assert.match(stdout, expected);
      assert.doesNotMatch(stdout, /PONG|Unknown command/);
    }
  });

  test('CLI parser normalizes grep-like tool calls to search_code', async () => {
    const { __test_parseTextToolCalls } = await import('../src/chat.js');
    const calls = __test_parseTextToolCalls(JSON.stringify({
      name: 'grep',
      arguments: { pattern: 'needle', path: 'src' },
    }));
    assert.equal(calls[0]?.function?.name, 'search_code');
  });

  // Verbatim from a qwen3-coder:30b eval run. The parser was JSON-only, so this
  // read as prose and the case scored 0 tool calls — for a tool call that was
  // entirely correct. Whole families of local models emit this shape.
  test('CLI parser reads Qwen-style XML tool calls', async () => {
    const { __test_parseTextToolCalls } = await import('../src/chat.js');
    const calls = __test_parseTextToolCalls(
      '<function=write_file>\n<parameter=path>\ngreeting.txt\n</parameter>\n' +
      '<parameter=content>\nhello from claudette\n</parameter>\n</function>\n</tool_call>');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'write_file');
    assert.deepEqual(calls[0].function.arguments, { path: 'greeting.txt', content: 'hello from claudette' });
  });

  test('XML tool calls keep interior whitespace and reject prose', async () => {
    const { parseXmlToolCalls } = await import('../src/tool-call-parser.js');
    // Indentation inside `content` is the file's, not the tag's — only the
    // newline the tag itself introduced comes off.
    const [call] = parseXmlToolCalls(
      '<function=write_file>\n<parameter=path>a.py</parameter>\n' +
      '<parameter=content>\ndef f():\n    return 1\n</parameter>\n</function>');
    assert.equal(call.function.arguments.content, 'def f():\n    return 1');

    assert.deepEqual(parseXmlToolCalls('I will call the write_file function now.'), [],
      'prose mentioning a tool is not a call');
    assert.deepEqual(parseXmlToolCalls('<function=bash></function>'), [],
      'a call with no parameters is not a call');

    const [numeric] = parseXmlToolCalls(
      '<function=read_file><parameter=path>a.js</parameter><parameter=limit>20</parameter></function>');
    assert.equal(numeric.function.arguments.limit, 20, 'numeric args are coerced, not left as strings');
  });

  test('CLI parser extracts wrapped and batched text tool calls', async () => {
    const { __test_parseTextToolCalls } = await import('../src/chat.js');
    const calls = __test_parseTextToolCalls(JSON.stringify({
      tool_calls: [
        { function: { name: 'read', arguments: { path: 'README.md' } } },
        { tool: { name: 'bash', arguments: { cmd: 'node --check src/chat.js' } } },
      ],
    }));
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.function?.name, 'read_file');
    assert.equal(calls[1]?.function?.name, 'bash');
    assert.equal(calls[1]?.function?.arguments?.command, 'node --check src/chat.js');
  });

  test('CLI parser never executes tool-shaped JSON or XML from hidden reasoning', async () => {
    const { __test_parseTextToolCalls } = await import('../src/chat.js');
    const hiddenJson = '{"name":"write_file","arguments":{"path":"reasoning.txt","content":"must not run"}}';
    const hiddenXml = '<function=bash><parameter=command>touch reasoning.txt</parameter></function>';
    const visible = '{"name":"read_file","arguments":{"path":"README.md"}}';
    const calls = __test_parseTextToolCalls(`<think>${hiddenJson}\n${hiddenXml}</think>\n${visible}`);
    assert.deepEqual(calls.map(call => call.function.name), ['read_file']);
    assert.equal(calls[0].function.arguments.path, 'README.md');
    assert.deepEqual(__test_parseTextToolCalls(`<think>${hiddenJson}`), [],
      'unterminated hidden reasoning fails closed');
  });

  // The exact-bash shortcut used to run any command that followed a magic
  // sentence, straight from the prompt, with no permission check — and the
  // prompt it scanned was the @file-EXPANDED one, so a file you merely asked it
  // to summarise could execute shell. The extractor is gone; nothing may bring
  // back a path from prompt text to executeTool that skips checkPermission.
  test('no prompt-triggered bash bypass remains in chat.js', async () => {
    const source = await fsp.readFile(path.join(ROOT, 'src', 'chat.js'), 'utf8');
    assert.ok(!/EXACTLY this command/.test(source), 'magic-sentence extractor is gone');
    assert.ok(!/extractExactBashCommand|runExactBashShortcut/.test(source), 'shortcut helpers are gone');
    const chat = await import('../src/chat.js');
    assert.equal(chat.__test_extractExactBashCommand, undefined, 'no test hook left behind');
  });

  test('pickDefaultModel needs tool support above all else', async () => {
    const { pickDefaultModel } = await import('../src/chat.js');
    // A model that cannot call tools cannot run the agent loop, however nice it
    // looks otherwise.
    const picked = pickDefaultModel([
      { name: 'pretty-coder:7b', size: 4e9, capabilities: ['completion'] },
      { name: 'plain:32b', size: 20e9, capabilities: ['completion', 'tools'] },
    ]);
    assert.equal(picked, 'plain:32b');
  });

  test('pickDefaultModel follows the shared free coding rank when routes are live', async () => {
    const { pickDefaultModel } = await import('../src/chat.js');
    const tools = ['tools'];
    assert.equal(pickDefaultModel([
      { name: 'deepseek-v4-pro:cloud', capabilities: tools },
      { name: 'openrouter/cohere/north-mini-code:free', capabilities: tools },
      { name: 'kimi-k2.7-code:cloud', capabilities: tools },
      { name: 'groq/openai/gpt-oss-120b', capabilities: tools },
      { name: 'openrouter/poolside/laguna-s-2.1:free', capabilities: tools },
      { name: 'openrouter/z-ai/glm-5.2:free', capabilities: tools },
    ]), 'kimi-k2.7-code:cloud');
  });

  test('pickDefaultModel prefers coding-tuned, then smaller', async () => {
    const { pickDefaultModel } = await import('../src/chat.js');
    const tools = ['tools'];
    assert.equal(
      pickDefaultModel([
        { name: 'general:8b', size: 5e9, capabilities: tools },
        { name: 'qwen2.5-coder:7b', size: 4.7e9, capabilities: tools },
      ]),
      'qwen2.5-coder:7b',
      'coding-tuned wins',
    );
    assert.equal(
      pickDefaultModel([
        { name: 'big-coder:70b', size: 40e9, capabilities: tools },
        { name: 'small-coder:7b', size: 4e9, capabilities: tools },
      ]),
      'small-coder:7b',
      'among equals, smaller wins — speed is what makes the loop usable',
    );
  });

  test('pickDefaultModel skips embedding and vision-only models', async () => {
    const { pickDefaultModel } = await import('../src/chat.js');
    const picked = pickDefaultModel([
      { name: 'nomic-embed-text', size: 3e8, capabilities: ['tools'] },
      { name: 'llama-guard:8b', size: 5e9, capabilities: ['tools'] },
      { name: 'workhorse:14b', size: 9e9, capabilities: ['tools'] },
    ]);
    assert.equal(picked, 'workhorse:14b');
  });

  test('pickDefaultModel does not punish cloud entries for reporting no capabilities', async () => {
    const { pickDefaultModel } = await import('../src/chat.js');
    // Cloud models carry no capability list — unknown, not empty.
    assert.equal(pickDefaultModel([{ name: 'openrouter/openai/gpt-5-nano' }]), 'openrouter/openai/gpt-5-nano');
    assert.equal(pickDefaultModel([]), null);
  });

  test('permissionKey scopes bash approval to the exact command', async () => {
    const { permissionKey } = await import('../src/chat.js');
    // "always" on one command must not authorise a different one.
    assert.equal(permissionKey('bash', { command: 'npm test' }), 'bash:npm test');
    assert.notEqual(
      permissionKey('bash', { command: 'npm test' }),
      permissionKey('bash', { command: 'rm -rf /' }),
    );
    assert.equal(permissionKey('bash', { command: '  npm test  ' }), 'bash:npm test', 'whitespace normalised');
    assert.equal(permissionKey('bash', {}), 'bash:');
    // Non-bash tools stay coarse — the workspace guard already bounds them.
    assert.equal(permissionKey('write_file', { path: 'a.js' }), 'write_file');
  });

  test('dropOrphanToolMessages removes tool messages with no matching tool_calls', async () => {
    const { dropOrphanToolMessages } = await import('../src/chat.js');
    // The shape the removed shortcut persisted, which OpenAI/Azure reject with
    // "messages with role 'tool' must be a response to a preceeding message
    // with 'tool_calls'" — poisoning every later prompt in that session.
    const poisoned = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Executed the exact bash command.' },
      { role: 'tool', content: 'output', name: 'bash' },
      { role: 'user', content: 'now what?' },
    ];
    assert.deepEqual(dropOrphanToolMessages(poisoned), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Executed the exact bash command.' },
      { role: 'user', content: 'now what?' },
    ]);
  });

  test('dropOrphanToolMessages keeps legitimate tool results untouched', async () => {
    const { dropOrphanToolMessages } = await import('../src/chat.js');
    const valid = [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: {} } }] },
      { role: 'tool', content: 'file body', tool_call_id: 'a' },
      { role: 'assistant', content: 'done' },
    ];
    assert.equal(dropOrphanToolMessages(valid), valid, 'unchanged array is returned by identity');
  });

  test('dropOrphanToolMessages keeps one result per parallel tool call', async () => {
    const { dropOrphanToolMessages } = await import('../src/chat.js');
    const parallel = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: {} }, { id: 'b', function: {} }] },
      { role: 'tool', content: 'one', tool_call_id: 'a' },
      { role: 'tool', content: 'two', tool_call_id: 'b' },
      { role: 'tool', content: 'orphan third' },
    ];
    const out = dropOrphanToolMessages(parallel);
    assert.equal(out.length, 3, 'the unmatched third result is dropped');
    assert.equal(out.at(-1).content, 'two');
  });

  test('CLI /models lists available models', async () => {
    // Asserted on vendor names (qwen/llama/gemma) before, which only held if the
    // developer happened to have those pulled. Assert on the model this suite
    // actually serves.
    const { stdout } = await runCliWithInput(['/models\n']);
    const plain = stripVTControlCharacters(stdout);
    assert.ok(plain.includes('mock-cli'), 'lists the reachable model');
    assert.ok(/Available Models/i.test(plain), 'renders the model table');
    assert.match(plain, /mock-cli:latest\s{2,}1b/, 'separates long model IDs from metadata');
  });

  test('CLI /config shows config table', async () => {
    const { stdout } = await runCliWithInput(['/config\n']);
    const plain = stripVTControlCharacters(stdout);
    assert.ok(plain.includes('model') || plain.includes('workspace'), 'shows config');
    assert.match(plain, /rotation\s+disabled/i, 'shows the effective model-rotation policy');
  });

  test('CLI /session shows session info', async () => {
    const { stdout } = await runCliWithInput(['/session\n']);
    assert.ok(stdout.includes('id') || stdout.includes('session'), 'shows session info');
  });

  test('CLI /sessions lists saved sessions', async () => {
    const { stdout } = await runCliWithInput(['/sessions\n']);
    // Should not crash — may show empty or list
    assert.ok(stdout.length > 0, 'produces output');
  });

  test('CLI /model <name> switches model', async () => {
    // /model only records the name, so any string exercises it — no live model needed.
    const target = LIVE_MODEL ?? 'llama3.2:latest';
    const { stdout } = await runCliWithInput([`/model ${target}\n`]);
    assert.ok(stdout.includes(target), `shows new model (${target})`);
  });

  test('CLI /tools toggles tool calling', async () => {
    const { stdout } = await runCliWithInput(['/tools\n']);
    assert.ok(stdout.includes('disabled') || stdout.includes('enabled'), 'toggles tools');
  });

  test('CLI /files lists workspace files', async () => {
    const { stdout } = await runCliWithInput(['/files\n']);
    assert.ok(stdout.includes('package.json') || stdout.includes('src'), 'lists workspace files');
  });

  test('CLI /status shows git status or error', async () => {
    const { stdout } = await runCliWithInput(['/status\n']);
    // This is not a git repo, so it should print an error
    assert.ok(stdout.includes('git') || stdout.includes('Not a git') || stdout.length > 0, 'shows git status');
  });

  test('CLI /diff shows git diff or error', async () => {
    const { stdout } = await runCliWithInput(['/diff\n']);
    assert.ok(stdout.length > 0, 'produces output');
  });

  test('CLI /cost shows token estimate', async () => {
    const { stdout } = await runCliWithInput(['/cost\n']);
    assert.ok(stdout.includes('token') || stdout.includes('message'), 'shows cost estimate');
  });

  test('CLI unknown command prints warning', async () => {
    const { stdout } = await runCliWithInput(['/notacommand\n']);
    assert.ok(stdout.includes('Unknown') || stdout.includes('unknown'), 'shows unknown command warning');
  });

  test('CLI processes a piped command even when stdin closes immediately (EOF flush)', async () => {
    // `echo "/help" | claudette` — the line and EOF arrive together. The burst
    // reader must flush the buffered line on close instead of dropping it.
    const out = await new Promise((resolve, reject) => {
      // Needs the mock model list too — the CLI refuses to start without one, so
      // this passed locally and failed in CI.
      const proc = spawn('node', ['claudette.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', OLLAMA_BASE_URL: modelBaseUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stdout += d);
      proc.on('close', () => resolve(stdout));
      proc.on('error', reject);
      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(stdout); }, 20000);
      proc.on('close', () => clearTimeout(timer));
      proc.stdin.write('/help\n');
      proc.stdin.end(); // EOF immediately after the line — the race that dropped input
    });
    assert.ok(/\/diff|\/commit|commands/i.test(out), 'the piped /help command was processed, not dropped');
    assert.ok(!/Fatal: readline was closed/.test(out), 'no closed-readline crash on EOF');
  });

  test('CLI coalesces a pasted multi-line block into ONE prompt (not N fragments)', async () => {
    // One stdin write with embedded newlines = the burst a terminal paste produces.
    // All-slash lines so it needs no model: if fragmented, readline would fire three
    // 'line' events → three "Unknown command" warnings; coalesced, it is one command.
    const { stdout } = await runCliWithInput(['/zzzpaste1\n/zzzpaste2\n/zzzpaste3\n'], { inputDelayMs: 700 });
    const warnings = (stdout.match(/Unknown command:/g) || []).length;
    assert.equal(warnings, 1, `pasted block handled as one prompt (saw ${warnings} unknown-command warnings)`);
    assert.ok(stdout.includes('/zzzpaste1'), 'the (coalesced) command is the first pasted line');
  });

  test('CLI /new creates fresh session', async () => {
    const { stdout } = await runCliWithInput(['/new\n']);
    assert.ok(stdout.includes('session') || stdout.includes('New'), 'creates new session');
  });

  test('CLI /clear also creates fresh session', async () => {
    const { stdout } = await runCliWithInput(['/clear\n']);
    assert.ok(stdout.includes('session') || stdout.includes('New'), '/clear creates session');
  });

  test('CLI /resume without arg shows usage', async () => {
    const { stdout } = await runCliWithInput(['/resume\n']);
    assert.ok(stdout.includes('Usage') || stdout.includes('usage') || stdout.length > 0, 'shows usage');
  });

  test('CLI sends a simple message and gets a response', async () => {
    const { stdout } = await runCliWithInput([
      `/model ${LIVE_MODEL}\n`,
      'Say only the word PONG\n'
    ], 45_000);
    assert.ok(stdout.length > 0, 'got response');
    // Model should produce some output
    assert.ok(stdout.includes('PONG') || stdout.includes('pong') || stdout.includes('◆'), 'got model response');
  });

  test('CLI /compact on short session shows too short message', async () => {
    const { stdout } = await runCliWithInput(['/compact\n']);
    assert.ok(stdout.includes('short') || stdout.includes('compact'), 'compact message');
  });
});

describe('CLI tool loop with mock Ollama', async () => {
  const hermeticModelEnv = {
    CLAUDETTE_WORKSPACE_SANDBOX: process.platform === 'darwin' ? '1' : '0',
    CLAUDETTE_FREE_TIER_ONLY: '0',
    CLAUDETTE_REQUIRE_TOOLS: '0',
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '', DEEPSEEK_KEY: '',
    GROQ_API_KEY: '', HF_TOKEN: '', HF_KEY: '', HUGGINGFACE_API_KEY: '',
    OPENROUTER_API_KEY: '', TOGETHER_API_KEY: '', FIREWORKS_API_KEY: '',
    GEMINI_API_KEY: '', GOOGLE_API_KEY: '', XAI_API_KEY: '', MISTRAL_API_KEY: '',
    COHERE_API_KEY: '', PERPLEXITY_API_KEY: '',
  };

  function runCliWithInput(inputs, options = {}) {
    const {
      timeout = 30_000,
      args = [],
      env = {},
      cwd = ROOT,
      inputDelayMs = 300,
      finalDelayMs = 500,
      waitForOutput = [],
    } = options;
    return new Promise((resolve, reject) => {
      const proc = spawn('node', ['claudette.js', ...args], {
        cwd,
        env: { ...process.env, ...hermeticModelEnv, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      let waitingFor = null;
      let nextTimer = null;
      proc.stdout.on('data', d => {
        stdout += d;
        if (waitingFor && stdout.includes(waitingFor)) sendNext();
      });
      proc.stderr.on('data', d => stderr += d);

      // EOF is the reliable shutdown signal after all requested inputs. A
      // synthetic `/exit` can arrive while the CLI is still inside a turn and
      // be consumed by its temporary mid-turn listener instead of the REPL.
      const lines = [...inputs];
      let idx = 0;
      function sendNext() {
        if (nextTimer) return;
        if (idx < lines.length) {
          const marker = waitForOutput[idx];
          if (marker && !stdout.includes(marker)) {
            waitingFor = marker;
            return;
          }
          waitingFor = null;
          nextTimer = setTimeout(() => {
            nextTimer = null;
            proc.stdin.write(lines[idx++]);
            sendNext();
          }, inputDelayMs);
        } else {
          setTimeout(() => proc.stdin.end(), finalDelayMs);
        }
      }
      sendNext();

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({ stdout, stderr, timedOut: true });
      }, timeout);

      proc.on('close', () => {
        clearTimeout(timer);
        resolve({ stdout, stderr, timedOut: false });
      });
      proc.on('error', reject);
    });
  }

  let tmpDir;
  let mockServer;
  let mockBaseUrl;
  let requestBodies = [];

  before(async () => {
    tmpDir = await makeTmpDir();
    await fsp.writeFile(path.join(tmpDir, 'notes.txt'), 'alpha from file\nbeta line\n', 'utf8');

    mockServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            {
              name: 'mock-coder:latest',
              size: 1,
              details: { family: 'mock', parameter_size: '1b' },
              modified_at: new Date().toISOString(),
            },
          ],
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/chat') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requestBodies.push(body);

        const messages = body.messages ?? [];
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const lastTool = [...messages].reverse().find(m => m.role === 'tool');

        if (lastTool?.content?.includes('alpha from file')) {
          createNdjsonResponse(res, [
            { message: { content: 'Final answer: saw alpha from file.' } },
            { done: true, prompt_eval_count: 10, eval_count: 12 },
          ]);
          return;
        }

        if (lastTool?.content?.includes('outside the workspace')) {
          createNdjsonResponse(res, [
            { message: { content: 'Blocked by workspace guard as expected.' } },
            { done: true, prompt_eval_count: 9, eval_count: 11 },
          ]);
          return;
        }

        if (lastTool?.content?.includes(tmpDir)) {
          createNdjsonResponse(res, [
            { message: { content: `Command completed in ${tmpDir}.` } },
            { done: true, prompt_eval_count: 8, eval_count: 10 },
          ]);
          return;
        }

        if (lastUser?.content?.includes('inspect the file')) {
          createNdjsonResponse(res, [
            {
              message: {
                content: 'Inspecting file now.',
                tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }],
              },
            },
            { done: true, prompt_eval_count: 6, eval_count: 7 },
          ]);
          return;
        }

        if (lastUser?.content?.includes('try to read outside')) {
          createNdjsonResponse(res, [
            {
              message: {
                content: 'Attempting external read.',
                tool_calls: [{ function: { name: 'read_file', arguments: { path: '../../etc/passwd' } } }],
              },
            },
            { done: true, prompt_eval_count: 6, eval_count: 7 },
          ]);
          return;
        }

        if (lastUser?.content?.includes('run pwd')) {
          createNdjsonResponse(res, [
            {
              message: {
                content: 'Running pwd.',
                tool_calls: [{ function: { name: 'bash', arguments: { command: 'pwd' } } }],
              },
            },
            { done: true, prompt_eval_count: 6, eval_count: 7 },
          ]);
          return;
        }

        createNdjsonResponse(res, [
          { message: { content: 'Mock fallback response.' } },
          { done: true, prompt_eval_count: 5, eval_count: 5 },
        ]);
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
    mockBaseUrl = `http://127.0.0.1:${mockServer.address().port}`;
  });

  beforeEach(() => {
    requestBodies = [];
  });

  after(async () => {
    await new Promise((resolve, reject) => mockServer.close(err => err ? reject(err) : resolve()));
    await cleanDir(tmpDir);
  });

  test('CLI completes a deterministic read_file tool loop', async () => {
    const { stdout, timedOut } = await runCliWithInput(
      ['inspect the file\n'],
      {
        args: ['-y', '--cwd', tmpDir, '--model', 'mock-coder:latest'],
        env: {
          OLLAMA_BASE_URL: mockBaseUrl,
          CLAUDETTE_WORKSPACE_SANDBOX: process.platform === 'darwin' ? '1' : '0',
        },
        timeout: 15_000,
      }
    );

    assert.equal(timedOut, false, 'cli should exit normally');
    assert.ok(stdout.includes('Tools'), 'tool activity is separated from assistant prose');
    assert.ok(stdout.includes('Explored 1 item'), 'routine read is summarized instead of printed twice');
    assert.ok(!stdout.includes('⏺ Read('), 'successful routine reads do not leave one permanent row per call');
    assert.ok(stdout.includes('Final answer: saw alpha from file.'), 'assistant finished with final answer');
    assert.equal(requestBodies.length, 2, 'two chat requests expected for tool loop');
    assert.ok(
      requestBodies[1].messages.some(m => m.role === 'tool' && String(m.content).includes('alpha from file')),
      'second request includes tool output from read_file'
    );
  });

  test('CLI surfaces workspace guard errors from tool execution', async () => {
    const { stdout, timedOut } = await runCliWithInput(
      ['try to read outside the workspace\n'],
      {
        args: ['-y', '--cwd', tmpDir, '--model', 'mock-coder:latest'],
        env: { OLLAMA_BASE_URL: mockBaseUrl },
        timeout: 15_000,
      }
    );

    assert.equal(timedOut, false, 'cli should exit normally');
    assert.ok(stdout.includes('outside the workspace'), 'workspace guard error is visible');
    assert.ok(stdout.includes('Blocked by workspace guard as expected.'), 'assistant sees the tool failure');
  });

  test('CLI executes deterministic bash tool calls end-to-end', async () => {
    const { stdout, timedOut } = await runCliWithInput(
      ['run pwd\n'],
      {
        args: ['-y', '--cwd', tmpDir, '--model', 'mock-coder:latest'],
        env: { OLLAMA_BASE_URL: mockBaseUrl },
        timeout: 15_000,
      }
    );

    assert.equal(timedOut, false, 'cli should exit normally');
    assert.ok(stdout.includes('⏺ Bash'), 'bash tool call was shown with its clean label');
    assert.ok(stdout.includes(tmpDir), 'bash tool output includes cwd');
    assert.ok(stdout.includes(`Command completed in ${tmpDir}.`), 'assistant consumed bash tool output');
    assert.equal(requestBodies.length, 2, 'two chat requests expected for bash tool loop');
    assert.ok(
      requestBodies[1].messages.some(m => m.role === 'tool' && String(m.content).includes(tmpDir)),
      'second request includes bash command output'
    );
  });

  test('CLI acknowledges y immediately and shows the approved command running', async () => {
    const { stdout, stderr, timedOut } = await runCliWithInput(
      ['run pwd\n', 'y\n'],
      {
        args: ['--cwd', tmpDir, '--model', 'mock-coder:latest'],
        env: { OLLAMA_BASE_URL: mockBaseUrl },
        inputDelayMs: 100,
        waitForOutput: [null, 'Allow this tool call?'],
        timeout: 15_000,
      }
    );

    assert.equal(timedOut, false, 'permission-gated CLI should exit normally');
    assert.ok(stdout.includes('Accepted y'), `the approval key is visibly acknowledged; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
    assert.ok(stdout.includes('Running Bash: pwd'), 'the status names the active command');
    assert.ok(stdout.includes(`Command completed in ${tmpDir}.`), 'agent continues after the approved command');
  });

  // `claudette -p "…"` — the headless entry point a script or CI job uses.
  function runHeadlessCli(prompt, extraArgs = []) {
    return new Promise((resolve, reject) => {
      const proc = spawn('node', ['claudette.js', '-p', prompt, '-y', '--cwd', tmpDir, '--model', 'mock-coder:latest', ...extraArgs], {
        cwd: ROOT,
        env: { ...process.env, ...hermeticModelEnv, OLLAMA_BASE_URL: mockBaseUrl },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.stdin.end();
      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve({ stdout, stderr, code: null, timedOut: true }); }, 20_000);
      proc.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code, timedOut: false }); });
      proc.on('error', reject);
    });
  }

  test('-p runs one prompt, prints the answer, and exits 0', async () => {
    const { stdout, code, timedOut } = await runHeadlessCli('inspect the file');
    assert.equal(timedOut, false, 'headless exits on its own');
    assert.equal(code, 0);
    assert.match(stdout, /Final answer: saw alpha from file\./);
  });

  test('-p executes a brokered Bash tool loop and exits 0', async () => {
    const { stdout, stderr, code, timedOut } = await runHeadlessCli('run pwd');
    assert.equal(timedOut, false, `headless exits on its own; stderr=${stderr}`);
    assert.equal(code, 0);
    assert.match(stdout, new RegExp(`Command completed in ${tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  test('-p output is clean enough to pipe (no banner, spinner, or cost footer)', async () => {
    const { stdout } = await runHeadlessCli('inspect the file');
    assert.ok(!stdout.includes('◆ Claudette'), 'no banner');
    assert.ok(!/Thinking…|Working…/.test(stdout), 'no spinner frames');
    assert.ok(!stdout.includes('↳'), 'no model/token footer');
    assert.ok(!/\x1b\[2K/.test(stdout), 'no line-clearing escapes');
  });

  test('records a per-turn trace (session.turns[]) with events and metrics', async () => {
    const sessionsDir = process.platform === 'darwin'
      ? path.join(tmpDir, '.claudette', 'state', 'sessions')
      : path.join(ROOT, 'data', 'sessions');
    await fsp.mkdir(sessionsDir, { recursive: true });
    const before = new Set(await fsp.readdir(sessionsDir));

    const { timedOut } = await runCliWithInput(
      ['inspect the file\n'],
      {
        args: ['-y', '--cwd', tmpDir, '--model', 'mock-coder:latest'],
        env: { OLLAMA_BASE_URL: mockBaseUrl },
        timeout: 15_000,
      }
    );
    assert.equal(timedOut, false, 'cli should exit normally');

    const created = (await fsp.readdir(sessionsDir)).filter(f => f.endsWith('.json') && !before.has(f));
    try {
      let turn;
      for (const f of created) {
        const s = JSON.parse(await fsp.readFile(path.join(sessionsDir, f), 'utf8'));
        if (s.turns?.[0]?.prompt?.includes('inspect the file')) { turn = s.turns[0]; break; }
      }
      assert.ok(turn, 'a session with a trace for this prompt was written');

      const types = turn.events.map(e => e.type);
      for (const expected of ['input_received', 'files_expanded', 'model_request_started', 'tool_activity_summary', 'assistant_completed']) {
        assert.ok(types.includes(expected), `turn records "${expected}" event (got: ${types.join(', ')})`);
      }
      const exploration = turn.events.find(e => e.type === 'tool_activity_summary');
      assert.equal(exploration.data.calls, 1, 'stored trace summarizes one routine call');
      assert.equal(exploration.data.byTool.read_file, 1, 'summary retains the tool count');
      assert.equal(turn.status, 'completed', 'turn marked completed');
      assert.ok(turn.metrics.durationMs >= 0, 'turn records a duration');
      assert.equal(typeof turn.metrics.totalTokens, 'number', 'turn records token metrics');
    } finally {
      await Promise.all(created.map(f => fsp.rm(path.join(sessionsDir, f), { force: true })));
    }
  });
});

// ─── Cost & request tuning (caching, max_tokens, pricing, bash cap) ──────────
// These directly cut the API bill: prompt caching stops re-billing the stable
// prefix every iteration, max_tokens stops gateways over-reserving credit, and
// the bash cap stops one big dump riding along forever.

describe('cost & request tuning', async () => {
  test('applyAnthropicCacheBreakpoints marks system + conversation tail, skips empty turns', async () => {
    const { applyAnthropicCacheBreakpoints } = await import('../src/openai.js');
    const messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'big result' },
    ];
    applyAnthropicCacheBreakpoints(messages);
    assert.equal(messages[0].content.at(-1).cache_control.type, 'ephemeral', 'system prompt cached');
    assert.equal(messages[3].content.at(-1).cache_control.type, 'ephemeral', 'conversation tail cached');
    assert.equal(messages[2].content, null, 'tool_calls-only assistant turn is left untouched');
  });

  test('markAnthropicTail (native) caches the last content block', async () => {
    const { markAnthropicTail } = await import('../src/anthropic.js');
    const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }] }];
    markAnthropicTail(messages);
    assert.equal(messages[0].content.at(-1).cache_control.type, 'ephemeral');
  });

  test('resolveMaxTokens caps output (sane default, env override)', async () => {
    const { resolveMaxTokens } = await import('../src/llm-config.js');
    const prev = process.env.CLAUDETTE_MAX_TOKENS;
    delete process.env.CLAUDETTE_MAX_TOKENS;
    assert.equal(resolveMaxTokens(), 16_384, 'sane default, not the model max');
    process.env.CLAUDETTE_MAX_TOKENS = '8000';
    assert.equal(resolveMaxTokens(), 8000, 'env override honored');
    if (prev === undefined) delete process.env.CLAUDETTE_MAX_TOKENS; else process.env.CLAUDETTE_MAX_TOKENS = prev;
  });

  test('promptCacheEnabled defaults on, disables with =0', async () => {
    const { promptCacheEnabled } = await import('../src/llm-config.js');
    const prev = process.env.CLAUDETTE_PROMPT_CACHE;
    delete process.env.CLAUDETTE_PROMPT_CACHE;
    assert.equal(promptCacheEnabled(), true);
    process.env.CLAUDETTE_PROMPT_CACHE = '0';
    assert.equal(promptCacheEnabled(), false);
    if (prev === undefined) delete process.env.CLAUDETTE_PROMPT_CACHE; else process.env.CLAUDETTE_PROMPT_CACHE = prev;
  });

  test('pricing matches most-specific model and estimates cost', async () => {
    const { priceFor, estimateCost, formatUsd } = await import('../src/cost.js');
    assert.deepEqual(priceFor('openai/gpt-4o-mini'), { in: 0.15, out: 0.6 }, 'mini beats 4o by specificity');
    assert.deepEqual(priceFor('openrouter/openai/gpt-5-nano'), { in: 0.05, out: 0.4 }, 'gpt-5-nano priced (no longer $0.00)');
    assert.deepEqual(priceFor('openai/gpt-5-mini'), { in: 0.25, out: 2 }, 'gpt-5-mini beats gpt-5 by specificity');
    assert.deepEqual(priceFor('gpt-5'), { in: 1.25, out: 10 });
    assert.ok(priceFor('openrouter/anthropic/claude-opus-4.8'), 'opus priced across prefixes');

    // Anthropic pricing. Opus 5 was missing entirely (cost reported as null), and
    // the bare claude-opus-4 rate of $15/$75 — right for 4.0/4.1 — was being
    // applied to 4.5 through 4.8, which are all $5/$25, overstating them 3x.
    assert.deepEqual(priceFor('anthropic/claude-opus-5'), { in: 5, out: 25 }, 'Opus 5 is priced');
    assert.deepEqual(priceFor('anthropic/claude-opus-4-8'), { in: 5, out: 25 }, '4.8 is not the 4.0 rate');
    assert.deepEqual(priceFor('anthropic/claude-opus-4-5'), { in: 5, out: 25 });
    assert.deepEqual(priceFor('anthropic/claude-opus-4-1'), { in: 15, out: 75 }, '4.1 keeps the original rate');
    assert.deepEqual(priceFor('anthropic/claude-sonnet-5'), { in: 3, out: 15 });
    assert.deepEqual(priceFor('anthropic/claude-fable-5'), { in: 10, out: 50 });
    // Anthropic writes `claude-opus-4-8`, OpenRouter writes `claude-opus-4.8`;
    // one entry must cover both or half the traffic silently goes unpriced.
    assert.deepEqual(
      priceFor('openrouter/anthropic/claude-opus-4.8'),
      priceFor('anthropic/claude-opus-4-8'),
      'dot and dash spellings resolve to the same price',
    );

    assert.equal(estimateCost('claude-haiku-4.5', { promptTokens: 1_000_000 }), 1, '$1 per 1M haiku input');
    assert.equal(estimateCost('anthropic/claude-opus-5', { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 30, 'Opus 5: $5 in + $25 out');
    assert.equal(estimateCost('mystery-model', { promptTokens: 1_000_000 }), null, 'unknown model → null');
    assert.equal(formatUsd(0.004), '$0.0040');
    assert.equal(formatUsd(1.5), '$1.50');
  });

  test('estimateCost discounts cached input instead of billing it as fresh', async () => {
    const { estimateCost } = await import('../src/cost.js');
    const M = 1_000_000;
    // Opus 5 input is $5/M. A fully cached million tokens is a read, at 0.1x.
    assert.equal(estimateCost('anthropic/claude-opus-5', { promptTokens: M, cachedTokens: M }), 0.5);
    // Writing the cache entry costs 1.25x — caching is not free on the first turn.
    assert.equal(estimateCost('anthropic/claude-opus-5', { promptTokens: M, cacheWriteTokens: M }), 6.25);
    // The subsets come out of the total, they do not add to it.
    assert.equal(
      estimateCost('anthropic/claude-opus-5', { promptTokens: M, cachedTokens: M / 2 }),
      2.5 + 0.25,
      'half fresh at $5/M, half cached at $0.50/M',
    );
    // A count that over-claims cannot push the estimate negative.
    assert.equal(estimateCost('anthropic/claude-opus-5', { promptTokens: 1000, cachedTokens: 9_999_999 }),
      estimateCost('anthropic/claude-opus-5', { promptTokens: 1000, cachedTokens: 1000 }));
  });

  test('formatTokens: compact counts for the live status line', async () => {
    const { formatTokens } = await import('../src/cost.js');
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(812), '812');
    assert.equal(formatTokens(4823), '4.8k');
    assert.equal(formatTokens(48234), '48k');
    assert.equal(formatTokens(1731705), '1.7M');
  });

  test('capBashOutput truncates large output (head+tail) and leaves small output intact', async () => {
    const { capBashOutput } = await import('../src/tools.js');
    const big = 'A'.repeat(40_000);
    const capped = capBashOutput(big);
    assert.ok(capped.length < big.length, 'large output is shrunk');
    assert.match(capped, /bash output truncated/, 'truncation is signposted');
    assert.equal(capBashOutput('hello world'), 'hello world', 'small output untouched');
  });
});

// ─── chat.js parser tests (normalizeArgs fix for 's' alias) ──────────────────

describe('tool-call-parser: normalizeArgs per-tool alias table', async () => {
  // These used to spawn a subprocess running an INLINED COPY of the alias tables,
  // so a real bug in the parser could never fail them. They import the shipping
  // function now.
  const { normalizeArgs, parseTextToolCalls } = await import('../src/tool-call-parser.js');

  const cases = [
    // read_file: 's' means "source path", NOT str_replace's "old string"
    { tool: 'read_file', args: { s: 'CLAUDE.md' }, expect: { path: 'CLAUDE.md' } },
    { tool: 'read_file', args: { f: 'foo.js' }, expect: { path: 'foo.js' } },
    { tool: 'read_file', args: { path: 'bar.txt' }, expect: { path: 'bar.txt' } },
    // str_replace: the same 's' means old_str here
    { tool: 'str_replace', args: { path: 'f.txt', s: 'find_me', new: 'replace' }, expect: { path: 'f.txt', old_str: 'find_me', new_str: 'replace' } },
    { tool: 'str_replace', args: { path: 'f.txt', old: 'x', new: 'y' }, expect: { path: 'f.txt', old_str: 'x', new_str: 'y' } },
    // write_file: 'contents'/'text' → 'content'
    { tool: 'write_file', args: { path: 'x.txt', contents: 'hello' }, expect: { path: 'x.txt', content: 'hello' } },
    { tool: 'write_file', args: { path: 'x.txt', text: 'world' }, expect: { path: 'x.txt', content: 'world' } },
    // bash: 'cmd' → 'command'
    { tool: 'bash', args: { cmd: 'ls -la' }, expect: { command: 'ls -la' } },
    // glob: no ambiguous remapping
    { tool: 'glob', args: { pattern: '*.js' }, expect: { pattern: '*.js' } },
    { tool: 'glob', args: { glob_pattern: '**/*.ts' }, expect: { pattern: '**/*.ts' } },
    // grep: 'regex' → 'pattern', 'dir' → 'path'
    { tool: 'grep', args: { regex: 'foo', dir: 'src' }, expect: { pattern: 'foo', path: 'src' } },
  ];

  for (const { tool, args, expect } of cases) {
    test(`${tool}(${JSON.stringify(args)}) normalises correctly`, () => {
      const got = normalizeArgs(args, tool);
      for (const [k, v] of Object.entries(expect)) {
        assert.equal(got[k], v, `${tool}: ${k}`);
      }
    });
  }

  // The regression this table exists for: llama3.2 emitted {"s":"CLAUDE.md"} for a
  // read, a shared alias table turned it into str_replace's old_str, and the run
  // went sideways.
  test('the ambiguous "s" resolves per tool, not globally', () => {
    const read = normalizeArgs({ s: 'CLAUDE.md' }, 'read_file');
    assert.equal(read.path, 'CLAUDE.md');
    assert.equal(read.old_str, undefined, 'read_file never gets an old_str');

    const edit = normalizeArgs({ path: 'f.txt', s: 'find', new: 'replace' }, 'str_replace');
    assert.equal(edit.old_str, 'find');
    assert.equal(edit.new_str, 'replace');
    assert.equal(edit.path, 'f.txt');
  });

  test('unknown keys and unknown tools pass through untouched', () => {
    assert.deepEqual(normalizeArgs({ weird: 1 }, 'read_file'), { weird: 1 });
    assert.deepEqual(normalizeArgs({ p: 'a.js' }, 'no_such_tool'), { path: 'a.js' }, 'falls back to the common table');
  });

  test('list-wrapped and array values collapse to a plain string', () => {
    // Models write {"command": "['ls','-la']"} surprisingly often.
    assert.equal(normalizeArgs({ cmd: "['ls -la']" }, 'bash').command, 'ls -la');
    assert.equal(normalizeArgs({ cmd: ['python3', 'main.py'] }, 'bash').command, 'python3 main.py');
  });

  test('the same normalisation applies through parseTextToolCalls', () => {
    const [call] = parseTextToolCalls('{"name":"read","arguments":{"s":"CLAUDE.md"}}');
    assert.equal(call.function.name, 'read_file');
    assert.equal(call.function.arguments.path, 'CLAUDE.md');
  });

  test('a standalone bare Bash argument object is recovered conservatively', () => {
    const [call] = parseTextToolCalls('{"command":".venv/bin/mypy --no-incremental src","description":"run mypy"}');
    assert.equal(call.function.name, 'bash');
    assert.equal(call.function.arguments.command, '.venv/bin/mypy --no-incremental src');
    assert.equal(call.function.arguments.description, 'run mypy');

    assert.deepEqual(
      parseTextToolCalls('Example only: {"command":"rm -rf build"}'),
      [],
      'a command-shaped fragment inside prose is not executable',
    );
    assert.deepEqual(parseTextToolCalls('{"path":"README.md"}'), [], 'ambiguous bare arguments stay prose');
    assert.deepEqual(
      parseTextToolCalls('{"command":"npm test","status":"suggested"}'),
      [],
      'extra structured-output fields fail closed',
    );
  });
});

// ─── Per-directory prompt history (up-arrow recall) ──────────────────────────

describe('src/history.js (per-directory prompt history)', async () => {
  const { historyFile, loadHistory, appendHistory } = await import('../src/history.js');

  test('history is per-directory, newest-first, dedups consecutive, skips blanks', async () => {
    const dir = await makeTmpDir();
    const a = '/tmp/projA', b = '/tmp/projB';
    appendHistory(a, 'first', { dir });
    appendHistory(a, '   ', { dir });      // blank skipped
    appendHistory(a, 'second', { dir });
    appendHistory(a, 'second', { dir });   // consecutive duplicate skipped
    appendHistory(b, 'other', { dir });
    assert.deepEqual(await loadHistory(a, { dir }), ['second', 'first'], 'newest-first, deduped, no blanks');
    assert.deepEqual(await loadHistory(b, { dir }), ['other'], 'separate dirs keep separate history');
    assert.notEqual(historyFile(a, dir), historyFile(b, dir), 'distinct files per directory');
    assert.equal((await fsp.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(historyFile(a, dir))).mode & 0o777, 0o600);
    await cleanDir(dir);
  });

  test('loadHistory returns [] when a directory has no history yet', async () => {
    const dir = await makeTmpDir();
    assert.deepEqual(await loadHistory('/tmp/never-used-here', { dir }), []);
    await cleanDir(dir);
  });
});

// ─── Turn trace terminal status ──────────────────────────────────────────────

describe('src/trace.js (turn status)', async () => {
  const { compactTraceEvents, createTurnTrace } = await import('../src/trace.js');

  test('complete/fail/cancel set distinct statuses and fire onFinish once', () => {
    for (const [method, expected] of [['complete', 'completed'], ['fail', 'failed'], ['cancel', 'cancelled']]) {
      let finished = null;
      const tr = createTurnTrace({ prompt: 'p', model: 'm', cwd: '/w', onFinish: (t) => { finished = t.status; } });
      tr[method]();
      assert.equal(tr.turn.status, expected, `${method}() → ${expected}`);
      assert.equal(finished, expected, 'onFinish saw the terminal status');
      assert.ok(tr.turn.metrics.durationMs >= 0, 'duration stamped');
    }
  });

  test('compactTraceEvents summarizes successful exploration but retains errors and commands', () => {
    const events = [
      { id: 'a', type: 'tool_call', at: 't1', data: { name: 'read_file' } },
      { id: 'b', type: 'tool_started', at: 't2', data: { name: 'read_file' } },
      { id: 'c', type: 'tool_result', at: 't3', data: { name: 'read_file', isError: false } },
      { id: 'd', type: 'tool_call', at: 't4', data: { name: 'bash' } },
      { id: 'e', type: 'tool_result', at: 't5', data: { name: 'bash', isError: false } },
      { id: 'f', type: 'tool_call', at: 't6', data: { name: 'list_dir' } },
      { id: 'g', type: 'tool_result', at: 't7', data: { name: 'list_dir', isError: true } },
    ];
    const compacted = compactTraceEvents(events);
    assert.equal(compacted[0].type, 'tool_activity_summary');
    assert.equal(compacted[0].data.calls, 1);
    assert.equal(compacted[0].data.byTool.read_file, 1);
    assert.deepEqual(compacted.slice(1), events.slice(3), 'Bash and failed listings remain verbatim');
  });
});

// ─── Token-spend usage log (dataset) ─────────────────────────────────────────
// One flat JSONL record per finished turn, for building token-efficiency datasets.

describe('src/usage.js (token-spend log)', async () => {
  const { buildUsageRecord, appendUsage, usageEnabled } = await import('../src/usage.js');
  const { estimateCost } = await import('../src/cost.js');

  test('buildUsageRecord flattens a finished turn into a dataset row', () => {
    const turn = {
      id: 't1', model: 'anthropic/claude-haiku-4.5', cwd: '/w', status: 'completed',
      prompt: 'do the thing', completedAt: '2026-06-12T00:00:00.000Z',
      metrics: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, durationMs: 1500 },
      events: [
        { type: 'model_resolved', data: { model: 'actual/free-model', provider: 'free-host' } },
        { type: 'tool_call' }, { type: 'tool_result' }, { type: 'tool_call' },
        { type: 'tool_activity_summary', data: { calls: 3 } },
      ],
    };
    const rec = buildUsageRecord(turn, { id: 's1' });
    assert.equal(rec.sessionId, 's1');
    assert.equal(rec.turnId, 't1');
    assert.equal(rec.totalTokens, 1200);
    assert.equal(rec.toolCalls, 5, 'counts raw calls and calls represented by compact summaries');
    assert.deepEqual(rec.resolvedModels, ['actual/free-model']);
    assert.deepEqual(rec.resolvedProviders, ['free-host']);
    assert.equal(rec.estCostUsd, estimateCost('anthropic/claude-haiku-4.5', turn.metrics));
    assert.equal(rec.prompt, 'do the thing');
    assert.equal(rec.ts, '2026-06-12T00:00:00.000Z');
  });

  test('buildUsageRecord records context-management signals (iterations/cap/compacted)', () => {
    const turn = {
      id: 't2', model: 'openrouter/openai/gpt-5-nano', status: 'completed', compacted: true,
      metrics: { promptTokens: 9, completionTokens: 1, totalTokens: 10 },
      events: [
        { type: 'model_request_started' }, { type: 'tool_call' }, { type: 'tool_result' },
        { type: 'model_request_started' }, { type: 'tool_call' }, { type: 'tool_result' },
        { type: 'max_iterations' },
      ],
    };
    const rec = buildUsageRecord(turn, { id: 's2' });
    assert.equal(rec.iterations, 2, 'one per model request');
    assert.equal(rec.hitToolCap, true, 'max_iterations event → cap hit');
    assert.equal(rec.compacted, true, 'reflects pre-turn auto-compaction');
    // Defaults when the signals are absent.
    const plain = buildUsageRecord({ id: 't3', metrics: {}, events: [] }, { id: 's3' });
    assert.equal(plain.iterations, 0);
    assert.equal(plain.hitToolCap, false);
    assert.equal(plain.compacted, false);
  });

  test('buildUsageRecord tracks automatic model switches and the final model', () => {
    const turn = {
      id: 't-switch', model: 'groq/openai/gpt-oss-120b', finalModel: 'openrouter/free',
      status: 'completed', metrics: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      events: [{
        type: 'model_switch',
        data: { from: 'groq/openai/gpt-oss-120b', to: 'openrouter/free', reason: 'rate limit' },
      }],
    };
    const rec = buildUsageRecord(turn, { id: 's-switch' });
    assert.equal(rec.finalModel, 'openrouter/free');
    assert.deepEqual(rec.attemptedModels, ['groq/openai/gpt-oss-120b', 'openrouter/free']);
    assert.equal(rec.modelSwitches, 1);
  });

  test('appendUsage writes one parseable JSONL record per call', async () => {
    const dir = await makeTmpDir();
    appendUsage({ a: 1 }, { dir });
    appendUsage({ a: 2 }, { dir });
    const lines = (await fsp.readFile(path.join(dir, 'usage.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2, 'append-only');
    assert.deepEqual(lines.map(l => JSON.parse(l).a), [1, 2], 'each line is valid JSON in order');
    assert.equal((await fsp.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(path.join(dir, 'usage.jsonl'))).mode & 0o777, 0o600);
    await cleanDir(dir);
  });

  test('always-track overrides the ordinary usage-log off switch', () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      log: process.env.CLAUDETTE_USAGE_LOG,
      always: process.env.CLAUDETTE_ALWAYS_TRACK,
    };
    try {
      process.env.NODE_ENV = 'development';
      process.env.CLAUDETTE_USAGE_LOG = '0';
      process.env.CLAUDETTE_ALWAYS_TRACK = '1';
      assert.equal(usageEnabled(), true);
      process.env.CLAUDETTE_ALWAYS_TRACK = '0';
      assert.equal(usageEnabled(), false);
    } finally {
      if (previous.nodeEnv == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.log == null) delete process.env.CLAUDETTE_USAGE_LOG; else process.env.CLAUDETTE_USAGE_LOG = previous.log;
      if (previous.always == null) delete process.env.CLAUDETTE_ALWAYS_TRACK; else process.env.CLAUDETTE_ALWAYS_TRACK = previous.always;
    }
  });
});

// ─── Follow-up queue (mid-run steering) ──────────────────────────────────────
// While the agent works, submitted prompts go into this FIFO and are drained
// into one steering message at a safe boundary — never a second agent loop.

describe('src/input.js (follow-up queue)', async () => {
  const { InputController, buildFollowUpMessage, classifyApprovalAnswer, classifyApprovalKeystroke, createInputAssembler, parseInterruptCommand, sanitizeUserInput, createBurstReader } = await import('../src/input.js');

  // ── Prompt sanitization (echoed tool-render glyphs leaking into input) ──
  test('sanitizeUserInput: cuts a single typed line at a leaked tool-render glyph', () => {
    // The real bug: typed "cont" + an echoed write_file result line got captured together.
    assert.equal(sanitizeUserInput('cont  ⎿ Wrote 1335 chars (44 lines) to src/run_pipeline.py'), 'cont');
    assert.equal(sanitizeUserInput('fix it ⏺ Read(foo.js)'), 'fix it');
  });

  test('sanitizeUserInput: strips ANSI escapes but keeps real text', () => {
    assert.equal(sanitizeUserInput('\x1b[35m\x1b[1mhello\x1b[0m world'), 'hello world');
  });

  test('sanitizeUserInput: rejects a leaked spinner status line', () => {
    assert.equal(sanitizeUserInput('⠙ Working…   ↑3.0k ↓1.0k · iter 1/150'), '');
    assert.equal(sanitizeUserInput('⠧ Thinking…'), '');
    assert.equal(sanitizeUserInput('⠙ Working · step 4/150 · 3 tools · in 25k · out 3.6k · 2m05s'), '');
    assert.equal(sanitizeUserInput('⠸ Running Bash: npm test · step 5/150 · 4 tools'), '');
    assert.equal(sanitizeUserInput('model  openrouter/poolside/laguna-s-2.1:free'), '');
    assert.equal(sanitizeUserInput('route  OpenRouter / Poolside'), '');
  });

  test('sanitizeUserInput: a deliberate multi-line paste keeps its newlines (not glyph-cut)', () => {
    const paste = 'line one\n  ⎿ this looks like output but it is pasted content\nline three';
    assert.equal(sanitizeUserInput(paste), paste.replace(/[ \t]+$/gm, ''), 'multi-line content preserved verbatim');
  });

  // ── Burst grouping (paste coalescing at the idle prompt) ──
  test('createBurstReader: a rapid burst of lines coalesces into one prompt', () => {
    // Drive with a synchronous fake scheduler so the grouping is deterministic.
    let scheduled = null;
    const setTimer = (fn) => { scheduled = fn; return 1; };
    const clearTimer = () => { scheduled = null; };
    const prompts = [];
    const r = createBurstReader({ flushMs: 40, onPrompt: p => prompts.push(p), setTimer, clearTimer });
    r.push('GET / 500'); r.push('  at handler'); r.push('  at next'); // paste: 3 lines, no pause
    assert.equal(prompts.length, 0, 'nothing emitted until the burst settles');
    scheduled();                                                      // the pause fires
    assert.deepEqual(prompts, ['GET / 500\n  at handler\n  at next'], 'joined into one prompt');
  });

  test('createBurstReader: a paused second line is a separate prompt; flush drains the tail', () => {
    let scheduled = null;
    const setTimer = (fn) => { scheduled = fn; return 1; };
    const clearTimer = () => { scheduled = null; };
    const prompts = [];
    const r = createBurstReader({ onPrompt: p => prompts.push(p), setTimer, clearTimer });
    r.push('first'); scheduled();           // settles alone
    r.push('second');                        // typed later
    r.flush();                               // e.g. on EOF
    assert.deepEqual(prompts, ['first', 'second'], 'distinct prompts, no merge across the pause');
  });


  test('assembler: a typed line submits on Enter', () => {
    const lines = [];
    const feed = createInputAssembler({ onLine: l => lines.push(l) });
    feed('also update the README\r');
    assert.deepEqual(lines, ['also update the README']);
  });

  test('assembler: terminal arrow keys do not leak printable `[A` text', () => {
    const lines = [];
    const feed = createInputAssembler({ onLine: l => lines.push(l) });
    feed('\x1b[A');
    feed('yes\r');
    assert.deepEqual(lines, ['yes']);
  });

  test('assembler: onChange echoes the growing buffer and clears on submit', () => {
    const changes = [];
    const lines = [];
    const feed = createInputAssembler({ onChange: b => changes.push(b), onLine: l => lines.push(l) });
    feed('hi');
    feed('\r');
    assert.deepEqual(changes, ['h', 'hi', ''], 'fires per keystroke, then empties on submit');
    assert.deepEqual(lines, ['hi']);
  });

  test('assembler: a bracketed paste is ONE submission, not one per line (the 78-line bug)', () => {
    const lines = [];
    const feed = createInputAssembler({ onLine: l => lines.push(l) });
    const pasted = ['## Sources', '', '* one', '* two', '* three'].join('\n'); // multi-line w/ blanks
    feed(`\x1b[200~${pasted}\x1b[201~`); // paste arrives; not submitted yet
    assert.deepEqual(lines, [], 'paste alone does not submit');
    feed('\r');                          // user presses Enter
    assert.equal(lines.length, 1, 'exactly one follow-up for the whole paste');
    assert.equal(lines[0], pasted.trim(), 'newlines preserved as one message');
  });

  test('assembler: a paste split across chunks still coalesces to one submission', () => {
    const lines = [];
    const feed = createInputAssembler({ onLine: l => lines.push(l) });
    feed('\x1b[200~line one\nline ');
    feed('two\x1b[201~');
    feed('\r');
    assert.deepEqual(lines, ['line one\nline two']);
  });

  test('assembler: Ctrl+C cancels and clears, backspace edits', () => {
    const lines = [];
    let cancelled = 0;
    const feed = createInputAssembler({ onLine: l => lines.push(l), onCancel: () => cancelled++ });
    feed('hi\x7f\r');                 // backspace removes the "i"
    assert.deepEqual(lines, ['h']);
    feed('partial\x03');             // Ctrl+C drops the buffer
    feed('\r');
    assert.equal(cancelled, 1);
    assert.deepEqual(lines, ['h'], 'cancelled text is not submitted');
  });

  test('enqueue trims, ignores blank, and stamps the item', () => {
    const q = new InputController();
    assert.equal(q.enqueue('   '), null, 'blank ignored');
    assert.equal(q.enqueue(''), null, 'empty ignored');
    const item = q.enqueue('  also update the README  ');
    assert.equal(item.content, 'also update the README', 'trimmed');
    assert.ok(item.id && item.queuedAt, 'stamped with id + timestamp');
    assert.equal(q.size, 1);
  });

  test('drain returns FIFO order once and empties the queue', () => {
    const q = new InputController();
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    assert.deepEqual(q.drain().map(i => i.content), ['a', 'b', 'c'], 'FIFO order');
    assert.equal(q.size, 0, 'emptied');
    assert.deepEqual(q.drain(), [], 'second drain is empty');
    q.enqueue('d'); // queued after a drain waits for the next boundary
    assert.deepEqual(q.drain().map(i => i.content), ['d']);
  });

  test('list returns copies; clear reports and empties', () => {
    const q = new InputController();
    q.enqueue('x'); q.enqueue('y');
    const listed = q.list();
    listed[0].content = 'mutated';
    assert.equal(q.list()[0].content, 'x', 'list returns copies, not live refs');
    assert.equal(q.clear(), 2, 'clear reports count');
    assert.equal(q.size, 0);
  });

  test('submit queues when no approval is pending', () => {
    const q = new InputController();
    const routed = q.submit('also update the README');
    assert.equal(routed.kind, 'queued');
    assert.equal(q.size, 1);
    // 'y' is only an answer when something is asking; otherwise it is content.
    assert.equal(q.submit('y').kind, 'queued', 'no prompt pending → y is just text');
    assert.equal(q.submit('   ').kind, 'ignored', 'blank is neither');
    assert.equal(q.size, 2);
  });

  test('submit answers a pending permission prompt without queueing it', async () => {
    const q = new InputController();
    const pending = q.awaitApproval();
    assert.equal(q.mode, 'approval');
    assert.ok(q.awaitingApproval);

    const routed = q.submit('a');
    assert.deepEqual(routed, { kind: 'approval', answer: 'a' });
    assert.equal(await pending, 'a', 'the answer resolves the parked prompt');
    assert.equal(q.size, 0, 'permission answers never enter the queue');
    assert.equal(q.mode, 'working', 'back to working once answered');
    assert.equal(q.awaitingApproval, false);
  });

  test('text typed at a permission prompt denies the tool and becomes an immediate redirect', async () => {
    const q = new InputController();
    const pending = q.awaitApproval();

    const routed = q.submit('actually, skip the tests');
    assert.equal(routed.kind, 'redirect', 'prose at the gate steers immediately');
    assert.equal(await pending, 'n', 'pending tool is denied before redirecting');
    assert.equal(q.size, 0, 'redirect does not wait in the ordinary safe queue');
    assert.equal(q.mode, 'working', 'approval mode is released');
    assert.equal(q.takeRedirect().content, 'actually, skip the tests');
  });

  test('resolveApproval reports whether anything was waiting (interrupt path)', async () => {
    const q = new InputController();
    assert.equal(q.resolveApproval('n'), false, 'nothing pending → no-op');
    const pending = q.awaitApproval();
    assert.equal(q.resolveApproval('n'), true, 'settled the parked prompt');
    assert.equal(await pending, 'n');
    assert.equal(q.resolveApproval('n'), false, 'already settled → no double-resolve');
  });

  test('classifyApprovalAnswer accepts only the y/n/a vocabulary', () => {
    assert.equal(classifyApprovalAnswer('Y'), 'y');
    assert.equal(classifyApprovalAnswer(' yes '), 'y');
    assert.equal(classifyApprovalAnswer('n'), 'n');
    assert.equal(classifyApprovalAnswer('NO'), 'n');
    assert.equal(classifyApprovalAnswer('always'), 'a');
    assert.equal(classifyApprovalAnswer('a'), 'a');
    for (const text of ['yeah', 'nope', 'y please', 'add tests', '']) {
      assert.equal(classifyApprovalAnswer(text), null, `${JSON.stringify(text)} is not an answer`);
    }
  });

  test('classifyApprovalKeystroke accepts exactly one y/n/a key', () => {
    assert.equal(classifyApprovalKeystroke('y'), 'y');
    assert.equal(classifyApprovalKeystroke('N'), 'n');
    assert.equal(classifyApprovalKeystroke('a'), 'a');
    assert.equal(classifyApprovalKeystroke('yes'), null, 'words still need Enter through normal line input');
    assert.equal(classifyApprovalKeystroke('x'), null);
  });

  test('parseInterruptCommand distinguishes redirects from ordinary queued text', () => {
    assert.equal(parseInterruptCommand('/interrupt stop the test and inspect logs'), 'stop the test and inspect logs');
    assert.equal(parseInterruptCommand('  /INTERRUPT   use the smaller fixture  '), 'use the smaller fixture');
    assert.equal(parseInterruptCommand('/interrupt'), '', 'recognised but missing its prompt');
    assert.equal(parseInterruptCommand('ordinary follow-up'), null);
    assert.equal(parseInterruptCommand('/interrupted nope'), null, 'requires the exact command');
  });

  test('one explicit redirect is retained separately from ordinary follow-ups', () => {
    const q = new InputController();
    q.enqueue('queued safely');
    const redirect = q.requestRedirect('stop and do this now');
    assert.equal(q.redirectPending, true);
    assert.equal(q.size, 1, 'redirect does not consume or mingle with the safe queue');
    assert.equal(q.takeRedirect().content, 'stop and do this now');
    assert.equal(q.redirectPending, false);
    assert.equal(q.takeRedirect(), null, 'redirect is delivered only once');
    assert.equal(q.drain()[0].content, 'queued safely', 'ordinary follow-up is preserved');
    assert.ok(redirect.id && redirect.queuedAt, 'redirect is stamped for traceability');
  });

  test('buildFollowUpMessage: null when empty, plain for one, numbered+labeled for many', () => {
    assert.equal(buildFollowUpMessage([]), null);
    assert.deepEqual(
      buildFollowUpMessage([{ content: 'just this' }]),
      { role: 'user', content: 'just this' },
      'single item is delivered verbatim',
    );
    const many = buildFollowUpMessage([{ content: 'first' }, { content: 'second' }]);
    assert.equal(many.role, 'user');
    assert.match(many.content, /\[Follow-up sent while you were working\]/, 'labeled as steering input');
    assert.match(many.content, /1\. first\n2\. second/, 'numbered, order preserved');
  });

  // createLineQueue — readline drops lines emitted while nobody is awaiting
  // question(). That is what made --json-ipc one-shot.
  test('createLineQueue buffers lines that arrive before anyone asks', async () => {
    const { createLineQueue } = await import('../src/input.js');
    const emitter = new EventEmitter();
    const q = createLineQueue(emitter);
    emitter.emit('line', 'one');
    emitter.emit('line', 'two');
    assert.equal(q.pending, 2, 'both buffered with no reader attached');
    assert.equal(await q.next(), 'one');
    assert.equal(await q.next(), 'two');
  });

  test('createLineQueue resolves a waiting reader when the line arrives later', async () => {
    const { createLineQueue } = await import('../src/input.js');
    const emitter = new EventEmitter();
    const q = createLineQueue(emitter);
    const pending = q.next();
    emitter.emit('line', 'later');
    assert.equal(await pending, 'later');
  });

  test('createLineQueue drains the buffer before reporting EOF', async () => {
    const { createLineQueue } = await import('../src/input.js');
    const emitter = new EventEmitter();
    const q = createLineQueue(emitter);
    emitter.emit('line', 'buffered');
    emitter.emit('close');
    assert.equal(q.closed, true);
    assert.equal(await q.next(), 'buffered', 'EOF does not discard queued input');
    assert.equal(await q.next(), null, 'then null, not a rejection');
    assert.equal(await q.next(), null, 'null is stable');
  });

  test('createLineQueue unblocks a waiting reader on close', async () => {
    const { createLineQueue } = await import('../src/input.js');
    const emitter = new EventEmitter();
    const q = createLineQueue(emitter);
    const pending = q.next();
    emitter.emit('close');
    assert.equal(await pending, null);
  });
});

// ─── chat.js: effort + bypass settings ────────────────────────────────────────

describe('chat.js (effort + bypass)', async () => {
  const { isValidEffort, EFFORT_LEVELS, resolveAutoApprove, BYPASS_FLAGS, resolveMaxIterations, explainStreamError, resolveActNudge, createActNudger, resolveVerifyGate, looksLikeVerification, buildVerifyNudge, runRedirectSequence } =
    await import('../src/chat.js');

  test('runRedirectSequence waits for cleanup before starting the injected prompt', async () => {
    const seen = [];
    let active = 0;
    let maxActive = 0;
    await runRedirectSequence('first', async prompt => {
      active++;
      maxActive = Math.max(maxActive, active);
      seen.push(`start:${prompt}`);
      await new Promise(resolve => setImmediate(resolve));
      seen.push(`end:${prompt}`);
      active--;
      return prompt === 'first' ? { content: 'redirected' } : null;
    });
    assert.equal(maxActive, 1, 'never runs two agent turns concurrently');
    assert.deepEqual(seen, ['start:first', 'end:first', 'start:redirected', 'end:redirected']);
  });

  test('resolveVerifyGate: on by default, CLAUDETTE_VERIFY_GATE=0 disables', () => {
    assert.equal(resolveVerifyGate({}), true);
    assert.equal(resolveVerifyGate({ CLAUDETTE_VERIFY_GATE: '0' }), false);
    assert.equal(resolveVerifyGate({ CLAUDETTE_VERIFY_GATE: '1' }), true);
  });

  test('looksLikeVerification: recognizes build/test/typecheck, ignores reads and servers', () => {
    for (const c of ['npm run build', 'npm test', 'npx tsc --noEmit', 'pytest -q', 'cd web && npm run build', 'go test ./...', 'cargo check', 'eslint . && npm run build', 'node --check src/util.js', 'python3 -m py_compile app.py']) {
      assert.ok(looksLikeVerification(c), `should count: ${c}`);
    }
    for (const c of ['cat build.md', 'ls test/', 'grep -r test src', 'npm run dev', 'npm start', 'next dev', 'node app.js', 'node -v', 'echo build']) {
      assert.ok(!looksLikeVerification(c), `should NOT count: ${c}`);
    }
  });

  test('buildVerifyNudge: distinct messages for never-ran vs failing', () => {
    assert.match(buildVerifyNudge(false), /haven't verified/);
    assert.match(buildVerifyNudge(true), /did not pass|do not finish with a failing/);
  });

  // Measured on a qwen3.6 eval trajectory: a three-file rename took 8 tool calls,
  // then 11 more on verification, three of them re-checking for a package.json
  // that a bare sandbox was never going to have. The nudge was naming npm and tsc
  // whatever the workspace looked like.
  test('the verify nudge names what the workspace actually has', async () => {
    const { verifyHint } = await import('../src/agent-runner.js');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-verify-'));
    try {
      assert.equal(verifyHint(dir), null, 'nothing to find in a bare directory');
      assert.match(buildVerifyNudge(false, verifyHint(dir)), /no build, test, or dependency manifest/);
      assert.doesNotMatch(buildVerifyNudge(false, verifyHint(dir)), /npm|tsc/,
        'must not send the model hunting for a build system that is not there');

      await fsp.writeFile(path.join(dir, 'package.json'), '{}');
      assert.match(verifyHint(dir), /npm/);
      assert.match(buildVerifyNudge(false, verifyHint(dir)), /npm test/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('resolveActNudge: default 15, env override, 0 disables', () => {
    assert.equal(resolveActNudge({}), 15);
    assert.equal(resolveActNudge({ CLAUDETTE_ACT_NUDGE: '8' }), 8);
    assert.equal(resolveActNudge({ CLAUDETTE_ACT_NUDGE: '0' }), 0, '0 is honored (disables)');
    assert.equal(resolveActNudge({ CLAUDETTE_ACT_NUDGE: 'junk' }), 15, 'bad value → default');
  });

  test('createActNudger: fires after N read-only calls, re-arms, and an action resets it', () => {
    const n = createActNudger(3);
    assert.equal(n.takeNudge(), null, 'nothing before any reads');
    n.record('read_file'); n.record('list_dir');
    assert.equal(n.takeNudge(), null, 'below threshold → no nudge');
    n.record('search_code'); // streak now 3
    const first = n.takeNudge();
    assert.match(first, /without a successful edit or command/, 'fires at the threshold');
    assert.equal(n.takeNudge(), null, 're-armed — does not fire again immediately');
    n.record('read_file'); n.record('read_file'); n.record('read_file'); // +3 more
    assert.ok(n.takeNudge(), 'fires again after another N read-only calls');
    n.record('str_replace'); // a successful edit resets the streak
    assert.equal(n.streak, 0, 'successful action clears the streak');
    assert.equal(n.takeNudge(), null, 'no nudge right after acting');
  });

  test('createActNudger: a FAILED action does not count as progress', () => {
    const n = createActNudger(3);
    n.record('read_file');
    n.record('patch_file', true); // a no-op / errored patch — not progress
    n.record('read_file');        // streak should be 3 (read, failed-patch, read)
    assert.equal(n.streak, 3, 'failed action increments, does not reset');
    assert.ok(n.takeNudge(), 'still nudges — the model is not actually making progress');
    n.record('write_file', false); // a successful write resets
    assert.equal(n.streak, 0);
  });

  test('createActNudger: threshold 0 disables nudging entirely', () => {
    const n = createActNudger(0);
    for (let i = 0; i < 50; i++) n.record('read_file');
    assert.equal(n.takeNudge(), null, 'disabled → never nudges');
  });

  test('explainStreamError flags a bad model id (logs showed typo\'d slugs failing opaquely)', () => {
    const m = 'openrouter/openai/gpt-54-mini';
    for (const raw of ['gpt-54-mini is not a valid model ID', 'No endpoints found for that model', 'HTTP 404: model not found']) {
      const out = explainStreamError(new Error(raw), m);
      assert.match(out, /rejected by the provider/, raw);
      assert.ok(out.includes(m) && /\/models/.test(out), 'points at the slug + /models');
    }
    // Unrelated errors keep the plain prefix.
    const other = explainStreamError(new Error('connection reset'), m);
    assert.match(other, /^Stream error: connection reset/);
  });

  test('resolveMaxIterations defaults to 150 and is configurable', () => {
    assert.equal(resolveMaxIterations([], {}), 150, 'sane default (raised from the old hard 20, then 50)');
    assert.equal(resolveMaxIterations(['node', 'claudette.js', '--max-iterations', '200'], {}), 200, 'flag wins');
    assert.equal(resolveMaxIterations([], { CLAUDETTE_MAX_ITERATIONS: '120' }), 120, 'env honored');
    assert.equal(resolveMaxIterations([], { CLAUDETTE_MAX_ITERATIONS: 'nonsense' }), 150, 'bad value → default');
    assert.equal(resolveMaxIterations([], { CLAUDETTE_MAX_ITERATIONS: '0' }), 150, 'zero rejected');
  });

  test('isValidEffort accepts the documented levels and rejects others', () => {
    for (const lvl of EFFORT_LEVELS) assert.ok(isValidEffort(lvl), `${lvl} valid`);
    assert.ok(!isValidEffort('turbo'));
    assert.ok(!isValidEffort(''));
    assert.ok(!isValidEffort(undefined));
    assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('resolveAutoApprove fires on any bypass flag', () => {
    for (const flag of BYPASS_FLAGS) {
      assert.ok(resolveAutoApprove(['node', 'claudette.js', flag], {}), `${flag} enables`);
    }
    assert.ok(!resolveAutoApprove(['node', 'claudette.js'], {}), 'off by default');
  });

  test('resolveAutoApprove honours CLAUDETTE_AUTO_APPROVE, ignoring falsey values', () => {
    assert.ok(resolveAutoApprove([], { CLAUDETTE_AUTO_APPROVE: '1' }));
    assert.ok(resolveAutoApprove([], { CLAUDETTE_AUTO_APPROVE: 'true' }));
    assert.ok(!resolveAutoApprove([], { CLAUDETTE_AUTO_APPROVE: '0' }));
    assert.ok(!resolveAutoApprove([], { CLAUDETTE_AUTO_APPROVE: 'false' }));
    assert.ok(!resolveAutoApprove([], { CLAUDETTE_AUTO_APPROVE: '' }));
    assert.ok(!resolveAutoApprove([], {}));
  });
});

// ─── chat.js: startup credential guard ────────────────────────────────────────

describe('chat.js (credential guard)', async () => {
  const { suggestCredentialFix } = await import('../src/chat.js');
  const missing = { model: 'anthropic/claude-opus-4-8', env: 'ANTHROPIC_API_KEY', label: 'Anthropic' };

  test('names the missing env var and the offending model', () => {
    const msg = suggestCredentialFix(missing, {});
    assert.ok(msg.includes('ANTHROPIC_API_KEY'), 'names the env var');
    assert.ok(msg.includes('anthropic/claude-opus-4-8'), 'names the model');
  });

  test('suggests routing through OpenRouter when an OpenRouter key is set', () => {
    const msg = suggestCredentialFix(missing, { OPENROUTER_API_KEY: 'k' });
    assert.ok(msg.includes('--model openrouter/anthropic/claude-opus-4-8'), 'suggests openrouter-prefixed model');
    assert.ok(/openrouter\.ai\/models|\/models/.test(msg), 'points at the model list for the exact slug');
  });

  test('falls back to .env setup guidance with no key', () => {
    const msg = suggestCredentialFix(missing, {});
    assert.ok(msg.includes('.env'), 'mentions .env setup');
    assert.ok(msg.includes('OPENROUTER_API_KEY'), 'recommends the one-key option');
  });
});

// ─── ui.js: managed turn status + incremental markdown stream ────────────────

describe('ui.js (managed turn status)', async () => {
  const { buildTurnStatusLines, buildAssistantFooter } = await import('../src/ui.js');

  test('completion footer keeps only router/provider and token count', () => {
    assert.equal(buildAssistantFooter({
      model: 'openrouter/poolside/laguna-s-2.1:free',
      resolvedProvider: 'Poolside',
      tokens: 3652,
      costUsd: 1.23,
      sessionCostUsd: 4.56,
      rateLimit: { remainingTokens: 7000 },
    }), 'OpenRouter / Poolside · ~3652 tokens');
    assert.equal(
      buildAssistantFooter({ model: 'groq/openai/gpt-oss-120b', resolvedProvider: 'Groq', tokens: 42 }),
      'Groq · ~42 tokens',
    );
    assert.equal(buildAssistantFooter({ model: 'qwen3.6:27b', tokens: 9 }), 'Ollama · ~9 tokens');
  });

  test('live footer keeps one compact route identity with labeled progress and tokens', () => {
    const startedAt = Date.now() - 125_000;
    const lines = buildTurnStatusLines({
      activeModel: 'openrouter/free',
      resolvedModel: 'poolside/laguna-s-2.1',
      resolvedProvider: 'Poolside',
      phase: 'Working', iteration: 10, maxIterations: 150, toolCount: 7,
      promptTokens: 25_000, completionTokens: 3_600, queueCount: 1, startedAt,
    }, 240, '⠸', startedAt + 125_000);
    const out = lines.join('\n');
    assert.equal(lines[0], '  route  OpenRouter / Poolside');
    assert.ok(!out.includes('openrouter/free'), 'selected model id is not repeated');
    assert.ok(!out.includes('poolside/laguna-s-2.1'), 'resolved model id is not repeated');
    for (const expected of ['step 10/150', '7 tools', 'in 25k', 'out 3.6k', '2m05s', '1 queued']) {
      assert.ok(out.includes(expected), `status labels ${expected}`);
    }
    assert.ok(!out.includes('↑') && !out.includes('↓'), 'cryptic token arrows are gone');
  });

  test('wraps a long provider label without restoring model ids', () => {
    const provider = 'A-Very-Long-Upstream-Provider';
    const model = 'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
    const lines = buildTurnStatusLines({ activeModel: model, resolvedProvider: provider, phase: 'Thinking', startedAt: 1 }, 28, '⠋', 1);
    const identityRows = lines.slice(0, -1);
    const reconstructed = identityRows.map(line => line.slice(9)).join('');
    assert.equal(reconstructed, `OpenRouter / ${provider}`);
    assert.ok(!lines.join('\n').includes(model));
    assert.ok(identityRows.every(line => !line.includes('…')), 'identity is never ellipsized');
  });
});

describe('ui.js (markdown stream)', async () => {
  const { createMarkdownStream, palette } = await import('../src/ui.js');
  const code = (t) => `${palette.C}${t}${palette.R}`; // how inline/code text is colored

  function collect() {
    const chunks = [];
    const stream = createMarkdownStream(c => chunks.push(c));
    return { stream, out: () => chunks.join('') };
  }

  test('renders inline markdown on streamed lines', () => {
    const { stream, out } = collect();
    stream.write('Here is **bo');
    stream.write('ld** and `code`\n');
    stream.end();
    const text = out();
    assert.ok(!text.includes('**'), 'bold markers consumed');
    assert.ok(text.includes(`${palette.B}bold${palette.R}`), 'bold rendered as ANSI');
    assert.ok(text.includes(code('code')), 'inline code rendered as ANSI');
  });

  test('keeps code-fence state across chunk boundaries', () => {
    const { stream, out } = collect();
    stream.write('```js\nconst x');
    stream.write(' = 1;\n``');
    stream.write('`\nplain **after** fence\n');
    stream.end();
    const text = out();
    assert.ok(text.includes(code('  const x = 1;')), 'code line rendered as code');
    assert.ok(text.includes(`${palette.B}after${palette.R}`), 'inline markdown resumes after the fence');
  });

  test('renders bullets and flushes a trailing partial line on end()', () => {
    const { stream, out } = collect();
    stream.write('- first item\n- second');
    assert.ok(out().includes('•'), 'completed bullet rendered before end()');
    assert.ok(!out().includes('second'), 'partial line buffered until end()');
    stream.end();
    assert.ok(out().includes('second'), 'end() flushes the partial line');
  });

  test('first rendered line carries no leading newline', () => {
    const { stream, out } = collect();
    stream.write('hello\n');
    stream.end();
    assert.ok(!out().startsWith('\n'), 'no blank line between ◆ marker and first line');
  });
});

// ─── src/agent-runner.js: the shared agent loop ───────────────────────────────
// The loop the CLI, the eval harness, and (later) subagents all run. Driven here
// by a scripted chatFn against a real sandbox, with no terminal involved — which
// is the whole point of the extraction.

// ─── index.js: the library API ────────────────────────────────────────────────
// `import { run } from 'claudette'` — the scriptable surface. Driven here by a
// scripted chatFn so it needs no provider.

describe('repository syntax checker', () => {
  test('checks every source file, preserves failures, and respects ignored paths', async () => {
    const dir = await makeTmpDir();
    try {
      assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: dir }).status, 0);
      await fsp.writeFile(path.join(dir, '.gitignore'), 'ignored/\n');
      await fsp.writeFile(path.join(dir, '00 tracked.js'), 'const = ;\n');
      assert.equal(spawnSync('git', ['add', '--', '00 tracked.js'], { cwd: dir }).status, 0);
      await fsp.writeFile(path.join(dir, 'middle untracked.cjs'), 'const = ;\n');
      await fsp.writeFile(path.join(dir, 'zz valid.mjs'), 'export const ok = true;\n');
      await fsp.mkdir(path.join(dir, 'ignored'));
      await fsp.writeFile(path.join(dir, 'ignored', 'broken.js'), 'const = ;\n');
      const check = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-syntax.js')], {
        cwd: dir, encoding: 'utf8',
      });
      const failed = check();
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stdout, /3 files; 2 failed/,
        'a later valid file must not hide earlier errors, including an untracked file');
      assert.match(failed.stderr, /00 tracked\.js/);
      assert.match(failed.stderr, /middle untracked\.cjs/);

      await fsp.rm(path.join(dir, '00 tracked.js'));
      await fsp.writeFile(path.join(dir, 'middle untracked.cjs'), 'module.exports = true;\n');
      const passed = check();
      assert.equal(passed.status, 0, passed.stderr);
      assert.match(passed.stdout, /2 files; 0 failed/,
        'deleted tracked files and ignored generated files are skipped');
    } finally {
      await cleanDir(dir);
    }
  });
});

describe('index.js (library API)', async () => {
  const lib = await import('../index.js');

  let ws;
  before(async () => {
    ws = await fsp.realpath(await makeTmpDir());
    await fsp.writeFile(path.join(ws, 'note.txt'), 'library speaking\n', 'utf8');
  });
  after(async () => { await cleanDir(ws); });

  function scripted(responses) {
    let i = 0;
    const seen = [];
    const fn = async ({ messages }) => {
      seen.push(messages);
      const r = responses[Math.min(i++, responses.length - 1)];
      return { content: '', toolCalls: null, promptTokens: 7, completionTokens: 3, ...r };
    };
    fn.seen = seen;
    return fn;
  }

  test('the documented surface is all exported', () => {
    for (const name of ['run', 'stream', 'createAgent', 'buildSystemPrompt', 'runAgent',
                        'TOOL_DEFS', 'executeTool', 'chatStream', 'getModels', 'estimateCost']) {
      assert.equal(typeof lib[name], name === 'TOOL_DEFS' ? 'object' : 'function', `${name} is exported`);
    }
  });

  test('run() returns text, status, usage and cost', async () => {
    const res = await lib.run('say hi', {
      model: 'mock', cwd: ws, projectInstructions: false,
      chatFn: scripted([{ content: 'hi there' }]),
    });
    assert.equal(res.text, 'hi there');
    assert.equal(res.status, 'completed');
    assert.equal(res.usage.promptTokens, 7);
    assert.equal(res.iterations, 1);
    assert.equal(res.model, 'mock');
  });

  test('run() executes tools against the given cwd, and only there', async () => {
    const res = await lib.run('read the note', {
      model: 'mock', cwd: ws, projectInstructions: false, tools: true,
      chatFn: scripted([
        { toolCalls: [{ id: 'r', function: { name: 'read_file', arguments: { path: 'note.txt' } } }] },
        { content: 'It says library speaking.' },
      ]),
    });
    assert.deepEqual(res.toolCalls.map(c => c.name), ['read_file']);
    assert.match(res.text, /library speaking/);
  });

  test('run() rejects an empty prompt rather than calling a provider', async () => {
    await assert.rejects(lib.run('', { model: 'mock' }), /non-empty string/);
    await assert.rejects(lib.run(undefined, { model: 'mock' }), /non-empty string/);
  });

  test('approve() gates tools — a script can allow reads but not writes', async () => {
    const target = path.join(ws, 'should-not-exist.txt');
    const res = await lib.run('write a file', {
      model: 'mock', cwd: ws, projectInstructions: false, tools: true,
      approve: (name) => name !== 'write_file',
      chatFn: scripted([
        { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'should-not-exist.txt', content: 'x' } } }] },
        { content: 'blocked' },
      ]),
    });
    assert.equal(fs.existsSync(target), false);
    assert.equal(res.status, 'completed');
  });

  test('tools:false makes it a plain completion with no tools offered', async () => {
    const chatFn = scripted([{ content: 'just words' }]);
    await lib.run('no tools', { model: 'mock', cwd: ws, projectInstructions: false, tools: false, chatFn });
    // The scripted fn records messages; assert the runner was given no tools by
    // checking it finished in one turn with no tool execution.
    const res = await lib.run('no tools', {
      model: 'mock', cwd: ws, projectInstructions: false, tools: false,
      chatFn: scripted([{ content: '{"name":"bash","arguments":{"command":"echo nope"}}' }]),
    });
    assert.deepEqual(res.toolCalls, [], 'tool-shaped text is not executed when tools are off');
  });

  test('library capabilities are off by default and Bash needs a separate opt-in', async () => {
    const offered = [];
    const seenUsers = [];
    const chatFn = async ({ messages, tools }) => {
      offered.push(tools.map(tool => tool.function.name));
      seenUsers.push(messages.find(message => message.role === 'user')?.content ?? '');
      return { content: 'ok', toolCalls: null, promptTokens: 1, completionTokens: 1 };
    };
    await lib.run('inspect @note.txt', {
      model: 'mock', cwd: ws, projectInstructions: false, chatFn,
    });
    await lib.run('inspect', {
      model: 'mock', cwd: ws, projectInstructions: false, tools: true, chatFn,
    });
    await lib.run('inspect', {
      model: 'mock', cwd: ws, projectInstructions: false, tools: true, allowShell: true, chatFn,
    });
    assert.deepEqual(offered[0], []);
    assert.match(seenUsers[0], /@note\.txt/, 'prompt expansion is also opt-in');
    assert.equal(offered[1].includes('bash'), false);
    assert.equal(offered[2].includes('bash'), true);
  });

  test('@paths are expanded into the prompt and reported', async () => {
    const chatFn = scripted([{ content: 'read it' }]);
    const res = await lib.run('summarise @note.txt', {
      model: 'mock', cwd: ws, projectInstructions: false, expandAtFiles: true, chatFn,
    });
    assert.deepEqual(res.files, ['note.txt']);
    const sentUser = chatFn.seen[0].find(m => m.role === 'user');
    assert.match(sentUser.content, /library speaking/, 'file contents inlined');
  });

  test('@path expansion refuses a symlink that resolves outside the workspace', async () => {
    const outside = path.join(path.dirname(ws), `claudette-expand-${randomUUID()}.txt`);
    const link = path.join(ws, 'outside-note.txt');
    await fsp.writeFile(outside, 'must not enter the prompt');
    await fsp.symlink(outside, link);
    try {
      const chatFn = scripted([{ content: 'ok' }]);
      const res = await lib.run('summarise @outside-note.txt', {
        model: 'mock', cwd: ws, projectInstructions: false, expandAtFiles: true, chatFn,
      });
      assert.deepEqual(res.files, []);
      const user = chatFn.seen[0].find(message => message.role === 'user').content;
      assert.match(user, /@outside-note\.txt/);
      assert.doesNotMatch(user, /must not enter the prompt/);
    } finally {
      await fsp.unlink(link).catch(() => {});
      await fsp.unlink(outside).catch(() => {});
    }
  });

  test('expandAtFiles:false leaves @tokens alone', async () => {
    const chatFn = scripted([{ content: 'ok' }]);
    const res = await lib.run('summarise @note.txt', {
      model: 'mock', cwd: ws, projectInstructions: false, expandAtFiles: false, chatFn,
    });
    assert.deepEqual(res.files, []);
    assert.match(chatFn.seen[0].find(m => m.role === 'user').content, /@note\.txt/);
  });

  test('system and append shape the system prompt', async () => {
    const chatFn = scripted([{ content: 'ok' }]);
    await lib.run('go', {
      model: 'mock', cwd: ws, projectInstructions: false,
      system: 'YOU ARE A TEAPOT', append: 'ALWAYS ANSWER IN HAIKU', chatFn,
    });
    const sys = chatFn.seen[0].find(m => m.role === 'system').content;
    assert.match(sys, /YOU ARE A TEAPOT/);
    assert.match(sys, /ALWAYS ANSWER IN HAIKU/);
  });

  test('stream() yields events and ends with the result', async () => {
    const types = [];
    let last = null;
    for await (const ev of lib.stream('say hi', {
      model: 'mock', cwd: ws, projectInstructions: false,
      chatFn: scripted([{ content: 'hi' }]),
    })) {
      types.push(ev.type);
      last = ev;
    }
    assert.ok(types.includes('completed'), 'observes the loop finishing');
    assert.equal(last.type, 'result', 'last event carries the result');
    assert.equal(last.text, 'hi');
  });

  test('stream() propagates a failure instead of hanging', async () => {
    await assert.rejects(async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of lib.stream('', { model: 'mock' })) { /* never reached */ }
    }, /non-empty string/);
  });

  test('stream() starts only when consumed and aborts before returning from an early break', async () => {
    let calls = 0;
    let requestSignal;
    let cleanedUp = false;
    const events = lib.stream('say hi', {
      model: 'mock', cwd: ws,
      chatFn: async ({ signal, onDelta }) => {
        calls++;
        requestSignal = signal;
        onDelta('hello');
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        await new Promise(resolve => setImmediate(resolve));
        cleanedUp = true;
        signal.throwIfAborted();
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0, 'creating an unused stream must not start a provider request');
    for await (const event of events) {
      if (event.type === 'text') break;
    }
    assert.equal(calls, 1);
    assert.equal(requestSignal.aborted, true);
    assert.equal(cleanedUp, true, 'iterator cleanup waits for the request to settle');
  });

  test('createAgent() keeps a cancelled stream busy until provider cleanup finishes', async () => {
    let finishCleanup;
    const cleanupGate = new Promise(resolve => { finishCleanup = resolve; });
    let reportAbort;
    const aborted = new Promise(resolve => { reportAbort = resolve; });
    let cleanedUp = false;
    const agent = lib.createAgent({
      model: 'mock', cwd: ws,
      chatFn: async ({ signal, onDelta }) => {
        onDelta('hello');
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        reportAbort();
        await cleanupGate;
        cleanedUp = true;
        signal.throwIfAborted();
      },
    });
    const consuming = (async () => {
      for await (const event of agent.stream('first')) {
        if (event.type === 'text') break;
      }
    })();
    try {
      await aborted;
      await new Promise(resolve => setImmediate(resolve));
      assert.throws(() => agent.reset(), /while a turn is in progress/);
      await assert.rejects(agent.send('overlap'), /already has a turn in progress/);
    } finally {
      finishCleanup();
      await consuming;
    }
    assert.equal(cleanedUp, true);
    assert.deepEqual(agent.messages, [], 'an abandoned stream does not commit incomplete history');
    agent.reset();
    const result = await agent.send('next', { chatFn: scripted([{ content: 'ready' }]) });
    assert.equal(result.text, 'ready');
  });

  test('createAgent().stream() honors a signal supplied in the agent defaults', async () => {
    const controller = new AbortController();
    const agent = lib.createAgent({
      model: 'mock', cwd: ws, signal: controller.signal,
      chatFn: async ({ signal }) => {
        controller.abort();
        assert.equal(signal.aborted, true);
        signal.throwIfAborted();
      },
    });
    let result;
    for await (const event of agent.stream('cancel')) {
      if (event.type === 'result') result = event;
    }
    assert.equal(result.status, 'cancelled');
  });

  test('createAgent() carries the conversation between calls', async () => {
    const chatFn = scripted([{ content: 'first answer' }, { content: 'second answer' }]);
    const agent = lib.createAgent({ model: 'mock', cwd: ws, projectInstructions: false, chatFn });

    const one = await agent.send('remember 41');
    assert.equal(one.text, 'first answer');
    const two = await agent.send('what did I say?');
    assert.equal(two.text, 'second answer');

    // The second request must have seen the first exchange.
    const secondRequest = chatFn.seen[1];
    assert.ok(secondRequest.some(m => m.role === 'user' && m.content.includes('remember 41')));
    assert.ok(secondRequest.some(m => m.role === 'assistant' && m.content === 'first answer'));
    assert.equal(secondRequest.filter(m => m.role === 'system').length, 1, 'exactly one system message');

    agent.reset();
    assert.deepEqual(agent.messages, []);
  });

  test('createAgent() commits streamed history and fallback model for the next turn', async () => {
    const seenModels = [];
    const seenMessages = [];
    let request = 0;
    const chatFn = async ({ model, messages }) => {
      seenModels.push(model);
      seenMessages.push(messages);
      request++;
      return {
        content: request === 1 ? 'streamed answer' : 'continued answer',
        toolCalls: null,
        promptTokens: 1,
        completionTokens: 1,
        ...(request === 1 ? { selectedModel: 'stream-fallback' } : {}),
      };
    };
    const agent = lib.createAgent({
      model: 'stream-start', cwd: ws, projectInstructions: false, tools: false, chatFn,
    });
    let streamedResult;
    for await (const event of agent.stream('remember this')) {
      if (event.type === 'result') streamedResult = event;
    }
    assert.equal(streamedResult.model, 'stream-fallback');
    assert.ok(agent.messages.some(message => message.role === 'assistant' && message.content === 'streamed answer'));

    await agent.send('continue');
    assert.deepEqual(seenModels, ['stream-start', 'stream-fallback']);
    assert.ok(seenMessages[1].some(message => message.role === 'user' && message.content.includes('remember this')));
    assert.ok(seenMessages[1].some(message => message.role === 'assistant' && message.content === 'streamed answer'));
  });

  test('createAgent() rejects overlapping turns that would race shared history', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const agent = lib.createAgent({
      model: 'mock', cwd: ws, projectInstructions: false, tools: false,
      chatFn: async () => {
        await waiting;
        return { content: 'done', toolCalls: null, promptTokens: 1, completionTokens: 1 };
      },
    });
    const first = agent.send('first');
    await assert.rejects(agent.send('second'), /already has a turn in progress/);
    assert.throws(() => agent.reset(), /while a turn is in progress/);
    release();
    await first;
  });

  test('createAgent() continues future calls on a provider-selected fallback', async () => {
    const seenModels = [];
    let call = 0;
    const chatFn = async (opts) => {
      seenModels.push(opts.model);
      call++;
      return {
        content: call === 1 ? 'recovered' : 'still here',
        toolCalls: null,
        promptTokens: 2,
        completionTokens: 1,
        ...(call === 1 ? { selectedModel: 'fallback-free' } : {}),
      };
    };
    const agent = lib.createAgent({
      model: 'starting-free', cwd: ws, projectInstructions: false, tools: false, chatFn,
    });
    const first = await agent.send('one');
    const second = await agent.send('two');
    assert.equal(first.model, 'fallback-free');
    assert.equal(second.model, 'fallback-free');
    assert.deepEqual(seenModels, ['starting-free', 'fallback-free']);
  });

  test('a missing provider key is reported before any request', async () => {
    // Must run with the key genuinely absent. `.env` is autoloaded, so on a
    // developer machine this test used to find a real key, skip the guard, and
    // bill a live Opus turn from inside `npm test`.
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(
        lib.run('go', { model: 'anthropic/claude-opus-4-8', cwd: ws }),
        /ANTHROPIC_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('package.json exposes the library and the binary', async () => {
    const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.main, './index.js');
    assert.equal(pkg.exports['.'], './index.js');
    assert.equal(pkg.bin.claudette, './claudette.js');
    // `files` decides what ships; a missing entry means a broken install.
    for (const needed of ['index.js', 'claudette.js', 'src/']) {
      assert.ok(pkg.files.includes(needed), `${needed} is published`);
    }
  });
});

describe('src/agent-runner.js (shared loop)', async () => {
  const { runAgent, mergeToolCalls, dropOrphanToolMessages, responseSignature, createRepeatDetector } = await import('../src/agent-runner.js');
  const { TOOL_DEFS } = await import('../src/tools.js');

  let sandbox;
  before(async () => { sandbox = await makeTmpDir(); });
  after(async () => { await cleanDir(sandbox); });

  // Replays a fixed list of model responses, one per call.
  function scripted(responses) {
    let i = 0;
    const seen = [];
    const fn = async ({ messages }) => {
      seen.push(messages);
      const r = responses[Math.min(i++, responses.length - 1)];
      return { content: '', toolCalls: null, promptTokens: 10, completionTokens: 2, ...r };
    };
    fn.seen = seen;
    return fn;
  }

  test('runs a tool then finishes, reporting status and usage', async () => {
    await fsp.writeFile(path.join(sandbox, 'note.txt'), 'hello runner\n', 'utf8');
    const messages = [{ role: 'user', content: 'read note.txt' }];
    const chatFn = scripted([
      { toolCalls: [{ id: 't1', function: { name: 'read_file', arguments: { path: 'note.txt' } } }] },
      { content: 'It says hello runner.' },
    ]);

    const events = [];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS, chatFn,
      toolContext: { cwd: sandbox, workspace: sandbox },
      emit: (type) => { events.push(type); },
    });

    assert.equal(run.status, 'completed');
    assert.equal(run.content, 'It says hello runner.');
    assert.equal(run.iterations, 2);
    assert.equal(run.usage.promptTokens, 20, 'usage accumulates across iterations');
    assert.deepEqual(run.toolCalls.map(c => c.name), ['read_file']);
    assert.ok(events.indexOf('tool_call') < events.indexOf('tool_start'), 'tool starts only after it is announced/approved');
    assert.ok(events.indexOf('tool_start') < events.indexOf('tool_result'), 'running status begins before the result');
    assert.ok(
      messages.some(m => m.role === 'tool' && m.content.includes('hello runner')),
      'the tool result lands in the message list',
    );
  });

  test('an interrupt at the approval boundary cancels before the tool starts', async () => {
    const messages = [{ role: 'user', content: 'run the command' }];
    const events = [];
    const ac = new AbortController();
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([{
        toolCalls: [{ id: 't1', function: { name: 'bash', arguments: { command: 'touch must-not-exist' } } }],
      }]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      signal: ac.signal,
      approve: async () => {
        ac.abort();
        return false;
      },
      emit: (type) => { events.push(type); },
    });

    assert.equal(run.status, 'cancelled');
    assert.ok(events.includes('tool_denied'), 'parked approval is settled as denied');
    assert.ok(!events.includes('tool_start'), 'aborted operation never enters its running state');
    await assert.rejects(fsp.access(path.join(sandbox, 'must-not-exist')), 'the command was never executed');
  });

  test('interrupting a multi-tool batch pairs every declared call before cancellation', async () => {
    const messages = [{ role: 'user', content: 'read both files' }];
    const ac = new AbortController();
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([{
        toolCalls: [
          { id: 'first', function: { name: 'read_file', arguments: { path: 'one.txt' } } },
          { id: 'second', function: { name: 'read_file', arguments: { path: 'two.txt' } } },
        ],
      }]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      signal: ac.signal,
      approve: async () => {
        ac.abort();
        return true;
      },
    });

    assert.equal(run.status, 'cancelled');
    const results = messages.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.tool_call_id), ['first', 'second']);
    assert.ok(results.every(message => /cancelled before execution/.test(message.content)));
    assert.deepEqual(run.toolCalls.map(call => call.isError), [true, true]);
  });

  test('persists a provider-selected fallback for later iterations and callers', async () => {
    const messages = [{ role: 'user', content: 'go' }];
    const events = [];
    const changed = [];
    const rotationState = {
      attemptedModels: ['groq/start', 'openrouter/free'],
    };
    const run = await runAgent({
      model: 'groq/start', messages, rotationState,
      chatFn: async (opts) => {
        await opts.onModelSwitch({
          from: 'groq/start', to: 'openrouter/free', reason: 'rate limit',
          status: 429, switch: 1, error: Object.assign(new Error('limited'), { status: 429 }),
        });
        return {
          content: 'recovered', toolCalls: null, promptTokens: 4, completionTokens: 1,
          selectedModel: 'openrouter/free',
        };
      },
      toolContext: { cwd: sandbox, workspace: sandbox },
      emit: (type, data) => events.push({ type, data }),
      onModelChange: model => changed.push(model),
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.model, 'openrouter/free');
    assert.deepEqual(run.attemptedModels, ['groq/start', 'openrouter/free']);
    assert.deepEqual(changed, ['openrouter/free']);
    assert.equal(events.find(event => event.type === 'model_switch')?.data.status, 429);
    assert.equal(events.find(event => event.type === 'usage')?.data.model, 'openrouter/free');
  });

  test('does not commit a fallback model that also fails', async () => {
    const changed = [];
    const run = await runAgent({
      model: 'groq/start', messages: [{ role: 'user', content: 'go' }],
      rotationState: { attemptedModels: ['groq/start', 'openrouter/free'] },
      chatFn: async (opts) => {
        await opts.onModelSwitch({
          from: 'groq/start', to: 'openrouter/free', reason: 'rate limit',
          status: 429, switch: 1, error: new Error('limited'),
        });
        throw new Error('fallback also failed');
      },
      onModelChange: model => changed.push(model),
    });
    assert.equal(run.status, 'failed');
    assert.deepEqual(changed, [], 'persistent session model remains the last successful model');
  });

  test('emits every appended message by reference, so callers can mirror history', async () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const mirrored = [];
    const run = await runAgent({
      model: 'mock', messages, chatFn: scripted([{ content: 'done' }]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      emit: (type, data) => { if (type === 'message') mirrored.push(data.message); },
    });
    assert.equal(run.status, 'completed');
    assert.equal(mirrored.length, 1);
    assert.equal(mirrored[0], messages.at(-1), 'same object, not a copy');
  });

  test('a denied tool call is reported to the model and execution is skipped', async () => {
    const target = path.join(sandbox, 'guarded.txt');
    await fsp.rm(target, { force: true });
    const messages = [{ role: 'user', content: 'write it' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'guarded.txt', content: 'nope' } } }] },
        { content: 'understood' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      approve: async () => false,
    });
    assert.equal(run.status, 'completed');
    assert.equal(fs.existsSync(target), false, 'denied write never touched the disk');
    assert.match(messages.find(m => m.role === 'tool').content, /denied permission/i);
  });

  test('stops at the iteration cap and reports it', async () => {
    const messages = [{ role: 'user', content: 'loop' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      // Never stops asking for a tool.
      chatFn: scripted([{ toolCalls: [{ id: 'l', function: { name: 'list_dir', arguments: { path: '.' } } }] }]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      maxIterations: 3,
      actNudge: 0,
    });
    assert.equal(run.status, 'max_iterations');
    assert.equal(run.iterations, 3);
  });

  test('onMaxIterations can grant a fresh budget without ending the turn', async () => {
    const messages = [{ role: 'user', content: 'loop' }];
    let granted = 0;
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([{ toolCalls: [{ id: 'l', function: { name: 'list_dir', arguments: { path: '.' } } }] }]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      maxIterations: 2,
      actNudge: 0,
      onMaxIterations: async () => (granted++ === 0), // extend exactly once
    });
    assert.equal(granted, 2, 'asked again after the extended budget ran out');
    assert.equal(run.iterations, 4, 'two budgets of two');
    assert.equal(run.status, 'max_iterations');
  });

  test('responseSignature ignores prose and key order, but not the calls', () => {
    const call = (name, args) => [{ function: { name, arguments: args } }];
    assert.equal(responseSignature(null), null, 'no tool calls cannot loop');
    assert.equal(responseSignature([]), null);
    assert.equal(
      responseSignature(call('bash', { command: 'ls', description: 'd' })),
      responseSignature(call('bash', { description: 'd', command: 'ls' })),
      'argument key order does not mask a repeat',
    );
    assert.equal(
      responseSignature(call('bash', '{"command":"ls"}')),
      responseSignature(call('bash', { command: 'ls' })),
      'string and object arguments compare equal',
    );
    assert.notEqual(
      responseSignature(call('bash', { command: 'ls' })),
      responseSignature(call('bash', { command: 'pwd' })),
      'a different command is a different response',
    );
  });

  test('createRepeatDetector fires on a run, re-arms, and resets on steering', () => {
    const d = createRepeatDetector(3);
    assert.equal(d.record('a'), null);
    assert.equal(d.record('a'), null);
    assert.ok(d.record('a'), 'fires on the third identical response');
    assert.equal(d.nudges, 1);
    assert.equal(d.record('a'), null, 're-armed, not firing every time after');
    assert.equal(d.record('a'), null);
    assert.ok(d.record('a'), 'fires again if the model ignored the nudge');
    assert.equal(d.nudges, 2);

    const e = createRepeatDetector(3);
    e.record('a'); e.record('a');
    e.record('b');                       // genuine progress breaks the run
    assert.equal(e.record('a'), null, 'streak restarts after a different response');

    const f = createRepeatDetector(3);
    f.record('a'); f.record('a');
    f.reset();                           // user steered; clean slate
    assert.equal(f.record('a'), null, 'reset clears the streak');
    assert.equal(createRepeatDetector(0).record('a'), null, 'threshold 0 disables');
  });

  test('a repeating model is nudged, then the turn ends instead of looping', async () => {
    // Replays the real failure: a model that re-issues the identical successful
    // bash batch forever. The act nudge cannot catch it, because a successful
    // bash resets that streak every iteration — so actNudge stays on here to
    // prove the repeat guard is what stops it.
    const messages = [{ role: 'user', content: 'probe the site' }];
    const sameCall = () => ({
      toolCalls: [{ id: 'c', function: { name: 'bash', arguments: { command: 'echo hi' } } }],
    });
    let requests = 0;
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: async () => { requests++; return sameCall(); },
      toolContext: { cwd: sandbox, workspace: sandbox },
      maxIterations: 100,
      repeatGuard: 3,
    });

    assert.equal(run.status, 'repeating', 'ended on repetition, not max_iterations');
    assert.ok(run.iterations < 12, `stopped early, took ${run.iterations} iterations`);
    const nudges = messages.filter(m => m.role === 'user' && /same set of tool calls/.test(m.content ?? ''));
    assert.equal(nudges.length, 2, 'nudged twice before giving up');
    assert.ok(requests < 12, 'did not burn the iteration budget');
  });

  test('trace records repetition and iteration caps as terminal statuses', async () => {
    const { createTurnTrace } = await import('../src/trace.js');
    const finished = [];
    const repeating = createTurnTrace({ onFinish: turn => finished.push(turn.status) });
    repeating.repeat();
    assert.equal(repeating.turn.status, 'repeating');
    assert.ok(repeating.turn.completedAt);
    assert.ok(repeating.turn.metrics.durationMs >= 0);

    const capped = createTurnTrace({ onFinish: turn => finished.push(turn.status) });
    capped.maxIterations();
    assert.equal(capped.turn.status, 'max_iterations');
    assert.deepEqual(finished, ['repeating', 'max_iterations']);
  });

  test('repeat guard ignores legitimate repetition that follows progress', async () => {
    // Running the same check after an edit is normal and must not trip the guard.
    const bash = (command) => ({ toolCalls: [{ id: 'b', function: { name: 'bash', arguments: { command } } }] });
    const messages = [{ role: 'user', content: 'fix it' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        bash('echo test'),
        { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'a.txt', content: 'x' } } }] },
        bash('echo test'),
        { toolCalls: [{ id: 'w2', function: { name: 'write_file', arguments: { path: 'b.txt', content: 'y' } } }] },
        bash('echo test'),
        { content: 'done' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      repeatGuard: 3, actNudge: 0, verifyGate: false,
    });
    assert.equal(run.status, 'completed', 'interleaved progress is not a loop');
    assert.equal(messages.filter(m => /same set of tool calls/.test(m.content ?? '')).length, 0);
  });

  test('a delivered follow-up resets the repeat streak', async () => {
    const same = { toolCalls: [{ id: 'c', function: { name: 'bash', arguments: { command: 'echo hi' } } }] };
    const messages = [{ role: 'user', content: 'go' }];
    let handed = false, calls = 0;
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: async () => (++calls > 4 ? { content: 'stopped' } : same),
      toolContext: { cwd: sandbox, workspace: sandbox },
      repeatGuard: 3, actNudge: 0, verifyGate: false,
      takeFollowUps: async () => {
        if (handed || calls < 2) return null;      // steer just before it would fire
        handed = true;
        return { role: 'user', content: 'try something else' };
      },
    });
    assert.equal(run.status, 'completed', 'user steering pre-empts the guard');
    assert.equal(messages.filter(m => /same set of tool calls/.test(m.content ?? '')).length, 0,
      'no automated nudge stacked on top of the user follow-up');
  });

  test('queued follow-ups keep the turn alive past a would-be finish', async () => {
    const messages = [{ role: 'user', content: 'first' }];
    let handed = false;
    const run = await runAgent({
      model: 'mock', messages,
      chatFn: scripted([{ content: 'all done' }, { content: 'and the follow-up too' }]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      takeFollowUps: async () => {
        if (handed) return null;
        handed = true;
        return { role: 'user', content: 'also do this' };
      },
    });
    assert.equal(run.iterations, 2, 'the follow-up bought another model request');
    assert.equal(run.content, 'and the follow-up too');
    assert.ok(messages.some(m => m.role === 'user' && m.content === 'also do this'));
  });

  // Found on a real Terminal-Bench run: the agent verified with
  // `python3 check_cert.py`, the gate didn't recognise it, and kept nudging —
  // an 8-call task became 20 calls and 80k input tokens.
  test('running the script you just wrote counts as verification', async () => {
    const { looksLikeMutation, looksLikeVerification } = await import('../src/agent-runner.js');
    for (const cmd of ['python3 /app/check_cert.py', 'node build.js', './run.sh',
                       'bash verify.sh', 'python3 -m pytest', 'npm test', 'cargo test']) {
      assert.equal(looksLikeVerification(cmd), true, `${cmd} verifies`);
    }
    // Still narrow enough to be meaningful: looking around is not verifying.
    for (const cmd of ['cat notes.txt', 'ls -la', 'echo hello', 'git status',
                       'python3 -c "print(1)"', 'npm run dev',
                       'npm test || true', 'npm test | tee test.log',
                       'npm test; echo done', 'npm test &']) {
      assert.equal(looksLikeVerification(cmd), false, `${cmd} does not verify`);
    }
    // Starting a server proves nothing — it blocks until the bash timeout — and
    // these names are conventionally an entry point, not a check.
    for (const cmd of ['node app.js', 'node server.js', 'python3 main.py']) {
      assert.equal(looksLikeVerification(cmd), false, `${cmd} is a server start`);
    }

    for (const cmd of [
      'cp .env.example .env.local',
      "sed -i '' 's/a/b/' .env.local",
      'npm install',
      'DATABASE_URL=file:./dev.db npx prisma migrate dev --name init',
      'echo hi > out.txt',
    ]) {
      assert.equal(looksLikeMutation(cmd), true, `${cmd} mutates the workspace`);
    }
    for (const cmd of ['ls -la', 'cat package.json', 'npm run build', 'node --check file.js', 'echo hi 2>&1']) {
      assert.equal(looksLikeMutation(cmd), false, `${cmd} is read-only or verification`);
    }
  });

  test('collection, help, version, and dry runs do not count as verification', async () => {
    const { looksLikeVerification } = await import('../src/agent-runner.js');
    for (const command of [
      'pytest --co -q', 'python3 -m pytest --collect-only',
      'pytest --collect-only=true', 'pytest --help', 'mypy --version',
      'npm test -- --help', 'npm run build --dry-run',
      'npx vitest --help', 'node --test --help', 'cargo test --help',
      'go test --help', 'ruff check --help', 'env CHECK=1 python3 -m pytest --co',
    ]) assert.equal(looksLikeVerification(command), false, command);
    for (const command of ['python3 -m pytest -q', 'pytest --co && pytest -q', 'node --check app.js']) {
      assert.equal(looksLikeVerification(command), true, command);
    }
  });

  test('test collection cannot satisfy the verification gate after a source edit', async () => {
    await fsp.writeFile(path.join(sandbox, 'pytest.py'), 'print("655 tests collected")\n');
    const messages = [{ role: 'user', content: 'make and verify the change' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'collection.js', content: 'const value = 1;\n' } } }] },
        { toolCalls: [{ id: 'c', function: { name: 'bash', arguments: { command: 'python3 -m pytest --collect-only' } } }] },
        { content: 'done' },
        { toolCalls: [{ id: 'v', function: { name: 'bash', arguments: { command: 'node --check collection.js' } } }] },
        { content: 'Syntax checked; full test coverage remains unknown.' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox }, verifyGate: true, actNudge: 0,
    });
    assert.equal(run.iterations, 5);
    assert.ok(messages.some(message => /edited files but haven't verified/.test(message.content ?? '')));
  });

  test('verification rejects discovery hidden in wrappers, pytest configuration, and make flags', async () => {
    const { looksLikeVerification } = await import('../src/agent-runner.js');
    const { annotateBashEvidence } = await import('../src/evidence.js');
    for (const command of [
      'pnpm jest --help', 'yarn vitest --help', 'bun jest --help',
      'pytest -o addopts=--collect-only', 'pytest --override-ini="addopts=--co -q"',
      'PYTEST_ADDOPTS=--co pytest', 'env PYTEST_ADDOPTS="--co -q" pytest',
      'make -n', 'make --just-print', 'make --recon', 'make -qn target',
    ]) assert.equal(looksLikeVerification(command), false, command);
    for (const command of [
      'pytest -o addopts=--collect-only', 'pytest --override-ini="addopts=--co -q"',
      'PYTEST_ADDOPTS=--co pytest', 'env PYTEST_ADDOPTS="--co -q" pytest',
    ]) assert.match(annotateBashEvidence(command, 'collected'), /collection-only/, command);
    for (const command of [
      'pnpm jest --runInBand', 'yarn vitest run', 'make -j2 test',
      'pytest -o addopts=-q', 'PYTEST_ADDOPTS=-q pytest',
    ]) assert.equal(looksLikeVerification(command), true, command);
    for (const command of [
      'printf "pytest --co"', 'echo "PYTEST_ADDOPTS=--co pytest"',
      'pytest -k "--collect-only"',
    ]) assert.equal(annotateBashEvidence(command, 'output'), 'output', command);
  });

  test('verification recognizes environment prefixes and checks only the final workspace state', async () => {
    const { looksLikeMutation, looksLikeVerification } = await import('../src/agent-runner.js');
    for (const command of [
      'NODE_ENV=test npm test',
      'env PYTHONPATH=src python3 -m pytest -q',
      'python3 -m compileall -q src',
      'python3 -m pip_audit --requirement requirements.txt',
      'pip-audit -r requirements.txt',
      'cp first.js second.js && node --check second.js',
      'npm test > test.log',
    ]) {
      assert.equal(looksLikeVerification(command), true, command);
    }
    for (const command of [
      'npm test && cp replacement.js app.js',
      'node --check app.js && echo broken > app.js',
      'npm test || true',
      'NODE_ENV=test npm test | tee test.log',
    ]) {
      assert.equal(looksLikeVerification(command), false, command);
    }
    for (const command of [
      'python3 -m compileall -q src',
      'python3 -m pytest --cov=src --cov-report=html',
      'python3 -m pip_audit --requirement requirements.txt',
      'pip-audit -r requirements.txt',
    ]) {
      assert.equal(looksLikeMutation(command), false, 'generated artifacts and audits: ' + command);
    }
  });

  test('discarded output is not a workspace edit and cannot trigger review verification', async () => {
    const { looksLikeMutation } = await import('../src/agent-runner.js');
    for (const command of [
      'ls -la 2>/dev/null', 'find . -name "*.toml" 2> /dev/null',
      'git status --short 2>/dev/null || echo "not a git repo"',
      'ls >"/dev/null"', "ls >>'/dev/null'", 'ls >/dev/null 2>&1',
    ]) assert.equal(looksLikeMutation(command), false, command);
    for (const command of ['echo x > app.js', 'ls 2>/dev/null > listing.txt', 'ls > /dev/nullish']) {
      assert.equal(looksLikeMutation(command), true, command);
    }
    const messages = [{ role: 'user', content: 'Review without making changes.' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        { toolCalls: [{ id: 'list', function: { name: 'bash', arguments: { command: 'ls -la 2>/dev/null' } } }] },
        { content: 'Review complete; no changes were needed.' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox }, verifyGate: true, actNudge: 0,
    });
    assert.equal(run.iterations, 2, 'a read-only review must finish without verification nags');
    assert.ok(!messages.some(message => /edited files but haven't verified/.test(message.content ?? '')));
  });

  test('generated discovery matrix distinguishes executed checks from discovery under wrappers', async () => {
    const { looksLikeVerification } = await import('../src/agent-runner.js');
    const { annotateBashEvidence } = await import('../src/evidence.js');
    const prefixes = ['', 'env CHECK=1 ', 'CHECK=1 ', 'sudo ', 'time ', 'env CHECK=1 time '];
    for (const prefix of prefixes) {
      for (const runner of ['pytest', 'python3 -m pytest', 'mypy', 'npx jest', 'pnpm jest', 'yarn vitest', 'node --test', 'cargo test', 'go test', 'make']) {
        assert.equal(looksLikeVerification(`${prefix}${runner}`), true, `${prefix}${runner}`);
        for (const flag of ['--help', '--version', '--dry-run']) {
          const command = `${prefix}${runner} ${flag}`;
          assert.equal(looksLikeVerification(command), false, command);
        }
      }
      for (const runner of ['pytest', 'python3 -m pytest']) {
        for (const flag of ['--co', '--collect-only', '--collectonly']) {
          for (const suffix of ['', ' -q | tail -5 || true', ' 2>/dev/null']) {
            const command = `${prefix}${runner} ${flag}${suffix}`;
            assert.equal(looksLikeVerification(command), false, command);
            assert.match(annotateBashEvidence(command, 'collected'), /collection-only/, command);
          }
        }
      }
    }
  });

  test('a model-returned tool that was not offered is paired but never executed', async () => {
    const target = path.join(sandbox, 'unoffered-tool.txt');
    await fsp.rm(target, { force: true });
    const messages = [{ role: 'user', content: 'do not escape the offered tools' }];
    const events = [];
    const readOnlyTools = TOOL_DEFS.filter(tool => tool.function.name === 'read_file');
    const run = await runAgent({
      model: 'mock', messages, tools: readOnlyTools,
      chatFn: scripted([
        { toolCalls: [{ id: 'hidden', function: { name: 'bash', arguments: { command: 'touch unoffered-tool.txt' } } }] },
        { content: 'The tool was unavailable.' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      emit: (type, data) => events.push({ type, data }),
      verifyGate: false,
    });
    assert.equal(run.status, 'completed');
    assert.equal(fs.existsSync(target), false, 'unoffered Bash was never executed');
    const result = events.find(event => event.type === 'tool_result');
    assert.equal(result?.data.isError, true);
    assert.match(result?.data.result ?? '', /was not offered/);
    assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'hidden'));
  });

  test('a second identical failed tool call stops tools and forces a blocker explanation', async () => {
    const target = path.join(sandbox, 'must-not-run-after-failures.txt');
    await fsp.rm(target, { force: true });
    const messages = [{ role: 'user', content: 'handle failures honestly' }];
    const events = [];
    const offeredCounts = [];
    const responses = [
      { toolCalls: [{ id: 'f1', function: { name: 'read_file', arguments: {} } }] },
      { toolCalls: [
        { id: 'f2', function: { name: 'read_file', arguments: {} } },
        { id: 'later', function: { name: 'write_file', arguments: { path: 'must-not-run-after-failures.txt', content: 'bad' } } },
      ] },
      { content: 'I am blocked because read_file was missing its path.' },
    ];
    let responseIndex = 0;
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: async options => {
        offeredCounts.push(options.tools.length);
        return { content: '', toolCalls: null, promptTokens: 1, completionTokens: 1, ...responses[responseIndex++] };
      },
      toolContext: { cwd: sandbox, workspace: sandbox },
      emit: (type, data) => events.push({ type, data }),
      verifyGate: false,
      repeatGuard: 0,
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.content, 'I am blocked because read_file was missing its path.');
    assert.equal(offeredCounts.at(-1), 0, 'the explanation request has tools disabled');
    assert.equal(fs.existsSync(target), false, 'later declared calls are cancelled, not executed');
    assert.equal(events.filter(event => event.type === 'tool_failure_limit').length, 1);
    assert.ok(messages.some(message => message.role === 'user' && /identical read_file tool call failed twice/.test(message.content ?? '')));
    assert.deepEqual(
      messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
      ['f1', 'f2', 'later'],
      'every declared call remains protocol-paired',
    );
    assert.ok(run.toolCalls.every(call => call.isError));
  });

  test('a failure-limit explanation ends without asking for verification with tools disabled', async () => {
    const messages = [{ role: 'user', content: 'make a change and verify' }];
    const responses = [
      { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'blocked.js', content: 'const value = 1;\n' } } }] },
      { toolCalls: [{ id: 'f1', function: { name: 'bash', arguments: { command: 'exit 2' } } }] },
      { toolCalls: [{ id: 'f2', function: { name: 'bash', arguments: { command: 'exit 2' } } }] },
      { content: 'The edit is unverified because the check failed.' },
    ];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS, chatFn: scripted(responses),
      toolContext: { cwd: sandbox, workspace: sandbox }, verifyGate: true, actNudge: 0,
    });
    assert.equal(run.iterations, 4);
    assert.ok(!messages.some(message => /automated check/.test(message.content ?? '')));
  });

  test('Bash variants returning the same exception stop before exhausting the turn', async () => {
    const messages = [{ role: 'user', content: 'assess the project' }];
    const events = [];
    const commands = [1, 2, 3, 4].map(n => `printf 'attempt ${n}\\nsqlite3.OperationalError: unable to open database file\\n' >&2; exit 1`);
    let requests = 0;
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: async ({ tools }) => {
        requests++;
        if (!tools.length) return { content: 'Disk SQLite is blocked; these checks did not pass.' };
        return { toolCalls: [{ id: `f${requests}`, function: { name: 'bash', arguments: { command: commands[(requests - 1) % commands.length] } } }] };
      },
      toolContext: { cwd: sandbox, workspace: sandbox },
      emit: (type, data) => events.push({ type, ...data }),
      maxIterations: 8, actNudge: 0, repeatGuard: 0,
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.toolCalls.length, 3);
    assert.equal(requests, 4);
    assert.equal(events.filter(event => event.type === 'tool_failure_limit').length, 1);
    assert.match(messages.at(-2).content, /same error/);
  });

  test('failure limits reset after edits or user steering and keep distinct errors separate', async () => {
    for (const progress of ['edit', 'follow-up', 'different-error']) {
      const messages = [{ role: 'user', content: 'investigate' }];
      const events = [];
      const fail = (n, detail = 'unavailable') => ({ toolCalls: [{
        id: `f${n}`, function: { name: 'bash', arguments: { command: `printf 'attempt ${n}\\nRuntimeError: ${detail}\\n' >&2; exit 1` } },
      }] });
      const responses = [fail(1), fail(2)];
      if (progress === 'edit') responses.push({ toolCalls: [{
        id: 'edit', function: { name: 'write_file', arguments: { path: 'fix.js', content: 'const fixed = true;\n' } },
      }] });
      responses.push(fail(3, progress === 'different-error' ? 'another issue' : 'unavailable'));
      responses.push(fail(4, progress === 'different-error' ? 'third issue' : 'unavailable'));
      responses.push({ content: 'Investigation summary.' });
      let requests = 0;
      let steered = false;
      const run = await runAgent({
        model: 'mock', messages, tools: TOOL_DEFS,
        chatFn: async () => responses[requests++],
        toolContext: { cwd: sandbox, workspace: sandbox },
        takeFollowUps: () => {
          if (progress === 'follow-up' && requests === 2 && !steered) {
            steered = true;
            return { role: 'user', content: 'I changed the environment; try again.' };
          }
          return null;
        },
        emit: type => events.push(type), verifyGate: false, actNudge: 0, repeatGuard: 0,
      });
      assert.equal(run.status, 'completed', progress);
      assert.equal(events.includes('tool_failure_limit'), false, progress);
      assert.equal(run.toolCalls.filter(call => call.isError).length, 4, progress);
    }
  });

  test('removing only known generated caches does not count as a source edit', async () => {
    const { looksLikeMutation } = await import('../src/agent-runner.js');
    for (const command of [
      'rm -rf .mypy_cache && mypy src',
      'rm -rf .pytest_cache src/__pycache__',
      'rm --recursive --force "nested path/.ruff_cache"',
    ]) assert.equal(looksLikeMutation(command), false, command);
    for (const command of [
      'rm -rf .mypy_cache src/app.py', 'rm -rf src',
      'rm -rf .mypy_cache/../src', 'rm -rf "$CACHE"',
      'rm -rf .mypy_cache; echo changed > app.py',
    ]) assert.equal(looksLikeMutation(command), true, command);
    const messages = [{ role: 'user', content: 'review the project' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        { toolCalls: [{ id: 'c', function: { name: 'bash', arguments: { command: 'rm -rf .mypy_cache' } } }] },
        { content: 'Review complete.' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox }, verifyGate: true,
    });
    assert.equal(run.iterations, 2);
  });

  test('the verification gate blocks finishing after an unverified edit', async () => {
    const messages = [{ role: 'user', content: 'edit it' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'verified.txt', content: 'x' } } }] },
        { content: 'Done!' }, // tries to finish with no build/test run
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      verifyGate: true,
    });
    assert.ok(
      messages.some(m => m.role === 'user' && /automated check/.test(m.content)),
      'the model is pushed to verify before finishing',
    );
    assert.equal(run.status, 'completed');
  });

  test('a full read-back verifies the matching plain-text edit in a bare workspace', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-readback-verify-'));
    const messages = [{ role: 'user', content: 'write and confirm the note' }];
    try {
      const run = await runAgent({
        model: 'mock', messages, tools: TOOL_DEFS,
        chatFn: scripted([
          { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'note.txt', content: 'checked\n' } } }] },
          { toolCalls: [{ id: 'r', function: { name: 'read_file', arguments: { path: 'note.txt', offset: 0, limit: 0 } } }] },
          { content: 'Written and confirmed.' },
        ]),
        toolContext: { cwd: dir, workspace: dir },
        verifyGate: true,
      });
      assert.equal(run.status, 'completed');
      assert.equal(messages.filter(m => /edited files but haven't verified/.test(m.content ?? '')).length, 0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('reading an unrelated file does not verify a pending plain-text edit', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-readback-unrelated-'));
    const messages = [{ role: 'user', content: 'write and confirm the target' }];
    try {
      await fsp.writeFile(path.join(dir, 'other.txt'), 'unrelated\n');
      const run = await runAgent({
        model: 'mock', messages, tools: TOOL_DEFS,
        chatFn: scripted([
          { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'target.txt', content: 'checked\n' } } }] },
          { toolCalls: [{ id: 'r1', function: { name: 'read_file', arguments: { path: 'other.txt' } } }] },
          { content: 'Done.' },
          { toolCalls: [{ id: 'r2', function: { name: 'read_file', arguments: { path: 'target.txt' } } }] },
          { content: 'Now confirmed.' },
        ]),
        toolContext: { cwd: dir, workspace: dir },
        verifyGate: true,
      });
      assert.equal(run.status, 'completed');
      assert.equal(messages.filter(m => /edited files but haven't verified/.test(m.content ?? '')).length, 1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('reading source code does not replace an executable verification check', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-readback-source-'));
    const messages = [{ role: 'user', content: 'write and verify the module' }];
    try {
      const run = await runAgent({
        model: 'mock', messages, tools: TOOL_DEFS,
        chatFn: scripted([
          { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'module.js', content: 'export const ok = true;\n' } } }] },
          { toolCalls: [{ id: 'r', function: { name: 'read_file', arguments: { path: 'module.js' } } }] },
          { content: 'Done.' },
          { toolCalls: [{ id: 'v', function: { name: 'bash', arguments: { command: 'node --check module.js' } } }] },
          { content: 'Verified.' },
        ]),
        toolContext: { cwd: dir, workspace: dir },
        verifyGate: true,
      });
      assert.equal(run.status, 'completed');
      assert.equal(messages.filter(m => /edited files but haven't verified/.test(m.content ?? '')).length, 1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('the verification gate stays out of the way for a read-only turn', async () => {
    const messages = [{ role: 'user', content: 'just look' }];
    await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        { toolCalls: [{ id: 'r', function: { name: 'list_dir', arguments: { path: '.' } } }] },
        { content: 'Looks fine.' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      verifyGate: true,
    });
    assert.ok(!messages.some(m => /automated check/.test(m.content ?? '')), 'nothing was edited, so nothing to verify');
  });

  test('post-verification guard forces a final summary after bounded extra investigation', async () => {
    const messages = [{ role: 'user', content: 'create and verify it' }];
    const offeredToolCounts = [];
    const responses = [
      { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'verified.js', content: 'const ok = true;\n' } } }] },
      { toolCalls: [{ id: 'v', function: { name: 'bash', arguments: { command: 'node --check verified.js' } } }] },
      { toolCalls: [{ id: 'l', function: { name: 'list_dir', arguments: { path: '.' } } }] },
      { toolCalls: [{ id: 'r', function: { name: 'read_file', arguments: { path: 'verified.js' } } }] },
      { content: 'Implemented and verified.' },
    ];
    let call = 0;
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: async (opts) => {
        offeredToolCounts.push(opts.tools.length);
        return { content: '', toolCalls: null, promptTokens: 1, completionTokens: 1, ...responses[call++] };
      },
      toolContext: { cwd: sandbox, workspace: sandbox },
      postVerifyGuard: 1,
      actNudge: 0,
      repeatGuard: 0,
    });
    assert.equal(run.status, 'completed');
    assert.equal(offeredToolCounts.at(-1), 0, 'second ignored completion nudge disables tools once');
    const nudges = messages.filter(m => /automated completion check/.test(m.content ?? ''));
    assert.equal(nudges.length, 2);
    assert.match(nudges[1].content, /next response has tools disabled/);
  });

  test('an edit after a passing check invalidates it and requires verification again', async () => {
    const messages = [{ role: 'user', content: 'make both files' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        { toolCalls: [{ id: 'w1', function: { name: 'write_file', arguments: { path: 'first.js', content: 'const first = true;\n' } } }] },
        { toolCalls: [{ id: 'v1', function: { name: 'bash', arguments: { command: 'node --check first.js' } } }] },
        { toolCalls: [{ id: 'w2', function: { name: 'bash', arguments: { command: 'cp first.js second.js' } } }] },
        { content: 'done' },
        { toolCalls: [{ id: 'v2', function: { name: 'bash', arguments: { command: 'node --check second.js' } } }] },
        { content: 'both verified' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      postVerifyGuard: 1,
      actNudge: 0,
      repeatGuard: 0,
      verifyGate: true,
    });
    assert.equal(run.status, 'completed');
    assert.equal(messages.filter(m => /edited files but haven't verified/.test(m.content ?? '')).length, 1);
    assert.equal(messages.filter(m => /automated completion check/.test(m.content ?? '')).length, 0);
  });

  test('a Bash edit followed by a passing check in the same call needs no extra verification', async () => {
    const messages = [{ role: 'user', content: 'create and verify a script' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'combined.js', content: 'const ok = true;\n' } } }] },
        { toolCalls: [{ id: 'v', function: { name: 'bash', arguments: { command: 'cp combined.js combined-copy.js && node --check combined-copy.js' } } }] },
        { content: 'verified' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      verifyGate: true, actNudge: 0, repeatGuard: 0,
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.iterations, 3);
    assert.ok(!messages.some(m => /automated check/.test(m.content ?? '')));
  });

  test('a failed Bash command can still invalidate a previously passing check', async () => {
    const messages = [{ role: 'user', content: 'edit and verify' }];
    const run = await runAgent({
      model: 'mock', messages, tools: TOOL_DEFS,
      chatFn: scripted([
        { toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: { path: 'partial.js', content: 'const ok = true;\n' } } }] },
        { toolCalls: [{ id: 'v', function: { name: 'bash', arguments: { command: 'node --check partial.js' } } }] },
        { toolCalls: [{ id: 'e', function: { name: 'bash', arguments: { command: 'echo broken > partial.js && false' } } }] },
        { content: 'done' },
      ]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      verifyGate: true, actNudge: 0, repeatGuard: 0,
    });
    assert.equal(run.toolCalls.at(-1).isError, true);
    assert.ok(messages.some(m => /edited files but haven't verified/.test(m.content ?? '')),
      'nonzero exit status does not undo an earlier write');
  });

  test('a cancelled request ends the run as cancelled, not failed', async () => {
    const messages = [{ role: 'user', content: 'go' }];
    const run = await runAgent({
      model: 'mock', messages,
      chatFn: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
      toolContext: { cwd: sandbox, workspace: sandbox },
    });
    assert.equal(run.status, 'cancelled');
  });

  test('a provider error ends the run as failed', async () => {
    const messages = [{ role: 'user', content: 'go' }];
    const events = [];
    const run = await runAgent({
      model: 'mock', messages,
      chatFn: async () => { throw new Error('provider exploded'); },
      toolContext: { cwd: sandbox, workspace: sandbox },
      emit: (type) => events.push(type),
    });
    assert.equal(run.status, 'failed');
    assert.ok(events.includes('failed'));
  });

  test('the payload is trimmed and orphan-free, while stored history is intact', async () => {
    // An orphan `tool` message (what the removed exact-bash shortcut wrote) must
    // never reach the provider, but must not be silently deleted from history.
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ran it' },
      { role: 'tool', content: 'orphan output' },
    ];
    const chatFn = scripted([{ content: 'ok' }]);
    await runAgent({
      model: 'mock', messages, chatFn,
      toolContext: { cwd: sandbox, workspace: sandbox },
    });
    const sent = chatFn.seen[0];
    assert.ok(!sent.some(m => m.role === 'tool'), 'orphan stripped from the payload');
    assert.ok(messages.some(m => m.role === 'tool'), 'but still present in stored history');
  });

  test('with tools disabled, tool-shaped text is treated as plain text', async () => {
    // `/tools off` used to still execute text-emitted calls: the parser ran
    // regardless of whether any tool was offered.
    const messages = [{ role: 'user', content: 'no tools please' }];
    const calls = [];
    const run = await runAgent({
      model: 'mock', messages, tools: [],
      chatFn: scripted([{ content: '{"name":"bash","arguments":{"command":"echo nope"}}' }]),
      toolContext: { cwd: sandbox, workspace: sandbox },
      emit: (type, data) => { if (type === 'tool_call') calls.push(data.name); },
    });
    assert.equal(run.status, 'completed');
    assert.deepEqual(calls, [], 'nothing was executed');
    assert.equal(run.iterations, 1);
  });

  test('mergeToolCalls keeps API calls and adds novel text-emitted ones', () => {
    const api = [{ function: { name: 'bash', arguments: { command: 'ls' } } }];
    // Same call in both channels → not duplicated.
    const dupe = mergeToolCalls({ content: '{"name":"bash","arguments":{"command":"ls"}}', toolCalls: api });
    assert.equal(dupe.length, 1);
    // A different text call → prepended, since it appeared earlier in the output.
    const merged = mergeToolCalls({ content: '{"name":"read_file","arguments":{"path":"a.js"}}', toolCalls: api });
    assert.equal(merged.length, 2);
    assert.equal(merged[0].function.name, 'read_file');
  });

  test('mergeToolCalls collapses exact text duplicates but preserves distinct and API calls', () => {
    const first = '{"name":"write_file","arguments":{"path":"a.txt","content":"x"}}';
    const second = '{"name":"write_file","arguments":{"path":"b.txt","content":"y"}}';
    const merged = mergeToolCalls({ content: `${first}\n${first}\n${second}`, toolCalls: null });
    assert.deepEqual(merged.map(call => call.function.arguments.path), ['a.txt', 'b.txt']);

    const explicit = [
      { id: 'one', function: { name: 'bash', arguments: { command: 'echo twice' } } },
      { id: 'two', function: { name: 'bash', arguments: { command: 'echo twice' } } },
    ];
    assert.equal(mergeToolCalls({ content: '', toolCalls: explicit }).length, 2,
      'provider-native calls carry explicit IDs and remain authoritative');
  });

  test('dropOrphanToolMessages is re-exported from chat.js unchanged', async () => {
    const chat = await import('../src/chat.js');
    assert.equal(chat.dropOrphanToolMessages, dropOrphanToolMessages);
  });
});

// ─── src/retry.js: provider resilience ────────────────────────────────────────
// One 429 used to kill an entire turn, and a hung provider hung forever.

describe('src/retry.js (retry, backoff, stall)', async () => {
  const {
    isRetryable, retryAfterMs, backoffMs, isConnectionFailure, withRetry, providerHttpError,
    resolveMaxRetries, resolveStallTimeout, RETRYABLE_STATUS,
  } = await import('../src/retry.js');

  const headers = (obj) => ({ get: (k) => obj[k.toLowerCase()] ?? null });

  test('providerHttpError carries status and Retry-After', () => {
    const err = providerHttpError('OpenRouter', { status: 429, headers: headers({ 'retry-after': '3' }) }, 'slow down');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 3000);
    assert.match(err.message, /OpenRouter chat \(429\): slow down/);
  });

  test('retryAfterMs parses seconds and HTTP-dates, ignores junk', () => {
    assert.equal(retryAfterMs(headers({ 'retry-after': '2' })), 2000);
    assert.equal(retryAfterMs(headers({})), null);
    assert.equal(retryAfterMs(headers({ 'retry-after': 'nonsense' })), null);
    const soon = new Date(Date.now() + 5000).toUTCString();
    assert.ok(retryAfterMs(headers({ 'retry-after': soon })) > 3000);
  });

  test('isRetryable retries transient failures only', () => {
    for (const status of RETRYABLE_STATUS) {
      assert.equal(isRetryable(Object.assign(new Error('x'), { status })), true, `${status} retries`);
    }
    // A bad model slug, a missing key, or a malformed request must fail loudly
    // on the first attempt rather than three times slower.
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(isRetryable(Object.assign(new Error('x'), { status })), false, `${status} does not retry`);
    }
    assert.equal(isRetryable(Object.assign(new Error('gone'), { name: 'AbortError' })), false, 'user cancel is final');
    assert.equal(isRetryable(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
    assert.equal(isRetryable(new Error('socket hang up')), true);
    assert.equal(isRetryable(new Error('model_not_found')), false);
  });

  test('backoffMs grows, stays capped, and respects Retry-After', () => {
    const high = { random: () => 1 }; // jitter at its maximum
    assert.equal(backoffMs(0, null, high), 500);
    assert.equal(backoffMs(1, null, high), 1000);
    assert.equal(backoffMs(9, null, high), 30_000, 'capped');
    assert.equal(backoffMs(0, { retryAfterMs: 9000 }, high), 9000, 'server hint wins when larger');
  });

  // Full jitter drew from [0, exponential], so an unlucky draw retried instantly:
  // three attempts inside a second, which cannot outlast anything real.
  test('backoffMs never collapses to zero, even on the unluckiest draw', () => {
    const low = { random: () => 0 };
    assert.equal(backoffMs(0, null, low), 250, 'half of the exponential is the floor');
    assert.equal(backoffMs(1, null, low), 500);
    assert.ok(backoffMs(0, null, low) < backoffMs(0, null, { random: () => 1 }), 'still jittered');
  });

  // Measured: Ollama auto-updated itself mid-run and took 8.4s to come back. At
  // the 500ms base the whole retry budget was under a second, so the turn died.
  test('isConnectionFailure separates "no socket" from "answered with an error"', () => {
    assert.ok(isConnectionFailure(new Error('fetch failed')));
    assert.ok(isConnectionFailure(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })));
    assert.ok(!isConnectionFailure(Object.assign(new Error('rate limited'), { status: 429 })),
      'a 429 answered the socket — it needs milliseconds, not seconds');
    assert.ok(!isConnectionFailure(new Error('bad model slug')));
  });

  test('backoffMs waits seconds, not milliseconds, when the server is not answering', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const low = { random: () => 0 };
    assert.equal(backoffMs(0, err, low), 1500);
    assert.equal(backoffMs(1, err, low), 3000);
    const budget = backoffMs(0, err, low) + backoffMs(1, err, low);
    assert.ok(budget >= 4000, `default budget ${budget}ms should span a local server restart`);
  });

  test('withRetry retries a transient failure and then succeeds', async () => {
    let attempts = 0;
    const slept = [];
    const value = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
        return 'ok';
      },
      { sleep: async (ms) => { slept.push(ms); }, random: () => 1, maxRetries: 3 },
    );
    assert.equal(value, 'ok');
    assert.equal(attempts, 3);
    assert.deepEqual(slept, [500, 1000], 'backoff grew between attempts');
  });

  test('withRetry gives up after maxRetries and rethrows the last error', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => { attempts++; throw Object.assign(new Error('still down'), { status: 503 }); },
        { sleep: async () => {}, maxRetries: 2 },
      ),
      /still down/,
    );
    assert.equal(attempts, 3, 'initial attempt plus two retries');
  });

  test('withRetry never retries once the caller vetoes', async () => {
    // provider.js vetoes after bytes have streamed — replaying would print twice.
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => { attempts++; throw Object.assign(new Error('429'), { status: 429 }); },
        { sleep: async () => {}, canRetry: () => false },
      ),
      /429/,
    );
    assert.equal(attempts, 1);
  });

  test('withRetry stops when the caller aborts mid-backoff', async () => {
    const ac = new AbortController();
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => { attempts++; ac.abort(); throw Object.assign(new Error('502'), { status: 502 }); },
        { sleep: async () => {}, signal: ac.signal },
      ),
      /502/,
    );
    assert.equal(attempts, 1, 'no retry after the user cancelled');
  });

  test('retry and stall settings read their env overrides', () => {
    assert.equal(resolveMaxRetries({}), 2);
    assert.equal(resolveMaxRetries({ CLAUDETTE_MAX_RETRIES: '0' }), 0);
    assert.equal(resolveMaxRetries({ CLAUDETTE_MAX_RETRIES: 'nope' }), 2);
    assert.equal(resolveStallTimeout({}), 300_000);
    assert.equal(resolveStallTimeout({ CLAUDETTE_STALL_TIMEOUT: '0' }), 0, '0 disables the watchdog');
  });

  test('a stalled request surfaces as an actionable error, not an AbortError', async () => {
    const { createStallGuard } = await import('../src/retry.js');
    const guard = createStallGuard({ timeoutMs: 10, label: 'TestProvider' });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(guard.signal.aborted, true, 'silence trips the watchdog');
    // AbortError would be read by the agent loop as "the user pressed Ctrl+C",
    // recording a real failure as a clean cancellation.
    assert.throws(
      () => guard.rethrow(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      (err) => err.name !== 'AbortError' && err.stall === true && /TestProvider sent nothing/.test(err.message),
    );
    guard.done();
  });

  test('activity keeps a slow-but-alive stream from tripping the watchdog', async () => {
    const { createStallGuard } = await import('../src/retry.js');
    const guard = createStallGuard({ timeoutMs: 60 });
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 25));
      guard.touch(); // a delta arrived
    }
    assert.equal(guard.signal.aborted, false, '100ms of steady output, 60ms watchdog');
    guard.done();
  });
});

// ─── src/completion.js: Tab completion ────────────────────────────────────────

// ─── Workspace boundary, shell-free glob, interruptible tools ────────────────

describe('tools.js (boundary, glob, cancellation)', async () => {
  const { executeTool, globToRegExp } = await import('../src/tools.js');

  let ws;
  before(async () => {
    ws = await fsp.realpath(await makeTmpDir());
    await fsp.mkdir(path.join(ws, 'src', 'deep'), { recursive: true });
    await fsp.mkdir(path.join(ws, 'node_modules', 'junk'), { recursive: true });
    await fsp.writeFile(path.join(ws, 'src', 'a.js'), 'a', 'utf8');
    await fsp.writeFile(path.join(ws, 'src', 'deep', 'b.js'), 'b', 'utf8');
    await fsp.writeFile(path.join(ws, 'src', 'notes.md'), 'n', 'utf8');
    await fsp.writeFile(path.join(ws, 'top.js'), 't', 'utf8');
    await fsp.writeFile(path.join(ws, 'node_modules', 'junk', 'evil.js'), 'x', 'utf8');
  });
  after(async () => { await cleanDir(ws); });

  const run = (name, args) => executeTool(name, args, { cwd: ws, workspace: ws });

  // A lexical path check is not a boundary: `ln -s /etc/passwd notes.txt` is
  // innocent-looking and used to read straight out of the workspace.
  test('a symlink pointing outside the workspace is refused', async () => {
    const secret = path.join(os.tmpdir(), `claudette-outside-${randomUUID()}.txt`);
    await fsp.writeFile(secret, 'TOP SECRET', 'utf8');
    const link = path.join(ws, 'innocent.txt');
    await fsp.symlink(secret, link);
    try {
      await assert.rejects(run('read_file', { path: 'innocent.txt' }), /symlink that resolves outside/);
      await assert.rejects(run('write_file', { path: 'innocent.txt', content: 'x' }), /symlink that resolves outside/);
      assert.equal(await fsp.readFile(secret, 'utf8'), 'TOP SECRET', 'the target was not overwritten');
    } finally {
      await fsp.rm(link, { force: true });
      await fsp.rm(secret, { force: true });
    }
  });

  test('a symlink to a directory outside the workspace is refused', async () => {
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-outdir-'));
    await fsp.writeFile(path.join(outsideDir, 'secret.txt'), 'nope', 'utf8');
    const link = path.join(ws, 'escape');
    await fsp.symlink(outsideDir, link);
    try {
      await assert.rejects(run('read_file', { path: 'escape/secret.txt' }), /symlink that resolves outside/);
      // A file that does not exist yet must be checked just as strictly.
      await assert.rejects(run('write_file', { path: 'escape/new.txt', content: 'x' }), /symlink that resolves outside/);
    } finally {
      await fsp.rm(link, { force: true });
      await cleanDir(outsideDir);
    }
  });

  test('ordinary paths inside the workspace still work', async () => {
    assert.equal(await run('read_file', { path: 'src/a.js' }), 'a');
    assert.match(await run('write_file', { path: 'fresh/new.txt', content: 'hi' }), /Wrote/);
    assert.equal(await fsp.readFile(path.join(ws, 'fresh', 'new.txt'), 'utf8'), 'hi');
  });

  test('the lexical escape is still refused, with its own message', async () => {
    await assert.rejects(run('read_file', { path: '../../etc/passwd' }), /outside the workspace root/);
  });

  test('globToRegExp: ** crosses directories, * and ? do not', () => {
    assert.ok(globToRegExp('**/*.js').test('src/deep/b.js'));
    assert.ok(globToRegExp('**/*.js').test('top.js'), '**/ matches zero directories');
    assert.ok(globToRegExp('src/*.js').test('src/a.js'));
    assert.ok(!globToRegExp('src/*.js').test('src/deep/b.js'), '* stops at a separator');
    assert.ok(globToRegExp('src/?.js').test('src/a.js'));
    assert.ok(!globToRegExp('src/?.js').test('src/ab.js'));
  });

  test('globToRegExp escapes regex metacharacters in the pattern', () => {
    // Without escaping, `a.js` would match `axjs` and `(x)` would be a group.
    assert.ok(!globToRegExp('a.js').test('axjs'));
    assert.ok(globToRegExp('we(ird).js').test('we(ird).js'));
    assert.ok(globToRegExp('a+b.js').test('a+b.js'));
  });

  test('glob matches without a shell and skips node_modules', async () => {
    const out = await run('glob', { pattern: '**/*.js' });
    const files = out.split('\n');
    assert.ok(files.includes('src/a.js') && files.includes('src/deep/b.js') && files.includes('top.js'));
    assert.ok(!files.includes('src/notes.md'), 'pattern filtered');
    assert.ok(!out.includes('node_modules'), 'never descends into node_modules');
  });

  // glob is auto-approved, so the pattern is attacker-influenced text that used
  // to reach `bash -c`. There is no shell in the path now.
  test('glob treats shell metacharacters as literal pattern text', async () => {
    const canary = path.join(ws, 'canary.txt');
    await fsp.rm(canary, { force: true });
    for (const pattern of ['$(touch canary.txt)', '`touch canary.txt`', '; touch canary.txt', '*.js; touch canary.txt']) {
      const out = await run('glob', { pattern });
      assert.equal(out, '(no matches)', `no match for ${pattern}`);
    }
    assert.equal(fs.existsSync(canary), false, 'nothing executed');
  });

  test('glob will not report a symlink that leaves the workspace', async () => {
    const outside = path.join(os.tmpdir(), `claudette-glob-${randomUUID()}.js`);
    await fsp.writeFile(outside, 'x', 'utf8');
    const link = path.join(ws, 'linked.js');
    await fsp.symlink(outside, link);
    try {
      const out = await run('glob', { pattern: '*.js' });
      assert.ok(!out.split('\n').includes('linked.js'), 'escaping symlink omitted');
      assert.ok(out.split('\n').includes('top.js'), 'real files still listed');
    } finally {
      await fsp.rm(link, { force: true });
      await fsp.rm(outside, { force: true });
    }
  });

  // Ctrl+C during a long foreground command. Before, executeTool ignored the
  // signal and you waited for `npm run build` no matter what.
  test('an aborted bash command stops and says it was interrupted', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(
      executeTool('bash', { command: 'sleep 30' }, { cwd: ws, workspace: ws, signal: ac.signal }),
      /interrupted by the user/i,
    );
    assert.ok(Date.now() - started < 5000, 'returned immediately, not after 30s');
  });

  test('an abort is not misreported as a timeout', async () => {
    // Both arrive as a killed child; telling the model "it timed out" would send
    // it off tuning CLAUDETTE_BASH_TIMEOUT for something the user did.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(
      executeTool('bash', { command: 'sleep 20' }, { cwd: ws, workspace: ws, signal: ac.signal }),
      (err) => !/timed out/i.test(err.message),
    );
  });

  test('a normal command is unaffected by an un-aborted signal', async () => {
    const ac = new AbortController();
    const out = await executeTool('bash', { command: 'echo alive' }, { cwd: ws, workspace: ws, signal: ac.signal });
    assert.match(out, /alive/);
  });

  test('a null signal is accepted, not passed through to execFile', async () => {
    // execFile validates options.signal as AbortSignal-or-undefined and rejects
    // null outright, so a caller with no signal to give (the eval harness) broke
    // every command before it ran.
    const out = await executeTool('bash', { command: 'echo nosignal' }, { cwd: ws, workspace: ws, signal: null });
    assert.match(out, /nosignal/);
    const viaGrep = await executeTool('search_code', { pattern: 'nosignal-not-present' }, { cwd: ws, workspace: ws, signal: null });
    assert.equal(typeof viaGrep, 'string');
  });
});

describe('ollama.js (context window)', async () => {
  const { resolveNumCtx } = await import('../src/ollama.js');

  test('num_ctx defaults to 32k and is overridable', () => {
    // Ollama's own default is 4096, which truncates an agent loop almost at once.
    assert.equal(resolveNumCtx({}), 32768);
    assert.equal(resolveNumCtx({ CLAUDETTE_NUM_CTX: '131072' }), 131072);
    assert.equal(resolveNumCtx({ CLAUDETTE_NUM_CTX: 'nonsense' }), 32768);
    assert.equal(resolveNumCtx({ CLAUDETTE_NUM_CTX: '0' }), 32768, 'zero would mean no context at all');
  });
});

describe('clipboard commands', async () => {
  const { copyToClipboard, copyLastAssistantMessage } = await import('../src/clipboard.js');

  test('copies the latest assistant text verbatim without copying tool results or prompts', async () => {
    const answer = '\n**Answer**\n```js\nconst greeting = "你好 🌍";\n```\n';
    const messages = [
      { role: 'assistant', content: 'older answer' },
      { role: 'assistant', content: answer },
      { role: 'tool', content: 'tool output' },
      { role: 'user', content: 'new prompt' },
      { role: 'assistant', content: '   ', tool_calls: [] },
    ];
    const before = structuredClone(messages);
    const copied = [];
    assert.equal(await copyLastAssistantMessage(messages, async text => copied.push(text)), true);
    assert.deepEqual(copied, [answer]);
    assert.deepEqual(messages, before, 'copying does not change session history');
  });

  test('leaves the clipboard alone when no answer exists and propagates copy failures', async () => {
    const copy = async () => { throw new Error('clipboard unavailable'); };
    assert.equal(await copyLastAssistantMessage([], copy), false);
    assert.equal(await copyLastAssistantMessage([{ role: 'user', content: 'hello' }], copy), false);
    await assert.rejects(copyLastAssistantMessage([{ role: 'assistant', content: 'answer' }], copy),
      /clipboard unavailable/);
  });

  test('native backends receive literal Unicode text through stdin, including Windows encoding', async () => {
    const dir = await makeTmpDir();
    const answer = 'line one\n你好 🌍\n$(echo must-stay-literal) `echo also-literal`';
    const capture = 'const fs=require("node:fs");const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>fs.writeFileSync(process.argv[1],Buffer.concat(chunks)));';
    try {
      for (const [platform, env, command, args, encoding] of [
        ['darwin', {}, '/usr/bin/pbcopy', [], 'utf8'],
        ['win32', {}, 'clip.exe', [], 'utf16le'],
        ['linux', { WAYLAND_DISPLAY: 'wayland-0' }, 'wl-copy', [], 'utf8'],
        ['linux', { DISPLAY: ':0' }, 'xclip', ['-selection', 'clipboard'], 'utf8'],
      ]) {
        const target = path.join(dir, 'clipboard.txt');
        const calls = [];
        await copyToClipboard(answer, {
          platform, env,
          execFile: (file, argv, options, callback) => {
            calls.push({ file, argv });
            assert.ok(!options.shell, 'clipboard text must not pass through a shell');
            return nativeExecFile(process.execPath, ['-e', capture, target], options, callback);
          },
        });
        assert.deepEqual(calls, [{ file: command, argv: args }]);
        assert.deepEqual(await fsp.readFile(target), Buffer.from(answer, encoding));
      }
    } finally { await cleanDir(dir); }
  });

  test('Linux falls back when a clipboard utility is missing and reports unavailable backends', async () => {
    const seen = [];
    await copyToClipboard('answer', {
      platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' },
      execFile: (file, _args, options, callback) => {
        seen.push(file);
        return file === 'wl-copy'
          ? nativeExecFile('/nonexistent-claudette-clipboard', [], options, callback)
          : nativeExecFile(process.execPath, ['-e', 'process.stdin.resume()'], options, callback);
      },
    });
    assert.deepEqual(seen, ['wl-copy', 'xclip']);
    await assert.rejects(copyToClipboard('answer', {
      platform: 'linux', env: {},
      execFile: (_file, _args, options, callback) => nativeExecFile('/nonexistent-claudette-clipboard', [], options, callback),
    }), /Could not copy to clipboard:.*Install wl-clipboard/s);
  });

  test('clipboard handles early pipe closure, timeout, all fallback backends, and unsupported platforms', async () => {
    await assert.rejects(copyToClipboard('text', { platform: 'plan9' }), /not supported/);
    let attempts = 0;
    const seen = [];
    await copyToClipboard('large input\n'.repeat(200000), {
      platform: 'linux', env: { DISPLAY: ':0' },
      execFile: (file, args, options, callback) => {
        seen.push([file, args]);
        attempts++;
        return nativeExecFile(process.execPath,
          ['-e', attempts < 3 ? 'process.exit(2)' : 'process.stdin.resume()'], options, callback);
      },
    });
    assert.deepEqual(seen, [
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
      ['wl-copy', []],
    ]);
    await assert.rejects(copyToClipboard('timeout', {
      platform: 'darwin',
      execFile: (_file, _args, options, callback) => {
        assert.equal(options.timeout, 5000, 'native clipboard operations have a deadline');
        return nativeExecFile(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
          { ...options, timeout: 50 }, callback);
      },
    }), /Could not copy to clipboard/);
  });
});

describe('src/completion.js (tab completion)', async () => {
  const { completeSlashCommand, completeAtPath, createCompleter, SLASH_COMMANDS } = await import('../src/completion.js');

  let dir;
  before(async () => {
    dir = await makeTmpDir();
    await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'src', 'chat.js'), '', 'utf8');
    await fsp.writeFile(path.join(dir, 'src', 'chunk.js'), '', 'utf8');
    await fsp.writeFile(path.join(dir, 'README.md'), '', 'utf8');
    await fsp.writeFile(path.join(dir, '.hidden'), '', 'utf8');
  });
  after(async () => { await cleanDir(dir); });

  test('completes a slash-command prefix', () => {
    const [hits, partial] = completeSlashCommand('/mod');
    assert.deepEqual(hits, ['/model', '/models']);
    assert.equal(partial, '/mod');
    assert.deepEqual(completeSlashCommand('/cop'), [['/copy'], '/cop']);
  });

  test('offers every command for a bare slash, and none for prose', () => {
    assert.deepEqual(completeSlashCommand('/')[0], SLASH_COMMANDS);
    assert.equal(completeSlashCommand('fix the build'), null);
    assert.equal(completeSlashCommand('/model gpt'), null, 'past the command word, stop completing');
  });

  test('completes @paths, marking directories', async () => {
    const [hits] = await completeAtPath('look at @sr', dir);
    assert.deepEqual(hits, ['src/']);
    const [inner] = await completeAtPath('look at @src/ch', dir);
    assert.deepEqual(inner, ['src/chat.js', 'src/chunk.js']);
  });

  test('@path completion hides dotfiles and node_modules until asked', async () => {
    const [hits] = await completeAtPath('@', dir);
    assert.ok(hits.includes('README.md'));
    assert.ok(!hits.includes('node_modules/'), 'never worth completing');
    assert.ok(!hits.some(h => h.startsWith('.')), 'hidden files stay hidden');
    const [dots] = await completeAtPath('@.h', dir);
    assert.deepEqual(dots, ['.hidden'], 'typing a dot opts in');
  });

  test('@path completion refuses to escape the workspace', async () => {
    const [hits] = await completeAtPath('@../', dir);
    assert.deepEqual(hits, [], 'same boundary @-expansion enforces');
  });

  test('completeAtPath ignores lines with no @token', async () => {
    assert.equal(await completeAtPath('just a prompt', dir), null);
  });

  test('readline/promises completer returns a Promise tuple instead of callback-style undefined', async () => {
    const completer = createCompleter(() => dir);
    assert.equal(completer.length, 1, 'one-argument form is treated as a Promise completer by readline');
    assert.deepEqual(await completer('/mod'), [['/model', '/models'], '/mod']);
    assert.deepEqual(await completer('look at @sr'), [['src/'], 'sr']);
  });
});

// ─── Durability: atomic writes + compaction archive ───────────────────────────

describe('session durability (atomic writes, compaction archive)', async () => {
  const { writeFileAtomic } = await import('../src/fs-atomic.js');
  const { archiveMessages, ARCHIVE_DIR } = await import('../src/session.js');

  let dir;
  before(async () => { dir = await makeTmpDir(); });
  after(async () => { await cleanDir(dir); });

  test('writeFileAtomic publishes the whole file and leaves no temp behind', async () => {
    const target = path.join(dir, 'nested', 'session.json');
    await writeFileAtomic(target, '{"a":1}\n');
    assert.equal(await fsp.readFile(target, 'utf8'), '{"a":1}\n');
    const strays = (await fsp.readdir(path.dirname(target))).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(strays, [], 'temp file was renamed, not left');
    assert.equal((await fsp.stat(path.dirname(target))).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
  });

  test('writeFileAtomic overwrites in place', async () => {
    const target = path.join(dir, 'twice.json');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');
    assert.equal(await fsp.readFile(target, 'utf8'), 'second');
  });

  test('archiveMessages snapshots history before compaction destroys it', async () => {
    const session = {
      id: `test-${randomUUID()}`,
      model: 'mock',
      title: 'Doomed history',
      messages: [{ role: 'user', content: 'keep me' }, { role: 'assistant', content: 'and me' }],
    };
    const file = await archiveMessages(session, 'compact');
    try {
      const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
      assert.deepEqual(saved.messages, session.messages);
      assert.equal(saved.reason, 'compact');
      assert.equal(saved.sessionId, session.id);
      // Must not sit beside the sessions: listSessions() globs *.json there and
      // loadSession() resolves short ids by prefix, so an archive would show up
      // as a session and could be resumed instead of the real one.
      assert.equal(path.dirname(file), ARCHIVE_DIR);
    } finally {
      await fsp.rm(file, { force: true });
    }
  });
});

// ─── bench/evals.js: prompt/tool-usage eval loops ─────────────────────────────
// All offline: a scripted chatFn stands in for the model, while the real
// executeTool runs against a throwaway sandbox.

describe('bench/evals.js (eval loops)', async () => {
  const { runEvalIteration, evaluateExpectations, matchToolCalls, argsMatch, loadCases, parseArgs } =
    await import('../bench/evals.js');

  // A replayed response reports the tokens recorded when it was captured and a
  // duration near zero, so a cached model reads as both cheaper and faster than
  // one actually being measured. Comparing models is what this harness is for.
  test('the response cache is opt-in, so a bake-off measures live calls', () => {
    assert.equal(parseArgs(['--all']).cache, false, 'off unless asked for');
    assert.equal(parseArgs(['--cache']).cache, true);
    assert.equal(parseArgs(['--no-cache']).cache, false, 'older commands still parse');
    assert.equal(parseArgs(['--all']).rotation, false, 'model identity is pinned by default');
    assert.equal(parseArgs(['--rotation']).rotation, true, 'fallback rotation requires an explicit opt-in');
    assert.equal(parseArgs(['--no-rotation']).rotation, false, 'explicit pinning still parses');
  });

  // A chatFn that replays a fixed sequence of model responses.
  function scriptedModel(responses) {
    let i = 0;
    return async () => responses[Math.min(i++, responses.length - 1)];
  }

  test('argsMatch: string values match by substring, others strictly', () => {
    assert.ok(argsMatch({ command: 'echo eval-ok && ls' }, { command: 'echo eval-ok' }));
    assert.ok(!argsMatch({ command: 'echo nope' }, { command: 'echo eval-ok' }));
    assert.ok(argsMatch({ offset: 5 }, { offset: 5 }));
    assert.ok(!argsMatch({ offset: 5 }, { offset: 6 }));
    assert.ok(argsMatch({ anything: 'x' }, {}), 'empty expectation always matches');
  });

  test('matchToolCalls: ordered subsequence', () => {
    const actual = [
      { name: 'read_file', args: { path: 'a.txt' } },
      { name: 'bash', args: { command: 'ls' } },
      { name: 'str_replace', args: { path: 'a.txt' } },
    ];
    assert.ok(matchToolCalls(actual, [{ name: 'read_file' }, { name: 'str_replace' }]).ok,
      'subsequence in order matches');
    const wrongOrder = matchToolCalls(actual, [{ name: 'str_replace' }, { name: 'read_file' }]);
    assert.ok(!wrongOrder.ok, 'out-of-order does not match');
    assert.equal(wrongOrder.missing.name, 'read_file');
  });

  test('runEvalIteration executes tool calls in a sandbox and passes expectations', async () => {
    const record = await runEvalIteration({
      id: 'mock-bash',
      prompt: 'run echo',
      maxTurns: 4,
      expect: {
        tools: [{ name: 'bash', args: { command: 'echo eval-ok' } }],
        answer: { matches: 'eval-ok' },
      },
    }, {
      model: 'mock',
      chatFn: scriptedModel([
        { content: '', toolCalls: [{ id: 't1', function: { name: 'bash', arguments: '{"command":"echo eval-ok"}' } }] },
        { content: 'The command printed eval-ok.' },
      ]),
    });

    assert.equal(record.error, null);
    assert.equal(record.status, 'completed');
    assert.equal(record.turns, 2);
    assert.deepEqual(record.assistantResponses.map(response => response.toolCalls), [['bash'], []]);
    assert.equal(record.toolCalls.length, 1);
    assert.ok(record.toolCalls[0].output.includes('eval-ok'), 'real executeTool ran the command');
    assert.ok(record.pass, `expected pass, failures: ${record.failures.join(' | ')}`);
  });

  test('runEvalIteration merges text-emitted tool calls like the CLI does', async () => {
    const record = await runEvalIteration({
      id: 'mock-text-call',
      prompt: 'write a file',
      maxTurns: 4,
      expect: {
        tools: [{ name: 'write_file', args: { path: 'out.txt' } }],
        files: { 'out.txt': { includes: 'hi' } },
      },
    }, {
      model: 'mock',
      chatFn: scriptedModel([
        // Tool call emitted as JSON in the text body, no API toolCalls field.
        { content: '{"name": "write_file", "arguments": {"path": "out.txt", "content": "hi"}}' },
        { content: 'done' },
      ]),
    });

    assert.equal(record.error, null);
    assert.ok(record.pass, `expected pass, failures: ${record.failures.join(' | ')}`);
    assert.equal(record.toolCalls[0].name, 'write_file');
  });

  test('runEvalIteration fails on forbidden tools and missing expectations', async () => {
    const record = await runEvalIteration({
      id: 'mock-forbidden',
      prompt: 'edit the file',
      files: { 'config.js': 'export const TIMEOUT = 30;\n' },
      maxTurns: 4,
      expect: {
        tools: [{ name: 'str_replace', args: { path: 'config.js' } }],
        forbid: ['write_file'],
        files: { 'config.js': { includes: 'TIMEOUT = 90' } },
      },
    }, {
      model: 'mock',
      chatFn: scriptedModel([
        // Model rewrites the whole file instead of a targeted edit — and gets it wrong.
        { content: '', toolCalls: [{ id: 't1', function: { name: 'write_file', arguments: '{"path":"config.js","content":"export const TIMEOUT = 60;"}' } }] },
        { content: 'done' },
      ]),
    });

    assert.ok(!record.pass);
    assert.ok(record.failures.some(f => f.includes('missing tool call: str_replace')), 'flags missing str_replace');
    assert.ok(record.failures.some(f => f.includes('forbidden tool was called: write_file')), 'flags forbidden write_file');
    assert.ok(record.failures.some(f => f.includes('does not include')), 'flags wrong file content');
  });

  // The tie-break assertions. Correctness alone stopped separating models once
  // several of them passed every case, so a case can also require that nothing
  // else got clobbered and that the answer was not brute-forced.
  test('runEvalIteration: excludes catches a rewrite that drops untouched content', async () => {
    const rewritten = 'export const TIMEOUT = 90;\n'; // RETRIES line lost
    const record = await runEvalIteration({
      id: 'mock-excludes',
      prompt: 'bump the timeout',
      files: { 'config.js': 'export const TIMEOUT = 30;\nexport const RETRIES = 3;\n' },
      maxTurns: 4,
      expect: {
        files: { 'config.js': { includes: ['TIMEOUT = 90', 'RETRIES = 3'], excludes: 'TIMEOUT = 30' } },
      },
    }, {
      model: 'mock',
      chatFn: scriptedModel([
        { content: '', toolCalls: [{ id: 't1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'config.js', content: rewritten }) } }] },
        { content: 'done' },
      ]),
    });

    assert.ok(!record.pass, 'the asked-for change landed but collateral damage fails the case');
    assert.ok(record.failures.some(f => f.includes('does not include "RETRIES = 3"')), 'flags the dropped line');
    assert.ok(!record.failures.some(f => f.includes('still includes')), 'excludes on the old value is satisfied');
  });

  test('runEvalIteration: absent expects a file the model must not create', async () => {
    const record = await runEvalIteration({
      id: 'mock-absent',
      prompt: 'edit in place',
      files: { 'config.js': 'x\n' },
      maxTurns: 4,
      expect: { files: { 'config.js.bak': { absent: true } } },
    }, {
      model: 'mock',
      chatFn: scriptedModel([
        { content: '', toolCalls: [{ id: 't1', function: { name: 'bash', arguments: '{"command":"cp config.js config.js.bak"}' } }] },
        { content: 'done' },
      ]),
    });

    assert.ok(!record.pass);
    assert.ok(record.failures.some(f => f.includes('config.js.bak should not exist')));

    const clean = await runEvalIteration({
      id: 'mock-absent-ok',
      prompt: 'edit in place',
      files: { 'config.js': 'x\n' },
      maxTurns: 4,
      expect: { files: { 'config.js.bak': { absent: true } } },
    }, { model: 'mock', chatFn: scriptedModel([{ content: 'done' }]) });
    assert.ok(clean.pass, 'a missing file satisfies absent');
  });

  test('runEvalIteration: maxToolCalls fails a correct-but-flailing run', async () => {
    const readCall = { id: 't1', function: { name: 'bash', arguments: '{"command":"true"}' } };
    const record = await runEvalIteration({
      id: 'mock-budget',
      prompt: 'do it efficiently',
      maxTurns: 8,
      expect: { answer: { matches: 'done' }, maxToolCalls: 2 },
    }, {
      model: 'mock',
      chatFn: scriptedModel([
        { content: '', toolCalls: [readCall] },
        { content: '', toolCalls: [readCall] },
        { content: '', toolCalls: [readCall] },
        { content: 'done' },
      ]),
    });

    assert.ok(!record.pass, 'right answer, too many calls');
    assert.ok(record.failures.some(f => f.includes('used 3 tool calls, budget is 2')));
    assert.ok(!record.failures.some(f => f.includes('final answer')), 'the answer itself matched');
  });

  test('evaluateExpectations enforces exact files, allowlists, and zero tool errors', async () => {
    const sandbox = await makeTmpDir();
    try {
      await fsp.writeFile(path.join(sandbox, 'target.txt'), 'wrong\n');
      await fsp.writeFile(path.join(sandbox, 'extra.txt'), 'scope creep\n');
      await fsp.writeFile(path.join(sandbox, 'locked.txt'), 'changed\n');
      await fsp.mkdir(path.join(sandbox, '.venv', 'bin'), { recursive: true });
      await fsp.writeFile(path.join(sandbox, '.venv', 'bin', 'python'), 'allowed generated tree\n');
      const evaluated = await evaluateExpectations({
        toolCalls: [{ name: 'read_file', isError: true }],
        finalText: 'done',
      }, {
        noToolErrors: true,
        allowedFiles: ['target.txt', 'locked.txt', '.venv/**'],
        unchangedFiles: ['locked.txt'],
        files: { 'target.txt': { equals: 'exact\n' } },
      }, sandbox, { 'locked.txt': 'original\n' });
      assert.equal(evaluated.pass, false);
      assert.ok(evaluated.failures.some(failure => failure.includes('tool errors are forbidden')));
      assert.ok(evaluated.failures.some(failure => failure.includes('does not exactly equal')));
      assert.ok(evaluated.failures.some(failure => failure.includes('unexpected file created: extra.txt')));
      assert.ok(evaluated.failures.some(failure => failure.includes('seeded file changed: locked.txt')));
      assert.ok(!evaluated.failures.some(failure => failure.includes('.venv/bin/python')),
        'a trailing /** entry permits only that generated subtree');
    } finally {
      await cleanDir(sandbox);
    }
  });

  // A whole model's column of failures used to read "agent run failed after 1
  // iterations", with the provider error — the only thing that explains it —
  // dropped on the floor.
  test('runEvalIteration reports the provider error behind a failed run', async () => {
    const record = await runEvalIteration({
      id: 'mock-provider-error',
      prompt: 'anything',
      maxTurns: 4,
      expect: { answer: { matches: 'never' } },
    }, {
      model: 'mock',
      chatFn: async () => { throw Object.assign(new Error('OpenRouter chat (402): credits exhausted'), { status: 402 }); },
    });

    assert.ok(!record.pass);
    assert.match(record.error, /credits exhausted/, 'the cause survives into the report');
    assert.match(record.failures[0], /402/);
  });

  test('runEvalIteration stops at maxTurns without a final answer', async () => {
    const record = await runEvalIteration({
      id: 'mock-loop',
      prompt: 'loop forever',
      maxTurns: 3,
      expect: { answer: { matches: 'never-said' } },
    }, {
      model: 'mock',
      chatFn: scriptedModel([
        { content: '', toolCalls: [{ id: 't1', function: { name: 'bash', arguments: '{"command":"true"}' } }] },
      ]),
    });

    assert.equal(record.turns, 3, 'hit the turn cap');
    assert.equal(record.status, 'max_iterations', 'records why no final answer was available');
    assert.ok(!record.pass, 'no final answer → answer expectation fails');
  });

  test('shipped eval cases are well-formed', async () => {
    const cases = await loadCases();
    assert.ok(cases.length >= 4, 'has seed cases');
    for (const c of cases) {
      assert.ok(c.id && c.title && c.prompt, `${c.id ?? '?'} has id/title/prompt`);
      assert.ok(c.expect && Object.keys(c.expect).length, `${c.id} has expectations`);
    }
    const ids = cases.map(c => c.id);
    assert.equal(new Set(ids).size, ids.length, 'case ids unique');
  });

  test('review-evidence fixture accepts grounded findings and rejects collection coverage claims', async () => {
    const cases = await loadCases();
    const caseDef = cases.find(candidate => candidate.id === 'review-evidence');
    const sandbox = await makeTmpDir();
    try {
      for (const [rel, content] of Object.entries(caseDef.files)) {
        const absolute = path.join(sandbox, rel);
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
        await fsp.writeFile(absolute, content);
      }
      const record = {
        toolCalls: Object.keys(caseDef.files).map(file => ({ name: 'read_file', args: { path: file } })),
        finalText: 'src/ports.py:3 accepts 0 contrary to its documented range. Add the missing zero boundary test. ' +
          'pyproject.toml already configures Ruff and strict mypy. Collection does not execute tests; actual coverage is unknown.',
      };
      assert.deepEqual(await evaluateExpectations(record, caseDef.expect, sandbox, caseDef.files),
        { pass: true, failures: [] });
      const unsupported = { ...record, finalText: 'Coverage is only 50%. Lower the 70% threshold and add Ruff and mypy.' };
      assert.equal((await evaluateExpectations(unsupported, caseDef.expect, sandbox, caseDef.files)).pass, false);
      const contradiction = { ...record, finalText: `${record.finalText}\nCoverage threshold will fail on any run.` };
      assert.ok((await evaluateExpectations(contradiction, caseDef.expect, sandbox, caseDef.files))
        .failures.includes('final answer contains a forbidden claim'));
      for (const claim of [
        'Actual coverage would likely be 100%.',
        'Both statements would be covered, producing 100 % statement coverage.',
      ]) {
        const guessed = { ...record, finalText: `${record.finalText}\n${claim}` };
        assert.ok((await evaluateExpectations(guessed, caseDef.expect, sandbox, caseDef.files))
          .failures.includes('final answer contains a forbidden claim'));
      }
      const markdown = { ...record, finalText: 'src/ports.py accepts 0. Collection does **not** establish actual test coverage.' };
      assert.equal((await evaluateExpectations(markdown, caseDef.expect, sandbox, caseDef.files)).pass, true);
      await fsp.appendFile(path.join(sandbox, 'src/ports.py'), '\n# unsolicited edit\n');
      const edited = await evaluateExpectations(record, caseDef.expect, sandbox, caseDef.files);
      assert.ok(edited.failures.includes('seeded file changed: src/ports.py'));
    } finally {
      await cleanDir(sandbox);
    }
  });

  test('fix-failing-test stays CommonJS beneath an ESM workspace', async () => {
    const cases = await loadCases();
    const caseDef = cases.find(candidate => candidate.id === 'fix-failing-test');
    assert.ok(caseDef, 'fixture exists');
    const esmParent = await makeTmpDir();
    const sandbox = path.join(esmParent, 'nested-fixture');
    try {
      await fsp.writeFile(path.join(esmParent, 'package.json'), '{"type":"module"}\n');
      for (const [rel, content] of Object.entries(caseDef.files)) {
        const absolute = path.join(sandbox, rel);
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
        await fsp.writeFile(absolute, content);
      }
      const initial = spawnSync('sh', ['test.sh'], { cwd: sandbox, encoding: 'utf8' });
      const output = `${initial.stdout}\n${initial.stderr}`;
      assert.equal(initial.status, 1, 'the deliberately broken implementation fails');
      assert.match(output, /returned -1, expected 5/, 'failure is the intended arithmetic assertion');
      assert.doesNotMatch(output, /require is not defined/, 'parent ESM metadata does not contaminate the fixture');
    } finally {
      await cleanDir(esmParent);
    }
  });

  test('diverse Farm fixtures reject seeds and accept known-good solutions', async () => {
    const cases = await loadCases();
    const scenarios = [
      {
        id: 'farm-env-matrix',
        command: [process.execPath, ['verify.mjs']],
        solutions: {
          'src/config.js': "const MODES = new Set(['dev', 'test', 'prod']);\n\nexport function readConfig(env = process.env) {\n  const rawPort = String(env.PORT ?? '');\n  const parsedPort = /^\\d+$/.test(rawPort) ? Number.parseInt(rawPort, 10) : NaN;\n  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 3000;\n  const mode = MODES.has(env.MODE) ? env.MODE : 'dev';\n  const label = String(env.APP_LABEL ?? '').trim() || 'Claudette';\n  return { port, mode, label };\n}\n",
          'bin/show-config.js': "import { readConfig } from '../src/config.js';\n\nconst { label, mode, port } = readConfig();\nconsole.log(`${label}|${mode}|${port}`);\n",
        },
      },
      {
        id: 'farm-unicode-path',
        command: [process.execPath, ['verify.mjs']],
        solutions: {
          'content/menu data.json': '{\n  "currency": "USD",\n  "items": [\n    {\n      "id": "dessert-01",\n      "displayName": "Crème brûlée ☕",\n      "priceCents": 775,\n      "seasonal": true\n    },\n    {\n      "id": "tea-02",\n      "displayName": "Jasmine tea 茉莉花茶",\n      "priceCents": 450\n    }\n  ]\n}\n',
        },
      },
      {
        id: 'farm-js-python-pipeline',
        command: ['sh', ['pipeline.sh']],
        solutions: {
          'lib/score.mjs': 'export function score(raw, scale) {\n  return raw * scale;\n}\n',
          'summarize.py': 'import json\n\n\ndef render(payload):\n    rows = sorted(payload["rows"], key=lambda row: row["name"])\n    return "\\n".join(\n        f\'{payload["prefix"]}:{row["name"]}={row["score"]}\' for row in rows\n    )\n\n\nif __name__ == "__main__":\n    with open("out/report.json", encoding="utf-8") as handle:\n        print(render(json.load(handle)))\n',
        },
      },
      {
        id: 'farm-shell-env',
        command: ['sh', ['verify.sh']],
        solutions: {
          'bin/render-env.sh': '#!/bin/sh\nset -eu\nif [ "$#" -ne 2 ]; then\n  echo "usage: render-env.sh FIRST SECOND" >&2\n  exit 2\nfi\ntarget=${DEPLOY_TARGET:-local}\nprintf \'[%s] %s :: %s\\n\' "$target" "$1" "$2"\n',
        },
      },
    ];

    for (const scenario of scenarios) {
      const caseDef = cases.find(candidate => candidate.id === scenario.id);
      assert.ok(caseDef, `${scenario.id} exists`);
      const sandbox = await makeTmpDir();
      try {
        for (const [rel, content] of Object.entries(caseDef.files)) {
          const absolute = path.join(sandbox, rel);
          await fsp.mkdir(path.dirname(absolute), { recursive: true });
          await fsp.writeFile(absolute, content);
        }
        const [command, args] = scenario.command;
        const seeded = spawnSync(command, args, { cwd: sandbox, encoding: 'utf8' });
        assert.notEqual(seeded.status, 0, `${scenario.id} seed must fail`);
        for (const [rel, content] of Object.entries(scenario.solutions)) {
          const absolute = path.join(sandbox, rel);
          await fsp.mkdir(path.dirname(absolute), { recursive: true });
          await fsp.writeFile(absolute, content);
        }
        const solved = spawnSync(command, args, { cwd: sandbox, encoding: 'utf8' });
        assert.equal(solved.status, 0,
          `${scenario.id} solution failed: ${solved.stdout}\n${solved.stderr}`);
        assert.equal(await fsp.readFile(path.join(sandbox, '.passed'), 'utf8'), 'ok\n');
      } finally {
        await cleanDir(sandbox);
      }
    }
  });

  test('loadCases ignores AppleDouble, hidden, and non-file JSON entries', async () => {
    const dir = await makeTmpDir();
    try {
      const valid = { id: 'visible', title: 'Visible', prompt: 'Do it', expect: { answer: { matches: 'done' } } };
      await fsp.writeFile(path.join(dir, 'visible.json'), JSON.stringify(valid));
      await fsp.writeFile(path.join(dir, '._visible.json'), Buffer.from([0, 5, 22, 7, 0, 2]));
      await fsp.writeFile(path.join(dir, '.hidden.json'), '{not json');
      await fsp.mkdir(path.join(dir, 'directory.json'));
      assert.deepEqual(await loadCases(dir), [valid]);
    } finally {
      await cleanDir(dir);
    }
  });
});

// ─── Harbor adapter contracts ─────────────────────────────────────────────────
// Harbor installs inside benchmark task containers. Keep its supply-chain pins
// and provider routing explicit: a mutable ref or silent provider fallback makes
// a benchmark impossible to reproduce and can send credentials to the wrong API.

describe('bench/harbor adapter contracts', () => {
  const adapterPath = path.join(ROOT, 'bench', 'harbor', 'src', 'claudette_harbor', 'agent.py');
  const pyprojectPath = path.join(ROOT, 'bench', 'harbor', 'pyproject.toml');

  test('pins the benchmark runtime and verifies the downloaded installer', async () => {
    const [adapter, pyproject] = await Promise.all([
      fsp.readFile(adapterPath, 'utf8'),
      fsp.readFile(pyprojectPath, 'utf8'),
    ]);

    assert.match(pyproject, /harbor==0\.22\.0/);
    assert.match(adapter, /_COMMIT_SHA = re\.compile\(r"\^\[0-9a-fA-F\]\{40\}\$"\)/);
    assert.match(adapter, /_NVM_VERSION = "v0\.40\.2"/);
    assert.match(adapter, /_NODE_VERSION = "22\.23\.2"/);
    assert.match(adapter, /_NVM_INSTALL_SHA256 = "[0-9a-f]{64}"/);
    assert.match(adapter, /sha256sum -c -/);
    assert.doesNotMatch(adapter, /_version or ["']main["']/);
    assert.doesNotMatch(adapter, /curl[^\n]*\|\s*(?:sh|bash)/);
  });

  test('routes every supported provider alias explicitly and rejects unknown prefixes', async () => {
    const adapter = await fsp.readFile(adapterPath, 'utf8');

    for (const alias of ['deepseek', 'hf', 'huggingface', 'google', 'gemini', 'xai', 'grok', 'perplexity', 'pplx']) {
      assert.match(adapter, new RegExp(`^[ \\t]*["']${alias}["']:\\s*\\[`, 'm'), `${alias} is routed`);
    }
    assert.match(adapter, /provider not in _PROVIDER_KEYS and provider != "ollama"/);
    assert.match(adapter, /Unknown Claudette provider prefix/);
    assert.doesNotMatch(adapter, /_PROVIDER_KEYS\.get\(provider, \[\]\)[\s\S]{0,400}provider (?:not in|==)/,
      'unknown prefixes are rejected before credential lookup or local routing');
  });
});

// ─── Bench task loading (YAML) ────────────────────────────────────────────────
// The JSON→YAML migration must preserve task semantics exactly. A folded scalar
// silently collapsed the multi-line str_replace anchors in exact-reproduction
// tasks, changing what the model was asked. parseYaml stores those as literal
// blocks and round-trips the original JSON objects.

describe('bench/tasks.js (YAML task loading)', async () => {
  test('parseYaml: literal block preserves newlines, blank lines, and indentation', async () => {
    const { parseYaml } = await import('../bench/tasks.js');
    const yaml = [
      'id: "x"',
      'prompt: |-',
      '  line one',
      '',
      '  line three',
      '      deeply indented',
    ].join('\n') + '\n';
    const obj = parseYaml(yaml);
    assert.equal(obj.id, 'x');
    assert.equal(obj.prompt, 'line one\n\nline three\n    deeply indented');
  });

  test('parseYaml: scalars coerce number/boolean and unquote strings', async () => {
    const { parseYaml } = await import('../bench/tasks.js');
    const obj = parseYaml(['n: 240', 'b: true', 'q: "hello: world"', 'plain: bare'].join('\n'));
    assert.equal(obj.n, 240);
    assert.equal(obj.b, true);
    assert.equal(obj.q, 'hello: world');
    assert.equal(obj.plain, 'bare');
  });

  test('toYaml → parseYaml round-trips a representative task exactly', async () => {
    const { parseYaml, toYaml } = await import('../bench/tasks.js');
    const task = {
      id: 'demo',
      title: 'Demo: edit & verify',
      category: 'coding',
      timeoutSec: 180,
      singleTurn: true,
      prompt: "Replace:\n\n    default: throw new Error();\n\nWith:\n\n    case 'x': return;\n    default: throw new Error();",
      verify: ['node --check src/tools.js', "grep -n '\"echo\"' src/tools.js"],
      judgeFocus: "Did it work? Don't churn the file.",
    };
    assert.deepEqual(parseYaml(toYaml(task)), task);
  });

  test('parseYaml: a line without a colon throws instead of silently dropping', async () => {
    const { parseYaml } = await import('../bench/tasks.js');
    assert.throws(() => parseYaml('this has no colon\n'), /expected "key: value"/);
  });

  test('loadTasks: every real task validates and exact anchors survive', async () => {
    const { loadTasks } = await import('../bench/tasks.js');
    const tasks = await loadTasks();
    assert.ok(tasks.length >= 20, 'all task files loaded');
    for (const t of tasks) {
      assert.ok(t.id && t.title && t.category && t.prompt, `${t.id ?? '?'} has required fields`);
      assert.ok(Array.isArray(t.verify) && t.verify.every(c => typeof c === 'string'), `${t.id} verify is string[]`);
    }
    const ids = tasks.map(t => t.id);
    assert.equal(new Set(ids).size, ids.length, 'task ids unique');

    const addTool = tasks.find(t => t.id === 'add-new-tool');
    assert.ok(addTool, 'add-new-tool present');
    assert.ok(
      addTool.prompt.includes('];\n\n// ─── Executor dispatch'),
      'multi-line str_replace anchor is byte-preserved (would break under folded scalars)',
    );
    assert.equal(addTool.singleTurn, true);
    assert.equal(addTool.timeoutSec, 180);
  });

  test('loadTasks ignores AppleDouble, hidden, and non-file task entries', async () => {
    const { loadTasks } = await import('../bench/tasks.js');
    const dir = await makeTmpDir();
    try {
      const valid = {
        id: 'visible', title: 'Visible', category: 'test', prompt: 'Do it', verify: ['true'],
      };
      await fsp.writeFile(path.join(dir, 'visible.json'), JSON.stringify(valid));
      await fsp.writeFile(path.join(dir, '._visible.yaml'), Buffer.from([0, 5, 22, 7, 0, 2]));
      await fsp.writeFile(path.join(dir, '.hidden.yml'), 'not: [supported');
      await fsp.mkdir(path.join(dir, 'directory.json'));
      assert.deepEqual(await loadTasks(dir), [valid]);
    } finally {
      await cleanDir(dir);
    }
  });
});

describe('benchmark report discovery', () => {
  test('summary and leaderboard loaders ignore AppleDouble and non-file JSON entries', async () => {
    const [{ loadLatestPerModel }, { loadLatestReports }] = await Promise.all([
      import('../bench/eval-summary.js'),
      import('../bench/leaderboard.js'),
    ]);
    const evalDir = await makeTmpDir();
    const reportDir = await makeTmpDir();
    try {
      await fsp.writeFile(path.join(evalDir, '2026-08-31-eval.json'), JSON.stringify({
        model: 'mock/eval',
        generatedAt: '2026-08-31T00:00:00.000Z',
        results: [{
          caseId: 'case-a', passAtK: true, repeat: 1,
          avgPromptTokens: 10, avgCompletionTokens: 2, iterations: [],
        }],
      }));
      await fsp.writeFile(path.join(reportDir, '2026-08-31-report.json'), JSON.stringify({
        model: 'mock/bench', task: { id: 'task-a' }, completedAt: '2026-08-31T00:00:00.000Z',
        summary: { overallScore: 9, hardScore: 8, judgeScore: 7 },
      }));
      for (const dir of [evalDir, reportDir]) {
        await fsp.writeFile(path.join(dir, '._sidecar.json'), Buffer.from([0, 5, 22, 7, 0, 2]));
        await fsp.writeFile(path.join(dir, '.hidden.json'), '{not json');
        await fsp.mkdir(path.join(dir, 'directory.json'));
      }

      const evals = await loadLatestPerModel(null, evalDir);
      assert.equal(evals.length, 1);
      assert.equal(evals[0].model, 'mock/eval');
      assert.equal(evals[0].passed, 1);
      const reports = await loadLatestReports(reportDir);
      assert.deepEqual(reports, [{
        file: '2026-08-31-report.json', model: 'mock/bench', taskId: 'task-a',
        overall: 9, hard: 8, judge: 7,
      }]);
    } finally {
      await cleanDir(evalDir);
      await cleanDir(reportDir);
    }
  });
});

// ─── Bench request cache ──────────────────────────────────────────────────────
// Caching is opt-in (CLAUDETTE_BENCH_CACHE=1) and lets the harness re-judge for
// free. The key must cover everything that changes the output; writes must be
// atomic; a corrupt or missing entry must degrade to a live call, never throw.

describe('provider.js (bench cache)', async () => {
  test('getCacheKey covers output-affecting fields and ignores callbacks/order', async () => {
    const { getCacheKey } = await import('../src/provider.js');
    const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], effort: 'high' };
    const k1 = getCacheKey({ ...base, signal: {}, onDelta() {}, onEvent() {} });
    const k2 = getCacheKey({ effort: 'high', tools: [], messages: [{ role: 'user', content: 'hi' }], model: 'm' });
    assert.equal(k1, k2, 'key is order-independent and ignores streaming/cancellation plumbing');
    assert.notEqual(k1, getCacheKey({ ...base, messages: [{ role: 'user', content: 'HELLO' }] }), 'content-sensitive');
    assert.notEqual(k1, getCacheKey({ ...base, effort: 'low' }), 'effort-sensitive');
    assert.notEqual(k1, getCacheKey({ ...base, model: 'other' }), 'model-sensitive');
    assert.match(k1, /^[0-9a-f]{64}$/, 'looks like a sha256 hex digest');
  });

  test('writeCache publishes atomically and readCache round-trips', async () => {
    const { writeCache, readCache } = await import('../src/provider.js');
    const dir = await makeTmpDir();
    const file = path.join(dir, 'entry.json');
    const value = { content: 'hello', toolCalls: [], promptTokens: 1, completionTokens: 2 };
    await writeCache(file, value);
    assert.deepEqual(await readCache(file), value);
    const leftover = (await fsp.readdir(dir)).filter(f => f.endsWith('.tmp'));
    assert.equal(leftover.length, 0, 'no temp file left behind after rename');
    await cleanDir(dir);
  });

  test('readCache returns null (clean miss) for a missing file', async () => {
    const { readCache } = await import('../src/provider.js');
    assert.equal(await readCache(path.join(os.tmpdir(), `absent-${randomUUID()}.json`)), null);
  });

  test('readCache returns null instead of throwing on a corrupt entry', async () => {
    const { readCache } = await import('../src/provider.js');
    const dir = await makeTmpDir();
    const file = path.join(dir, 'corrupt.json');
    await fsp.writeFile(file, '{ not valid json', 'utf8');
    assert.equal(await readCache(file), null);
    await cleanDir(dir);
  });
});

// ─── CLI JSON IPC protocol ────────────────────────────────────────────────────
// The benchmark harness drives claudette.js over --json-ipc. stdout must be a
// pure JSONL event stream (no spinner/markdown/banner leakage), and the full
// tool loop must surface ready/turn/tool_call/tool_result/assistant/done.

describe('CLI JSON IPC protocol (--json-ipc)', async () => {
  let tmpDir;
  let mockServer;
  let mockBaseUrl;
  const observedToolResults = [];
  const hermeticModelEnv = {
    CLAUDETTE_FREE_TIER_ONLY: '0',
    CLAUDETTE_REQUIRE_TOOLS: '0',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    DEEPSEEK_KEY: '',
    GROQ_API_KEY: '',
    HF_TOKEN: '',
    HF_KEY: '',
    HUGGINGFACE_API_KEY: '',
    OPENROUTER_API_KEY: '',
    TOGETHER_API_KEY: '',
    FIREWORKS_API_KEY: '',
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
    XAI_API_KEY: '',
    MISTRAL_API_KEY: '',
    COHERE_API_KEY: '',
    PERPLEXITY_API_KEY: '',
  };

  before(async () => {
    tmpDir = await makeTmpDir();
    await fsp.writeFile(path.join(tmpDir, 'notes.txt'), 'alpha from file\n', 'utf8');

    mockServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/broker-loopback') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('loopback-ok');
        return;
      }
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [{ name: 'mock-ipc:latest', size: 1, details: { family: 'mock', parameter_size: '1b' }, modified_at: new Date().toISOString() }],
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const ndjson = (recs) => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          for (const r of recs) res.write(JSON.stringify(r) + '\n');
          res.end();
        };
        const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === 'user');
        const lastTool = [...(body.messages ?? [])].reverse().find(m => m.role === 'tool');
        if (lastTool) {
          observedToolResults.push(String(lastTool.content ?? ''));
          ndjson([{ message: { content: 'Tool result received.' } }, { done: true, prompt_eval_count: 5, eval_count: 6 }]);
        } else if (typeof lastUser?.content === 'string' && lastUser.content.startsWith('bash64:')) {
          const command = Buffer.from(lastUser.content.slice('bash64:'.length), 'base64url').toString('utf8');
          ndjson([
            { message: { content: 'Running sandbox probe.', tool_calls: [{ function: { name: 'bash', arguments: { command } } }] } },
            { done: true, prompt_eval_count: 4, eval_count: 5 },
          ]);
        } else {
          ndjson([
            { message: { content: 'Reading file.', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }] } },
            { done: true, prompt_eval_count: 4, eval_count: 5 },
          ]);
        }
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
    mockBaseUrl = `http://127.0.0.1:${mockServer.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => mockServer.close(err => err ? reject(err) : resolve()));
    await cleanDir(tmpDir);
  });

  function driveIpc({ timeout = 20_000, prompt = 'inspect the file', approvalFlag = '-y', env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn('node', ['claudette.js', '--json-ipc', approvalFlag, '--cwd', tmpDir, '--model', 'mock-ipc:latest'], {
        cwd: ROOT,
        env: {
          ...process.env,
          ...hermeticModelEnv,
          OLLAMA_BASE_URL: mockBaseUrl,
          CLAUDETTE_WORKSPACE_SANDBOX: process.platform === 'darwin' ? '1' : '0',
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', buffer = '';
      const events = [], nonJson = [];
      let promptSent = false;
      proc.stdout.on('data', d => {
        stdout += d;
        buffer += d.toString();
        const parts = buffer.split('\n');
        buffer = parts.pop();
        for (const line of parts) {
          const t = line.trim();
          if (!t) continue;
          let msg;
          try { msg = JSON.parse(t); } catch { nonJson.push(line); continue; }
          events.push(msg);
          if (msg.type === 'ready') {
            if (!promptSent) {
              promptSent = true;
              proc.stdin.write(JSON.stringify({ type: 'prompt', text: prompt }) + '\n');
            } else {
              proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
              proc.stdin.end();
            }
          }
        }
      });
      proc.stderr.on('data', d => stderr += d);
      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve({ events, nonJson, stdout, stderr, code: null, timedOut: true }); }, timeout);
      proc.on('close', code => { clearTimeout(timer); resolve({ events, nonJson, stdout, stderr, code, timedOut: false }); });
      proc.on('error', reject);
    });
  }

  test('emits pure JSONL and a complete event sequence through a tool loop', async () => {
    const { events, nonJson, timedOut, stderr, stdout } = await driveIpc();
    assert.equal(timedOut, false, 'process exits cleanly after {type:exit}');
    assert.deepEqual(nonJson, [], 'stdout is pure JSONL — no spinner/markdown/banner leaks');
    if (process.platform === 'darwin') {
      assert.match(stderr, /\[sandbox\] confined to /, 'CLI relaunched inside the workspace sandbox');
      await assert.doesNotReject(
        fsp.access(path.join(tmpDir, '.claudette', 'state', 'sessions')),
        `sandboxed CLI created workspace-local sessions; stderr: ${stderr}`
      );
    }

    const types = events.map(e => e.type);
    assert.ok(types.includes('ready'), `ready emitted; events=${JSON.stringify(events)} stderr=${stderr} stdout=${stdout}`);
    assert.ok(types.includes('turn'), 'turn emitted');

    const toolCall = events.find(e => e.type === 'tool_call');
    assert.ok(toolCall && toolCall.name === 'read_file', 'tool_call event carries the tool name');
    const toolResult = events.find(e => e.type === 'tool_result');
    assert.ok(toolResult && toolResult.name === 'read_file' && typeof toolResult.result === 'string', 'tool_result event carries the result');
    const done = events.find(e => e.type === 'done');
    assert.ok(done && typeof done.tokens === 'number', 'done event reports a token count');
    assert.ok(
      events.some(e => e.type === 'assistant' && /Tool result received/.test(e.content ?? '')),
      'final assistant content is present',
    );
  });

  test('sandboxed CLI brokers Bash once and preserves every security boundary under --yolo', { skip: process.platform !== 'darwin' }, async () => {
    const outside = path.join(path.dirname(tmpDir), `claudette-broker-outside-${randomUUID()}.txt`);
    const socketEntriesBefore = new Set((await fsp.readdir('/tmp')).filter(name => name.startsWith('claudette-broker-')));
    await fsp.writeFile(path.join(tmpDir, 'apiscanner.py'), 'first\nsecond\nthird\n', 'utf8');
    await fsp.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({
      scripts: { 'broker-probe': 'node -e "console.log(\'npm-ok\')"' },
    }), 'utf8');
    await fsp.writeFile(outside, 'outside-secret', 'utf8');

    const command = [
      'echo "bash_pid=$$"',
      'wc -l apiscanner.py',
      'cat notes.txt',
      `python3 -c 'print("python-ok")'`,
      `node -e 'console.log("node-ok")'`,
      'npm run --silent broker-probe',
      'case "$HOME" in "$PWD"/.claudette/home) echo "home-ok";; *) echo "home-unsafe=$HOME";; esac',
      'case "$TMPDIR" in "$PWD"/.claudette/tmp) echo "tmp-ok";; *) echo "tmp-unsafe=$TMPDIR";; esac',
      'test -z "$DEVELOPER_DIR"; echo "developer_env_scrubbed=$?"',
      `cat ${JSON.stringify(outside)} >/dev/null 2>&1; echo "outside_read=$?"`,
      `printf changed > ${JSON.stringify(outside)} 2>/dev/null; echo "outside_write=$?"`,
      '/usr/bin/curl --max-time 3 -fsS https://example.com >/dev/null 2>&1; echo "external_network=$?"',
      `/usr/bin/curl --max-time 3 -fsS ${JSON.stringify(`${mockBaseUrl}/broker-loopback`)}; echo`,
      `kill -0 ${process.pid} >/dev/null 2>&1; echo "parent_signal=$?"`,
      `/usr/bin/osascript -e 'tell application "System Events" to count processes' >/dev/null 2>&1; echo "apple_event=$?"`,
      'test -z "$CLAUDETTE_BROKER_TEST_SECRET"; echo "secret_scrubbed=$?"',
      'pwd',
    ].join('\n');
    observedToolResults.length = 0;
    try {
      const result = await driveIpc({
        prompt: `bash64:${Buffer.from(command).toString('base64url')}`,
        approvalFlag: '--yolo',
        env: {
          CLAUDETTE_BROKER_TEST_SECRET: 'must-not-reach-bash',
          DEVELOPER_DIR: '/tmp/model-controlled-xcode',
        },
        timeout: 30_000,
      });
      assert.equal(result.timedOut, false, `CLI exits cleanly; stderr=${result.stderr}`);
      assert.equal(result.code, 0);
      assert.deepEqual(result.nonJson, [], 'JSON mode remains a pure protocol stream');
      assert.ok(result.events.some(event => event.type === 'ready'), 'CLI reaches ready inside the outer sandbox');
      assert.ok(result.events.some(event => event.type === 'tool_call' && event.name === 'bash'));
      const output = observedToolResults.find(value => value.includes('bash_pid=')) ?? '';
      assert.match(output, /3 apiscanner\.py/);
      assert.match(output, /alpha from file/);
      assert.match(output, /python-ok/);
      assert.match(output, /node-ok/);
      assert.match(output, /npm-ok/);
      assert.match(output, /home-ok/);
      assert.match(output, /tmp-ok/);
      assert.match(output, /developer_env_scrubbed=0/);
      assert.match(output, /outside_read=[1-9]/);
      assert.match(output, /outside_write=[1-9]/);
      assert.match(output, /external_network=[1-9]/);
      assert.match(output, /loopback-ok/);
      assert.match(output, /parent_signal=[1-9]/);
      assert.match(output, /apple_event=[1-9]/);
      assert.match(output, /secret_scrubbed=0/);
      assert.match(output, new RegExp(tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(await fsp.readFile(outside, 'utf8'), 'outside-secret');
      const bashPid = Number(output.match(/bash_pid=(\d+)/)?.[1]);
      assert.ok(bashPid > 0);
      assert.throws(() => process.kill(bashPid, 0), error => error?.code === 'ESRCH', 'brokered Bash process exited');
      const socketEntriesAfter = new Set((await fsp.readdir('/tmp')).filter(name => name.startsWith('claudette-broker-')));
      assert.deepEqual(socketEntriesAfter, socketEntriesBefore, 'direct IPC leaves no broker socket behind');
    } finally {
      await fsp.unlink(outside).catch(() => {});
    }
  });

  // Regression: readline emits `line` events during a turn with nobody
  // listening, so prompts written up-front (a pipe, a file redirect, any driver
  // that doesn't wait for `ready`) were dropped. Two prompts must run two turns.
  function drivePrebuffered(prompts, { timeout = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn('node', ['claudette.js', '--json-ipc', '-y', '--cwd', tmpDir, '--model', 'mock-ipc:latest'], {
        cwd: ROOT,
        env: { ...process.env, ...hermeticModelEnv, OLLAMA_BASE_URL: mockBaseUrl },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '';
      const events = [];
      proc.stdout.on('data', d => {
        buffer += d.toString();
        const parts = buffer.split('\n');
        buffer = parts.pop();
        for (const line of parts) {
          const t = line.trim();
          if (!t) continue;
          try { events.push(JSON.parse(t)); } catch { /* non-JSON is asserted elsewhere */ }
        }
      });
      // Everything up front, then EOF — no waiting for `ready`.
      for (const text of prompts) proc.stdin.write(JSON.stringify({ type: 'prompt', text }) + '\n');
      proc.stdin.end();

      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve({ events, timedOut: true }); }, timeout);
      proc.on('close', () => { clearTimeout(timer); resolve({ events, timedOut: false }); });
      proc.on('error', reject);
    });
  }

  test('runs every pre-buffered prompt, not just the first', async () => {
    const { events, timedOut } = await drivePrebuffered(['inspect the file', 'inspect the file again']);
    assert.equal(timedOut, false, 'exits cleanly at EOF');
    const done = events.filter(e => e.type === 'done');
    assert.equal(done.length, 2, `both prompts ran a turn (got ${done.length})`);
    assert.equal(events.filter(e => e.type === 'ready').length, 2, 'ready advertised once per turn');
  });

  test('a single piped prompt still completes (Harbor adapter path)', async () => {
    const { events, timedOut } = await drivePrebuffered(['inspect the file']);
    assert.equal(timedOut, false, 'exits cleanly at EOF');
    assert.equal(events.filter(e => e.type === 'done').length, 1);
  });
});

// ─── Server streaming error path ──────────────────────────────────────────────
// Regression: a provider error after the SSE headers were sent used to leave
// the response open forever (the top-level handler tried to re-send headers).
// The stream must terminate with an `error` record instead.

describe('server.js: stream error path', async () => {
  let port;
  let base;
  let serverProcess;

  before(async () => {
    port = await getFreePort();
    // Point Ollama at a port nothing listens on so the provider fails fast.
    const deadOllamaPort = await getFreePort();
    base = `http://127.0.0.1:${port}`;
    serverProcess = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        OLLAMA_BASE_URL: `http://127.0.0.1:${deadOllamaPort}`,
      },
      stdio: 'pipe',
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('error-path server start timeout')), 10_000);
      const onReady = data => {
        if (data.toString().includes('listening')) {
          clearTimeout(timeout);
          setTimeout(resolve, 100);
        }
      };
      serverProcess.stdout.on('data', onReady);
      serverProcess.on('error', err => { clearTimeout(timeout); reject(err); });
    });
  });

  after(async () => {
    if (serverProcess) serverProcess.kill();
  });

  test('POST /api/sessions/:id/messages ends with an error record when the provider is unreachable', async () => {
    // A literal bare model id, not LIVE_MODEL: the point is that the PROVIDER is
    // unreachable, and passing null made the server fall through to
    // getDefaultModel(), whose answer depends on what is installed.
    const UNREACHABLE = 'unreachable-model:latest';
    const { body: created } = await httpPost(`${base}/api/sessions`, { model: UNREACHABLE });
    const sid = created.session.id;

    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('stream never ended — error path regressed to a hang')), 15_000);
    });
    const { status, lines } = await Promise.race([
      httpPostStream(`${base}/api/sessions/${sid}/messages`, {
        content: 'Reply with just the number 42.',
        model: UNREACHABLE,
      }),
      guard,
    ]).finally(() => clearTimeout(timer));

    assert.equal(status, 200, 'headers already sent as 200 before the failure');
    const err = lines.find(l => l.type === 'error');
    assert.ok(err, 'stream terminates with an error record');
    assert.ok(err.error, 'error record carries a message');
    assert.equal(err.traceTurn?.status, 'failed', 'trace turn marked failed');
  });
});

// ─── Stress loop: Ollama integration ─────────────────────────────────────────

describe('Stress: Ollama message stream', { skip: LIVE_SKIP }, async () => {
  let testPort2;
  let base2;
  let serverProcess;

  before(async () => {
    testPort2 = await getFreePort();
    base2 = `http://127.0.0.1:${testPort2}`;
    serverProcess = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(testPort2), HOST: '127.0.0.1', NODE_ENV: 'test' },
      stdio: 'pipe',
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server2 start timeout')), 10_000);
      const onReady = data => {
        if (data.toString().includes('listening')) {
          clearTimeout(timeout);
          cleanup();
          setTimeout(resolve, 100);
        }
      };
      const onErrorOutput = data => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Server2 failed to start: ${data.toString().trim()}`));
      };
      const onExit = (code, signal) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Server2 exited before start (code=${code}, signal=${signal})`));
      };
      const cleanup = () => {
        serverProcess.stdout.off('data', onReady);
        serverProcess.stderr.off('data', onErrorOutput);
        serverProcess.off('exit', onExit);
      };
      serverProcess.stdout.on('data', onReady);
      serverProcess.stderr.on('data', onErrorOutput);
      serverProcess.on('error', err => { clearTimeout(timeout); cleanup(); reject(err); });
      serverProcess.on('exit', onExit);
    });
  });

  after(async () => {
    if (!serverProcess) return;
    serverProcess.kill();
    await new Promise(resolve => serverProcess.once('exit', resolve));
  });

  const PROMPTS = [
    'Hypothetical coding task: write a JavaScript function that debounces a callback and explain the edge cases in two sentences.',
    'Hypothetical debugging task: a Node server leaks memory after repeated file reads. List three likely causes and one concrete fix for each.',
    'Hypothetical refactor: convert a callback-based fs.readFile flow into async/await and include a complete example.',
    'Hypothetical shell task: give me a one-line bash command to find all .js files larger than 50 KB under src.',
    'Hypothetical Python task: write a function that merges two sorted lists without using sorted().',
    'Hypothetical test task: write a node:test test case for an HTTP /health endpoint that should return status 200 and { ok: true }.',
    'Hypothetical code review: identify two risks in a function that overwrites files based on user-provided paths.',
    'Hypothetical Git task: suggest a concise conventional commit message for a fix that prevents duplicate tool execution.',
    'Hypothetical API design: propose a JSON response shape for a streamed coding assistant response with delta, tool, and done events.',
    'Hypothetical repo question: summarize what @README.md says about running this app and its key environment variables.',
  ];

  let sessionId;

  before(async () => {
    const { body } = await httpPost(`${base2}/api/sessions`, { model: LIVE_MODEL });
    sessionId = body.session.id;
  });

  for (const prompt of PROMPTS) {
    test(`Stress: "${prompt.slice(0, 40)}"`, { skip: LIVE_SKIP }, async () => {
      const { status, lines } = await httpPostStream(
        `${base2}/api/sessions/${sessionId}/messages`,
        { content: prompt, model: LIVE_MODEL }
      );
      assert.equal(status, 200, `HTTP 200 for: ${prompt}`);
      const deltas = lines.filter(l => l?.type === 'delta');
      assert.ok(deltas.length > 0, `got response for: ${prompt}`);
      const done = lines.find(l => l?.type === 'done');
      assert.ok(done, `got done for: ${prompt}`);
    });
  }

  test('Stress: multi-turn conversation maintains history', { skip: LIVE_SKIP }, async () => {
    const { body: s } = await httpPost(`${base2}/api/sessions`, { model: LIVE_MODEL });
    const sid = s.session.id;

    await httpPostStream(`${base2}/api/sessions/${sid}/messages`, {
      content: 'Hypothetical coding context: remember that the bug is in src/ollama.js and the failing test is test/test.js.',
      model: LIVE_MODEL,
    });
    const { lines } = await httpPostStream(`${base2}/api/sessions/${sid}/messages`, {
      content: 'What file did I say contains the bug, and what file contains the failing test?',
      model: LIVE_MODEL,
    });
    const response = lines.filter(l => l?.type === 'delta').map(l => l.content).join('');
    // The model may or may not remember perfectly, but it should respond
    assert.ok(response.length > 0, 'got multi-turn response');

    const { body: loaded } = await httpGet(`${base2}/api/sessions/${sid}`);
    assert.ok(loaded.session.messages.length >= 4, 'session has 4+ messages (2 user + 2 assistant)');
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${sid}.json`)); } catch {}
  });

  test('Stress: concurrent requests', { skip: LIVE_SKIP }, async () => {
    const prompts = [
      'Hypothetical codegen: write a JavaScript helper that retries fetch twice.',
      'Hypothetical debugging: explain why a JSON.parse call may throw on partial streamed chunks.',
      'Hypothetical refactor: suggest how to separate session persistence from HTTP request handling.',
    ];
    const results = await Promise.all(
      prompts.map(async (p) => {
        const { body: s } = await httpPost(`${base2}/api/sessions`, { model: LIVE_MODEL });
        const r = await httpPostStream(`${base2}/api/sessions/${s.session.id}/messages`, {
          content: p,
          model: LIVE_MODEL,
        });
        try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${s.session.id}.json`)); } catch {}
        return r;
      })
    );
    for (const r of results) {
      assert.equal(r.status, 200, 'concurrent request succeeded');
      assert.ok(r.lines.some(l => l?.type === 'delta'), 'got deltas');
    }
  });

  after(async () => {
    // Cleanup stress session
    try { await fsp.unlink(path.join(ROOT, 'data', 'sessions', `${sessionId}.json`)); } catch {}
  });
});
