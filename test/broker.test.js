import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fork } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachBashBroker, createBashBrokerClient } from '../src/bash-broker.js';

const envelope = { channel: 'claudette-bash-broker', version: 1 };
async function until(predicate, description) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(description);
    await delay(1);
  }
}
function parentFixture(t, execute) {
  const channel = new EventEmitter();
  channel.connected = true;
  const sent = [];
  channel.send = (message, callback) => { sent.push(message); callback?.(null); };
  const close = attachBashBroker(channel, { workspace: '/fixed/workspace', execute });
  t.after(close);
  channel.emit('message', { ...envelope, type: 'hello' });
  const token = sent.find(message => message.type === 'ready').token;
  const message = (id, overrides = {}) => ({ ...envelope, type: 'request', token,
    id, command: id, cwd: '/fixed/workspace', ...overrides });
  return { channel, sent, message, close, token };
}
function linkedFixture(t, execute) {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const channel of [parent, child]) {
    channel.connected = true;
    channel.referenced = true;
    channel.channel = {
      ref() { channel.referenced = true; }, unref() { channel.referenced = false; },
    };
  }
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.send = (message, callback) => {
      queueMicrotask(() => { if (to.connected) to.emit('message', structuredClone(message)); });
      callback?.(null);
    };
  }
  const closeParent = attachBashBroker(parent, { workspace: '/fixed/workspace', execute });
  const client = createBashBrokerClient(child);
  const disconnect = () => {
    parent.connected = child.connected = false;
    parent.emit('disconnect'); child.emit('disconnect');
  };
  t.after(() => { client.close(); closeParent(); });
  return { client, parent, child, disconnect };
}

test('broker reports synchronous executor failures and accepts a subsequent request', async t => {
  const { channel, sent, message } = parentFixture(t, ({ command }) => {
    if (command === 'throws') throw new Error('synchronous fixture failure');
    return 'recovered 日本語';
  });
  assert.doesNotThrow(() => channel.emit('message', message('throws')));
  await until(() => sent.some(m => m.id === 'throws'), 'missing synchronous error response');
  assert.match(sent.find(m => m.id === 'throws').error, /synchronous fixture failure/);
  channel.emit('message', message('next'));
  await until(() => sent.some(m => m.id === 'next'), 'next request did not complete');
  assert.equal(sent.find(m => m.id === 'next').result, 'recovered 日本語');
});

test('closing a broker client cancels all outstanding commands', async t => {
  const signals = [];
  const { client, child } = linkedFixture(t, ({ signal }) => new Promise((_, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('executor cancelled')), { once: true });
  }));
  await client.ready();
  const requests = Array.from({ length: 32 }, (_, i) => client.run(`held-${i}`, '/fixed/workspace')
    .then(value => ({ value }), error => ({ error })));
  await until(() => signals.length === 32, 'commands did not start');
  client.close();
  const results = await Promise.all(requests);
  assert.ok(results.every(result => /client closed/.test(result.error?.message)));
  await until(() => signals.every(signal => signal.aborted), 'client close left commands running');
  assert.equal(child.referenced, false);
});

test('broker isolates 96 interleaved successes, failures, and repeated cancellations', async t => {
  const pending = new Map();
  let cancellations = 0;
  const { client, child } = linkedFixture(t, ({ command, signal }) => new Promise((resolve, reject) => {
    pending.set(command, { resolve, reject });
    signal.addEventListener('abort', () => { cancellations++; reject(new Error('executor cancelled')); }, { once: true });
  }));
  await client.ready();
  const controllers = Array.from({ length: 96 }, () => new AbortController());
  const requests = controllers.map((controller, index) => client.run(String(index), '/fixed/workspace', controller.signal)
    .then(value => ({ value }), error => ({ error })));
  await until(() => pending.size === 96, 'concurrent requests did not start');
  for (let index = 95; index >= 0; index--) {
    if (index % 5 === 0) {
      controllers[index].abort(); controllers[index].abort(); controllers[index].abort();
    } else if (index % 5 === 1) pending.get(String(index)).reject(new Error(`failure-${index}`));
    else pending.get(String(index)).resolve(`response-${index}:日本語 🧪`);
  }
  const results = await Promise.all(requests);
  for (let index = 0; index < results.length; index++) {
    if (index % 5 === 0) assert.match(results[index].error.message, /interrupted/);
    else if (index % 5 === 1) assert.equal(results[index].error.message, `failure-${index}`);
    else assert.equal(results[index].value, `response-${index}:日本語 🧪`);
    assert.equal(getEventListeners(controllers[index].signal, 'abort').length, 0);
  }
  await until(() => cancellations === 20, 'cancellation delivery count differs');
  assert.equal(child.referenced, false);
});

test('disconnect rejects concurrent callers and aborts every active executor', async t => {
  const signals = [];
  const { client, child, disconnect } = linkedFixture(t, ({ signal }) => new Promise((_, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('disconnected')), { once: true });
  }));
  await client.ready();
  const controllers = Array.from({ length: 48 }, () => new AbortController());
  const running = controllers.map((controller, i) => client.run(String(i), '/fixed/workspace', controller.signal).catch(error => error));
  await until(() => signals.length === 48, 'disconnect fixture did not start');
  disconnect();
  const results = await Promise.all(running);
  assert.ok(results.every(error => /disconnected/.test(error.message)));
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok(controllers.every(controller => getEventListeners(controller.signal, 'abort').length === 0));
  assert.equal(child.referenced, false);
});

test('invalid broker request fields never reach the fixed executor', async t => {
  let executed = 0;
  const { channel, message, sent } = parentFixture(t, () => { executed++; return 'unexpected'; });
  const mutations = [
    ...[undefined, null, 0, false, '', [], {}, 'x'.repeat(1_000_001)].map(command => ({ command })),
    ...[undefined, null, 0, false, '', [], {}, 'x'.repeat(16_385)].map(cwd => ({ cwd })),
    ...[undefined, null, 0, false, '', [], {}, 'x'.repeat(129)].map(id => ({ id })),
    ...[undefined, null, 0, false, '', [], {}, 'invalid-token'].map(token => ({ token })),
    ...[undefined, null, 0, '1', 2].map(version => ({ version })),
    { env: { PATH: '/untrusted' } }, { workspace: '/untrusted' }, { executable: '/untrusted' },
  ];
  for (const [index, mutation] of mutations.entries()) channel.emit('message', message(`invalid-${index}`, mutation));
  await delay(0);
  assert.equal(executed, 0);
  assert.equal(sent.filter(m => m.type === 'rejected').length, mutations.length);
});

test('an active duplicate request is rejected without replacing the original command', async t => {
  let resolve;
  let executed = 0;
  const { channel, message, sent } = parentFixture(t, () => {
    executed++; return new Promise(done => { resolve = done; });
  });
  channel.emit('message', message('same'));
  channel.emit('message', message('same'));
  await until(() => executed === 1, 'original request did not start');
  assert.equal(sent.filter(m => m.type === 'rejected').length, 1);
  resolve('original result');
  await until(() => sent.some(m => m.type === 'result'), 'original result was lost');
  assert.equal(sent.find(m => m.type === 'result').result, 'original result');
});

async function ipcFixture(t, source, execute) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-broker-'));
  const file = path.join(root, 'actor.mjs');
  const moduleUrl = new URL('../src/bash-broker.js', import.meta.url).href;
  await fsp.writeFile(file, `
    import { createBashBrokerClient } from ${JSON.stringify(moduleUrl)};
    const deadline = setTimeout(() => process.exit(2), 5000);
    const client = createBashBrokerClient(process);
    await client.ready();
    ${source}
    clearTimeout(deadline);
    process.disconnect();
  `);
  const child = fork(file, [], { execArgv: ['--unhandled-rejections=strict'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  const messages = [];
  child.on('message', message => { if (message.scenario) messages.push(message); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  exited.catch(() => {});
  const closeParent = attachBashBroker(child, {
    workspace: '/fixed/workspace', execute: request => execute(request, child),
  });
  t.after(async () => {
    closeParent();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { child, messages, exited, stderr: () => stderr };
}

test('real IPC retains synchronous, async, and result-conversion failures without killing the broker', async t => {
  const actor = await ipcFixture(t, `
    const results = await Promise.all(Array.from({ length: 72 }, (_, index) =>
      client.run(String(index), '/fixed/workspace').then(value => ({ value }), error => ({ error: error.message }))));
    process.send({ scenario: 'results', results });
    client.close();
  `, ({ command }) => {
    const index = Number(command);
    if (index % 4 === 0) throw new Error(`sync-${index}`);
    if (index % 4 === 1) return Promise.reject(new Error(`async-${index}`));
    if (index % 4 === 2) return { toString() { throw new Error(`conversion-${index}`); } };
    return Promise.resolve(`result-${index}:日本語 🧪`);
  });
  const exit = await actor.exited;
  assert.deepEqual(exit, { code: 0, signal: null }, actor.stderr());
  assert.equal(actor.messages.length, 1);
  const results = actor.messages[0].results;
  assert.equal(results.length, 72);
  for (let index = 0; index < results.length; index++) {
    if (index % 4 === 0) assert.equal(results[index].error, `sync-${index}`);
    else if (index % 4 === 1) assert.equal(results[index].error, `async-${index}`);
    else if (index % 4 === 2) assert.equal(results[index].error, `conversion-${index}`);
    else assert.equal(results[index].value, `result-${index}:日本語 🧪`);
  }
});

test('real IPC client close cancels commands before its transport disconnects', async t => {
  let started = 0;
  let aborted = 0;
  const actor = await ipcFixture(t, `
    const closeNow = new Promise(resolve => process.on('message', message => {
      if (message.scenario === 'close-now') resolve();
    }));
    const done = new Promise(resolve => process.on('message', message => {
      if (message.scenario === 'done') resolve();
    }));
    const running = Array.from({ length: 24 }, (_, index) => client.run(String(index), '/fixed/workspace')
      .then(value => ({ value }), error => ({ error: error.message })));
    await closeNow;
    client.close();
    process.send({ scenario: 'client-closed', results: await Promise.all(running) });
    await done;
  `, ({ signal }, child) => new Promise((_, reject) => {
    started++;
    signal.addEventListener('abort', () => { aborted++; reject(new Error('cancel acknowledged')); }, { once: true });
    if (started === 24) child.send({ scenario: 'close-now' });
  }));
  await until(() => actor.messages.some(message => message.scenario === 'client-closed'), 'IPC client did not close');
  assert.equal(actor.child.connected, true, 'disconnect must not explain the cancellation');
  assert.equal(aborted, 24);
  assert.ok(actor.messages[0].results.every(result => /client closed/.test(result.error)));
  actor.child.send({ scenario: 'done' });
  assert.deepEqual(await actor.exited, { code: 0, signal: null }, actor.stderr());
});

test('aborting while connecting cannot dispatch a stale command after the handshake', async t => {
  const channel = new EventEmitter();
  channel.connected = true;
  const sent = [];
  channel.send = (message, callback) => { sent.push(message); callback?.(null); };
  const client = createBashBrokerClient(channel);
  t.after(() => client.close());
  const controller = new AbortController();
  const running = client.run('must-not-run', '/fixed/workspace', controller.signal).catch(error => error);
  controller.abort();
  assert.match((await running).message, /interrupted/);
  channel.emit('message', { ...envelope, type: 'ready', token: 'x'.repeat(43) });
  await client.ready();
  await delay(0);
  assert.equal(sent.filter(message => message.type === 'request').length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
