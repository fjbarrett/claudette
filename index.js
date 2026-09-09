/**
 * Claudette as a library.
 *
 *   import { run, stream, createAgent } from 'claudette';
 *
 *   const { text } = await run('summarise src/index.js', { cwd: './my-project' });
 *
 * Everything here is the same agent the CLI runs — same tools, same loop, same
 * re-read guard and verification gate. The CLI is one caller of it; your script
 * is another.
 *
 * Nothing in this module touches the terminal, so it is safe inside a server, a
 * test, or a CI job. Load `.env` yourself (or `import 'claudette/env'`) if you
 * keep provider keys there.
 */

import { runAgent } from './src/agent-runner.js';
import { TOOL_DEFS, executeTool } from './src/tools.js';
import { chatStream, getModels, providerFor, missingCredential, defaultCloudModels } from './src/provider.js';
import { loadClaudeMd, expandFiles, trimToolOutputs } from './src/context.js';
import { parseTextToolCalls } from './src/tool-call-parser.js';
import { estimateCost, formatUsd } from './src/cost.js';

const DEFAULT_SYSTEM_PROMPT = [
  'You are Claudette, an AI coding assistant.',
  'Guidelines:',
  '- Always read files before editing them.',
  '- Prefer patch_file or str_replace for targeted edits over rewriting whole files.',
  '- Explore only as much as the task needs, then act.',
  '- All file paths must be relative to the workspace root.',
  '- VERIFY before claiming done: after editing, run the build, typecheck, or tests and fix any errors.',
  '- Be concise. When writing code, provide complete working implementations.',
].join('\n');

/**
 * Build the system prompt for a run: the base rules, any CLAUDE.md / CLAUDETTE.md
 * found by walking up from `cwd`, and an optional caller addition.
 */
export async function buildSystemPrompt({ cwd = process.cwd(), projectInstructions = true, system = null, append = null } = {}) {
  const parts = [system ?? DEFAULT_SYSTEM_PROMPT];
  if (projectInstructions) {
    const md = await loadClaudeMd(cwd);
    if (md) parts.push('', '--- Project Instructions ---', md);
  }
  if (append) parts.push('', append);
  return parts.join('\n');
}

/**
 * Run one agent turn to completion and return the result.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {string} [options.model]      provider/model; defaults to the first credentialed cloud model, else the first local one
 * @param {string} [options.cwd]        workspace root — the agent cannot read or write outside it
 * @param {boolean} [options.tools]     enable tool use (default true); false makes it a plain completion
 * @param {(name, args) => boolean|Promise<boolean>} [options.approve]
 *                                      permission gate. Default allows everything, because a script
 *                                      has nobody to ask; pass one to restrict.
 * @param {number} [options.maxIterations]
 * @param {AbortSignal} [options.signal]
 * @param {(event) => void} [options.onEvent]  {type, ...} for every step
 * @param {(text) => void} [options.onText]    streamed assistant text
 * @param {string} [options.system]     replace the base system prompt
 * @param {string} [options.append]     append to it (project rules, output format…)
 * @param {boolean} [options.projectInstructions] load CLAUDE.md/CLAUDETTE.md (default true)
 * @param {boolean} [options.expandAtFiles] expand `@path` tokens in the prompt (default true)
 * @param {Array} [options.messages]    prior conversation to continue
 *
 * @returns {Promise<{text, status, messages, usage, costUsd, iterations, toolCalls, files}>}
 */
export async function run(prompt, options = {}) {
  const {
    model: requestedModel,
    cwd = process.cwd(),
    tools = true,
    approve,
    maxIterations,
    signal,
    onEvent,
    onText,
    system,
    append,
    projectInstructions = true,
    expandAtFiles = true,
    messages: prior = [],
    effort = null,
    chatFn,
  } = options;

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('run(prompt): prompt must be a non-empty string');
  }

  const model = requestedModel ?? await pickDefaultModel();
  if (!model) {
    throw new Error(
      'No model available. Set a provider key (OPENROUTER_API_KEY is the easiest) or run Ollama, or pass { model }.'
    );
  }
  const missing = missingCredential([model]);
  if (missing) {
    throw new Error(`${missing.label} model "${missing.model}" needs ${missing.env}, which is not set.`);
  }

  const { text: expanded, files } = expandAtFiles
    ? await expandFiles(prompt, cwd, cwd)
    : { text: prompt, files: [] };

  const messages = [
    { role: 'system', content: await buildSystemPrompt({ cwd, projectInstructions, system, append }) },
    ...prior,
    { role: 'user', content: expanded },
  ];

  const result = await runAgent({
    model,
    messages,
    tools: tools ? TOOL_DEFS : [],
    toolContext: { cwd, workspace: cwd },
    effort,
    signal,
    ...(chatFn ? { chatFn } : {}),
    ...(maxIterations ? { maxIterations } : {}),
    // A script has nobody to prompt, so the default is to allow. Callers who
    // want a gate pass one; returning false is reported to the model as a denial.
    approve: approve ? (name, args) => approve(name, args) : undefined,
    onDelta: onText,
    emit: onEvent ? (type, data) => onEvent({ type, ...data }) : undefined,
  });

  return {
    text: result.content,
    status: result.status,          // 'completed' | 'cancelled' | 'failed' | 'max_iterations'
    messages: result.messages,      // full history — pass back in as `messages` to continue
    usage: result.usage,
    costUsd: estimateCost(model, result.usage),
    iterations: result.iterations,
    toolCalls: result.toolCalls,    // [{ name, args, isError }]
    files,                          // @paths that were expanded into the prompt
    model,
  };
}

/**
 * Same as run(), but returns an async iterable of events as they happen.
 *
 *   for await (const ev of stream('fix the build')) {
 *     if (ev.type === 'text') process.stdout.write(ev.text);
 *     if (ev.type === 'tool_call') console.log('→', ev.name);
 *   }
 *
 * The final event is `{ type: 'result', ... }` carrying what run() returns.
 */
export function stream(prompt, options = {}) {
  const queue = [];
  let notify = null;
  let done = false;
  let failure = null;

  const push = (event) => {
    queue.push(event);
    if (notify) { const n = notify; notify = null; n(); }
  };

  run(prompt, {
    ...options,
    onText: (text) => { push({ type: 'text', text }); options.onText?.(text); },
    onEvent: (event) => { push(event); options.onEvent?.(event); },
  }).then(
    (result) => { push({ type: 'result', ...result }); done = true; if (notify) notify(); },
    (err) => { failure = err; done = true; if (notify) notify(); },
  );

  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (failure) throw failure;
        if (done) return;
        await new Promise((resolve) => { notify = resolve; });
      }
    },
  };
}

/**
 * A reusable agent bound to one model/workspace, keeping conversation history
 * between calls.
 *
 *   const agent = createAgent({ cwd: './repo', model: 'openrouter/openai/gpt-5-nano' });
 *   await agent.send('what does src/index.js do?');
 *   await agent.send('now add JSDoc to it');   // remembers the first answer
 */
export function createAgent(defaults = {}) {
  let history = [];
  return {
    async send(prompt, options = {}) {
      const result = await run(prompt, { ...defaults, ...options, messages: history });
      // Drop the system message; run() rebuilds it each time.
      history = result.messages.filter(m => m.role !== 'system');
      return result;
    },
    stream(prompt, options = {}) {
      return stream(prompt, { ...defaults, ...options, messages: history });
    },
    get messages() { return [...history]; },
    reset() { history = []; return this; },
  };
}

/** First credentialed cloud model, else the first model any provider offers. */
async function pickDefaultModel() {
  const cloud = defaultCloudModels();
  if (cloud?.agent) return cloud.agent;
  const all = await getModels().catch(() => []);
  return all[0]?.name ?? null;
}

// Lower-level pieces, for callers who want to assemble their own loop.
export {
  runAgent,          // the agent loop itself, fully hookable
  TOOL_DEFS,         // tool schemas, OpenAI function-calling shape
  executeTool,       // run one tool directly
  chatStream,        // one model call, with retry + stall handling
  getModels,         // every model reachable with the keys that are set
  providerFor,       // which backend handles a model id
  missingCredential, // which key a model id needs, if it is missing
  parseTextToolCalls,// recover tool calls models wrote as text
  trimToolOutputs,   // collapse old tool output in a payload
  estimateCost,
  formatUsd,
};
