// Groq adapter — OpenAI-compatible, fast hosted inference (api.groq.com).
//
// Models are addressed `groq/<id>`. Only models documented on Groq's Free-plan
// limits table are surfaced here; the live /models response is intersected with
// this allowlist so a deprecated model disappears without accidentally exposing
// a paid-only replacement. Reuses the OpenAI Chat Completions transport.

import { chatCompletionsStream } from './openai.js';
import { resolveMaxTokens } from './llm-config.js';

const PREFIX = 'groq/';
export const KEY_ENV = 'GROQ_API_KEY';
export const LABEL = 'Groq';
export const id = 'groq';

export const FREE_MODELS = [
  { id: 'openai/gpt-oss-120b', family: 'gpt-oss', paramSize: '120b' },
  { id: 'openai/gpt-oss-20b', family: 'gpt-oss', paramSize: '20b' },
  { id: 'qwen/qwen3.8-27b', family: 'qwen', paramSize: '27b-preview' },
  { id: 'qwen/qwen3.6-27b', family: 'qwen', paramSize: '27b-preview' },
];

export const DEFAULT_MODELS = {
  agent: 'groq/openai/gpt-oss-120b',
  judge: 'groq/openai/gpt-oss-20b',
};

function apiBase() {
  return (process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
}
function apiKey() {
  return process.env.GROQ_API_KEY ?? '';
}

export function handles(model) {
  return typeof model === 'string' && model.startsWith(PREFIX);
}
export function stripPrefix(model) {
  return handles(model) ? model.slice(PREFIX.length) : model;
}
export function hasCredentials() {
  return Boolean(apiKey());
}

// Groq Free currently allows 8K tokens/minute for these models. The API counts
// the requested output reservation against that ceiling before generation, so
// even a useful 6.8K agent context fails with a 2K reservation. Keep the Free
// default at 1K; set GROQ_MAX_TOKENS for a different account or workload.
export function resolveGroqMaxTokens() {
  const configured = Number(process.env.GROQ_MAX_TOKENS);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return Math.min(resolveMaxTokens(), 1_024);
}

export async function getModels() {
  if (!hasCredentials()) return [];
  const response = await fetch(`${apiBase()}/models`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`${LABEL} /models returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  const active = new Set(
    Array.isArray(payload.data)
      ? payload.data.map(model => model?.id).filter(idStr => typeof idStr === 'string')
      : [],
  );
  return FREE_MODELS
    .filter(model => active.has(model.id))
    .map(model => ({
      name: `${PREFIX}${model.id}`,
      size: 0,
      family: model.family,
      paramSize: model.paramSize,
      modified: null,
      capabilities: ['tools'],
      access: { free: true, kind: 'recurring', provider: 'groq' },
    }));
}

export const FREE_TIER_DEFAULTS = true;

export async function chatStream({ model, messages, tools = [], onDelta, signal, effort = null }) {
  if (!hasCredentials()) {
    throw new Error(`${KEY_ENV} is not set — cannot reach ${LABEL}`);
  }
  return chatCompletionsStream({
    baseUrl: apiBase(),
    apiKey: apiKey(),
    model: stripPrefix(model),
    messages, tools, onDelta, signal, label: LABEL, effort,
    maxTokens: resolveGroqMaxTokens(),
  });
}
