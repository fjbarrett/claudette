// Ollama API client — direct connection, no server proxy
import { resolveOllamaBaseUrl } from './config.js';

const BASE = resolveOllamaBaseUrl();

export async function getModels() {
  const res = await fetch(`${BASE}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags: ${res.status} ${res.statusText}`);
  const { models = [] } = await res.json();
  return models.map(m => ({
    name: m.name,
    size: m.size,
    family: m.details?.family ?? 'unknown',
    paramSize: m.details?.parameter_size ?? '?',
    modified: m.modified_at,
  }));
}

/**
 * Stream a chat completion.
 * Calls onDelta(delta) for each text chunk as it arrives.
 * Returns { content, toolCalls, promptTokens, completionTokens }
 */
export async function chatStream({ model, messages, tools = [], onDelta, signal }) {
  const body = {
    model,
    messages,
    stream: true,
    options: { temperature: 0, num_ctx: 32768 },
  };
  let toolMode = tools.length ? 'native' : 'none';
  let res = await postChat({
    body: tools.length ? { ...body, tools } : body,
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const unsupportedTools = tools.length
      && res.status === 400
      && /does not support tools/i.test(txt);
    if (!unsupportedTools) {
      throw new Error(`Ollama chat (${res.status}): ${txt}`);
    }

    toolMode = 'text';
    const fallbackMessages = injectFallbackToolPrompt(messages);
    res = await postChat({
      body: { ...body, messages: fallbackMessages },
      signal,
    });
    if (!res.ok) {
      const fallbackText = await res.text().catch(() => '');
      throw new Error(`Ollama chat (${res.status}): ${fallbackText}`);
    }
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let fullContent = '';
  let toolCalls = [];
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk;
      try { chunk = JSON.parse(line); } catch { continue; }

      const delta = chunk.message?.content ?? '';
      if (delta) {
        fullContent += delta;
        onDelta?.(delta);
      }

      if (chunk.message?.tool_calls?.length) {
        toolCalls.push(...chunk.message.tool_calls);
      }

      if (chunk.done) {
        promptTokens = chunk.prompt_eval_count ?? 0;
        completionTokens = chunk.eval_count ?? 0;
      }
    }
  }

  return {
    content: stripSpecialTokens(fullContent),
    toolCalls: toolCalls.length ? toolCalls : null,
    hadApiToolCalls: toolCalls.length > 0,
    promptTokens,
    completionTokens,
    toolMode,
  };
}

function stripSpecialTokens(text) {
  // Remove model-internal tokens (DeepSeek BOS/EOS, etc.) that sometimes leak into output
  return text.replace(/<｜[^｜]*｜>/g, '').trim();
}

async function postChat({ body, signal }) {
  return fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

function injectFallbackToolPrompt(messages) {
  const fallback = {
    role: 'system',
    content: [
      'Native tool calling is unavailable for this model.',
      'When you need a tool, respond with ONLY one compact JSON object and nothing else.',
      'Format: {"name":"read_file","arguments":{"path":"src/app.js"}}',
      'Do not use markdown fences. Do not explain your plan. After each tool result, emit the next JSON tool call or the final answer.',
    ].join('\n'),
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return [fallback];
  }
  if (messages[0]?.role === 'system') {
    return [messages[0], fallback, ...messages.slice(1)];
  }
  return [fallback, ...messages];
}
