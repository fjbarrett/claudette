// OpenAI adapter + shared Chat Completions transport.
//
// Models are addressed `openai/<id>` (e.g. `openai/gpt-4o`). This module also
// exports the OpenAI-compatible Chat Completions plumbing — chatCompletionsStream,
// toOpenAIMessages, toOpenAITools — reused by the sibling bespoke adapters
// (deepseek.js, groq.js, huggingface.js), which each own their base URL, key,
// and model list while sharing this wire protocol.

const PREFIX = 'openai/';
export const KEY_ENV = 'OPENAI_API_KEY';
export const LABEL = 'OpenAI';
export const id = 'openai';

// Starter list surfaced in /models when a key is set. Non-authoritative: any
// `openai/<id>` works via chatStream regardless of what's listed here.
const KNOWN_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'o4-mini'];

// Picked when a caller needs a model and the user didn't choose one (see
// provider.js defaultCloudModels): a capable agent, a cheap high-volume judge.
export const DEFAULT_MODELS = {
  agent: 'openai/gpt-4o',
  judge: 'openai/gpt-4o-mini',
};

function apiBase() {
  return (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
}
function apiKey() {
  return process.env.OPENAI_API_KEY ?? '';
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
    family: 'openai',
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
    messages, tools, onDelta, signal, label: LABEL,
    effort, reasoningStyle: 'openai',
  });
}

// ─── Shared OpenAI-compatible Chat Completions transport ─────────────────────

/**
 * Stream a chat completion from any OpenAI-compatible /chat/completions endpoint.
 * Mirrors the ollama.js / anthropic.js contract: calls onDelta(text) per chunk
 * and returns { content, toolCalls, hadApiToolCalls, promptTokens,
 * completionTokens, toolMode }. `baseUrl` must include the version segment
 * (e.g. `.../v1`); `/chat/completions` is appended.
 *
 * `effort` (low|medium|high|xhigh|max) sets reasoning depth on models that
 * support it. The wire field differs by ecosystem: OpenRouter wants a nested
 * `reasoning: { effort }`, plain OpenAI-compatible endpoints want a flat
 * `reasoning_effort` — `reasoningStyle` picks which. Only sent when `effort`
 * is set, so default requests are byte-identical to before.
 */
export async function chatCompletionsStream({
  baseUrl, apiKey, model, messages, tools = [], onDelta, signal,
  label = 'OpenAI', extraHeaders = {}, effort = null, reasoningStyle = 'openai',
}) {
  if (!apiKey) throw new Error(`${label}: missing API key`);

  const body = {
    model,
    messages: toOpenAIMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
  };
  if (tools.length) body.tools = toOpenAITools(tools);
  if (effort) {
    if (reasoningStyle === 'openrouter') body.reasoning = { effort };
    else body.reasoning_effort = effort;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    throw new Error(`${label} chat (${res.status}): ${txt}`);
  }

  const result = await parseChatCompletionsSSE(res.body, onDelta);
  result.toolMode = tools.length ? 'native' : 'none';
  return result;
}

// ─── Provider factory ────────────────────────────────────────────────────────

/**
 * Build a provider module (same shape as the bespoke adapters) for any
 * OpenAI-compatible, Bearer-authenticated endpoint. Used by src/providers.js to
 * register the long tail of frontier providers and hosting platforms from a
 * single catalog table. Any row can be promoted to a bespoke file later if it
 * grows provider-specific quirks.
 *
 *   prefixes   — addressing prefixes, e.g. ['openrouter/'] (first is canonical)
 *   keyEnv     — primary API-key env var; altKeyEnvs are accepted fallbacks
 *   baseUrl    — default endpoint incl. version segment (…/v1); /chat/completions
 *                is appended. Overridable via baseUrlEnv (handy for tests/proxies)
 *   models     — starter ids surfaced in /models (non-authoritative)
 */
export function makeOpenAICompatibleProvider({
  id, label, prefixes, keyEnv, altKeyEnvs = [], baseUrl, baseUrlEnv, family, models = [],
}) {
  const pres = Array.isArray(prefixes) ? prefixes : [prefixes];
  const keyEnvs = [keyEnv, ...altKeyEnvs];
  const readKey = () => {
    for (const k of keyEnvs) if (process.env[k]) return process.env[k];
    return '';
  };
  const readBase = () =>
    ((baseUrlEnv && process.env[baseUrlEnv]) || baseUrl).replace(/\/+$/, '');

  const handles = m => typeof m === 'string' && pres.some(p => m.startsWith(p));
  const stripPrefix = m => {
    const p = typeof m === 'string' && pres.find(pre => m.startsWith(pre));
    return p ? m.slice(p.length) : m;
  };
  const hasCredentials = () => Boolean(readKey());

  return {
    id,
    LABEL: label,
    KEY_ENV: keyEnv,
    handles,
    stripPrefix,
    hasCredentials,
    async getModels() {
      if (!hasCredentials()) return [];
      return models.map(idStr => ({
        name: `${pres[0]}${idStr}`,
        size: 0,
        family: family ?? id,
        paramSize: 'cloud',
        modified: null,
      }));
    },
    async chatStream({ model, messages, tools = [], onDelta, signal, effort = null }) {
      if (!hasCredentials()) {
        throw new Error(`${keyEnv} is not set — cannot reach ${label}`);
      }
      return chatCompletionsStream({
        baseUrl: readBase(),
        apiKey: readKey(),
        model: stripPrefix(model),
        messages, tools, onDelta, signal, label,
        effort, reasoningStyle: 'openrouter',
      });
    },
  };
}

// ─── Format translation ──────────────────────────────────────────────────────

function asText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : c.text ?? '')).join('');
  }
  return String(content);
}

// Internal tool defs are already OpenAI-shaped; normalise the wrapper.
export function toOpenAITools(tools) {
  return tools.map(t => {
    const fn = t.function ?? t;
    return {
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description ?? '',
        parameters: fn.parameters ?? { type: 'object', properties: {} },
      },
    };
  });
}

/**
 * Normalise the internal message list to OpenAI Chat Completions shape.
 *
 * The agent loop frequently omits tool-call ids (text-parsed calls have none),
 * so ids are synthesised per assistant turn and matched to the following tool
 * results positionally — results always follow their calls in order. Tool-call
 * arguments are serialised to strings, which Chat Completions requires.
 */
export function toOpenAIMessages(messages = []) {
  const out = [];
  let pendingToolIds = [];

  for (const m of messages) {
    if (m.role === 'assistant') {
      let toolCalls = null;
      pendingToolIds = [];
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        toolCalls = m.tool_calls.map((call, i) => {
          const fn = call.function ?? {};
          const callId = call.id || `call_${out.length}_${i}`;
          pendingToolIds.push(callId);
          let args = fn.arguments;
          if (typeof args !== 'string') args = JSON.stringify(args ?? {});
          return { id: callId, type: 'function', function: { name: fn.name, arguments: args } };
        });
      }
      const text = asText(m.content);
      const msg = { role: 'assistant', content: text || (toolCalls ? null : '') };
      if (toolCalls) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    if (m.role === 'tool') {
      const callId = pendingToolIds.length ? pendingToolIds.shift() : (m.tool_call_id || 'tool_call');
      out.push({ role: 'tool', tool_call_id: callId, content: asText(m.content) });
      continue;
    }

    // system, user, and anything else → passthrough text
    out.push({ role: m.role, content: asText(m.content) });
  }

  return out;
}

// ─── SSE stream assembly ─────────────────────────────────────────────────────

async function parseChatCompletionsSSE(stream, onDelta) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let fullContent = '';
  const toolsByIndex = new Map();   // delta index → { id, name, argsBuf }
  const order = [];                 // first-seen index order
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (delta.content) {
        fullContent += delta.content;
        onDelta?.(delta.content);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let entry = toolsByIndex.get(idx);
          if (!entry) {
            entry = { id: tc.id || null, name: '', argsBuf: '' };
            toolsByIndex.set(idx, entry);
            order.push(idx);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.argsBuf += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls = order.map((idx, i) => {
    const e = toolsByIndex.get(idx);
    let args = {};
    if (e.argsBuf.trim()) {
      try { args = JSON.parse(e.argsBuf); } catch { args = { _raw: e.argsBuf }; }
    }
    return { id: e.id || `call_${i}`, function: { name: e.name, arguments: args } };
  });

  return {
    content: fullContent.trim(),
    toolCalls: toolCalls.length ? toolCalls : null,
    hadApiToolCalls: toolCalls.length > 0,
    promptTokens,
    completionTokens,
  };
}
