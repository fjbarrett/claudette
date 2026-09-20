import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeTool, capBashOutput, resolveBashTimeout, createBashBrokerExecutor } from '../src/tools.js';
import { runBashProcess } from '../src/bash-process.js';

function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function configure(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}
async function fixture(t, source) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-shell-')));
  const program = path.join(root, "producer 日本語 '$.cjs");
  await fsp.writeFile(program, source);
  t.after(async () => {
    try {
      const pid = Number(await fsp.readFile(path.join(root, 'worker.pid'), 'utf8'));
      if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    } catch {}
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, command: `${quote(process.execPath)} ${quote(program)}` };
}
async function waitForPid(root) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return Number(await fsp.readFile(path.join(root, 'worker.pid'), 'utf8')); } catch {}
    await delay(10);
  }
  throw new Error('fixture worker did not start');
}
async function stopped(pid) {
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    await delay(10);
  }
  return false;
}
const stubborn = `
  require('node:fs').writeFileSync('worker.pid', String(process.pid));
  process.on('SIGTERM', () => {});
  setTimeout(() => process.exit(0), 2000);
`;

test('Bash preserves stdout and stderr with UTF-8 split into individual writes', async t => {
  const text = '日本語 🧪 café é\r\n';
  const { root, command } = await fixture(t, `
    const fs = require('node:fs');
    (async () => {
      for (const fd of [1, 2]) for (const byte of Buffer.from(${JSON.stringify(text)})) {
        fs.writeSync(fd, Buffer.from([byte]));
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    })();
  `);
  const output = await executeTool('bash', { command }, { cwd: root, workspace: root });
  assert.equal(output, `${text}\n${text}`.trim());
});

test('Bash caps failed command output while retaining the final error', async t => {
  configure(t, { CLAUDETTE_BASH_OUTPUT_CHARS: '1000' });
  const { root, command } = await fixture(t, `
    require('node:fs').writeSync(1, 'HEAD\\n' + 'x'.repeat(250000));
    require('node:fs').writeSync(2, '\\nFINAL DIAGNOSTIC 日本語');
    process.exitCode = 7;
  `);
  await assert.rejects(executeTool('bash', { command }, { cwd: root, workspace: root }), error => {
    assert.ok(error.message.length < 1500, `failed output has ${error.message.length} characters`);
    assert.match(error.message, /HEAD/);
    assert.match(error.message, /FINAL DIAGNOSTIC 日本語/);
    assert.match(error.message, /truncated/);
    return true;
  });
});

test('Bash distinguishes the capture limit from a command timeout', async t => {
  const { root, command } = await fixture(t, `
    require('node:fs').writeSync(1, 'x'.repeat(3 * 1024 * 1024));
  `);
  await assert.rejects(executeTool('bash', { command }, { cwd: root, workspace: root }), error => {
    assert.match(error.message, /output.*(?:limit|large)|(?:buffer|capture) limit/i);
    assert.doesNotMatch(error.message, /timed out/i);
    assert.ok(error.message.length < 17000);
    return true;
  });
});

for (const reason of ['abort', 'timeout']) {
  test(`Bash ${reason} stops a child that outlives its shell`, { timeout: 8000, skip: process.platform === 'win32' }, async t => {
    configure(t, { CLAUDETTE_BASH_TIMEOUT: reason === 'timeout' ? '300' : '5000' });
    const { root, command } = await fixture(t, stubborn);
    const controller = new AbortController();
    const result = executeTool('bash', { command: `${command} & wait` }, {
      cwd: root, workspace: root, signal: controller.signal,
    }).catch(error => error);
    const pid = await waitForPid(root);
    if (reason === 'abort') controller.abort();
    const error = await result;
    assert.ok(error instanceof Error);
    assert.match(error.message, reason === 'abort' ? /interrupted/ : /timed out/);
    assert.equal(await stopped(pid), true, `worker ${pid} survived ${reason}`);
  });
}

test('Bash timeout also stops a foreground process that ignores SIGTERM', { timeout: 8000 }, async t => {
  configure(t, { CLAUDETTE_BASH_TIMEOUT: '150' });
  const { root, command } = await fixture(t, stubborn);
  const start = Date.now();
  await assert.rejects(executeTool('bash', { command }, { cwd: root, workspace: root }), /timed out/);
  assert.ok(Date.now() - start < 1200, 'timeout must not wait for the stubborn command to finish');
  assert.equal(await stopped(await waitForPid(root)), true);
});

test('Bash output truncation preserves complete Unicode characters across small budgets', () => {
  for (const content of ['🧪'.repeat(100), 'a🧪é日本語'.repeat(100)]) {
    for (let limit = 1; limit <= 64; limit++) {
      const output = capBashOutput(content, { CLAUDETTE_BASH_OUTPUT_CHARS: String(limit) });
      assert.equal(Buffer.from(output).toString('utf8'), output, `invalid Unicode at budget ${limit}`);
      assert.match(output, /truncated/);
    }
  }
});

test('Bash timeout overrides stay within timer bounds and never silently disable the deadline', () => {
  for (const [value, expected] of [
    ['0.5', 1], ['0.000001', 1], ['1.9', 1], ['300', 300],
    ['2147483647', 2147483647], ['2147483648', 2147483647], ['1e100', 2147483647],
    ['', 120000], ['0', 120000], ['-1', 120000], ['NaN', 120000], ['Infinity', 120000],
  ]) assert.equal(resolveBashTimeout({ CLAUDETTE_BASH_TIMEOUT: value }), expected, value);
});

test('cancelling one Bash command leaves a simultaneous sibling command running', async t => {
  const first = await fixture(t, stubborn);
  const second = await fixture(t, `
    require('node:fs').writeFileSync('worker.pid', String(process.pid));
    setTimeout(() => console.log('sibling completed 日本語'), 300);
  `);
  const controller = new AbortController();
  const cancelled = executeTool('bash', { command: `${first.command} & wait` }, {
    cwd: first.root, workspace: first.root, signal: controller.signal,
  }).catch(error => error);
  const sibling = executeTool('bash', { command: second.command }, { cwd: second.root, workspace: second.root });
  await Promise.all([waitForPid(first.root), waitForPid(second.root)]);
  controller.abort();
  assert.match((await cancelled).message, /interrupted/);
  assert.equal(await sibling, 'sibling completed 日本語');
});

test('strict macOS broker executor stops cancelled command descendants', { skip: process.platform !== 'darwin' }, async t => {
  const { root, command } = await fixture(t, stubborn);
  const wrapperBin = path.join(root, 'wrapper-bin');
  await fsp.mkdir(wrapperBin);
  const execute = await createBashBrokerExecutor({ workspace: root, wrapperBin });
  const controller = new AbortController();
  const running = execute({ command: `${command} & wait`, cwd: root, signal: controller.signal }).catch(error => error);
  const pid = await waitForPid(root);
  controller.abort();
  assert.match((await running).message, /interrupted/);
  assert.equal(await stopped(pid), true);
});

test('a pre-aborted Bash command cannot create a file', async t => {
  const { root } = await fixture(t, '');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeTool('bash', { command: 'printf unexpected > started.txt' }, {
    cwd: root, workspace: root, signal: controller.signal,
  }), /interrupted/);
  await assert.rejects(fsp.stat(path.join(root, 'started.txt')), { code: 'ENOENT' });
});

test('an intentionally backgrounded successful command keeps its explicit lifecycle', async t => {
  const { root, command } = await fixture(t, stubborn);
  const output = await executeTool('bash', { command: `${command} > child.log 2>&1 &` }, { cwd: root, workspace: root });
  assert.equal(output, '(exit 0, no output)');
  const pid = await waitForPid(root);
  assert.doesNotThrow(() => process.kill(pid, 0));
});

test('simultaneous Bash commands retain their own bounded stdout and stderr', async t => {
  configure(t, { CLAUDETTE_BASH_OUTPUT_CHARS: '1000' });
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const { root, command } = await fixture(t, `
      const fs = require('node:fs');
      fs.writeSync(1, 'HEAD ${index}\\n' + '🧪日本語'.repeat(2000));
      fs.writeSync(2, '\\nTAIL ${index}');
    `);
    const output = await executeTool('bash', { command }, { cwd: root, workspace: root });
    assert.ok(output.startsWith(`HEAD ${index}\n`));
    assert.ok(output.endsWith(`TAIL ${index}`));
    assert.ok(output.length < 1200);
    assert.equal(Buffer.from(output).toString('utf8'), output);
  }));
});

test('foreground process launch and external signal errors retain their actual cause', async t => {
  const { root } = await fixture(t, '');
  await assert.rejects(runBashProcess({ file: path.join(root, 'missing-executable'), args: [], env: process.env }, {
    cwd: root, timeout: 2000,
  }), { code: 'ENOENT' });
  await assert.rejects(executeTool('bash', { command: 'kill -TERM $$' }, { cwd: root, workspace: root }), error => {
    assert.match(error.message, /SIGTERM/);
    assert.doesNotMatch(error.message, /timed out/);
    return true;
  });
});
