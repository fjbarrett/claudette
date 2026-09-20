// Append-only per-turn token/cost usage log (JSONL).
//
// One flat record per completed turn, written to data/usage/usage.jsonl, so you
// can build datasets to study and improve token efficiency. On by default;
// disable with CLAUDETTE_USAGE_LOG=0, relocate with CLAUDETTE_USAGE_DIR. Skipped
// under NODE_ENV=test so the suite doesn't write logs.
import path from 'node:path';
import { estimateCost } from './cost.js';
import { alwaysTrack } from './model-policy.js';
import { DATA_DIR } from './state-paths.js';
import { appendPrivateFileSync } from './fs-atomic.js';

const DEFAULT_DIR = path.join(DATA_DIR, 'usage');

export function usageEnabled() {
  return process.env.NODE_ENV !== 'test'
    && (alwaysTrack() || process.env.CLAUDETTE_USAGE_LOG !== '0');
}

export function usageDir() {
  return process.env.CLAUDETTE_USAGE_DIR || DEFAULT_DIR;
}

// Flatten a finished trace turn (+ its session) into a dataset-friendly row.
// Token counts are exact (provider-reported); estCostUsd is an estimate and is
// null for unpriced models — keep tokens as the ground truth for training.
export function buildUsageRecord(turn, session) {
  const m = turn.metrics ?? {};
  const events = turn.events ?? [];
  const switches = events
    .filter(event => event.type === 'model_switch')
    .map(event => event.data ?? {});
  const resolved = events
    .filter(event => event.type === 'model_resolved')
    .map(event => event.data ?? {});
  return {
    ts: turn.completedAt ?? new Date().toISOString(),
    sessionId: session?.id ?? null,
    turnId: turn.id,
    model: turn.model ?? null,
    finalModel: turn.finalModel ?? switches.at(-1)?.to ?? turn.model ?? null,
    attemptedModels: [...new Set([
      turn.model,
      ...switches.flatMap(item => [item.from, item.to]),
    ].filter(Boolean))],
    modelSwitches: switches.length,
    resolvedModels: [...new Set(resolved.map(item => item.model).filter(Boolean))],
    resolvedProviders: [...new Set(resolved.map(item => item.provider).filter(Boolean))],
    status: turn.status ?? null,
    promptTokens: m.promptTokens ?? 0,
    completionTokens: m.completionTokens ?? 0,
    totalTokens: m.totalTokens ?? 0,
    estCostUsd: estimateCost(turn.finalModel ?? turn.model, m),
    durationMs: m.durationMs ?? null,
    toolCalls: events.reduce((count, event) => count
      + (event.type === 'tool_call' ? 1 : 0)
      + (event.type === 'tool_activity_summary' ? Number(event.data?.calls) || 0 : 0), 0),
    // Context-management signal: lets the dataset show whether the runaway guard
    // fired and whether history was auto-compacted, so per-turn input-token growth
    // can be tracked before/after the context fixes.
    iterations: events.filter(e => e.type === 'model_request_started').length,
    hitToolCap: events.some(e => e.type === 'max_iterations'),
    compacted: !!turn.compacted,
    prompt: turn.prompt ?? '',
    cwd: turn.cwd ?? null,
  };
}

export function appendUsage(record, { dir = usageDir() } = {}) {
  try {
    appendPrivateFileSync(path.join(dir, 'usage.jsonl'), JSON.stringify(record) + '\n');
  } catch { /* never break a turn on a logging failure */ }
}

// Build + append a record when usage logging is enabled. Returns the record (or
// null when disabled) so callers/tests can inspect it.
export function recordTurnUsage(turn, session) {
  if (!usageEnabled()) return null;
  const record = buildUsageRecord(turn, session);
  appendUsage(record);
  return record;
}
