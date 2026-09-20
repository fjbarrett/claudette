#!/usr/bin/env node
// Reproducible offline stress batches. Stops at the first failing batch and
// keeps its seed, environment and complete output; Ctrl+C stops the active child.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const values = { batches: 0, cases: 1000, seed: randomBytes(4).readUInt32LE(), output: null };
const limits = { batches: 1000000, cases: 100000, seed: 0xffffffff };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') {
    console.log('Usage: node scripts/stress-streams.mjs [--batches N] [--cases N] [--seed N] [--output NEW_DIR]');
    console.log('Default: run until interrupted or a failure occurs. Each batch uses a fresh recorded seed.');
    process.exit(0);
  }
  const key = arg.slice(2);
  const raw = process.argv[++i];
  if (!arg.startsWith('--') || !Object.hasOwn(values, key) || raw === undefined) {
    throw new Error(`Unknown option or missing value: ${arg}`);
  }
  if (key === 'output') values.output = path.resolve(raw);
  else {
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < (key === 'cases' ? 1 : 0) || n > limits[key]) {
      throw new Error(`Invalid --${key}: ${raw}`);
    }
    values[key] = n;
  }
}

const output = values.output ?? fs.mkdtempSync(path.join(os.tmpdir(), 'claudette-stream-stress-'));
if (values.output) fs.mkdirSync(output); // never overwrite an existing run
const environments = [
  { TZ: 'UTC', LANG: 'C', NO_COLOR: '1', heapMiB: 128 },
  { TZ: 'America/Phoenix', LANG: 'en_US.UTF-8', NO_COLOR: '1', heapMiB: 256 },
  { TZ: 'Asia/Tokyo', LANG: 'ja_JP.UTF-8', NO_COLOR: '1', heapMiB: 512 },
  { TZ: 'Europe/Berlin', LANG: 'de_DE.UTF-8', NO_COLOR: '1', heapMiB: 128 },
];
let stopping = false;
let active = null;
let killTimer = null;
function killChild(signal) {
  if (!active?.pid) return;
  try {
    if (process.platform === 'win32') active.kill(signal);
    else process.kill(-active.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function stop() {
  if (stopping) return;
  stopping = true;
  killChild('SIGTERM');
  killTimer = setTimeout(() => killChild('SIGKILL'), 5000);
  killTimer.unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(JSON.stringify({ type: 'started', pid: process.pid, node: process.version, ...values, output }));

let seed = values.seed;
for (let batch = 1; !stopping && (values.batches === 0 || batch <= values.batches); batch++) {
  const environment = environments[(batch - 1) % environments.length];
  const { heapMiB, ...env } = environment;
  const log = path.join(output, `batch-${String(batch).padStart(6, '0')}.log`);
  const fd = fs.openSync(log, 'wx');
  const started = Date.now();
  let launchError;
  const childEnv = { ...process.env, ...env, NODE_ENV: 'test', CLAUDETTE_SKIP_LIVE: '1',
    CLAUDETTE_STRESS_SEED: String(seed), CLAUDETTE_STRESS_CASES: String(values.cases) };
  // Each batch is an independent runner, including when invoked by another test.
  // Inheriting this internal marker can skip the entire batch with exit 0.
  delete childEnv.NODE_TEST_CONTEXT;
  const result = await new Promise(resolve => {
    active = spawn(process.execPath, [
      `--max-old-space-size=${heapMiB}`, '--test', '--test-reporter=tap', path.join(root, 'test/streaming.test.js'),
    ], {
      cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd],
      env: childEnv,
    });
    active.once('error', error => { launchError = error.message; });
    active.once('close', (code, signal) => resolve({ code, signal }));
  });
  active = null;
  if (killTimer) { clearTimeout(killTimer); killTimer = null; }
  fs.closeSync(fd);
  const record = {
    type: 'batch', batch, seed, cases: values.cases, node: process.version, environment,
    startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    ...result, ...(launchError ? { launchError } : {}), stopped: stopping, log,
  };
  fs.appendFileSync(path.join(output, 'results.jsonl'), JSON.stringify(record) + '\n');
  console.log(JSON.stringify(record));
  if (!stopping && (result.code !== 0 || launchError)) { process.exitCode = 1; break; }
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}
process.removeListener('SIGINT', stop);
process.removeListener('SIGTERM', stop);
console.log(JSON.stringify({ type: 'finished', stopped: stopping, output, exitCode: process.exitCode ?? 0 }));
