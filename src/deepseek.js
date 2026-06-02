// DeepSeek adapter — first-party OpenAI-compatible API (api.deepseek.com).
//
// Models are addressed `deepseek/<id>` (e.g. `deepseek/deepseek-reasoner`).
// DeepSeek also runs locally via Ollama (`ollama/deepseek-r1`,
// `ollama/deepseek-coder-v2`) with no key. Reuses the OpenAI Chat Completions
// transport but owns its base URL, key, and model list so it can diverge
// (e.g. surfacing deepseek-reasoner's reasoning_content) independently.

import { chatCompletionsStream } from './openai.js';

const PREFIX = 'deepseek/';
export const KEY_ENV = 'DEEPSEEK_API_KEY';
export const LABEL = 'DeepSeek';
export const id = 'deepseek';

const KNOWN_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

function apiBase() {
  return (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
}
function apiKey() {
  return process.env.DEEPSEEK_API_KEY ?? '';
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

export async function getModels() {
  if (!hasCredentials()) return [];
  return KNOWN_MODELS.map(idStr => ({
    name: `${PREFIX}${idStr}`,
    size: 0,
    family: 'deepseek',
    paramSize: 'cloud',
    modified: null,
  }));
}

export async function chatStream({ model, messages, tools = [], onDelta, signal }) {
  if (!hasCredentials()) {
    throw new Error(`${KEY_ENV} is not set — cannot reach ${LABEL}`);
  }
  return chatCompletionsStream({
    baseUrl: apiBase(),
    apiKey: apiKey(),
    model: stripPrefix(model),
    messages, tools, onDelta, signal, label: LABEL,
  });
}
