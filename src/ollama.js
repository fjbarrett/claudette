// Ollama API client — direct connection, no server proxy
import { resolveOllamaBaseUrl } from './config.js';
import { providerHttpError } from './retry.js';

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
    // Ollama reports what a model can actually do ("tools", "thinking", …).
    // Auto-selection used to guess from a hardcoded list of name fragments,
    // which rots: none of qwen3.6/gpt-oss/devstral matched it.
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
  }));
}

/**
 * Stream a chat completion.
 * Calls onDelta(delta) for each text chunk as it arrives.
 * Returns { content, toolCalls, promptTokens, completionTokens }
 */
// Ollama defaults num_ctx to 4096, which truncates an agent loop almost
// immediately, so we always send one. 32k is a safe default for a laptop; models
// that advertise far more (qwen3.6 exposes 256k) were still capped at 32k with no
// way to raise it, hence the override.
export function resolveNumCtx(env = process.env) {
  const n = Number(env.CLAUDETTE_NUM_CTX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32768;
}

/**
 * Whether to let a local model "think" before answering.
 *
 * This is the single biggest lever on local speed, and the default was costing
 * everything. Measured on an M1 Max, prompt "Reply with just the word READY":
 *
 *   qwen3.6:27b-opencode      think on 17.2s → off 0.8s   (21×)
 *   qwen3.6:35b-a3b-opencode  think on 11.6s → off 0.4s   (29×)
 *
 * The models burn ~1000 reasoning tokens before the first content token, on
 * every iteration of an agent loop. Off by default, therefore; `--effort medium`
 * or higher turns it back on, which is exactly what that flag already meant.
 * CLAUDETTE_THINK=1/0 forces it either way.
 */
export function resolveThink(effort = null, env = process.env) {
  const forced = env.CLAUDETTE_THINK;
  if (forced != null && forced !== '') return forced !== '0' && String(forced).toLowerCase() !== 'false';
  return ['medium', 'high', 'xhigh', 'max'].includes(effort);
}

export async function chatStream({ model, messages, tools = [], onDelta, signal, effort = null }) {
  const body = {
    model,
    messages,
    stream: true,
    // `think: false` is accepted by every model; `think: true` is a 400 on one
    // that has no thinking mode, so it is only ever sent deliberately.
    think: resolveThink(effort),
    options: { temperature: 0, num_ctx: resolveNumCtx() },
  };
  let toolMode = tools.length ? 'native' : 'none';
  let res = await postChat({
    body: tools.length ? { ...body, tools } : body,
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    // `--effort high` against a model with no thinking mode is a 400. That is a
    // reasonable thing for a user to ask for and a silly thing to fail on, so
    // drop the flag and run without it.
    if (res.status === 400 && /does not support thinking/i.test(txt)) {
      const { think, ...noThink } = body;
      res = await postChat({ body: tools.length ? { ...noThink, tools } : noThink, signal });
      if (!res.ok) throw providerHttpError('Ollama', res, await res.text().catch(() => ''));
    } else {
    const unsupportedTools = tools.length
      && res.status === 400
      && /does not support tools/i.test(txt);
    if (!unsupportedTools) {
      throw providerHttpError('Ollama', res, txt);
    }

    toolMode = 'text';
    const fallbackMessages = injectFallbackToolPrompt(messages);
    res = await postChat({
      body: { ...body, messages: fallbackMessages },
      signal,
    });
    if (!res.ok) {
      const fallbackText = await res.text().catch(() => '');
      throw providerHttpError('Ollama', res, fallbackText);
    }
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
