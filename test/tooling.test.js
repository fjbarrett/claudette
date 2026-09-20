import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url));
async function fixture(t, code) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-launcher-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'scripts'));
  await fsp.mkdir(path.join(root, 'test'));
  await fsp.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fsp.copyFile(source, path.join(root, 'scripts/run-tests.mjs'));
  if (code) await fsp.writeFile(path.join(root, 'test', "space 日本語 '$.test.js"), code);
  return root;
}
function isolatedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Nested fixture coverage must not pollute the enclosing suite's report.
  delete env.NODE_V8_COVERAGE;
  return env;
}
function run(root, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/run-tests.mjs'), '--test-reporter=tap', ...args], {
    cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000,
    env: isolatedEnv(env),
  });
}

test('test launcher discovers literal unusual paths and sets offline environment', async t => {
  const root = await fixture(t, `
    import {test} from 'node:test';
    import assert from 'node:assert/strict';
    test('environment', () => {
      assert.equal(process.env.NODE_ENV, 'test');
      assert.equal(process.env.CLAUDETTE_SKIP_LIVE, '1');
      for (const key of ['CLAUDETTE_FREE_TIER_ONLY','CLAUDETTE_REQUIRE_TOOLS','CLAUDETTE_ALWAYS_TRACK','CLAUDETTE_MODEL_ROTATION']) assert.equal(process.env[key], '0');
    });
  `);
  const result = run(root, [], { NODE_ENV: 'production', CLAUDETTE_MODEL_ROTATION: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 1/);
});

test('live test selection clears an inherited live-skip flag', async t => {
  const root = await fixture(t, `
    import {test} from 'node:test';
    import assert from 'node:assert/strict';
    test('live selection', () => assert.equal(process.env.CLAUDETTE_SKIP_LIVE, undefined));
  `);
  const result = run(root, ['--live'], { CLAUDETTE_SKIP_LIVE: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('test launcher propagates test failures and rejects an empty suite', async t => {
  const root = await fixture(t, `
    import {test} from 'node:test';
    import assert from 'node:assert/strict';
    test('intentional failure', () => assert.fail('fixture failure retained'));
  `);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /fixture failure retained/);
  const empty = await fixture(t, null);
  const missing = run(empty);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No test files found/);
});

test('coverage command enforces its thresholds instead of accepting successful assertions alone', async t => {
  const root = await fixture(t, `
    import {test} from 'node:test';
    import '../source.js';
    test('passing assertion', () => {});
  `);
  await fsp.writeFile(path.join(root, 'source.js'), `export function notExecuted() {
    let total = 0;
    total += 1;
    total += 2;
    total += 3;
    total += 4;
    total += 5;
    total += 6;
    total += 7;
    total += 8;
    return total;
  }
  `);
  const result = run(root, ['--coverage']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  if (Number(process.versions.node.split('.')[0]) < 22) {
    assert.match(result.stderr, /cannot enforce coverage thresholds/);
  } else {
    assert.match(result.stdout, /# pass 1/);
    assert.match(result.stdout + result.stderr, /coverage.*(?:threshold|70)|threshold.*coverage/i);
  }
});

test('coverage command passes when executed source meets its thresholds', async t => {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    t.skip('Node 20 does not support coverage thresholds');
    return;
  }
  const root = await fixture(t, `
    import {test} from 'node:test';
    import assert from 'node:assert/strict';
    import {answer} from '../source.js';
    test('covered source', () => assert.equal(answer(), 42));
  `);
  await fsp.writeFile(path.join(root, 'source.js'), 'export function answer() { return 42; }\n');
  const result = run(root, ['--coverage']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('stress coordinator executes nested tests and stops at the first failing batch', async t => {
  const root = await fixture(t, `
    import {test} from 'node:test';
    import assert from 'node:assert/strict';
    test('intentional failure', () => assert.fail('stress failure retained'));
  `);
  await fsp.copyFile(new URL('../scripts/stress-streams.mjs', import.meta.url), path.join(root, 'scripts/stress-streams.mjs'));
  await fsp.rename(path.join(root, 'test', "space 日本語 '$.test.js"), path.join(root, 'test/streaming.test.js'));
  const output = path.join(root, 'results');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/stress-streams.mjs'),
    '--batches', '2', '--seed', '42', '--output', output], {
    cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000,
    env: isolatedEnv({ NODE_TEST_CONTEXT: 'child-v8' }),
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const records = (await fsp.readFile(path.join(output, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 1, 'a failed batch must stop subsequent batches');
  assert.equal(records[0].seed, 42);
  assert.equal(records[0].code, 1);
  assert.match(await fsp.readFile(records[0].log, 'utf8'), /stress failure retained/);
});

test('test launcher forwards interruption and returns a nonzero status', { timeout: 15000 }, async t => {
  const root = await fixture(t, `
    import {test} from 'node:test';
    test('held', async () => {
      console.log('FIXTURE_READY:' + process.pid);
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `);
  const child = spawn(process.execPath, [path.join(root, 'scripts/run-tests.mjs'), '--test-reporter=tap'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: isolatedEnv(),
  });
  let workerPid;
  t.after(() => {
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch {} }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /FIXTURE_READY:(\d+)/.exec(output);
      if (match) { workerPid = Number(match[1]); resolve(); }
    });
    child.on('error', reject);
    child.on('close', () => reject(new Error('fixture exited before readiness')));
  });
  await ready;
  child.kill('SIGTERM');
  const result = await closed;
  assert.equal(result.code, 143);
  assert.equal(result.signal, null);
});
