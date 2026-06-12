// HuggingFace adapter — OpenAI-compatible Inference Providers router
// (router.huggingface.co/v1).
//
// Models are addressed `hf/<org>/<model>` (e.g.
// `hf/meta-llama/Llama-3.3-70B-Instruct`) — note HF ids themselves contain a
// slash, so only the leading `hf/` (or `huggingface/`) segment is stripped.
// This is another hosted path for Meta/Facebook Llama and many open models.

import { chatCompletionsStream } from './openai.js';

const PREFIXES = ['hf/', 'huggingface/'];
export const KEY_ENV = 'HF_TOKEN';
export const LABEL = 'HuggingFace';
export const id = 'huggingface';

const KNOWN_MODELS = ['meta-llama/Llama-3.3-70B-Instruct', 'deepseek-ai/DeepSeek-V3'];

function apiBase() {
  return (process.env.HF_BASE_URL ?? 'https://router.huggingface.co/v1').replace(/\/+$/, '');
}
function apiKey() {
  return process.env.HF_TOKEN ?? process.env.HUGGINGFACE_API_KEY ?? '';
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
  return KNOWN_MODELS.map(idStr => ({
    name: `hf/${idStr}`,
    size: 0,
    family: 'huggingface',
    paramSize: 'cloud',
    modified: null,
  }));
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
  });
}
