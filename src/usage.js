// Append-only per-turn token/cost usage log (JSONL).
//
// One flat record per completed turn, written to data/usage/usage.jsonl, so you
// can build datasets to study and improve token efficiency. On by default;
// disable with CLAUDETTE_USAGE_LOG=0, relocate with CLAUDETTE_USAGE_DIR. Skipped
// under NODE_ENV=test so the suite doesn't write logs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateCost } from './cost.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'usage');

export function usageEnabled() {
  return process.env.NODE_ENV !== 'test' && process.env.CLAUDETTE_USAGE_LOG !== '0';
}

export function usageDir() {
  return process.env.CLAUDETTE_USAGE_DIR || DEFAULT_DIR;
}

// Flatten a finished trace turn (+ its session) into a dataset-friendly row.
// Token counts are exact (provider-reported); estCostUsd is an estimate and is
// null for unpriced models — keep tokens as the ground truth for training.
export function buildUsageRecord(turn, session) {
  const m = turn.metrics ?? {};
  return {
    ts: turn.completedAt ?? new Date().toISOString(),
    sessionId: session?.id ?? null,
    turnId: turn.id,
    model: turn.model ?? null,
    status: turn.status ?? null,
    promptTokens: m.promptTokens ?? 0,
    completionTokens: m.completionTokens ?? 0,
    totalTokens: m.totalTokens ?? 0,
    estCostUsd: estimateCost(turn.model, m),
    durationMs: m.durationMs ?? null,
    toolCalls: (turn.events ?? []).filter(e => e.type === 'tool_call').length,
    prompt: turn.prompt ?? '',
    cwd: turn.cwd ?? null,
  };
}

export function appendUsage(record, { dir = usageDir() } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'usage.jsonl'), JSON.stringify(record) + '\n', 'utf8');
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
