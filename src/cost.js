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

// Compact token count for the live status line: 812 → "812", 48234 → "48.2k",
// 1731705 → "1.7M".
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 10e3 ? 1 : 0)}k`;
  return `${(v / 1e6).toFixed(1)}M`;
}
