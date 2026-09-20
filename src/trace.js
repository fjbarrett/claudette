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
import { explorationStats, isRoutineExplorationTool } from './tool-activity.js';

export function truncateLine(value, max = 160) {
  const line = String(value ?? '').split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const EXPLORATION_EVENT_TYPES = new Set(['tool_call', 'tool_started', 'tool_result']);

// Collapse only complete, successful, adjacent read-only lifecycles. Errors,
// writes, shell commands, approvals, and incomplete live calls stay verbatim.
export function compactTraceEvents(events = []) {
  const compacted = [];
  for (let index = 0; index < events.length;) {
    const event = events[index];
    if (!EXPLORATION_EVENT_TYPES.has(event?.type)
        || !isRoutineExplorationTool(event?.data?.name)) {
      compacted.push(event);
      index += 1;
      continue;
    }

    let end = index;
    const segment = [];
    while (end < events.length
        && EXPLORATION_EVENT_TYPES.has(events[end]?.type)
        && isRoutineExplorationTool(events[end]?.data?.name)) {
      segment.push(events[end]);
      end += 1;
    }
    const names = segment.filter(item => item.type === 'tool_call').map(item => item.data.name);
    const results = segment.filter(item => item.type === 'tool_result');
    const complete = names.length > 0 && results.length >= names.length;
    const failed = results.some(item => item.data?.isError);
    if (!complete || failed) {
      compacted.push(...segment);
      index = end;
      continue;
    }

    const first = segment[0];
    const last = segment.at(-1);
    compacted.push({
      id: first.id,
      type: 'tool_activity_summary',
      at: first.at,
      data: {
        category: 'exploration',
        ...explorationStats(names),
        completedAt: last.at,
      },
    });
    index = end;
  }
  return compacted;
}

export function compactSessionTraceForStorage(session) {
  if (!session?.turns?.length) return session;
  return {
    ...session,
    turns: session.turns.map(turn => ({
      ...turn,
      events: compactTraceEvents(turn.events),
    })),
  };
}

export function createTurnTrace({ prompt, model, cwd, expandedFiles = [], compacted = false, onEvent = null, onFinish = null } = {}) {
  const turn = {
    id: randomUUID(),
    prompt: truncateLine(prompt, 160),
    createdAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    model,
    cwd,
    expandedFiles,
    compacted, // history was auto-compacted just before this turn
    finalModel: model,
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
    // Fires once per terminal turn — used to append the usage
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
    repeat: () => finish('repeating'),
    maxIterations: () => finish('max_iterations'),
  };
}
