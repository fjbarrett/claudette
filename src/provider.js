// Provider router.
//
// Models are addressed `provider/model` (LiteLLM/terminal-bench style):
//   anthropic/claude-opus-4-8   openai/gpt-4o   deepseek/deepseek-reasoner
//   groq/llama-3.3-70b-versatile   hf/meta-llama/Llama-3.3-70B-Instruct
// Anything without a recognised provider prefix (e.g. `qwen2.5-coder:14b`, or
// `ollama/llama3.2`) routes to local Ollama. The legacy `anthropic:` colon form
// is still accepted. Consumers (chat.js, server.js, the benchmark CLI) import
// from here rather than a specific backend, so adding a provider is a one-line
// registry change.

import * as ollama from './ollama.js';
import * as anthropic from './anthropic.js';
import * as openai from './openai.js';
import * as deepseek from './deepseek.js';
import * as groq from './groq.js';
import * as huggingface from './huggingface.js';
import { catalogProviders } from './providers.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(PACKAGE_ROOT, 'bench', 'runs', '.cache');

// Cloud providers, in /models display order. Each exposes the same contract:
// handles() · getModels() · chatStream() · hasCredentials() · KEY_ENV · LABEL.
// The bespoke modules come first; the catalog (OpenRouter, Together, Fireworks,
// Google, xAI, Mistral, Cohere, Perplexity) supplies the long tail.
const CLOUD = [anthropic, openai, deepseek, groq, huggingface, ...catalogProviders];

// Explicit `ollama/` prefix → strip it before hitting the Ollama API.
const OLLAMA_PREFIX = 'ollama/';
function normaliseOllama(model) {
  return typeof model === 'string' && model.startsWith(OLLAMA_PREFIX)
    ? model.slice(OLLAMA_PREFIX.length)
    : model;
}

export function providerFor(model) {
  for (const p of CLOUD) {
    if (p.handles(model)) return p;
  }
  return ollama; // bare names and `ollama/` prefix
}

/**
 * Merged model list across providers. Cloud models (only those whose key is
 * set) are listed first; Ollama failures are swallowed so cloud models remain
 * usable when no local Ollama is reachable.
 */
export async function getModels() {
  const lists = await Promise.all([
    ...CLOUD.map(p => p.getModels().catch(() => [])),
    ollama.getModels().catch(() => []),
  ]);
  return lists.flat();
}

function getCacheKey(opts) {
  const serializable = {
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    effort: opts.effort,
  };
  const str = JSON.stringify(serializable);
  return crypto.createHash('sha256').update(str).digest('hex');
}

export async function chatStream(opts) {
  const isCacheEnabled = process.env.CLAUDETTE_BENCH_CACHE === '1';

  if (isCacheEnabled) {
    const key = getCacheKey(opts);
    const cacheFile = path.join(CACHE_DIR, `${key}.json`);
    try {
      const cacheContent = await fs.readFile(cacheFile, 'utf8');
      const cachedResult = JSON.parse(cacheContent);
      if (opts.onDelta && cachedResult.content) {
        opts.onDelta(cachedResult.content);
      }
      return cachedResult;
    } catch (err) {
      // Cache miss or read/parse error
    }
  }

  const provider = providerFor(opts.model);
  // For Ollama, strip an explicit `ollama/` prefix; cloud adapters strip their
  // own prefix internally.
  const model = provider === ollama ? normaliseOllama(opts.model) : opts.model;
  const result = await provider.chatStream({ ...opts, model });

  if (isCacheEnabled) {
    const key = getCacheKey(opts);
    const cacheFile = path.join(CACHE_DIR, `${key}.json`);
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      // Ignore write errors
    }
  }

  return result;
}


/**
 * Agent/judge default models from the first credentialed cloud provider that
 * declares them (registry display order: Anthropic, then OpenAI, ...), or null
 * when no cloud key is set. Lets callers (e.g. the benchmark CLI) pick
 * cloud-first defaults instead of assuming a local Ollama is running.
 */
export function defaultCloudModels() {
  for (const p of CLOUD) {
    if (p.DEFAULT_MODELS && p.hasCredentials?.()) return p.DEFAULT_MODELS;
  }
  return null;
}

/**
 * First requested model whose cloud provider is missing credentials, or null if
 * all are reachable. Lets callers (e.g. the benchmark CLI) fail fast before
 * doing expensive setup. Local Ollama models never require credentials.
 */
export function missingCredential(models) {
  for (const model of models) {
    const provider = providerFor(model);
    if (provider !== ollama && provider.hasCredentials && !provider.hasCredentials()) {
      return { model, env: provider.KEY_ENV, label: provider.LABEL };
    }
  }
  return null;
}
