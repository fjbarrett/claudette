function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function stripOpenAiSuffix(value) {
  return value.replace(/\/v1$/, '');
}

export function resolveOllamaBaseUrl(env = process.env) {
  // Ollama-only. The OpenAI-compatible env vars (OPENAI_BASE_URL/OPENAI_API_BASE)
  // used to fall through here, but they now configure the dedicated OpenAI
  // provider (src/openai.js) — routing both to one base would collide.
  const raw =
    env.OLLAMA_BASE_URL ??
    env.OLLAMA_HOST ??
    'http://localhost:11434';

  const cleaned = trimTrailingSlash(String(raw).trim());
  if (!cleaned) {
    return 'http://localhost:11434';
  }

  return stripOpenAiSuffix(cleaned);
}
