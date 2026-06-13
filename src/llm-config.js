// Shared, env-tunable LLM request knobs used across provider adapters.

// Cap on output tokens per request. The big reason this matters for cost: some
// gateways (OpenRouter) RESERVE credit equal to max_tokens × output price, so an
// unset/huge value both over-reserves and can 402 on a low balance. 16k is plenty
// for normal agent turns; raise CLAUDETTE_MAX_TOKENS for long generations.
export function resolveMaxTokens(fallback = 16_384) {
  const v = Number(process.env.CLAUDETTE_MAX_TOKENS);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Anthropic prompt caching is on by default (set CLAUDETTE_PROMPT_CACHE=0 to
// disable). It marks the stable prefix (system prompt + conversation tail) as an
// ephemeral cache breakpoint so it isn't re-billed at full input price on every
// tool iteration / follow-up turn — typically a 60–90% input-cost reduction.
export function promptCacheEnabled() {
  return process.env.CLAUDETTE_PROMPT_CACHE !== '0';
}
