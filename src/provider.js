// Provider router.
//
// Models are addressed `provider/model` (LiteLLM/terminal-bench style):
//   anthropic/claude-opus-4-8   openai/gpt-4o   deepseek/deepseek-reasoner
//   groq/openai/gpt-oss-120b   hf/meta-llama/Llama-3.3-70B-Instruct
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
import {
  filterModelsForPolicy,
  freeCodingModelRank,
  freeTierOnly,
  modelPolicyActive,
  rankFreeCodingModels,
  requireToolSupport,
  unavailableModelMessage,
} from './model-policy.js';
import { withRetry, createStallGuard, isRetryable } from './retry.js';
import crypto from 'node:crypto';

async function pMap(items, fn, concurrency = 3) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
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
  const cloudLists = await pMap(CLOUD, p => p.getModels().catch(err => { console.warn(`${p.LABEL ?? p.id} getModels failed: ${err.message}`); return []; }), 3);
  const ollamaList = await ollama.getModels().catch(err => { console.warn(`ollama getModels failed: ${err.message}`); return []; });
  const lists = [...cloudLists, ollamaList];
  const models = rankFreeCodingModels(filterModelsForPolicy(lists.flat()));
  rememberValidatedModels(models);
  return models;
}

// A validated catalog entry is cached for the process lifetime under the exact
// active policy. Interactive startup always calls getModels(), so agent-loop
// iterations do not repeatedly spend network requests on provider discovery.
const validatedModels = new Map(); // LRU bounded
function policyKey(model) {
  return `${freeTierOnly() ? 1 : 0}:${requireToolSupport() ? 1 : 0}:${model}`;
}
function canonicalModelName(model, provider = providerFor(model)) {
  return provider === ollama ? normaliseOllama(model) : model;
}
function rememberValidatedModels(models) {
  for (const model of models) {
    const k = policyKey(model.name);
    validatedModels.delete(k);
    validatedModels.set(k, Date.now());
    if (validatedModels.size > 1000) {
      const first = validatedModels.keys().next().value;
      validatedModels.delete(first);
    }
  }
}

export async function assertModelAvailable(model, { models = null } = {}) {
  if (!modelPolicyActive()) return null;
  const provider = providerFor(model);
  const canonical = canonicalModelName(model, provider);
  if (validatedModels.has(policyKey(model)) || validatedModels.has(policyKey(canonical))) return null;

  const candidates = models ?? filterModelsForPolicy(await provider.getModels().catch(() => []));
  const match = candidates.find(item => item.name === model || item.name === canonical);
  if (!match) {
    const error = new Error(unavailableModelMessage(model));
    error.code = 'MODEL_POLICY_REJECTED';
    throw error;
  }
  validatedModels.set(policyKey(model), Date.now());
  validatedModels.set(policyKey(match.name), Date.now());
  return match;
}

// Automatic failover is deliberately independent of the policy opt-out flags:
// even a developer who temporarily lists paid models must never have a failed
// request silently rotate into one. Fallback candidates are always both free
// and native-tool capable.
export function modelRotationEnabled(env = process.env) {
  return env.CLAUDETTE_MODEL_ROTATION !== '0';
}

export function resolveModelRotationMax(env = process.env) {
  const n = Number(env.CLAUDETTE_MODEL_ROTATION_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

export function rotationFailureLabel(error) {
  if (error?.status === 429) return 'rate limit';
  if (error?.status === 413) return 'request too large';
  if (error?.status === 402) return 'free quota unavailable';
  if (error?.stall) return 'provider stalled';
  if (typeof error?.status === 'number') return `HTTP ${error.status}`;
  return error?.code ?? error?.cause?.code ?? 'provider failure';
}

// Conservative preflight estimate. Tokenizers differ, but JSON characters / 4
// plus the normal 1K output reservation is enough to avoid blindly sending a
// 20K-token agent history to Groq's 8K Free-plan TPM bucket. A provider's exact
// 413 "Requested N" value supersedes this estimate below.
export function estimateRequestTokens(messages = [], tools = [], outputReservation = 1_024) {
  let chars = 0;
  try { chars = JSON.stringify({ messages, tools }).length; } catch { return Infinity; }
  return Math.max(0, Math.ceil(chars / 4)) + Math.max(0, Math.floor(outputReservation));
}

export function providerRequestedTokens(error) {
  const match = String(error?.message ?? '').match(/Requested\s+([\d,]+)\b/i);
  return match ? Number(match[1].replaceAll(',', '')) : 0;
}

export function resolveGroqRotationTokenLimit(env = process.env) {
  const configured = Number(env.GROQ_TPM_LIMIT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 8_000;
}

function modelFitsRequest(model, requestTokens, env = process.env) {
  if (!Number.isFinite(requestTokens) || requestTokens <= 0) return true;
  const name = String(model?.name ?? model ?? '');
  if (name.startsWith('groq/')) return requestTokens <= resolveGroqRotationTokenLimit(env);
  const contextLength = Number(model?.contextLength);
  return !Number.isFinite(contextLength) || contextLength <= 0 || requestTokens <= contextLength;
}

function preferProviderHop(error) {
  const status = Number(error?.status);
  return status === 402 || status === 429 || error?.stall === true || status >= 500;
}

function rotationProvider(model) {
  const value = String(model ?? '');
  return value.includes('/') ? value.split('/')[0] : 'ollama';
}

function isFreeToolModel(model) {
  return model?.access?.free === true && model?.capabilities?.includes('tools');
}

/**
 * Stateful selector reused across every request in one agent turn. It never
 * chooses the same model twice. Known coding routes follow the shared practical
 * ranking exactly; unranked routes retain the provider-diversity fallback.
 */
export function createModelRotation({
  initialModel,
  loadModels = getModels,
  maxSwitches = resolveModelRotationMax(),
  enabled = modelRotationEnabled(),
} = {}) {
  const attempted = [];
  const attemptedSet = new Set();
  const failedProviders = new Set();
  let catalog = null;
  let switches = 0;
  let lastSkippedModels = [];

  const remember = (name) => {
    if (!name || attemptedSet.has(name)) return;
    attemptedSet.add(name);
    attempted.push(name);
  };
  remember(initialModel);

  return {
    get attemptedModels() { return [...attempted]; },
    get switches() { return switches; },
    get lastSkippedModels() { return [...lastSkippedModels]; },
    get failedProviders() { return [...failedProviders]; },
    async next({ from, error, streamed = false, requestTokens = 0 } = {}) {
      remember(from);
      lastSkippedModels = [];
      if (!enabled || streamed || error?.name === 'AbortError' || switches >= maxSwitches) {
        return null;
      }

      if (!catalog) {
        try {
          catalog = rankFreeCodingModels((await loadModels()).filter(isFreeToolModel));
        } catch {
          catalog = [];
        }
      }
      const remaining = catalog.filter(item => !attemptedSet.has(item.name));
      if (!remaining.length) return null;

      const exactRequested = providerRequestedTokens(error);
      const effectiveRequestTokens = Math.max(requestTokens || 0, exactRequested || 0);
      const viable = remaining.filter(item => {
        const fits = modelFitsRequest(item, effectiveRequestTokens);
        if (!fits) lastSkippedModels.push(item.name);
        return fits;
      });
      if (!viable.length) return null;

      const triedProviders = new Set(attempted.map(rotationProvider));
      const currentProvider = rotationProvider(from);
      if (preferProviderHop(error)) failedProviders.add(currentProvider);
      const eligible = viable.filter(item => !failedProviders.has(rotationProvider(item.name)));
      if (!eligible.length) return null;
      const chosen = (preferProviderHop(error)
        ? eligible.find(item => rotationProvider(item.name) !== currentProvider)
        : null) ??
        eligible.find(item => freeCodingModelRank(item) != null) ??
        eligible.find(item => !triedProviders.has(rotationProvider(item.name))) ??
        eligible.find(item => rotationProvider(item.name) !== currentProvider) ??
        eligible[0];

      remember(chosen.name);
      switches++;
      return chosen.name;
    },
  };
}

function attachAttemptedModels(error, rotation) {
  if (error && typeof error === 'object') error.attemptedModels = rotation.attemptedModels;
  return error;
}

/**
 * Run one request, rotating only while an attempt is still silent. A stream
 * that has emitted bytes cannot be replayed safely without duplicating output.
 * `request(model, { fastFail, onDelta })` is injected to keep this orchestration
 * unit-testable without live providers.
 */
export async function runWithModelRotation({
  model,
  request,
  rotation,
  onDelta,
  onSwitch,
  requestTokens = 0,
  enabled = modelRotationEnabled(),
} = {}) {
  if (!enabled) {
    const result = await request(model, { fastFail: false, onDelta });
    return { ...result, selectedModel: model, attemptedModels: [model] };
  }

  let activeModel = model;
  let switched = false;
  for (;;) {
    let streamed = false;
    try {
      const result = await request(activeModel, {
        fastFail: true,
        onDelta: (delta) => {
          streamed = true;
          onDelta?.(delta);
        },
      });
      return {
        ...result,
        selectedModel: activeModel,
        attemptedModels: rotation.attemptedModels,
      };
    } catch (error) {
      const next = await rotation.next({ from: activeModel, error, streamed, requestTokens });
      if (!next) {
        // A one-model installation should retain the old bounded retry behavior.
        // We already know this attempt was silent, so retrying it cannot duplicate
        // visible output. Once a real switch occurred, surface the final error.
        if (!switched && !streamed && isRetryable(error)) {
          try {
            const result = await request(activeModel, { fastFail: false, onDelta });
            return {
              ...result,
              selectedModel: activeModel,
              attemptedModels: rotation.attemptedModels,
            };
          } catch (retryError) {
            throw attachAttemptedModels(retryError, rotation);
          }
        }
        throw attachAttemptedModels(error, rotation);
      }

      const event = {
        from: activeModel,
        to: next,
        reason: rotationFailureLabel(error),
        status: error?.status ?? null,
        error,
        switch: rotation.switches,
        requestTokens: Math.max(requestTokens || 0, providerRequestedTokens(error) || 0),
        skippedModels: rotation.lastSkippedModels ?? [],
      };
      await onSwitch?.(event);
      activeModel = next;
      switched = true;
    }
  }
}

// Hash every request field that can change the output. Streaming/cancellation
// plumbing (onDelta, onEvent, signal) is excluded because it doesn't affect the
// model's response. stableStringify makes the digest independent of property
// insertion order so equivalent requests from different call sites collide.
export function getCacheKey(opts) {
  const {
    signal, onDelta, onEvent, onRetry, onModelSwitch,
    rotationState, disableModelRotation, ...rest
  } = opts;
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
    await pruneCacheIfNeeded(path.dirname(file));
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    console.error(`\x1b[33m⚠ bench cache write failed (${path.basename(file)}): ${err.message}\x1b[0m`);
  }
}

const CACHE_MAX_FILES = 500;
const CACHE_MAX_BYTES = 50 * 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function pruneCacheIfNeeded(dir) {
  try {
    const files = await fs.readdir(dir);
    const entries = [];
    let totalBytes = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(dir, f);
      try {
        const stat = await fs.stat(fp);
        entries.push({ fp, mtime: stat.mtimeMs, size: stat.size });
        totalBytes += stat.size;
      } catch {}
    }
    // Evict expired first
    const now = Date.now();
    for (const e of entries) {
      if (now - e.mtime > CACHE_TTL_MS) {
        try { await fs.unlink(e.fp); totalBytes -= e.size; } catch {}
      }
    }
    // Then LRU if over limits
    if (entries.length > CACHE_MAX_FILES || totalBytes > CACHE_MAX_BYTES) {
      entries.sort((a,b) => a.mtime - b.mtime);
      for (const e of entries) {
        if (entries.length <= CACHE_MAX_FILES && totalBytes <= CACHE_MAX_BYTES) break;
        try { await fs.unlink(e.fp); totalBytes -= e.size; } catch {}
      }
    }
  } catch {}
}

export async function pruneBenchCache() {
  await pruneCacheIfNeeded(CACHE_DIR);
}

async function chatStreamOneModel(opts, { fastFail = false } = {}) {
  // Enforce before cache lookup: free-only means a paid model may not be used
  // even if a benchmark response happens to exist locally under its cache key.
  await assertModelAvailable(opts.model);

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
  const {
    rotationState, onModelSwitch, disableModelRotation,
    ...providerOpts
  } = opts;
  const result = await withRetry(
    async () => {
      const guard = createStallGuard({ signal: opts.signal, label: provider.LABEL ?? 'Provider' });
      try {
        return await provider.chatStream({
          ...providerOpts,
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
      ...(fastFail ? { maxRetries: 0 } : {}),
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

export async function chatStream(opts) {
  const enabled = !opts.disableModelRotation
    && (opts.rotationState ? true : modelRotationEnabled());
  const rotation = opts.rotationState ?? createModelRotation({ initialModel: opts.model });

  return runWithModelRotation({
    model: opts.model,
    rotation,
    enabled,
    onDelta: opts.onDelta,
    onSwitch: opts.onModelSwitch,
    requestTokens: estimateRequestTokens(opts.messages, opts.tools),
    request: (model, { fastFail, onDelta }) => chatStreamOneModel({
      ...opts,
      model,
      onDelta,
    }, { fastFail }),
  });
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
    if (freeTierOnly() && !p.FREE_TIER_DEFAULTS) continue;
    if (requireToolSupport() && !p.FREE_TIER_DEFAULTS) continue;
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
