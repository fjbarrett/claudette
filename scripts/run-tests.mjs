#!/usr/bin/env node
// Keep test environment, discovery and exit handling identical across npm/CI
// and platforms. No shell-specific assignments or wildcard expansion required.
import { readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv.slice(2);
const live = input.includes('--live');
const coverage = input.includes('--coverage');
const forwarded = input.filter(arg => arg !== '--live' && arg !== '--coverage');
const args = ['--test'];
if (coverage) {
  const help = spawnSync(process.execPath, ['--help'], { encoding: 'utf8' });
  if (help.status !== 0 || !help.stdout?.includes('--test-coverage-lines')) {
    console.error('This Node version cannot enforce coverage thresholds. Run coverage with Node 22 or 24.');
    process.exit(1);
  }
  args.push('--experimental-test-coverage', '--test-coverage-lines=70', '--test-coverage-branches=60');
}
args.push(...forwarded);
const files = readdirSync(path.join(root, 'test'), { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name))
  .map(entry => path.join(root, 'test', entry.name)).sort();
if (!files.length) { console.error('No test files found.'); process.exit(1); }
args.push(...files);
const env = {
  ...process.env, NODE_ENV: 'test', CLAUDETTE_FREE_TIER_ONLY: '0',
  CLAUDETTE_REQUIRE_TOOLS: '0', CLAUDETTE_ALWAYS_TRACK: '0', CLAUDETTE_MODEL_ROTATION: '0',
};
// This invocation owns an independent test runner. Inheriting the parent's
// internal marker makes Node skip all tests as a recursive run (even exit 0).
delete env.NODE_TEST_CONTEXT;
if (live) delete env.CLAUDETTE_SKIP_LIVE;
else env.CLAUDETTE_SKIP_LIVE = '1';
const child = spawn(process.execPath, args, {
  cwd: root, env, stdio: 'inherit', detached: process.platform !== 'win32',
});
let interrupted = null;
const forward = signal => {
  interrupted ??= signal;
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const onInt = () => forward('SIGINT');
const onTerm = () => forward('SIGTERM');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', (code, signal) => {
  process.removeListener('SIGINT', onInt);
  process.removeListener('SIGTERM', onTerm);
  const terminalSignal = interrupted ?? signal;
  process.exitCode = terminalSignal ? 128 + (constants.signals[terminalSignal] ?? 1) : (code ?? 1);
});
