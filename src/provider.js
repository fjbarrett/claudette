// Provider router.
//
// Dispatches getModels()/chatStream() to the right backend based on the model
// id. `anthropic:`-prefixed models go to the Anthropic Messages API; everything
// else goes to Ollama. Consumers (chat.js, server.js, the benchmark CLI) import
// from here instead of a specific provider so adding Opus 4.8 is transparent.

import * as ollama from './ollama.js';
import * as anthropic from './anthropic.js';

export function providerFor(model) {
  return anthropic.isAnthropicModel(model) ? anthropic : ollama;
}

/**
 * Merged model list across providers. Anthropic models are listed first (only
 * when ANTHROPIC_API_KEY is set) and Ollama failures are swallowed so cloud
 * models remain usable even when no local Ollama is reachable.
 */
export async function getModels() {
  const [anthropicModels, ollamaModels] = await Promise.all([
    anthropic.getModels().catch(() => []),
    ollama.getModels().catch(() => []),
  ]);
  return [...anthropicModels, ...ollamaModels];
}

export function chatStream(opts) {
  return providerFor(opts.model).chatStream(opts);
}
