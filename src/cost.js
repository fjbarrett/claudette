// Best-effort cost estimation for the session cost meter.
//
// Prices are USD per 1,000,000 tokens, matched by substring of the model id, so
// `claude-opus-4` covers `anthropic/claude-opus-4-8`, `openrouter/anthropic/
// claude-opus-4.8`, etc. These are estimates — override the whole table with the
// CLAUDETTE_PRICES env var (JSON: { "<id-substring>": { "in": N, "out": N } }).
// Unknown models return null, and callers fall back to showing tokens only.

const DEFAULT_PRICES = {
  // Anthropic. Opus 4.5 onward is $5/$25 — only the original 4.0/4.1 were
  // $15/$75, so the bare `claude-opus-4` key must stay the least specific of
  // these or every modern Opus gets priced at 3x.
  'claude-fable-5': { in: 10, out: 50 },
  'claude-mythos-5': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-opus-4': { in: 15, out: 75 },   // 4.0 / 4.1 only
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-4': { in: 1, out: 5 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5': { in: 1.25, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1': { in: 2, out: 8 },
  'o4-mini': { in: 1.1, out: 4.4 },
  'o3': { in: 2, out: 8 },
  'deepseek': { in: 0.27, out: 1.1 },
  'llama-3.3': { in: 0.1, out: 0.3 },
};

function priceTable() {
  if (process.env.CLAUDETTE_PRICES) {
    try { return { ...DEFAULT_PRICES, ...JSON.parse(process.env.CLAUDETTE_PRICES) }; } catch { /* ignore bad override */ }
  }
  return DEFAULT_PRICES;
}

export function priceFor(model) {
  // Providers spell the same model differently: Anthropic uses
  // `claude-opus-4-8`, OpenRouter uses `claude-opus-4.8`. Fold dots to dashes so
  // one table entry covers both instead of silently missing half the traffic.
  const id = String(model ?? '').toLowerCase().replace(/\./g, '-');
  const table = priceTable();
  // Most-specific (longest) key wins so `gpt-4o-mini` beats `gpt-4o`.
  for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
    if (id.includes(key)) return table[key];
  }
  return null;
}

// Cache pricing, as multiples of the base input rate. These are Anthropic's
// published ratios (0.1x to read, 1.25x to write a 5-minute entry); OpenAI
// discounts cached input too, between 0.1x and 0.5x depending on the family, so
// treating them the same is an approximation in the same spirit as the rest of
// this table. Getting it merely close beats the alternative: caching is on by
// default here, so billing every cached token at full price overstates a long
// session badly.
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;

/**
 * Estimated USD for one set of token counts, or null when the model is unpriced.
 *
 * `cachedTokens` and `cacheWriteTokens` are subsets of `promptTokens`, not
 * additions to it — every provider we speak to reports the total input and the
 * cached part of it separately.
 */
export function estimateCost(model, {
  promptTokens = 0, completionTokens = 0, cachedTokens = 0, cacheWriteTokens = 0,
} = {}) {
  const p = priceFor(model);
  if (!p) return null;
  const inRate = p.in ?? 0;
  const cached = Math.min(cachedTokens, promptTokens);
  const written = Math.min(cacheWriteTokens, Math.max(0, promptTokens - cached));
  const fullPrice = Math.max(0, promptTokens - cached - written);
  return (
    (fullPrice / 1e6) * inRate +
    (cached / 1e6) * inRate * CACHE_READ_RATE +
    (written / 1e6) * inRate * CACHE_WRITE_RATE +
    (completionTokens / 1e6) * (p.out ?? 0)
  );
}

export function formatUsd(n) {
  if (n == null || Number.isNaN(n)) return null;
  if (n === 0) return '$0.00';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

// Compact token count for the live status line: 812 → "812", 48234 → "48.2k",
// 1731705 → "1.7M".
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 10e3 ? 1 : 0)}k`;
  return `${(v / 1e6).toFixed(1)}M`;
}
