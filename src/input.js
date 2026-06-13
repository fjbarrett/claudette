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
