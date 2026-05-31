// Anthropic Messages API client.
//
// Mirrors the ollama.js chatStream() contract so the agent loop, server, and
// benchmark harness can stream from Claude models transparently. Models are
// addressed with an `anthropic:` prefix (e.g. `anthropic:claude-opus-4-8`);
// the prefix is stripped before hitting the API.

const PREFIX = 'anthropic:';
const API_VERSION = '2023-06-01';

// Current Claude models surfaced when ANTHROPIC_API_KEY is set.
const KNOWN_MODELS = [
  { id: 'claude-opus-4-8',   paramSize: 'cloud' },
  { id: 'claude-sonnet-4-6', paramSize: 'cloud' },
  { id: 'claude-haiku-4-5',  paramSize: 'cloud' },
];

// Env is read at call time (not module load) so tests can point the client at
// a mock server and toggle credentials between cases.
function apiBase() {
  return (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
}
function apiKey() {
  return process.env.ANTHROPIC_API_KEY ?? '';
}

export function isAnthropicModel(model) {
  return typeof model === 'string' && model.startsWith(PREFIX);
}

export function stripPrefix(model) {
  return isAnthropicModel(model) ? model.slice(PREFIX.length) : model;
}

export function hasCredentials() {
  return Boolean(apiKey());
}

export async function getModels() {
  if (!hasCredentials()) return [];
  return KNOWN_MODELS.map(m => ({
    name: `${PREFIX}${m.id}`,
    size: 0,
    family: 'anthropic',
    paramSize: m.paramSize,
    modified: null,
  }));
}

/**
 * Stream a chat completion from the Anthropic Messages API.
 * Calls onDelta(text) for each text chunk as it arrives.
 * Returns { content, toolCalls, hadApiToolCalls, promptTokens, completionTokens, toolMode }
 * in the same shape as ollama.js chatStream().
 */
export async function chatStream({ model, messages, tools = [], onDelta, signal }) {
  if (!hasCredentials()) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot reach the Anthropic API');
  }

  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const body = {
    model: stripPrefix(model),
    max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 4096),
    stream: true,
    messages: anthropicMessages,
  };
  if (system) body.system = system;
  if (tools.length) body.tools = toAnthropicTools(tools);

  const res = await fetch(`${apiBase()}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey(),
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Anthropic chat (${res.status}): ${txt}`);
  }

  const result = await parseSSE(res.body, onDelta);
  result.toolMode = tools.length ? 'native' : 'none';
  return result;
}

// ─── Format translation ─────────────────────────────────────────────────────

// OpenAI/Ollama-style tool defs → Anthropic tool defs.
export function toAnthropicTools(tools) {
  return tools.map(t => {
    const fn = t.function ?? t;
    return {
      name: fn.name,
      description: fn.description ?? '',
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    };
  });
}

function asText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : c.text ?? '')).join('');
  }
  return String(content);
}

/**
 * Translate the internal OpenAI/Ollama-style message list into Anthropic's
 * Messages format: pull the system prompt to a top-level field, emit tool
 * calls as `tool_use` blocks and tool results as `tool_result` blocks.
 *
 * The agent loop frequently omits tool-call ids (text-parsed calls have none),
 * so ids are synthesized per assistant turn and matched to the following tool
 * results positionally — results always follow their calls in order.
 */
export function toAnthropicMessages(messages = []) {
  let system = '';
  const out = [];
  let pendingToolIds = [];

  for (const m of messages) {
    if (m.role === 'system') {
      const t = asText(m.content);
      if (t) system += (system ? '\n\n' : '') + t;
      continue;
    }

    if (m.role === 'assistant') {
      const blocks = [];
      const text = asText(m.content);
      if (text) blocks.push({ type: 'text', text });
      pendingToolIds = [];
      if (Array.isArray(m.tool_calls)) {
        m.tool_calls.forEach((call, i) => {
          const fn = call.function ?? {};
          const id = call.id || `call_${out.length}_${i}`;
          pendingToolIds.push(id);
          let input = fn.arguments;
          if (typeof input === 'string') {
            try { input = JSON.parse(input); } catch { input = { value: input }; }
          }
          blocks.push({ type: 'tool_use', id, name: fn.name, input: input ?? {} });
        });
      }
      // Anthropic requires non-empty content; fall back to a single space.
      out.push({ role: 'assistant', content: blocks.length ? blocks : (text || ' ') });
      continue;
    }

    if (m.role === 'tool') {
      const id = pendingToolIds.length ? pendingToolIds.shift() : (m.tool_call_id || 'tool_result');
      const block = { type: 'tool_result', tool_use_id: id, content: asText(m.content) };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) &&
          last.content.every(b => b.type === 'tool_result')) {
        last.content.push(block);   // merge consecutive results into one user turn
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    // user (and anything else) → plain user text
    out.push({ role: 'user', content: asText(m.content) });
  }

  return { system, messages: out };
}

// ─── SSE stream assembly ─────────────────────────────────────────────────────

async function parseSSE(stream, onDelta) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let fullContent = '';
  const tools = [];               // ordered { id, name, jsonBuf }
  const toolByIndex = new Map();  // content-block index → tools[] entry
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
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }

      switch (evt.type) {
        case 'message_start':
          promptTokens = evt.message?.usage?.input_tokens ?? 0;
          break;
        case 'content_block_start':
          if (evt.content_block?.type === 'tool_use') {
            const entry = { id: evt.content_block.id, name: evt.content_block.name, jsonBuf: '' };
            tools.push(entry);
            toolByIndex.set(evt.index, entry);
          }
          break;
        case 'content_block_delta':
          if (evt.delta?.type === 'text_delta') {
            const text = evt.delta.text ?? '';
            if (text) { fullContent += text; onDelta?.(text); }
          } else if (evt.delta?.type === 'input_json_delta') {
            const entry = toolByIndex.get(evt.index);
            if (entry) entry.jsonBuf += evt.delta.partial_json ?? '';
          }
          break;
        case 'message_delta':
          completionTokens = evt.usage?.output_tokens ?? completionTokens;
          break;
        default:
          break;
      }
    }
  }

  const toolCalls = tools.map(t => {
    let args = {};
    if (t.jsonBuf.trim()) {
      try { args = JSON.parse(t.jsonBuf); } catch { args = { _raw: t.jsonBuf }; }
    }
    return { id: t.id, function: { name: t.name, arguments: args } };
  });

  return {
    content: fullContent.trim(),
    toolCalls: toolCalls.length ? toolCalls : null,
    hadApiToolCalls: toolCalls.length > 0,
    promptTokens,
    completionTokens,
  };
}
