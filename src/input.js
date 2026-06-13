// Follow-up queue for mid-run steering.
//
// While a turn is running, prompts the user submits are not started as a second
// agent loop — they go into this in-memory FIFO and are drained at a safe
// boundary (after a model response + its tool calls complete, before the next
// model request, or just before the turn would finish). This keeps exactly one
// agent loop per session and preserves provider message ordering.
//
// The controller is deliberately free of terminal/model logic so it can be
// unit-tested in isolation; chat.js owns the wiring.
import { randomUUID } from 'node:crypto';

export class InputController {
  constructor() {
    this.pending = [];      // FIFO of { id, content, queuedAt }
    this.mode = 'idle';     // 'idle' | 'working' | 'approval'
  }

  setMode(mode) {
    this.mode = mode;
    return this.mode;
  }

  // Queue a follow-up. Blank input is ignored (returns null). Returns the item.
  enqueue(content) {
    const text = String(content ?? '').trim();
    if (!text) return null;
    const item = { id: randomUUID(), content: text, queuedAt: new Date().toISOString() };
    this.pending.push(item);
    return item;
  }

  get size() {
    return this.pending.length;
  }

  list() {
    return this.pending.map(item => ({ ...item }));
  }

  // Remove all pending items; returns how many were cleared.
  clear() {
    const n = this.pending.length;
    this.pending = [];
    return n;
  }

  // Take everything queued so far (in order) and empty the queue. Items queued
  // after a drain wait for the next boundary.
  drain() {
    const items = this.pending;
    this.pending = [];
    return items;
  }
}

// Terminal-input state machine: assembles typed lines and bracketed pastes into
// whole submissions. Text between the bracketed-paste markers (\x1b[200~ …
// \x1b[201~) is kept as ONE submission even across many lines — fixing the bug
// where each pasted newline became a separate queued follow-up. Pure and
// callback-based so it's unit-testable; the terminal wiring lives in chat.js.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function createInputAssembler({ onLine, onCancel, onChange } = {}) {
  let buf = '';
  let pasting = false;
  const changed = () => onChange?.(buf); // current buffer, for live echo

  const submit = () => {
    const content = buf.replace(/\r/g, '').replace(/\n+$/, '').trim();
    buf = '';
    changed();
    if (content && onLine) onLine(content);
  };

  return function feed(input) {
    let s = String(input ?? '');
    while (s.length) {
      if (pasting) {
        const end = s.indexOf(PASTE_END);
        if (end === -1) { buf += s; s = ''; }          // paste continues in a later chunk
        else { buf += s.slice(0, end); s = s.slice(end + PASTE_END.length); pasting = false; }
        changed();
        continue;
      }
      const start = s.indexOf(PASTE_START);
      const segment = start === -1 ? s : s.slice(0, start);
      for (const ch of segment) {
        const code = ch.charCodeAt(0);
        if (code === 0x03) { buf = ''; changed(); onCancel?.(); }        // Ctrl+C
        else if (code === 0x0d || code === 0x0a) submit();               // Enter
        else if (code === 0x7f || code === 0x08) { buf = buf.slice(0, -1); changed(); } // Backspace
        else if (code >= 0x20) { buf += ch; changed(); }                 // printable
      }
      if (start === -1) { s = ''; }
      else { pasting = true; s = s.slice(start + PASTE_START.length); }
    }
  };
}

// Combine drained follow-ups into a single steering user message, preserving
// order. Returning one message (not several) avoids adjacent user turns and an
// extra provider request per queued line.
export function buildFollowUpMessage(items) {
  if (!items || !items.length) return null;
  if (items.length === 1) {
    return { role: 'user', content: items[0].content };
  }
  const numbered = items.map((it, i) => `${i + 1}. ${it.content}`).join('\n');
  return {
    role: 'user',
    content: `[Follow-up sent while you were working]\n${numbered}`,
  };
}
