function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function stripOpenAiSuffix(value) {
  return value.replace(/\/v1$/, '');
}

export function resolveOllamaBaseUrl(env = process.env) {
  const raw =
    env.OLLAMA_BASE_URL ??
    env.OLLAMA_HOST ??
    env.OPENAI_BASE_URL ??
    env.OPENAI_API_BASE ??
    'http://localhost:11434';

  const cleaned = trimTrailingSlash(String(raw).trim());
  if (!cleaned) {
    return 'http://localhost:11434';
  }

  return stripOpenAiSuffix(cleaned);
}
