import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './fs-atomic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'data', 'transcripts');

await fsp.mkdir(TRANSCRIPTS_DIR, { recursive: true });

// A transcript is a derived, human-readable view of the session JSON, and the
// session is committed after every tool result — so a 150-iteration turn used to
// re-serialise and rewrite the whole growing transcript 150 times. Throttle it:
// staleness costs nothing (the file is regenerable from the session), and
// flushTranscripts() makes it exact at turn end and on exit.
const pending = new Map(); // id → { session, timer }
const lastWrite = new Map(); // id → epoch ms

function throttleMs() {
  const n = Number(process.env.CLAUDETTE_TRANSCRIPT_THROTTLE);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

/**
 * Queue a transcript write for a session. Writes immediately when the last write
 * is older than the throttle window, otherwise schedules a trailing write so the
 * final state always lands. Skips sessions with no messages.
 */
export async function saveTranscript(session, { force = false } = {}) {
  if (process.env.NODE_ENV === 'test' && !force) return;
  if (!session?.messages?.length) return;

  const wait = throttleMs();
  const since = Date.now() - (lastWrite.get(session.id) ?? 0);
  if (force || wait === 0 || since >= wait) return writeNow(session);

  // Inside the window — remember the newest state and let one trailing timer fire.
  const entry = pending.get(session.id) ?? {};
  entry.session = session;
  if (!entry.timer) {
    entry.timer = setTimeout(() => { void writeNow(entry.session); }, wait - since);
    entry.timer.unref?.(); // never keep the process alive for a derived file
  }
  pending.set(session.id, entry);
}

async function writeNow(session) {
  const entry = pending.get(session.id);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(session.id);
  lastWrite.set(session.id, Date.now());
  const file = path.join(TRANSCRIPTS_DIR, `${session.id}.txt`);
  await writeFileAtomic(file, formatTranscript(session));
}

/** Write every queued transcript now — call at turn end and before exit. */
export async function flushTranscripts() {
  const queued = [...pending.values()].map(e => e.session).filter(Boolean);
  await Promise.all(queued.map(s => writeNow(s).catch(() => {})));
}

function formatTranscript(session) {
  const SEP = '='.repeat(80);
  const lines = [
    `SESSION  ${session.id}`,
    `TITLE    ${session.title ?? 'Untitled'}`,
    `MODEL    ${session.model ?? 'unknown'}`,
    `CWD      ${session.cwd ?? ''}`,
    `CREATED  ${session.createdAt ?? ''}`,
    `UPDATED  ${session.updatedAt ?? ''}`,
    SEP,
    '',
  ];

  for (const msg of session.messages) {
    const role = msg.role?.toUpperCase();
    if (role === 'SYSTEM') continue;

    if (role === 'TOOL') {
      lines.push('[TOOL RESULT]');
      lines.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2));
      lines.push('');
      continue;
    }

    lines.push(`[${role}]`);
    if (typeof msg.content === 'string' && msg.content) {
      lines.push(msg.content);
    } else if (msg.content) {
      lines.push(JSON.stringify(msg.content, null, 2));
    }

    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const name = call.function?.name ?? 'unknown';
        const args = call.function?.arguments;
        const argsStr = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
        lines.push(`[TOOL CALL: ${name}]`);
        lines.push(argsStr);
      }
    }

    lines.push('');
  }

  lines.push(SEP);
  lines.push('(end of session)');
  lines.push('');

  return lines.join('\n');
}
