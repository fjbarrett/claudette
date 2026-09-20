import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensurePrivateDirectory, writeFileAtomic } from './fs-atomic.js';
import { DATA_DIR } from './state-paths.js';
import { formatExplorationSummary, isRoutineExplorationTool } from './tool-activity.js';

export const TRANSCRIPTS_DIR = path.join(DATA_DIR, 'transcripts');

await ensurePrivateDirectory(TRANSCRIPTS_DIR);

// A transcript is a derived, human-readable view of the session JSON, and the
// session is committed after every tool result — so a 150-iteration turn used to
// re-serialise and rewrite the whole growing transcript 150 times. Throttle it:
// staleness costs nothing (the file is regenerable from the session), and
// flushTranscripts() makes it exact at turn end and on exit.
const pending = new Map(); // id → { session, timer }
const lastWrite = new Map(); // id → epoch ms
const activeWrites = new Map(); // id → latest queued publication

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
    entry.timer = setTimeout(() => { writeNow(entry.session).catch(() => {}); }, wait - since);
    entry.timer.unref?.(); // never keep the process alive for a derived file
  }
  pending.set(session.id, entry);
  boundPending();
}

async function writeNow(session) {
  const entry = pending.get(session.id);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(session.id);
  lastWrite.set(session.id, Date.now());
  const file = path.join(TRANSCRIPTS_DIR, `${session.id}.txt`);
  const contents = formatTranscript(session);
  const previous = activeWrites.get(session.id) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(() => writeFileAtomic(file, contents));
  activeWrites.set(session.id, write);
  try {
    await write;
  } finally {
    if (activeWrites.get(session.id) === write) activeWrites.delete(session.id);
  }
}

/** Write every queued transcript now — call at turn end and before exit. */
export async function flushTranscripts() {
  const queued = [...pending.values()].map(e => e.session).filter(Boolean);
  const writes = queued.map(s => writeNow(s).catch(() => {}));
  writes.push(...[...activeWrites.values()].map(write => write.catch(() => {})));
  await Promise.all(writes);
}

export function clearTranscriptForSession(sessionId) {
  const entry = pending.get(sessionId);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(sessionId);
  lastWrite.delete(sessionId);
}

// Bound pending size without dropping a session's latest derived view.
function boundPending() {
  if (pending.size > 100) {
    const first = pending.keys().next().value;
    const e = pending.get(first);
    writeNow(e.session).catch(() => {});
  }
}

// Flush on process exit for derived file completeness
if (typeof process !== 'undefined' && !process.env.CLAUDETTE_TRANSCRIPT_HOOKED) {
  process.env.CLAUDETTE_TRANSCRIPT_HOOKED = '1';
  process.on('beforeExit', () => { flushTranscripts().catch(() => {}); });
}

function toolCallName(call) {
  return call?.function?.name ?? 'unknown';
}

function toolCallArgs(call) {
  const args = call?.function?.arguments;
  return typeof args === 'string' ? args : JSON.stringify(args ?? {}, null, 2);
}

function toolResultFailed(message) {
  if (message?.isError === true) return true;
  const content = typeof message?.content === 'string'
    ? message.content
    : JSON.stringify(message?.content ?? '');
  return /^Error:/i.test(content.trimStart());
}

export function formatTranscript(session) {
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

  const callsById = new Map();
  let exploration = [];
  const flushExploration = () => {
    if (!exploration.length) return;
    lines.push('[TOOLS]');
    lines.push(formatExplorationSummary(exploration));
    lines.push('(routine read-only results omitted; full protocol history remains in the session JSON)');
    lines.push('');
    exploration = [];
  };

  for (const msg of session.messages) {
    const role = msg.role?.toUpperCase();
    if (role === 'SYSTEM') continue;

    if (role === 'TOOL') {
      const call = callsById.get(msg.tool_call_id);
      if (call?.routine && !toolResultFailed(msg)) {
        exploration.push(call.name);
        callsById.delete(msg.tool_call_id);
        continue;
      }
      flushExploration();
      lines.push('[TOOLS]');
      if (call?.routine) {
        lines.push(`[CALL ${call.name}]`);
        lines.push(call.args);
      }
      lines.push(`[RESULT ${call?.name ?? msg.name ?? 'unknown'}${toolResultFailed(msg) ? ' — ERROR' : ''}]`);
      lines.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2));
      lines.push('');
      callsById.delete(msg.tool_call_id);
      continue;
    }

    const hasContent = typeof msg.content === 'string' ? Boolean(msg.content) : Boolean(msg.content);
    const routineOnly = !hasContent && Boolean(msg.tool_calls?.length)
      && msg.tool_calls.every(call => isRoutineExplorationTool(toolCallName(call)));
    if (!routineOnly) flushExploration();
    if (hasContent) lines.push(`[${role}]`);
    if (typeof msg.content === 'string' && msg.content) {
      lines.push(msg.content);
    } else if (msg.content) {
      lines.push(JSON.stringify(msg.content, null, 2));
    }

    if (hasContent) lines.push('');

    if (msg.tool_calls?.length) {
      if (!routineOnly) lines.push('[TOOLS]');
      for (const call of msg.tool_calls) {
        const name = toolCallName(call);
        const args = toolCallArgs(call);
        if (call.id) callsById.set(call.id, {
          name,
          args,
          routine: routineOnly && isRoutineExplorationTool(name),
        });
        if (!routineOnly) {
          lines.push(`[CALL ${name}]`);
          lines.push(args);
        }
      }
      if (!routineOnly) lines.push('');
    }
  }

  flushExploration();
  const pendingExploration = [...callsById.values()].filter(call => call.routine);
  if (pendingExploration.length) {
    lines.push('[TOOLS]');
    lines.push(formatExplorationSummary(pendingExploration.map(call => call.name), 'Requested'));
    lines.push('(results pending)');
    lines.push('');
  }

  lines.push(SEP);
  lines.push('(end of session)');
  lines.push('');

  return lines.join('\n');
}
