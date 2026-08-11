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
import { withRetry, createStallGuard } from './retry.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(PACKAGE_ROOT, 'bench', 'runs', '.cache');
// Bump when the cached result shape or the key inputs change, so stale entries
// from an older format never produce a false hit.
const CACHE_VERSION = 'v1';

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

// Hash every request field that can change the output. Streaming/cancellation
// plumbing (onDelta, onEvent, signal) is excluded because it doesn't affect the
// model's response. stableStringify makes the digest independent of property
// insertion order so equivalent requests from different call sites collide.
export function getCacheKey(opts) {
  const { signal, onDelta, onEvent, onRetry, ...rest } = opts;
  return crypto.createHash('sha256')
    .update(`${CACHE_VERSION}\n${stableStringify(rest)}`)
    .digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function readCache(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`\x1b[33m⚠ bench cache read failed (${path.basename(file)}): ${err.message}\x1b[0m`);
    }
    return null; // clean miss, or unreadable — fall through to a live call
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`\x1b[33m⚠ bench cache entry corrupt, ignoring: ${path.basename(file)}\x1b[0m`);
    return null;
  }
}

export async function writeCache(file, result) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Atomic publish: write to a unique temp file then rename, so a concurrent
    // reader sees either the previous entry or the complete new one, never a
    // half-written file.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    console.error(`\x1b[33m⚠ bench cache write failed (${path.basename(file)}): ${err.message}\x1b[0m`);
  }
}

export async function chatStream(opts) {
  // Caching is opt-in via the benchmark harness (CLAUDETTE_BENCH_CACHE=1) so
  // interactive/server calls always hit the live provider.
  const cacheFile = process.env.CLAUDETTE_BENCH_CACHE === '1'
    ? path.join(CACHE_DIR, `${getCacheKey(opts)}.json`)
    : null;

  if (cacheFile) {
    const cached = await readCache(cacheFile);
    if (cached) {
      // Replay the full text once so callers that render streamed deltas behave
      // the same on a cache hit as on a live call.
      if (opts.onDelta && cached.content) opts.onDelta(cached.content);
      return cached;
    }
  }

  const provider = providerFor(opts.model);
  // For Ollama, strip an explicit `ollama/` prefix; cloud adapters strip their
  // own prefix internally.
  const model = provider === ollama ? normaliseOllama(opts.model) : opts.model;

  // Rate limits and transient 5xx used to kill the whole turn. Retry them with
  // bounded backoff, but only while the response is still silent: once deltas
  // have reached the terminal, replaying the call would print the answer twice.
  let streamed = false;
  const result = await withRetry(
    async () => {
      const guard = createStallGuard({ signal: opts.signal, label: provider.LABEL ?? 'Provider' });
      try {
        return await provider.chatStream({
          ...opts,
          model,
          signal: guard.signal,
          onDelta: (delta) => {
            streamed = true;
            guard.touch();
            opts.onDelta?.(delta);
          },
        });
      } catch (err) {
        guard.rethrow(err); // stall → actionable error, never a bare AbortError
      } finally {
        guard.done();
      }
    },
    {
      signal: opts.signal,
      canRetry: () => !streamed,
      onRetry: (err, attempt, delay) => {
        opts.onRetry?.({ error: err, attempt, delayMs: delay });
        if (process.env.CLAUDETTE_QUIET_RETRIES !== '1') {
          console.error(
            `\x1b[33m⚠ ${provider.LABEL ?? 'provider'} request failed (${err.status ?? err.code ?? 'network'}), ` +
            // Sub-second delays used to round to "in 0s", which read as "it did
            // not wait at all" while debugging a failed run.
            `retry ${attempt} in ${delay < 1000 ? `${delay}ms` : `${(delay / 1000).toFixed(1)}s`}: ` +
            `${truncate(err.message, 160)}\x1b[0m`
          );
        }
      },
    },
  );

  if (cacheFile) await writeCache(cacheFile, result);
  return result;
}

function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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
