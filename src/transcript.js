import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'data', 'transcripts');

await fsp.mkdir(TRANSCRIPTS_DIR, { recursive: true });

/**
 * Write a plain-text transcript of a session to data/transcripts/{id}.txt.
 * Called on every session save so the transcript stays current.
 * Skips sessions with no messages.
 */
export async function saveTranscript(session) {
  if (process.env.NODE_ENV === 'test') return;
  if (!session.messages?.length) return;
  const file = path.join(TRANSCRIPTS_DIR, `${session.id}.txt`);
  await fsp.writeFile(file, formatTranscript(session), 'utf8');
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
