// HuggingFace adapter — OpenAI-compatible Inference Providers router
// (router.huggingface.co/v1).
//
// Models are addressed `hf/<org>/<model>` (e.g.
// `hf/meta-llama/Llama-3.3-70B-Instruct`) — note HF ids themselves contain a
// slash, so only the leading `hf/` (or `huggingface/`) segment is stripped.
// This is another hosted path for Meta/Facebook Llama and many open models.

import { chatCompletionsStream } from './openai.js';
import { resolveMaxTokens } from './llm-config.js';

const PREFIXES = ['hf/', 'huggingface/'];
export const KEY_ENV = 'HF_TOKEN';
export const LABEL = 'HuggingFace';
export const id = 'huggingface';

function apiBase() {
  return (process.env.HF_BASE_URL ?? 'https://router.huggingface.co/v1').replace(/\/+$/, '');
}
function apiKey() {
  return process.env.HF_TOKEN ?? process.env.HF_KEY ?? process.env.HUGGINGFACE_API_KEY ?? '';
}

export function handles(model) {
  return typeof model === 'string' && PREFIXES.some(p => model.startsWith(p));
}
export function stripPrefix(model) {
  const p = typeof model === 'string' && PREFIXES.find(pre => model.startsWith(pre));
  return p ? model.slice(p.length) : model;
}
export function hasCredentials() {
  return Boolean(apiKey());
}

export async function getModels() {
  if (!hasCredentials()) return [];
  const response = await fetch(`${apiBase()}/models`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`${LABEL} /models returned HTTP ${response.status}`);
  const payload = await response.json();
  const models = payload.data ?? [];
  return models.flatMap(model => (model.providers ?? [])
    .filter(provider => provider.status === 'live' && provider.is_free === true && provider.supports_tools === true)
    .map(provider => ({
      name: `hf/${model.id}:${provider.provider}`,
      size: 0,
      family: model.owned_by ?? model.id?.split('/')[0] ?? 'huggingface',
      paramSize: 'free',
      modified: null,
      capabilities: ['tools'],
      access: { free: true, kind: 'recurring', provider: `huggingface:${provider.provider}` },
      contextLength: provider.context_length ?? null,
    })));
}

export function resolveHfMaxTokens() {
  const configured = Number(process.env.HF_MAX_TOKENS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : Math.min(resolveMaxTokens(), 1_024);
}

export async function chatStream({ model, messages, tools = [], onDelta, signal, effort = null }) {
  if (!hasCredentials()) {
    throw new Error(`${KEY_ENV} is not set — cannot reach ${LABEL}`);
  }
  return chatCompletionsStream({
    baseUrl: apiBase(),
    apiKey: apiKey(),
    model: stripPrefix(model),
    messages, tools, onDelta, signal, label: LABEL, effort,
    maxTokens: resolveHfMaxTokens(),
  });
}
