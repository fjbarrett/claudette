// Groq adapter — OpenAI-compatible, fast hosted inference (api.groq.com).
//
// Models are addressed `groq/<id>`. This is the hosted path for Meta/Facebook
// Llama models (e.g. `groq/llama-3.3-70b-versatile`); Llama also runs locally
// via Ollama (`ollama/llama3.2`). Reuses the OpenAI Chat Completions transport.

import { chatCompletionsStream } from './openai.js';

const PREFIX = 'groq/';
export const KEY_ENV = 'GROQ_API_KEY';
export const LABEL = 'Groq';
export const id = 'groq';

const KNOWN_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

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

export async function getModels() {
  if (!hasCredentials()) return [];
  return KNOWN_MODELS.map(idStr => ({
    name: `${PREFIX}${idStr}`,
    size: 0,
    family: 'llama',
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
