// Central model eligibility policy.
//
// A credential proves only that an endpoint is reachable; it says nothing
// about price or tool support. Providers attach reviewed/live metadata to each
// discovered model and this module applies the user's hard boundaries.

export const FREE_ONLY_ENV = 'CLAUDETTE_FREE_TIER_ONLY';
export const REQUIRE_TOOLS_ENV = 'CLAUDETTE_REQUIRE_TOOLS';
export const ALWAYS_TRACK_ENV = 'CLAUDETTE_ALWAYS_TRACK';

// Practical coding-agent preference order for recurring-free models that have
// native tool support. Keep this list in one place: discovery, automatic boot,
// and silent failover all consume it. A route still has to appear in the live
// provider catalog before it can be selected; this is preference, not an
// availability allowlist.
export const BENCHMARKED_OLLAMA_CLOUD_MODEL_ORDER = Object.freeze([
  'kimi-k2.7-code:cloud',
  'deepseek-v4-pro:cloud',
  'minimax-m3:cloud',
  'glm-5.3:cloud',
  'glm-5.3-flash:cloud',
  'gpt-oss:120b-cloud',
]);

export const FREE_CODING_MODEL_ORDER = Object.freeze([
  ...BENCHMARKED_OLLAMA_CLOUD_MODEL_ORDER,
  'openrouter/poolside/laguna-s-2.1:free',
  'openrouter/z-ai/glm-5.2:free',
  'groq/openai/gpt-oss-120b',
  'openrouter/minimax/minimax-m3:free',
  'openrouter/thinkingmachines/inkling:free',
  'openrouter/poolside/laguna-xs-2.1:free',
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/minimax/minimax-m2.7:free',
  'openrouter/cohere/north-mini-code:free',
  'groq/openai/gpt-oss-20b',
  // This route stays ranked, but behind the stronger existing fallbacks: it
  // scored 3/11 in the same Farm matrix and emitted malformed tool protocol.
  'gpt-oss:20b-cloud',
]);

const FREE_CODING_MODEL_RANK = new Map(
  FREE_CODING_MODEL_ORDER.map((name, index) => [name, index]),
);

export function freeCodingModelRank(model) {
  const name = typeof model === 'string' ? model : model?.name;
  return FREE_CODING_MODEL_RANK.get(name) ?? null;
}

/** Stable sort: ranked live routes first, every unranked route keeps its order. */
export function rankFreeCodingModels(models = []) {
  return [...models]
    .map((model, index) => ({ model, index, rank: freeCodingModelRank(model) }))
    .sort((a, b) => {
      if (a.rank == null && b.rank == null) return a.index - b.index;
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank || a.index - b.index;
    })
    .map(entry => entry.model);
}

export function freeTierOnly(env = process.env) {
  return env[FREE_ONLY_ENV] !== '0';
}

export function requireToolSupport(env = process.env) {
  return env[REQUIRE_TOOLS_ENV] !== '0';
}

export function alwaysTrack(env = process.env) {
  return env[ALWAYS_TRACK_ENV] !== '0';
}

export function hasNativeTools(model) {
  return Array.isArray(model?.capabilities) && model.capabilities.includes('tools');
}

export function isFreeTierModel(model) {
  return model?.access?.free === true;
}

export function modelPolicyActive(env = process.env) {
  return freeTierOnly(env) || requireToolSupport(env);
}

export function filterModelsForPolicy(models, env = process.env) {
  return (Array.isArray(models) ? models : []).filter(model => {
    if (freeTierOnly(env) && !isFreeTierModel(model)) return false;
    if (requireToolSupport(env) && !hasNativeTools(model)) return false;
    return true;
  });
}

export function modelPolicyDescription(env = process.env) {
  const rules = [];
  if (freeTierOnly(env)) rules.push('free-tier only');
  if (requireToolSupport(env)) rules.push('native tools required');
  if (alwaysTrack(env)) rules.push('usage tracking required');
  return rules.length ? rules.join(', ') : 'standard';
}

export function unavailableModelMessage(model, env = process.env) {
  const rules = modelPolicyDescription(env);
  const directDeepSeek = String(model ?? '').startsWith('deepseek/');
  const detail = directDeepSeek && freeTierOnly(env)
    ? ' Direct DeepSeek API models are billed per token; use a currently listed openrouter/...:free DeepSeek route if one is available.'
    : '';
  return `Model "${model}" is not available under the active policy (${rules}).${detail} Run /models and switch with /model <name>.`;
}
