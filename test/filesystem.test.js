import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadClaudeMd, invalidateClaudeMdCache } from '../src/context.js';
import { writeFileAtomic } from '../src/fs-atomic.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudette-filesystem-'));
const previousDataDir = process.env.CLAUDETTE_DATA_DIR;
process.env.CLAUDETTE_DATA_DIR = path.join(root, 'private state 日本語');
const sessions = await import('../src/session.js');
const transcripts = await import('../src/transcript.js');
if (previousDataDir === undefined) delete process.env.CLAUDETTE_DATA_DIR;
else process.env.CLAUDETTE_DATA_DIR = previousDataDir;
after(async () => {
  await sessions.listSessions(); // settle any scheduled writes before removing fixtures
  await fsp.rm(root, { recursive: true, force: true });
});

async function workspace(t) {
  const dir = await fsp.mkdtemp(path.join(root, 'repo-'));
  await fsp.mkdir(path.join(dir, '.git'));
  t.after(() => invalidateClaudeMdCache());
  return dir;
}

test('project instructions refresh either local file even when its sibling is unchanged', async t => {
  const dir = await workspace(t);
  const names = ['CLAUDE.md', 'CLAUDETTE.md'];
  for (const name of names) await fsp.writeFile(path.join(dir, name), `${name} original`);
  assert.match(await loadClaudeMd(dir), /original/);
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = await fsp.stat(file);
    await fsp.writeFile(file, `${name} modified`);
    // Reproduces editors/tools that preserve modification times.
    await fsp.utimes(file, stat.atime, stat.mtime);
    const result = await loadClaudeMd(dir);
    assert.ok(result.includes(`${name} modified`), name);
    assert.ok(!result.includes(`${name} original`), name);
  }
});

test('project instructions immediately reflect creation, deletion and ancestor edits', async t => {
  const dir = await workspace(t);
  const child = path.join(dir, 'nested space', '日本語');
  await fsp.mkdir(child, { recursive: true });
  assert.equal(await loadClaudeMd(child), '');
  const parentFile = path.join(dir, 'CLAUDE.md');
  await fsp.writeFile(parentFile, 'parent first');
  assert.match(await loadClaudeMd(child), /parent first/);
  await fsp.writeFile(parentFile, 'parent second');
  assert.match(await loadClaudeMd(child), /parent second/);
  const localFile = path.join(child, 'CLAUDETTE.md');
  await fsp.writeFile(localFile, 'local instructions');
  assert.match(await loadClaudeMd(child), /local instructions/);
  await fsp.unlink(parentFile);
  const withoutParent = await loadClaudeMd(child);
  assert.ok(!withoutParent.includes('parent'));
  assert.ok(withoutParent.includes('local instructions'));
  await fsp.unlink(localFile);
  assert.equal(await loadClaudeMd(child), '');
});

test('instruction ancestry changes immediately when a nested git boundary appears or disappears', async t => {
  const dir = await workspace(t);
  const child = path.join(dir, 'child');
  await fsp.mkdir(child);
  await fsp.writeFile(path.join(dir, 'CLAUDE.md'), 'outer instructions');
  await fsp.writeFile(path.join(child, 'CLAUDETTE.md'), 'inner instructions');
  assert.match(await loadClaudeMd(child), /outer instructions/);
  await fsp.writeFile(path.join(child, '.git'), 'gitdir: ../worktree-data');
  assert.ok(!(await loadClaudeMd(child)).includes('outer instructions'));
  await fsp.unlink(path.join(child, '.git'));
  assert.match(await loadClaudeMd(child), /outer instructions/);
});

test('an explicit session save supersedes an older pending debounced snapshot', async () => {
  const session = await sessions.createSession({ model: 'fixture', cwd: root });
  session.messages = [{ role: 'user', content: 'old pending' }];
  const pending = sessions.scheduleSessionSave(session);
  session.messages.push({ role: 'assistant', content: 'new explicit save' });
  await sessions.saveSession(session);
  await pending;
  const loaded = await sessions.loadSession(session.id);
  assert.deepEqual(loaded.messages, session.messages);
});

test('concurrent direct session saves publish in invocation order', async t => {
  const session = await sessions.createSession({ model: 'fixture', cwd: root });
  const file = path.join(sessions.SESSIONS_DIR, `${session.id}.json`);
  const rename = fsp.rename;
  let releaseFirst;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let calls = 0;
  const stub = t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === file && ++calls === 1) { firstStarted(); await held; }
    return rename(from, to);
  });
  const oldSave = sessions.saveSession({ ...session, title: 'older' });
  await started;
  const newSave = sessions.saveSession({ ...session, title: 'newest' });
  try {
    // Leave the first atomic publication blocked while the newer save starts.
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    releaseFirst();
    await Promise.allSettled([oldSave, newSave]);
    stub.mock.restore();
  }
  await Promise.all([oldSave, newSave]);
  assert.equal((await sessions.loadSession(session.id)).title, 'newest');
});

test('a failed queued save does not block the newer snapshot or unrelated sessions', async t => {
  const session = await sessions.createSession({ model: 'fixture', cwd: root });
  const other = await sessions.createSession({ model: 'fixture', cwd: root });
  const file = path.join(sessions.SESSIONS_DIR, `${session.id}.json`);
  const rename = fsp.rename;
  let failed = false;
  const expected = Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
  const stub = t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === file && !failed) { failed = true; throw expected; }
    return rename(from, to);
  });
  try {
    const results = await Promise.allSettled([
      sessions.saveSession({ ...session, title: 'failed save' }),
      sessions.saveSession({ ...session, title: 'recovered save' }),
      sessions.saveSession({ ...other, title: 'independent save' }),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[0].reason, expected);
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(results[2].status, 'fulfilled');
  } finally { stub.mock.restore(); }
  assert.equal((await sessions.loadSession(session.id)).title, 'recovered save');
  assert.equal((await sessions.loadSession(other.id)).title, 'independent save');
});

test('loading a session waits for a direct save and preserves its invocation snapshot', async t => {
  const session = await sessions.createSession({ model: 'fixture', cwd: root });
  const file = path.join(sessions.SESSIONS_DIR, `${session.id}.json`);
  const rename = fsp.rename;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const stub = t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === file) { notify(); await held; }
    return rename(from, to);
  });
  session.messages = [{ role: 'user', content: 'captured at invocation' }];
  const saving = sessions.saveSession(session);
  session.messages[0].content = 'later unsaved mutation';
  await started;
  let loaded = false;
  const loading = sessions.loadSession(session.id).then(value => { loaded = true; return value; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(loaded, false, 'read waits for pending publication');
  } finally {
    release();
    await Promise.allSettled([saving, loading]);
    stub.mock.restore();
  }
  assert.equal((await loading).messages[0].content, 'captured at invocation');
});

test('forced transcript writes publish newest last and flush waits for in-flight work', async t => {
  const session = await sessions.createSession({ model: 'fixture', cwd: root });
  const file = path.join(transcripts.TRANSCRIPTS_DIR, `${session.id}.txt`);
  const rename = fsp.rename;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  let calls = 0;
  const stub = t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === file && ++calls === 1) { notify(); await held; }
    return rename(from, to);
  });
  const oldWrite = transcripts.saveTranscript({ ...session, messages: [{ role: 'user', content: 'older transcript' }] }, { force: true });
  await started;
  const newWrite = transcripts.saveTranscript({ ...session, messages: [{ role: 'user', content: 'newest transcript' }] }, { force: true });
  let flushed = false;
  const flushing = transcripts.flushTranscripts().then(() => { flushed = true; });
  let flushedBeforeRelease;
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    flushedBeforeRelease = flushed;
  } finally {
    release();
    await Promise.allSettled([oldWrite, newWrite, flushing]);
    stub.mock.restore();
    transcripts.clearTranscriptForSession(session.id);
  }
  await Promise.all([oldWrite, newWrite, flushing]);
  assert.equal(flushedBeforeRelease, false, 'flush includes writes already in flight');
  const result = await fsp.readFile(file, 'utf8');
  assert.ok(result.includes('newest transcript'));
  assert.ok(!result.includes('older transcript'));
});

test('transcript queue pressure preserves the latest view for every session', async () => {
  const oldEnvironment = process.env.NODE_ENV;
  const oldThrottle = process.env.CLAUDETTE_TRANSCRIPT_THROTTLE;
  process.env.NODE_ENV = 'stress';
  process.env.CLAUDETTE_TRANSCRIPT_THROTTLE = '100000';
  const ids = Array.from({ length: 120 }, (_, index) => `pressure-${index}`);
  try {
    for (const id of ids) {
      const session = { id, model: 'fixture', messages: [{ role: 'user', content: 'initial view' }] };
      await transcripts.saveTranscript(session, { force: true });
      await transcripts.saveTranscript({ ...session, messages: [{ role: 'user', content: 'latest view' }] });
    }
    await transcripts.flushTranscripts();
    for (const id of ids) {
      const text = await fsp.readFile(path.join(transcripts.TRANSCRIPTS_DIR, `${id}.txt`), 'utf8');
      assert.ok(text.includes('latest view'), `latest state retained for ${id}`);
    }
  } finally {
    for (const id of ids) transcripts.clearTranscriptForSession(id);
    if (oldEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldEnvironment;
    if (oldThrottle === undefined) delete process.env.CLAUDETTE_TRANSCRIPT_THROTTLE;
    else process.env.CLAUDETTE_TRANSCRIPT_THROTTLE = oldThrottle;
  }
});

test('archives preserve every snapshot even when timestamps collide', async t => {
  const session = await sessions.createSession({ model: 'fixture', cwd: root });
  const clock = t.mock.method(Date.prototype, 'toISOString', () => '2026-09-05T12:00:00.000Z');
  let files;
  try {
    files = await Promise.all(Array.from({ length: 24 }, (_, index) => sessions.archiveMessages({
      ...session, messages: [{ role: 'user', content: `snapshot-${index}` }],
    })));
  } finally { clock.mock.restore(); }
  assert.equal(new Set(files).size, 24, 'every snapshot has an independent archive path');
  for (const [index, file] of files.entries()) {
    const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(saved.messages[0].content, `snapshot-${index}`);
  }
});

test('instruction cache follows symlink retargeting and retries temporary read failures', async t => {
  const dir = await workspace(t);
  const one = path.join(dir, 'one.md');
  const two = path.join(dir, 'two.md');
  const instruction = path.join(dir, 'CLAUDE.md');
  await fsp.writeFile(one, 'instructions one');
  await fsp.writeFile(two, 'instructions two');
  await fsp.symlink('one.md', instruction);
  assert.match(await loadClaudeMd(dir), /instructions one/);
  await fsp.unlink(instruction);
  await fsp.symlink('two.md', instruction);
  assert.match(await loadClaudeMd(dir), /instructions two/);
  invalidateClaudeMdCache(dir);
  const readFile = fsp.readFile;
  const stub = t.mock.method(fsp, 'readFile', async (file, ...args) => {
    if (file === instruction) throw Object.assign(new Error('temporary fixture read failure'), { code: 'EIO' });
    return readFile(file, ...args);
  });
  try { assert.equal(await loadClaudeMd(dir), ''); }
  finally { stub.mock.restore(); }
  assert.match(await loadClaudeMd(dir), /instructions two/);
});

test('atomic writes preserve the existing document and remove temporary files on write or rename failure', async t => {
  const dir = await workspace(t);
  const file = path.join(dir, 'state.json');
  const oldText = JSON.stringify({ version: 1, data: '日本語 🧪' });
  await writeFileAtomic(file, oldText);
  for (const operation of ['writeFile', 'chmod', 'rename']) {
    const native = fsp[operation];
    const injected = Object.assign(new Error(`fixture ${operation} failed`), { code: operation === 'writeFile' ? 'ENOSPC' : 'EACCES' });
    const stub = t.mock.method(fsp, operation, async (...args) => {
      if (String(args[0]).endsWith('.tmp')) {
        if (operation === 'writeFile') await native(args[0], 'partial', args[2]);
        throw injected;
      }
      return native(...args);
    });
    try {
      await assert.rejects(writeFileAtomic(file, '{"version":2}'), error => error === injected);
    } finally { stub.mock.restore(); }
    assert.equal(await fsp.readFile(file, 'utf8'), oldText, operation);
    assert.deepEqual((await fsp.readdir(dir)).filter(name => name.endsWith('.tmp')), [], operation);
  }
});

test('concurrent atomic writers never expose partial or mixed JSON documents', async t => {
  const dir = await workspace(t);
  const file = path.join(dir, 'state space 日本語.json');
  const documents = Array.from({ length: 80 }, (_, id) => JSON.stringify({ id, text: `${id}:日本語 🧪\n`.repeat(2048) }));
  const valid = new Set(documents);
  await writeFileAtomic(file, documents[0]);
  let writing = true;
  let reads = 0;
  const readers = Array.from({ length: 4 }, async () => {
    while (writing) {
      const content = await fsp.readFile(file, 'utf8');
      assert.ok(valid.has(content), 'every read is one complete published snapshot');
      reads++;
    }
  });
  try {
    await Promise.all(documents.map(document => writeFileAtomic(file, document)));
  } finally { writing = false; }
  await Promise.all(readers);
  assert.ok(reads >= 4);
  assert.deepEqual((await fsp.readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
});

test('atomic writes support legal long filenames and keep private modes under varied umasks', async t => {
  const dir = await workspace(t);
  const names = ['space 日本語 🧪.json', "quotes'\"$`.json", 'x'.repeat(240) + '.json'];
  const original = process.umask();
  try {
    for (const mask of [0o000, 0o022, 0o077]) {
      process.umask(mask);
      for (const [index, name] of names.entries()) {
        const parent = path.join(dir, `${mask}-${index}`);
        const file = path.join(parent, name);
        const data = Buffer.from('literal data \0 日本語 🧪\r\n');
        await writeFileAtomic(file, data);
        assert.deepEqual(await fsp.readFile(file), data);
        assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
        assert.equal((await fsp.stat(parent)).mode & 0o777, 0o700);
      }
    }
  } finally { process.umask(original); }
});
