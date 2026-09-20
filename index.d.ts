/**
 * Type declarations for the Claudette library API.
 *
 * The project is plain JavaScript; these exist so editors and TypeScript
 * consumers get completion and checking without a build step.
 */

export type RunStatus = 'completed' | 'cancelled' | 'failed' | 'max_iterations' | 'repeating';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface Usage {
  /** Total input tokens, cached ones included. */
  promptTokens: number;
  completionTokens: number;
  /** Subset of promptTokens served from the provider's prompt cache. */
  cachedTokens?: number;
  /** Subset of promptTokens written into it (Anthropic reports this separately). */
  cacheWriteTokens?: number;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
}

/** Every step the agent takes. `type` discriminates the payload. */
export interface AgentEvent {
  type:
    | 'iteration_start' | 'request_start' | 'stream_started' | 'request_end'
    | 'usage' | 'message' | 'assistant_text' | 'tool_call' | 'tool_start' | 'tool_denied'
    | 'tool_result' | 'act_nudge' | 'verify_nudge' | 'post_verify_nudge'
    | 'repeat_nudge' | 'tool_failure_limit' | 'iteration_end'
    | 'model_switch' | 'cancelled' | 'failed' | 'completed' | 'max_iterations' | 'repeating'
    | 'text' | 'result';
  [key: string]: unknown;
}

export interface RunOptions {
  /** `provider/model`, e.g. "openrouter/openai/gpt-5-nano" or a bare Ollama id. */
  model?: string;
  /** Workspace root for structured file tools. */
  cwd?: string;
  /** Enable structured tool use. Default false. */
  tools?: boolean;
  /** Include the unsandboxed Bash tool. Default false and only applies with tools:true. */
  allowShell?: boolean;
  /** Permission gate. Default allows everything — a script has nobody to ask. */
  approve?: (name: string, args: Record<string, unknown>) => boolean | Promise<boolean>;
  maxIterations?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  onText?: (text: string) => void;
  /** Replace the base system prompt. */
  system?: string;
  /** Append to the base system prompt. */
  append?: string;
  /** Load CLAUDE.md / CLAUDETTE.md by walking up from cwd. Default false. */
  projectInstructions?: boolean;
  /** Expand `@path` tokens in the prompt into file contents. Default false. */
  expandAtFiles?: boolean;
  /** Prior conversation to continue. */
  messages?: Message[];
  /** Reasoning depth, where the provider supports it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /** Swap the model call — used by tests to script a fake model. */
  chatFn?: (opts: Record<string, unknown>) => Promise<unknown>;
}

export interface RunResult {
  /** The assistant's final text. */
  text: string;
  status: RunStatus;
  /** Full history; pass back as `messages` to continue the conversation. */
  messages: Message[];
  usage: Usage;
  /** Estimated USD, or null for a model with no known pricing. */
  costUsd: number | null;
  iterations: number;
  toolCalls: ToolCallRecord[];
  /** `@paths` expanded into the prompt. */
  files: string[];
  model: string;
  /** Models attempted in order, including automatic free-model fallbacks. */
  attemptedModels: string[];
}

/** Run one agent turn to completion. */
export function run(prompt: string, options?: RunOptions): Promise<RunResult>;

/** Run one agent turn, yielding events as they happen; last event is `result`. */
export function stream(prompt: string, options?: RunOptions): AsyncIterable<AgentEvent>;

export interface Agent {
  send(prompt: string, options?: RunOptions): Promise<RunResult>;
  stream(prompt: string, options?: RunOptions): AsyncIterable<AgentEvent>;
  readonly messages: Message[];
  reset(): Agent;
}

/** An agent bound to one model/workspace that remembers the conversation. */
export function createAgent(defaults?: RunOptions): Agent;

export function buildSystemPrompt(options?: {
  cwd?: string;
  projectInstructions?: boolean;
  system?: string | null;
  append?: string | null;
}): Promise<string>;

// ── Lower-level pieces ───────────────────────────────────────────────────────

export function runAgent(options: Record<string, unknown>): Promise<{
  status: RunStatus;
  content: string;
  messages: Message[];
  usage: Usage;
  iterations: number;
  toolCalls: ToolCallRecord[];
  model: string;
  attemptedModels: string[];
  /** The provider error behind a `failed` run; null otherwise. */
  error: Error | null;
}>;

export const TOOL_DEFS: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;

export function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: { cwd: string; workspace: string; readCache?: Map<string, unknown>; signal?: AbortSignal | null },
): Promise<string>;

export function chatStream(options: Record<string, unknown>): Promise<{
  content: string;
  toolCalls: unknown[] | null;
} & Usage>;

export function getModels(): Promise<Array<{ name: string; family: string; paramSize: string }>>;
export function providerFor(model: string): unknown;
export function missingCredential(models: string[]): { model: string; env: string; label: string } | null;
export function parseTextToolCalls(text: string): unknown[];
export function trimToolOutputs(messages: Message[], options?: { keep?: number; minChars?: number; maxTotalChars?: number }): Message[];
export function estimateCost(model: string, usage: Partial<Usage>): number | null;
export function formatUsd(value: number | null): string;
