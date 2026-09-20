// Run only through test-native-clipboard.swift, which preserves the clipboard.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { copyToClipboard } from '../src/clipboard.js';

const marker = process.env.CLAUDETTE_CLIPBOARD_TEST_MARKER;
assert.ok(marker && process.platform === 'darwin', 'Run through the Swift clipboard-preservation wrapper on macOS.');
const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudette-native-clipboard-'));
let chatRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ models: [{ name: 'mock-copy:latest', size: 1, capabilities: ['tools'] }] }));
  } else {
    chatRequests++;
    res.writeHead(500).end('Clipboard command must not call a model');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelBase = `http://127.0.0.1:${server.address().port}`;
const modelEnv = Object.fromEntries(Object.entries(process.env).map(([key, value]) =>
  [key, /KEY|TOKEN|SECRET|PASSWORD/i.test(key) ? '' : value]));

async function runCopy(messages, input = '/copy\n', sandbox = true) {
  const workspace = await fs.mkdtemp(path.join(root, 'workspace-'));
  const stateDir = path.join(workspace, '.claudette', 'state');
  await fs.mkdir(path.join(stateDir, 'sessions'), { recursive: true });
  const session = {
    id: randomUUID(), model: 'mock-copy:latest', cwd: workspace, title: 'clipboard fixture',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages, turns: [],
  };
  const sessionPath = path.join(stateDir, 'sessions', `${session.id}.json`);
  await fs.writeFile(sessionPath, JSON.stringify(session));
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['claudette.js', '--yolo', '--cwd', workspace, '--resume', session.id], {
      env: {
        ...modelEnv, NODE_ENV: 'test', OLLAMA_BASE_URL: modelBase,
        CLAUDETTE_FREE_TIER_ONLY: '0', CLAUDETTE_REQUIRE_TOOLS: '0', CLAUDETTE_ALWAYS_TRACK: '0',
        CLAUDETTE_MODEL_ROTATION: '0', CLAUDETTE_WORKSPACE_SANDBOX: sandbox ? '1' : '0',
        CLAUDETTE_DATA_DIR: stateDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', reject);
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Clipboard CLI timed out')); }, 20000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Clipboard CLI exit ${code}: ${stderr}`));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
  const loaded = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
  assert.deepEqual(loaded.messages, messages, 'Copy must preserve saved conversation');
  return output;
}

try {
  for (const [name, body] of [
    ['Unicode and Markdown', '\n**你好 🌍**\n```js\nconst café = "é";\n```\n'],
    ['shell metacharacters', '$(touch must-not-exist) `touch neither` \' " & | ; < > \\'],
    ['large reply', 'abcd你好🌍\n'.repeat(100000)],
  ]) {
    const answer = `${marker}\n${body}`;
    await copyToClipboard(`${marker}\nreset`);
    const messages = [
      { role: 'assistant', content: 'old answer' },
      { role: 'assistant', content: answer },
      { role: 'tool', content: 'do not copy this tool result' },
      { role: 'user', content: 'do not copy this prompt' },
      { role: 'assistant', content: '  ' },
    ];
    const output = await runCopy(messages);
    assert.match(output, /Copied the last assistant message/);
    const { stdout } = await exec('/usr/bin/pbpaste', [], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.ok(stdout === answer, `${name}: native clipboard bytes differ`);
    console.log(`PASS: sandboxed CLI /copy — ${name} (${Buffer.byteLength(answer)} bytes)`);
  }
  for (const [name, messages, command, expected] of [
    ['empty history', [], '/copy\n', /No assistant message/],
    ['invalid arguments', [{ role: 'assistant', content: 'answer' }], '/copy extra\n', /Usage: \/copy/],
  ]) {
    const sentinel = `${marker}\n${name}`;
    await copyToClipboard(sentinel);
    assert.match(await runCopy(messages, command), expected);
    const { stdout } = await exec('/usr/bin/pbpaste', [], { encoding: 'utf8' });
    assert.ok(stdout === sentinel, `${name}: clipboard unexpectedly changed`);
    console.log(`PASS: ${name} leaves clipboard unchanged`);
  }
  const direct = `${marker}\nunsandboxed copy`;
  assert.match(await runCopy([{ role: 'assistant', content: direct }], '/copy\n', false), /Copied the last assistant message/);
  assert.ok((await exec('/usr/bin/pbpaste', [], { encoding: 'utf8' })).stdout === direct);
  assert.equal(chatRequests, 0, 'Slash command must never invoke the model');
  console.log('PASS: unsandboxed CLI /copy; zero model requests across all six cases');
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
