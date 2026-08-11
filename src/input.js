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

// A permission prompt accepts a tiny fixed vocabulary. Anything else typed while
// one is pending is a follow-up, not an answer — so a user who types "actually
// skip the tests" at a [y/n/a] prompt gets it queued rather than silently read as
// "a" (always allow). Returns 'y' | 'n' | 'a', or null when it isn't an answer.
export function classifyApprovalAnswer(text) {
  const a = String(text ?? '').trim().toLowerCase();
  if (a === 'y' || a === 'yes') return 'y';
  if (a === 'n' || a === 'no') return 'n';
  if (a === 'a' || a === 'always') return 'a';
  return null;
}

export class InputController {
  constructor() {
    this.pending = [];      // FIFO of { id, content, queuedAt }
    this.mode = 'idle';     // 'idle' | 'working' | 'approval'
    this._approval = null;  // resolver for the in-flight permission prompt
  }

  setMode(mode) {
    this.mode = mode;
    return this.mode;
  }

  // ── Permission prompts ─────────────────────────────────────────────────────
  // While a turn is capturing input, the raw-mode reader owns stdin, so the
  // permission prompt can't use readline's question(). It parks here instead and
  // the same keystroke stream answers it.

  get awaitingApproval() {
    return Boolean(this._approval);
  }

  // Resolves to 'y' | 'n' | 'a' once the user answers.
  awaitApproval() {
    this.setMode('approval');
    return new Promise(resolve => { this._approval = resolve; });
  }

  // Settle a pending prompt (an answer, or 'n' from an interrupt). Returns false
  // when nothing was waiting, so callers can tell a stray key from a real answer.
  resolveApproval(answer) {
    const resolve = this._approval;
    if (!resolve) return false;
    this._approval = null;
    this.setMode('working');
    resolve(answer);
    return true;
  }

  // Route one submitted line to whichever consumer is active. Returns what
  // happened so the caller can render it.
  submit(content) {
    if (this.awaitingApproval) {
      const answer = classifyApprovalAnswer(content);
      if (answer) {
        this.resolveApproval(answer);
        return { kind: 'approval', answer };
      }
    }
    const item = this.enqueue(content);
    return item ? { kind: 'queued', item } : { kind: 'ignored' };
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

// Strip terminal artifacts that leak into captured input. While a turn runs we
// read stdin in raw mode and stream rendered output to the same terminal; a real
// session logged a prompt of `cont  ⎿ Wrote 1335 chars (44 lines) to …` — the
// user typed "cont" and an echoed tool-result line got captured with it. We:
//   1. drop ANSI CSI/OSC escape sequences, and
//   2. cut at the first ⏺ (tool-call) or ⎿ (tool-result) render glyph — anything
//      from there on is echoed output, not something the user typed,
// then strip remaining control chars (keeping tab/newline so pastes survive) and
// trim. Pure so it's unit-tested in isolation.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const RENDER_GLYPHS_RE = /[⏺⎿]/u; // ⏺ ⎿
export function sanitizeUserInput(text) {
  let s = String(text ?? '').replace(ANSI_RE, '');
  // Glyph-cut only single-line input: the leak we're fixing appends an echoed
  // tool-result line to a typed line ("cont  ⎿ Wrote …"). A deliberate multi-line
  // paste (a stack trace, a build log) is content the user wants kept whole, so
  // don't truncate it even if a line happens to contain a box glyph.
  if (!s.includes('\n')) {
    const glyph = s.search(RENDER_GLYPHS_RE);
    if (glyph !== -1) s = s.slice(0, glyph);
  }
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[ \t]+$/gm, '').trim();
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
    const content = sanitizeUserInput(buf);
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

// Groups a rapid burst of input lines into one submission. At the idle prompt,
// readline emits one 'line' event per newline, so pasting a multi-line block (a
// stack trace, a build log) fragments into N separate prompts/commands. Lines
// that arrive within `flushMs` of each other are joined into a single prompt;
// a genuine pause flushes what's accumulated. `setTimer`/`clearTimer` are
// injectable so the grouping is unit-testable without real timers.
export function createBurstReader({ flushMs = 40, onPrompt, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let lines = [];
  let timer = null;
  const emit = () => {
    timer = null;
    if (!lines.length) return;
    const text = lines.join('\n');
    lines = [];
    onPrompt?.(text);
  };
  return {
    push(line) {
      lines.push(String(line ?? ''));
      if (timer) clearTimer(timer);
      timer = setTimer(emit, flushMs);
    },
    // Force out whatever is buffered (e.g. on stream close) so a trailing line
    // that never saw a following pause isn't lost.
    flush() { if (timer) clearTimer(timer); emit(); },
    get pending() { return lines.length; },
  };
}

// Buffer every line a readline interface emits, so none is lost while the caller
// is busy. `rl.question()` only listens during the await; lines that arrive while
// a turn is running (or that were already buffered when stdin is a pipe/file) are
// emitted to nobody and dropped. That made `--json-ipc` a one-shot protocol: it
// advertises `ready` each turn but only ever served the first prompt, and with
// stdin redirected from a file it lost even that one.
//
// `next()` resolves with the next line, or null once the stream has closed and
// the buffer is drained — so EOF is a value, not a rejection.
export function createLineQueue(emitter, { lineEvent = 'line', closeEvent = 'close' } = {}) {
  const lines = [];
  let closed = false;
  let waiter = null;
  const settle = (value) => { const w = waiter; waiter = null; w(value); };

  emitter.on(lineEvent, (l) => {
    if (waiter) settle(String(l));
    else lines.push(String(l));
  });
  emitter.once(closeEvent, () => {
    closed = true;
    if (waiter) settle(null);
  });

  return {
    next() {
      if (lines.length) return Promise.resolve(lines.shift());
      if (closed) return Promise.resolve(null);
      return new Promise(resolve => { waiter = resolve; });
    },
    get pending() { return lines.length; },
    get closed() { return closed; },
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
