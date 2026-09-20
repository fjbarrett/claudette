import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveTranscript } from './transcript.js';
import { ensurePrivateDirectory, writeFileAtomic } from './fs-atomic.js';
import { DATA_DIR } from './state-paths.js';
import { compactSessionTraceForStorage } from './trace.js';

export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const ARCHIVE_DIR = path.join(SESSIONS_DIR, 'archive');
const pendingWrites = new Map();
const activeWrites = new Map(); // id -> latest queued publication
const SAVE_DEBOUNCE_MS = 150;

await ensurePrivateDirectory(SESSIONS_DIR);

export async function createSession({ model, cwd, title = 'New Session' }) {
  const session = {
    id: randomUUID(),
    model,
    cwd,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    turns: [],
  };
  await saveSession(session);
  return session;
}

export async function loadSession(id) {
  await flushMatchingSession(id);
  // Support short IDs — find first match
  const files = await fsp.readdir(SESSIONS_DIR);
  const match = files.find(f => f === `${id}.json` || f.startsWith(`${id}`));
  if (!match) throw new Error(`Session not found: ${id}`);
  const raw = await fsp.readFile(path.join(SESSIONS_DIR, match), 'utf8');
  return JSON.parse(raw);
}

export async function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  // A direct save is newer than any queued snapshot. Flush through the same
  // entry so the debounce timer cannot later restore stale conversation data.
  return flushSessionSave(session);
}

export function scheduleSessionSave(session) {
  session.updatedAt = new Date().toISOString();
  let entry = pendingWrites.get(session.id);
  if (!entry) {
    entry = createPendingEntry(session.id);
    pendingWrites.set(session.id, entry);
  }

  entry.latestSession = cloneSession(session);
  if (!entry.promise) {
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    // Mark the shared promise handled even when a UI caller intentionally does
    // not await a debounced save. Awaiting it still observes the rejection.
    entry.promise.catch(() => {});
  }

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    flushSessionSave(session.id).catch(() => {});
  }, SAVE_DEBOUNCE_MS);

  return entry.promise;
}

export async function flushSessionSave(sessionOrId) {
  const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId?.id;
  if (!sessionId) return;

  const entry = pendingWrites.get(sessionId);
  if (!entry) {
    // Debounce timer already fired and cleared the entry — write directly if we have the session object.
    if (typeof sessionOrId === 'object') {
      sessionOrId.updatedAt = new Date().toISOString();
      await commitSession(sessionOrId);
    }
    return;
  }

  if (typeof sessionOrId === 'object') {
    sessionOrId.updatedAt = new Date().toISOString();
    entry.latestSession = cloneSession(sessionOrId);
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  if (entry.activeFlush) {
    await entry.activeFlush;
    if (entry.latestSession) {
      return flushSessionSave(sessionId);
    }
    return;
  }

  entry.activeFlush = (async () => {
    while (entry.latestSession) {
      const snapshot = entry.latestSession;
      entry.latestSession = null;
      await commitSession(snapshot);
    }
  })();

  try {
    await entry.activeFlush;
    entry.resolve?.();
  } catch (err) {
    entry.reject?.(err);
    throw err;
  } finally {
    entry.activeFlush = null;
    entry.promise = null;
    entry.resolve = null;
    entry.reject = null;
    if (!entry.latestSession && !entry.timer) {
      pendingWrites.delete(sessionId);
    }
  }
}

export async function listSessions({ limit = 0, offset = 0 } = {}) {
  await flushAllSessionSaves();
  let files;
  try { files = await fsp.readdir(SESSIONS_DIR); } catch (err) { console.warn(`listSessions readdir failed: ${err.message}`); return []; }
  const sessions = await Promise.all(
    files
      .filter(f => f.endsWith('.json'))
      .map(async f => {
        try {
          const raw = await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8');
          const s = JSON.parse(raw);
          return {
            id: s.id,
            title: s.title ?? 'Untitled',
            model: s.model ?? '?',
            cwd: s.cwd ?? null,
            updatedAt: s.updatedAt,
            count: s.messages?.length ?? 0,
            messageCount: s.messages?.length ?? 0,
          };
        } catch { return null; }
      })
  );
  const sorted = sessions
    .filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const start = Math.max(0, Math.floor(offset));
  const end = limit > 0 ? start + Math.floor(limit) : undefined;
  return sorted.slice(start, end);
}

function createPendingEntry(id) {
  return {
    id,
    latestSession: null,
    timer: null,
    promise: null,
    resolve: null,
    reject: null,
    activeFlush: null,
  };
}

async function commitSession(session) {
  const snapshot = cloneSession(session);
  const file = path.join(SESSIONS_DIR, `${snapshot.id}.json`);
  const stored = compactSessionTraceForStorage(snapshot);
  const contents = JSON.stringify(stored, null, 2) + '\n';
  // Atomic rename prevents torn reads, but does not order concurrent writers.
  // A slower old save must finish before the newer snapshot is published.
  const previous = activeWrites.get(snapshot.id) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    await writeFileAtomic(file, contents);
    await saveTranscript(snapshot);
  });
  activeWrites.set(snapshot.id, write);
  try {
    await write;
  } finally {
    if (activeWrites.get(snapshot.id) === write) activeWrites.delete(snapshot.id);
  }
}

/**
 * Snapshot the current messages beside the session before something destroys
 * them. Compaction replaces the whole array with a summary, and the transcript
 * is regenerated from the truncated array — so without this the original
 * conversation is gone from both places. Returns the archive path.
 */
export async function archiveMessages(session, reason = 'compact') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // A subdirectory, not a sibling: listSessions() globs *.json here, and
  // loadSession() resolves short ids by prefix — an archive named
  // `<id>.compact-….json` would show up as a session and could be resumed
  // instead of the real one.
  const file = path.join(ARCHIVE_DIR, `${session.id}.${reason}-${stamp}-${randomUUID()}.json`);
  await writeFileAtomic(file, JSON.stringify({
    sessionId: session.id,
    reason,
    archivedAt: new Date().toISOString(),
    model: session.model,
    title: session.title,
    messages: session.messages,
  }, null, 2) + '\n');
  return file;
}

async function flushMatchingSession(id) {
  const keys = new Set([...pendingWrites.keys(), ...activeWrites.keys()]);
  const match = [...keys].find(key => key === id || key.startsWith(id));
  if (match) {
    await flushSessionSave(match);
    await activeWrites.get(match);
  }
}

async function flushAllSessionSaves() {
  await Promise.all([...pendingWrites.keys()].map(id => flushSessionSave(id)));
  await Promise.all([...activeWrites.values()]);
}

function cloneSession(session) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(session); } catch {}
  }
  return JSON.parse(JSON.stringify(session));
}
