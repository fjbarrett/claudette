// Per-turn trace recorder shared by the web server and the CLI/TUI agent loop.
//
// A "turn" is one user prompt and everything the agent did in response. The
// trace captures status, model, the expanded @file set, token/duration metrics,
// and an ordered `events` log (input_received → system_prompt_built →
// model_request_started → tool_call/tool_result … → assistant_completed|failed).
// It is persisted on the session as `session.turns[]`, so a past session can be
// fully reconstructed for debugging without re-running anything.
//
// `onEvent(event, turn)` is an optional sink: the web server uses it to also
// stream each event to the browser over NDJSON; the CLI leaves it unset.
import { randomUUID } from 'node:crypto';

export function truncateLine(value, max = 160) {
  const line = String(value ?? '').split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function createTurnTrace({ prompt, model, cwd, expandedFiles = [], onEvent = null, onFinish = null } = {}) {
  const turn = {
    id: randomUUID(),
    prompt: truncateLine(prompt, 160),
    createdAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    model,
    cwd,
    expandedFiles,
    metrics: { durationMs: null, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    events: [],
  };
  const startedAt = Date.now();

  function event(type, data = {}) {
    const ev = { id: randomUUID(), type, at: new Date().toISOString(), data };
    turn.events.push(ev);
    if (onEvent) onEvent(ev, turn);
    return ev;
  }

  // Add token counts from one model response into the running totals (a CLI turn
  // may make several model requests across tool iterations).
  function addUsage({ promptTokens = 0, completionTokens = 0 } = {}) {
    turn.metrics.promptTokens += promptTokens || 0;
    turn.metrics.completionTokens += completionTokens || 0;
    turn.metrics.totalTokens = turn.metrics.promptTokens + turn.metrics.completionTokens;
  }

  function finish(status) {
    turn.status = status;
    turn.completedAt = new Date().toISOString();
    turn.metrics.durationMs = Date.now() - startedAt;
    // Fires once per terminal turn (complete/fail) — used to append the usage
    // log. A logging error must never break the turn.
    if (onFinish) { try { onFinish(turn); } catch { /* ignore */ } }
    return turn;
  }

  return {
    turn,
    event,
    addUsage,
    complete: () => finish('completed'),
    fail: () => finish('failed'),
    cancel: () => finish('cancelled'),
  };
}
