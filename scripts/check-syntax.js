#!/usr/bin/env node
// Check tracked and new source files without scanning ignored dependencies or
// generated artifacts. NUL-delimited paths preserve spaces and shell characters.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const listing = spawnSync('git', [
  'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
  '*.js', '*.mjs', '*.cjs',
], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

if (listing.error || listing.status !== 0) {
  console.error(listing.error?.message ?? (listing.stderr.trim() || 'Could not list source files.'));
  process.exit(1);
}

let checked = 0;
let failed = 0;
for (const file of new Set(listing.stdout.split('\0').filter(Boolean))) {
  // Deleted tracked files remain in `git ls-files` until staged.
  if (!existsSync(file)) continue;
  const result = spawnSync(process.execPath, ['--check', path.resolve(file)], { stdio: 'inherit' });
  checked++;
  if (result.error || result.status !== 0) {
    if (result.error) console.error(`${file}: ${result.error.message}`);
    failed++;
  }
}

console.log(`Syntax checked ${checked} files; ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
