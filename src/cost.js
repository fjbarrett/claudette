// Best-effort cost estimation for the session cost meter.
//
// Prices are USD per 1,000,000 tokens, matched by substring of the model id, so
// `claude-opus-4` covers `anthropic/claude-opus-4-8`, `openrouter/anthropic/
// claude-opus-4.8`, etc. These are estimates — override the whole table with the
// CLAUDETTE_PRICES env var (JSON: { "<id-substring>": { "in": N, "out": N } }).
// Unknown models return null, and callers fall back to showing tokens only.

const DEFAULT_PRICES = {
  'claude-opus-4': { in: 15, out: 75 },
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
  const id = String(model ?? '').toLowerCase();
  const table = priceTable();
  // Most-specific (longest) key wins so `gpt-4o-mini` beats `gpt-4o`.
  for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
    if (id.includes(key)) return table[key];
  }
  return null;
}

// Estimated USD for one set of token counts, or null when the model is unpriced.
export function estimateCost(model, { promptTokens = 0, completionTokens = 0 } = {}) {
  const p = priceFor(model);
  if (!p) return null;
  return (promptTokens / 1e6) * (p.in ?? 0) + (completionTokens / 1e6) * (p.out ?? 0);
}

export function formatUsd(n) {
  if (n == null || Number.isNaN(n)) return null;
  if (n === 0) return '$0.00';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
