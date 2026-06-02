# Changelog

## [Unreleased]

### Added
- Multi-provider model layer addressed `provider/model` (LiteLLM / terminal-bench
  style). New backends: OpenAI, DeepSeek, Groq, HuggingFace (bespoke modules) plus
  a provider catalog (`src/providers.js`) for OpenRouter, Together, Fireworks,
  Google Gemini, xAI Grok, Mistral, Cohere, and Perplexity — all sharing one
  OpenAI-compatible Chat Completions transport. Cloud models work with no local
  Ollama; OpenRouter reaches every major provider with a single key.
- Explicit CLI git workflow commands for feature branching, saving, publishing, and fast-forward updates.
- Benchmark harness support for multi-task model matrix runs from a single command.

### Changed
- Model addressing moved from the `anthropic:` colon prefix to canonical
  `provider/model` slashes (the `anthropic:` colon form is still accepted; bare
  names and `ollama/` route to local Ollama).
- `OPENAI_BASE_URL` / `OPENAI_API_BASE` no longer fall through to the Ollama base
  resolver — `OPENAI_BASE_URL` now configures the OpenAI provider. Use
  `OLLAMA_BASE_URL` / `OLLAMA_HOST` for Ollama.
- Benchmark credential fail-fast generalized from Anthropic to any cloud provider.
- `str_replace` failures now return targeted hints so models can retry with exact snippets copied from the file.

### Fixed
- Benchmark runs now wait for the CLI to finish task execution before sending `/exit`.
- Text-parsed `grep`-style tool calls are normalized to `search_code` so verification searches work reliably.
