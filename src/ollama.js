// Ollama API client — direct connection, no server proxy
const BASE = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';

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
    options: { temperature: 0.7 },
  };
  // Only attach tools if provided — some older Ollama versions reject unknown fields
  if (tools.length) body.tools = tools;

  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Ollama chat (${res.status}): ${txt}`);
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
    content: fullContent,
    toolCalls: toolCalls.length ? toolCalls : null,
    promptTokens,
    completionTokens,
  };
}
