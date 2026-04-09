import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { saveTranscript } from './transcript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');
const pendingWrites = new Map();
const SAVE_DEBOUNCE_MS = 150;

await fsp.mkdir(SESSIONS_DIR, { recursive: true });

export async function createSession({ model, cwd }) {
  const session = {
    id: randomUUID(),
    model,
    cwd,
    title: 'New Session',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
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
  return commitSession(session);
}

export async function scheduleSessionSave(session) {
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
  }

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    void flushSessionSave(session.id);
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

export async function listSessions() {
  await flushAllSessionSaves();
  let files;
  try { files = await fsp.readdir(SESSIONS_DIR); } catch { return []; }
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
            updatedAt: s.updatedAt,
            count: s.messages?.length ?? 0,
          };
        } catch { return null; }
      })
  );
  return sessions
    .filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
  const file = path.join(SESSIONS_DIR, `${session.id}.json`);
  await fsp.writeFile(file, JSON.stringify(session, null, 2) + '\n', 'utf8');
  await saveTranscript(session);
}

async function flushMatchingSession(id) {
  const match = [...pendingWrites.keys()].find(key => key === id || key.startsWith(id));
  if (match) {
    await flushSessionSave(match);
  }
}

async function flushAllSessionSaves() {
  await Promise.all([...pendingWrites.keys()].map(id => flushSessionSave(id)));
}

function cloneSession(session) {
  return JSON.parse(JSON.stringify(session));
}
