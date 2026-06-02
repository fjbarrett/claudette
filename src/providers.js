// Provider catalog — the long tail of frontier providers and hosting platforms.
//
// Almost every large LLM provider exposes an OpenAI-compatible, Bearer-auth
// /chat/completions endpoint, so each is just a row here: a prefix, a key env,
// a base URL, and a starter model list. The bespoke modules (openai, anthropic,
// deepseek, groq, huggingface) cover the providers with dedicated files; this
// table covers the rest from one place. Promote any row to its own module if it
// grows provider-specific quirks.
//
// Hosting platforms (OpenRouter, Together, Fireworks — plus Groq/HuggingFace in
// their own modules) matter when you can't run models locally: one API key, no
// local GPU. OpenRouter in particular proxies every major provider behind a
// single key, which is the simplest way to reach "all the large providers".
//
// NOT here (different auth, need bespoke adapters): Azure OpenAI (deployment
// URLs + api-key header + api-version), AWS Bedrock (SigV4), Google Vertex (GCP
// auth). Tracked as future work.

import { makeOpenAICompatibleProvider } from './openai.js';

export const CATALOG = [
  // ── Aggregator / hosting platforms (best fit for no-local-GPU setups) ──────
  {
    id: 'openrouter', label: 'OpenRouter', prefixes: ['openrouter/'],
    keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEnv: 'OPENROUTER_BASE_URL', family: 'aggregator',
    models: [
      'openai/gpt-4o', 'anthropic/claude-3.7-sonnet', 'google/gemini-2.5-pro',
      'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat',
    ],
  },
  {
    id: 'together', label: 'Together', prefixes: ['together/'],
    keyEnv: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1',
    baseUrlEnv: 'TOGETHER_BASE_URL', family: 'host',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
    ],
  },
  {
    id: 'fireworks', label: 'Fireworks', prefixes: ['fireworks/'],
    keyEnv: 'FIREWORKS_API_KEY', baseUrl: 'https://api.fireworks.ai/inference/v1',
    baseUrlEnv: 'FIREWORKS_BASE_URL', family: 'host',
    models: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/deepseek-v3',
    ],
  },

  // ── Frontier first-party providers ─────────────────────────────────────────
  {
    id: 'google', label: 'Google Gemini', prefixes: ['google/', 'gemini/'],
    keyEnv: 'GEMINI_API_KEY', altKeyEnvs: ['GOOGLE_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    baseUrlEnv: 'GEMINI_BASE_URL', family: 'gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  {
    id: 'xai', label: 'xAI Grok', prefixes: ['xai/', 'grok/'],
    keyEnv: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1',
    baseUrlEnv: 'XAI_BASE_URL', family: 'grok',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
  },
  {
    id: 'mistral', label: 'Mistral', prefixes: ['mistral/'],
    keyEnv: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1',
    baseUrlEnv: 'MISTRAL_BASE_URL', family: 'mistral',
    models: ['mistral-large-latest', 'codestral-latest', 'mistral-small-latest'],
  },
  {
    id: 'cohere', label: 'Cohere', prefixes: ['cohere/'],
    keyEnv: 'COHERE_API_KEY', baseUrl: 'https://api.cohere.ai/compatibility/v1',
    baseUrlEnv: 'COHERE_BASE_URL', family: 'cohere',
    models: ['command-a-03-2025', 'command-r-plus'],
  },
  {
    id: 'perplexity', label: 'Perplexity', prefixes: ['perplexity/', 'pplx/'],
    keyEnv: 'PERPLEXITY_API_KEY', baseUrl: 'https://api.perplexity.ai',
    baseUrlEnv: 'PERPLEXITY_BASE_URL', family: 'perplexity',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning'],
  },
];

// Provider modules built from the catalog, same shape as the bespoke adapters.
export const catalogProviders = CATALOG.map(makeOpenAICompatibleProvider);
