// The agent loop, with no terminal in it.
//
// This used to live inside chat.js, tangled with readline, the spinner, and the
// session file. bench/evals.js therefore carried a second, simpler copy, and the
// browser had none — so every behaviour added to the CLI (the re-read guard, the
// action nudge, the verification gate, orphan-message repair) was invisible to
// the harness that measures it. The benchmark was scoring a different agent than
// the one that ships.
//
// Callers supply behaviour through a small set of hooks:
//   emit(type, data)          observe everything (render, trace, persist)
//   onDelta(text)             streamed assistant text
//   approve(name, args)       permission gate; omit to allow every call
//   takeFollowUps()           steering input to inject at a safe boundary
//   onMaxIterations()         return true to grant a fresh iteration budget
//
// Every message the runner appends to `messages` is announced as a `message`
// event carrying the same object reference, so a caller mirroring them into
// persistent history sees later in-place edits (the action nudge appends to the
// last tool result) without any extra bookkeeping.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { chatStream, createModelRotation, modelRotationEnabled } from './provider.js';
import { executeTool } from './tools.js';
import { resolveToolOutputTrimOptions, trimToolOutputs } from './context.js';
import { parseTextToolCalls } from './tool-call-parser.js';
import { isNonExecutingCheck } from './evidence.js';

// ─── Tunables ────────────────────────────────────────────────────────────────

// Tool iterations allowed per turn before the runaway guard pauses the loop.
// Default 150 (was a hard 20, then 50, both of which cut off large multi-file
// builds); raise/lower with --max-iterations N or CLAUDETTE_MAX_ITERATIONS.
export function resolveMaxIterations(argv = process.argv, env = process.env) {
  const flagIdx = argv.indexOf('--max-iterations');
  const raw = flagIdx !== -1 ? argv[flagIdx + 1] : env.CLAUDETTE_MAX_ITERATIONS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 150;
}

// Action-forcing nudge. The logs showed gpt-5-nano re-reading the same files
// dozens of times without ever editing (one turn: 40+ reads, 0 edits) — the
// re-read guard makes that cheap but doesn't stop it, and the system-prompt hint
// is ignored. After N consecutive read-only tool calls with no edit/command, we
// append a firm steering line to the last tool result telling the model to act;
// it re-arms after another N. Any action tool (edit/bash) resets the streak.
const ACTION_TOOLS = new Set(['write_file', 'str_replace', 'patch_file', 'bash']);
const EDIT_TOOLS = new Set(['write_file', 'str_replace', 'patch_file']);
const READBACK_EDIT_TOOLS = new Set(['write_file', 'str_replace']);
const READBACK_VERIFY_EXTENSIONS = new Set(['.txt', '.md', '.mdx', '.rst']);

export function resolveActNudge(env = process.env) {
  const n = Number(env.CLAUDETTE_ACT_NUDGE);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 15; // 0 disables
}

export function createActNudger(threshold) {
  let streak = 0;   // tool calls since the last SUCCESSFUL action (edit/command)
  let firedAt = 0;  // streak value at the last nudge (for re-arming)
  return {
    // A successful action resets the streak (real progress). A read, or an action
    // that ERRORED (e.g. a no-op patch), counts toward the streak — a failed edit
    // is not progress, so it should still push toward the nudge.
    record(toolName, isError = false) {
      if (ACTION_TOOLS.has(toolName) && !isError) { streak = 0; firedAt = 0; }
      else streak++;
    },
    // Returns a nudge string when the streak has crossed another `threshold`
    // since the last nudge, else null. Call once per tool batch.
    takeNudge() {
      if (threshold > 0 && streak - firedAt >= threshold) {
        firedAt = streak;
        return `[automated nudge] You've made ${streak} tool calls without a successful edit or command. ` +
          `You very likely have enough context now — make a concrete change (write_file / str_replace / patch_file) or run a command to make progress. ` +
          `For a review-only request, provide evidence-backed findings instead of making unsolicited edits. ` +
          `If something is blocking you, state exactly what. Stop re-reading files you've already seen.`;
      }
      return null;
    },
    get streak() { return streak; },
  };
}

// Verification gate. A turn that edited files shouldn't finish without proving the
// result works — the logs showed a Sonnet turn that "completed cleanly" (and cost
// $2.55) but left the site broken because it never ran a build. When the model
// tries to finish after editing without a passing check, the loop pushes it to run
// one (build / typecheck / tests), capped to avoid loops. CLAUDETTE_VERIFY_GATE=0
// disables it.
export function resolveVerifyGate(env = process.env) {
  return env.CLAUDETTE_VERIFY_GATE !== '0';
}

// A command segment counts as verification only when it STARTS with a known
// build/test/typecheck/lint invocation — conservative on purpose: a false negative
// just re-prompts (cheap), a false positive would let a broken result ship.
// Long-running servers (npm run dev / start) are deliberately excluded — a
// successful background launch does not verify correctness.
const VERIFY_RE = /^(sudo\s+)?(time\s+)?(npx\s+|pnpm\s+|yarn\s+|bun\s+)?(npm\s+(run\s+)?(build|test|lint|typecheck|type-check|check)\b|(pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|check)\b|next\s+(build|lint)\b|vite\s+build\b|tsc\b|eslint\b|ruff\b|flake8\b|mypy\b|pyright\b|pytest\b|pip-audit\b|jest\b|vitest\b|phpunit\b|rspec\b|node\s+--(check|test)\b|go\s+(build|test|vet)\b|cargo\s+(build|test|check|clippy)\b|make\b|mvn\b|gradle\b|python3?\s+-m\s+(pytest|unittest|mypy|py_compile|compileall|pip_audit)\b)/i;

// Running the thing you just wrote is verification too. The list above only knows
// package-manager and test-runner invocations, so on a Terminal-Bench task with no
// package.json the gate kept firing at an agent that WAS verifying: it ran
// `python3 check_cert.py` five times and got nudged after every one, turning an
// 8-call task into 20 calls and 80k input tokens.
const RUN_SCRIPT_RE = /^(sudo\s+)?(time\s+)?(python3?|node|deno|bun|ruby|perl|php|bash|sh|zsh)\s+(\S+\/)?(\S+\.(py|js|mjs|cjs|ts|rb|pl|php|sh))\s*$|^\.\/\S+\s*$/i;

// …with one exception. These names are conventionally a server's entry point, and
// starting a server proves nothing even when Bash launches it in the background.
// A script that genuinely checks something is not called `app.js`.
const SERVER_ENTRY_RE = /^(app|server|index|main|start|dev)\.(js|mjs|cjs|ts|py)$/i;

export function looksLikeVerification(command) {
  const source = String(command || '').trim();
  // Bash returns the status of the last command. Pipelines, fallback branches,
  // backgrounding, or a later `;`/newline command can turn a failed check into
  // exit 0 (`npm test || true`, `npm test | tee log`, `npm test; echo done`).
  // Only trust verification in the final sequential group, joined by `&&`.
  if (!source || source.includes('|') || source.replaceAll('&&', '').includes('&')) return false;
  const terminalGroup = source.split(/;|\n/).map(value => value.trim()).filter(Boolean).at(-1) ?? '';
  let verified = false;
  for (const segment of terminalGroup.split(/&&/)) {
    const s = stripCommandPrefixes(segment);
    // `cp source target && node --check target` verifies the resulting file;
    // the reverse order leaves the edit unverified. Output redirections happen
    // before their command, so a passing check can still establish a baseline.
    if (looksLikeMutation(s)) verified = false;
    if (VERIFY_RE.test(s) && !isNonExecutingCheck(segment)) {
      verified = true;
    } else {
      const script = RUN_SCRIPT_RE.exec(s);
      const basename = (script?.[5] ?? s).split('/').pop();
      if (script && !SERVER_ENTRY_RE.test(basename)) verified = true;
    }
  }
  return verified;
}

export function buildToolFailureLimitNudge(name, args, { diagnostic = null, attempts = 2 } = {}) {
  const detail = JSON.stringify(args ?? {}).slice(0, 400);
  const reason = diagnostic
    ? `The ${name} tool failed ${attempts} times with the same error (${diagnostic.slice(0, 400)}). Changing the command arguments has not resolved it.`
    : `The identical ${name || 'unknown'} tool call failed twice (${detail}).`;
  return `[automated blocker] ${reason} ` +
    'Stop making tool calls. Answer the original request as far as the evidence supports, explain what failed, ' +
    'and distinguish verified findings from anything still blocked. Do not promise to run another check. ' +
    'Do not claim the task succeeded.';
}

// Keep the actual terminal exception, not traceback source/caret lines that
// change every time a model tweaks the invocation. Do not collapse paths or
// numbers: different missing files and distinct failures must remain distinct.
function bashFailureDiagnostic(output) {
  for (const line of stripVTControlCharacters(output).split('\n').reverse()) {
    const text = line.trim();
    if (/^(?:[\w.]+(?:Error|Exception)|Error|Exception):\s*\S/.test(text)
        && !/^Error:\s*(?:Traceback|Command failed:)/.test(text)) return text;
  }
  return null;
}

// Shell is both an execution tool and a common indirect editor. Treat the
// ordinary filesystem/package/schema mutation forms as edits so a check that
// passed before one of them cannot verify the resulting workspace. This stays
// deliberately narrower than "any Bash command": reads and verification
// commands should not constantly reset the verification/completion state.
const MUTATING_COMMAND_RE = /^(?:(?:cp|mv|rm|mkdir|touch|ln|chmod|chown|truncate|install|patch)\b|sed\b.*(?:^|\s)-i(?:\s|$)|perl\b.*(?:^|\s)-pi(?:\s|$)|git\s+apply\b|npm\s+(?:i|install)\b|(?:pnpm|yarn|bun)\s+(?:add|install)\b|(?:pip3?|python3?\s+-m\s+pip)\s+install\b|(?:npx\s+)?prisma\s+(?:migrate\b|generate\b|db\s+push\b))/i;

function stripCommandPrefixes(command) {
  let value = command.trim();
  let previous;
  do {
    previous = value;
    value = value
      .replace(/^(?:sudo|time|env)\s+/i, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, '');
  } while (value !== previous);
  return value;
}

const GENERATED_CACHE_NAMES = new Set(['.mypy_cache', '.pytest_cache', '.ruff_cache', '__pycache__']);

function removesOnlyGeneratedCaches(command) {
  if (/[;&|<>$`\\()\n]/.test(command)) return false;
  const words = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  if (words.shift() !== 'rm') return false;
  const paths = [];
  let optionsEnded = false;
  for (const word of words) {
    if (!optionsEnded && word === '--') { optionsEnded = true; continue; }
    if (!optionsEnded && word.startsWith('-')) {
      if (!/^(?:-[frdv]+|--force|--recursive|--dir|--verbose)$/.test(word)) return false;
      continue;
    }
    const value = word.replace(/^(["'])(.*)\1$/, '$2');
    const parts = value.split('/');
    if (path.isAbsolute(value) || parts.includes('..') || !parts.some(part => GENERATED_CACHE_NAMES.has(part))) return false;
    paths.push(value);
  }
  return paths.length > 0;
}

export function looksLikeMutation(command) {
  return String(command || '')
    .split(/&&|\|\||;|\n/)
    .some(segment => {
      const value = stripCommandPrefixes(segment);
      if (MUTATING_COMMAND_RE.test(value) && !removesOnlyGeneratedCaches(value)) return true;
      // Discarding output and descriptor forwarding do not edit the workspace.
      // Keep inspecting later redirects: `ls 2>/dev/null > listing.txt` does.
      const redirects = value.matchAll(/(?:^|\s)\d*(?:>>|>)(?!&)\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g);
      return [...redirects].some(match => match[1].replace(/^(["'])([\s\S]*)\1$/, '$2') !== '/dev/null');
    });
}

// What this workspace can actually be verified with. The nudge used to name
// `npm run build` and `npx tsc --noEmit` unconditionally, which sent models
// hunting for a build system in directories that have none: one eval trajectory
// finished a three-file rename in 8 tool calls, then spent 11 more on
// verification, three of them re-checking whether package.json existed. Say what
// is there, or say plainly that there is nothing.
const MANIFEST_HINTS = [
  ['package.json', '`npm test` or `npm run build` (check the scripts first), or `node --check <file>`'],
  ['pyproject.toml', '`pytest`, or `python3 -m py_compile <file>`'],
  ['requirements.txt', '`pytest`, or `python3 -m py_compile <file>`'],
  ['Cargo.toml', '`cargo check` or `cargo test`'],
  ['go.mod', '`go build ./...` or `go test ./...`'],
  ['Makefile', '`make` or `make test`'],
];

export function verifyHint(workspace) {
  if (!workspace) return null;
  for (const [file, hint] of MANIFEST_HINTS) {
    if (existsSync(path.join(workspace, file))) return hint;
  }
  return null;
}

// In a bare workspace a plain-text deliverable may have nothing executable to
// build or test. A full read-back of the exact file is still a meaningful check,
// but keep this deliberately narrow: source/config files, patch_file (which may
// touch several paths), Bash mutations, ranged reads, and truncated reads must
// still pass an executable verification command.
function readbackVerificationPath(name, args, toolContext) {
  if (!READBACK_EDIT_TOOLS.has(name) || verifyHint(toolContext.workspace)) return null;
  if (typeof args?.path !== 'string' || !READBACK_VERIFY_EXTENSIONS.has(path.extname(args.path).toLowerCase())) {
    return null;
  }
  const base = toolContext.cwd ?? toolContext.workspace;
  return base ? path.resolve(base, args.path) : path.normalize(args.path);
}

function fullReadbackPath(name, args, output, toolContext) {
  if (name !== 'read_file' || typeof args?.path !== 'string') return null;
  if (Number(args.offset) > 0 || Number(args.limit) > 0) return null;
  if (output.startsWith('[read_file:') || output.includes('[truncated —')) return null;
  const base = toolContext.cwd ?? toolContext.workspace;
  return base ? path.resolve(base, args.path) : path.normalize(args.path);
}

export function buildVerifyNudge(verifyRan, hint) {
  if (verifyRan) {
    return '[automated check] Your last build/test/typecheck did not pass. Fix the errors and re-run it — do not finish with a failing check.';
  }
  const lead = "[automated check] You edited files but haven't verified the result works. ";
  const tail = ' Do not report the task complete until a check passes.';
  if (!hint) {
    // No manifest, so no run script to point at; naming a build tool this
    // workspace does not have would send the model hunting for one.
    return lead + 'This workspace has no build, test, or dependency manifest — do not go looking for one. ' +
      'Exercise what you changed directly instead: run the script, or a one-liner that calls it, ' +
      'or at minimum syntax-check the edited files.' + tail;
  }
  return lead + `Run ${hint} and fix any errors.` + tail +
    ' Starting a background dev server alone is not verification; probe the changed behavior or run a focused check.';
}

const VERIFY_MAX = 2; // gate fires at most twice per turn (initial + one fix cycle)

// A passing build/test is a strong completion signal. Some models ignore it and
// spend dozens of calls inventorying generated files or re-diagnosing already
// solved setup. After N additional tools with no edit or failing check, remind
// the model to finish; if it ignores two reminders, offer no tools on the next
// request so it must produce a final summary. Any later edit invalidates the old
// verification and resets this guard.
export function resolvePostVerifyGuard(env = process.env) {
  const n = Number(env.CLAUDETTE_POST_VERIFY_GUARD);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 6; // 0 disables
}

export function buildPostVerifyNudge(toolCalls, verificationCommand, forceFinal = false) {
  const verifiedBy = verificationCommand ? ` (${verificationCommand})` : '';
  const lead = `[automated completion check] The requested changes already passed verification${verifiedBy}, ` +
    `and you have made ${toolCalls} additional tool call${toolCalls === 1 ? '' : 's'} without another edit.`;
  if (forceFinal) {
    return `${lead} Stop investigating now. Your next response has tools disabled: summarize what was completed, the passing verification, and any genuine remaining limitation.`;
  }
  return `${lead} Unless you found a concrete new failure, stop exploring and give the user the final summary. If something is genuinely blocked, state the blocker directly.`;
}

const POST_VERIFY_MAX_NUDGES = 2;

// Repetition guard. A degenerating model re-emits the same response forever: a
// real session logged 30 consecutive byte-identical replies, the same five curl
// commands re-issued for 37 minutes, turning 38 distinct commands into 183. The
// act nudge cannot see this, because a SUCCESSFUL bash call resets its streak —
// so a loop of successful identical commands looks like progress every single
// iteration. Only `maxIterations` would have ended it, about two hours later.
export function resolveRepeatGuard(env = process.env) {
  const n = Number(env.CLAUDETTE_REPEAT_GUARD);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3; // 0 disables
}

// Recursively sort object keys so an argument set that serialises in a different
// order still compares equal.
function stableValue(v) {
  if (Array.isArray(v)) return v.map(stableValue);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, stableValue(v[k])]));
  }
  return v;
}

/**
 * Signature of one assistant turn: the tool calls it wants to make, by name and
 * argument. Prose is deliberately excluded — a model that reworded its preamble
 * while re-issuing identical commands is still looping. Returns null when there
 * are no tool calls, which ends the turn anyway and so cannot loop.
 */
export function responseSignature(calls) {
  if (!calls?.length) return null;
  return JSON.stringify(calls.map(c => {
    let args = c.function?.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* compare raw */ } }
    return [c.function?.name ?? '', stableValue(args ?? {})];
  }));
}

export function buildRepeatNudge(count) {
  return `[automated check] You have issued this exact same set of tool calls ${count} times in a row and learned nothing new from it. ` +
    'Stop repeating it. Either answer with what you already have, or do something genuinely different — a different command, a different file, ' +
    'a different approach. If you are stuck, say plainly what is blocking you instead of retrying.';
}

// Fires when the same signature repeats `threshold` times running. Re-arms after
// each nudge, so an ignored nudge fires again rather than going silent.
export function createRepeatDetector(threshold) {
  let last = null, streak = 0, nudges = 0;
  return {
    record(signature) {
      if (signature == null) { last = null; streak = 0; return null; }
      if (signature === last) streak++;
      else { last = signature; streak = 1; }
      if (threshold > 0 && streak >= threshold) {
        streak = 0; // re-arm: another `threshold` repeats needed to fire again
        nudges++;
        return buildRepeatNudge(threshold);
      }
      return null;
    },
    // Steering input changed the context; give the model a clean slate.
    reset() { last = null; streak = 0; },
    get nudges() { return nudges; },
    get streak() { return streak; },
  };
}

const REPEAT_MAX = 2; // nudge twice, then end the turn rather than loop forever

// ─── Message hygiene ─────────────────────────────────────────────────────────

/**
 * A `tool` message is only legal as the answer to an assistant turn that carried
 * `tool_calls`. Sessions written by older builds contain orphans, and OpenAI and
 * Azure reject the whole request with "messages with role 'tool' must be a
 * response to a preceeding message with 'tool_calls'" — poisoning every later
 * prompt in that session. Drop orphans on the way into a payload.
 */
export function dropOrphanToolMessages(messages) {
  const out = [];
  let openCalls = 0;
  for (const m of messages) {
    if (m?.role === 'tool') {
      if (openCalls <= 0) continue; // orphan — no assistant tool_calls to answer
      openCalls--;
      out.push(m);
      continue;
    }
    openCalls = m?.role === 'assistant' && Array.isArray(m.tool_calls) ? m.tool_calls.length : 0;
    out.push(m);
  }
  return out.length === messages.length ? messages : out;
}

/**
 * Merge tool calls the model wrote as JSON text with the ones it made through
 * the tool-call API. Some models (qwen2.5-coder) do both in a single response;
 * text-parsed calls go first because they appear earlier in the output.
 */
export function mergeToolCalls(result) {
  if (!result.content) return result.toolCalls ?? null;
  const seenTextCalls = new Set();
  const textParsed = parseTextToolCalls(result.content).filter(call => {
    const key = JSON.stringify(call.function);
    if (seenTextCalls.has(key)) return false;
    seenTextCalls.add(key);
    return true;
  });
  if (!textParsed.length) return result.toolCalls ?? null;
  if (!result.toolCalls?.length) return textParsed;
  const apiKeys = new Set(result.toolCalls.map(c => JSON.stringify(c.function)));
  const novel = textParsed.filter(c => !apiKeys.has(JSON.stringify(c.function)));
  return [...novel, ...result.toolCalls];
}

function parseArgs(rawArgs) {
  if (typeof rawArgs !== 'string') return rawArgs ?? {};
  try { return JSON.parse(rawArgs); } catch { return { raw: rawArgs }; }
}

// ─── The loop ────────────────────────────────────────────────────────────────

/**
 * Drive one agent turn to completion.
 *
 * `messages` is mutated in place (the caller usually wants the final list), and
 * returned alongside the outcome:
 *   { status, content, messages, usage, iterations, toolCalls }
 * where status is 'completed' | 'cancelled' | 'failed' | 'max_iterations' |
 * 'repeating' (the model kept re-issuing identical tool calls).
 */
export async function runAgent({
  model,
  messages,
  tools = [],
  toolContext = {},
  execute = executeTool,
  chatFn = chatStream,
  effort = null,
  signal = undefined,
  maxIterations = resolveMaxIterations(),
  actNudge = resolveActNudge(),
  verifyGate = resolveVerifyGate(),
  postVerifyGuard = resolvePostVerifyGuard(),
  repeatGuard = resolveRepeatGuard(),
  emit = () => {},
  onDelta = null,
  approve = null,
  takeFollowUps = null,
  onMaxIterations = null,
  onModelChange = null,
  rotationState = null,
} = {}) {
  // Per-turn read cache: short-circuits identical re-reads of unchanged files.
  // Usage logs showed the agent re-reading the same files dozens of times in one
  // turn (one file 23×; 69% of reads redundant), stalling progress and bloating
  // context. Fresh per run so a later turn always sees current files.
  const readCache = toolContext.readCache ?? new Map();
  const nudger = createActNudger(actNudge);
  const repeater = createRepeatDetector(repeatGuard);
  const failedToolAttempts = new Map();
  const failedDiagnostics = new Map();
  // cachedTokens/cacheWriteTokens are subsets of promptTokens, carried so the
  // cost meter can price cache hits at their discount instead of full input.
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  const toolCalls = [];
  let activeModel = model;
  let committedModel = model;
  const rotation = rotationState ?? (
    chatFn === chatStream && modelRotationEnabled()
      ? createModelRotation({ initialModel: model })
      : null
  );

  let iteration = 0;
  let budget = maxIterations;
  let content = '';
  // Verification-gate state: did this turn edit files, and has a build/test/
  // typecheck actually passed since?
  let turnEdited = false, verifyRan = false, verifyOk = false, verifyNudges = 0;
  let postVerifyCalls = 0, postVerifyNudges = 0, forceFinal = false;
  let lastVerificationCommand = '';
  const pendingReadbackPaths = new Set();
  let readbackBlocked = false;

  const append = async (message) => {
    messages.push(message);
    await emit('message', { message });
    return message;
  };
  // `error` is carried on a failed run so callers can say *why*. Without it a
  // batch runner reports "agent run failed after 1 iterations" and the provider
  // error — the only thing that explains a whole model's column of failures —
  // is gone by the time anyone reads the report.
  const finish = (status, error = null) =>
    ({
      status, content, messages, usage, iterations: iteration, toolCalls, error,
      model: activeModel,
      attemptedModels: rotation?.attemptedModels ?? [activeModel],
    });

  while (true) {
    while (iteration < budget) {
      iteration++;
      await emit('iteration_start', { iteration, maxIterations: budget, model: activeModel });

      const controller = new AbortController();
      const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      await emit('request_start', { iteration, controller, model: activeModel });

      let streamed = false;
      let result;
      const offeredTools = forceFinal ? [] : tools;
      const offeredToolNames = new Set(
        offeredTools.map(tool => tool?.function?.name).filter(name => typeof name === 'string'),
      );
      try {
        result = await chatFn({
          model: activeModel,
          // Collapse old tool outputs in the payload (not in stored history) so a
          // long tool loop doesn't re-send every file read on every iteration,
          // and strip orphan tool messages the provider would reject outright.
          messages: dropOrphanToolMessages(trimToolOutputs(messages, resolveToolOutputTrimOptions(activeModel))),
          tools: offeredTools,
          signal: requestSignal,
          onDelta: (delta) => {
            if (!streamed) {
              streamed = true;
              void emit('stream_started', { iteration });
            }
            onDelta?.(delta);
          },
          ...(rotation ? {
            rotationState: rotation,
            onModelSwitch: async (change) => {
              activeModel = change.to;
              const event = {
                from: change.from,
                to: change.to,
                reason: change.reason,
                status: change.status,
                switch: change.switch,
                iteration,
                error: change.error?.message ?? String(change.error ?? ''),
                attemptedModels: rotation.attemptedModels,
                requestTokens: change.requestTokens ?? null,
                skippedModels: change.skippedModels ?? [],
              };
              await emit('model_switch', event);
            },
          } : {}),
          ...(effort ? { effort } : {}),
        });
      } catch (err) {
        await emit('request_end', { iteration, error: err, streamed });
        if (err.name === 'AbortError') {
          await emit('cancelled', { iteration });
          return finish('cancelled');
        }
        await emit('failed', { iteration, error: err });
        return finish('failed', err);
      }
      await emit('request_end', { iteration, result, streamed });

      // Provider-level rotation reports the selected route in the result. The
      // switch callback normally updated this before the successful attempt,
      // but preserve correctness for wrappers that only return selectedModel.
      activeModel = result.selectedModel ?? activeModel;
      if (activeModel !== committedModel) {
        await onModelChange?.(activeModel, {
          iteration,
          attemptedModels: rotation?.attemptedModels ?? result.attemptedModels ?? [activeModel],
        });
        committedModel = activeModel;
      }

      usage.promptTokens += result.promptTokens ?? 0;
      usage.completionTokens += result.completionTokens ?? 0;
      usage.cachedTokens += result.cachedTokens ?? 0;
      usage.cacheWriteTokens += result.cacheWriteTokens ?? 0;
      await emit('usage', { iteration, model: activeModel, ...usage, last: result });

      // With no tools offered, text that merely looks like a tool call is just
      // text. `/tools off` used to still execute it, because the text parser ran
      // regardless of whether tools were enabled.
      const calls = offeredTools.length ? mergeToolCalls(result) : null;
      const signature = responseSignature(calls);
      content = result.content ?? '';

      // ── No tool calls → the model is trying to finish ──────────────────────
      if (!calls?.length) {
        await emit('assistant_text', { content, streamed, iteration, final: true });
        await append({ role: 'assistant', content });

        // Safe boundary: steering input queued during this turn keeps the same
        // loop alive instead of ending the turn.
        const followUps = takeFollowUps ? await takeFollowUps() : null;
        if (followUps) {
          forceFinal = false;
          failedToolAttempts.clear();
          failedDiagnostics.clear();
          postVerifyCalls = 0;
          postVerifyNudges = 0;
          await append(followUps);
          continue;
        }

        // Don't let a turn that edited files finish without a passing check.
        if (!forceFinal && verifyGate && turnEdited && !verifyOk && verifyNudges < VERIFY_MAX) {
          verifyNudges++;
          await emit('verify_nudge', { verifyRan, attempt: verifyNudges });
          await append({ role: 'user', content: buildVerifyNudge(verifyRan, verifyHint(toolContext.workspace)) });
          continue;
        }

        await emit('completed', { content });
        return finish('completed');
      }

      // ── Tool calls ────────────────────────────────────────────────────────
      // `toolCalls` rides along because the message isn't appended yet — a
      // listener can't read it off the tail of `messages`.
      await emit('assistant_text', { content, streamed, iteration, final: false, toolCalls: calls });
      await append({ role: 'assistant', content, tool_calls: calls });

      const announcedCalls = new Set();
      let repeatedFailure = null;
      let nextCallIndex = 0;
      for (; nextCallIndex < calls.length; nextCallIndex++) {
        const call = calls[nextCallIndex];
        if (signal?.aborted) break;
        const name = call.function?.name;
        const args = parseArgs(call.function?.arguments);
        await emit('tool_call', { name, args, call });
        announcedCalls.add(call);

        const toolWasOffered = typeof name === 'string' && offeredToolNames.has(name);
        if (toolWasOffered && approve && !(await approve(name, args))) {
          await emit('tool_denied', { name, args });
          await append({ role: 'tool', content: 'User denied permission for this operation.', ...(call.id ? { tool_call_id: call.id } : {}) });
          continue;
        }

        let output;
        let isError = false;
        if (!toolWasOffered) {
          output = `Error: Tool "${name || '(missing name)'}" was not offered for this request and was not executed.`;
          isError = true;
        } else {
          // A redirect may arrive while the permission prompt is open. The
          // terminal resolves that prompt as denied and aborts the turn signal;
          // do not start the operation after the user has asked to steer away.
          if (signal?.aborted) break;
          await emit('tool_start', { name, args, call });
          try {
            output = String(await execute(name, args, { ...toolContext, readCache, signal }));
          } catch (err) {
            output = `Error: ${err.message}`;
            isError = true;
          }
        }

        toolCalls.push({ name, args, isError });
        await emit('tool_result', { name, args, result: output, isError });
        await append({ role: 'tool', content: output, ...(call.id ? { tool_call_id: call.id } : {}) });

        nudger.record(name, isError); // a failed action doesn't count as progress
        // A failing shell command can have written files before it failed.
        // Preserve that invalidation instead of trusting an older passing check.
        const edited = toolWasOffered && (
          EDIT_TOOLS.has(name) || (name === 'bash' && looksLikeMutation(args?.command))
        );
        const verified = name === 'bash' && looksLikeVerification(args?.command);
        if (!isError && (edited || verified)) {
          failedToolAttempts.clear();
          failedDiagnostics.clear();
        }
        if (edited) {
          // A passing check establishes a fresh baseline. Edits after that point
          // are judged independently from older, already-verified changes.
          if (verifyOk) {
            pendingReadbackPaths.clear();
            readbackBlocked = false;
          }
          turnEdited = true;
          // A check that passed before this edit no longer verifies the current
          // workspace. The ordinary verification gate must require a new one.
          verifyRan = false;
          verifyOk = false;
          postVerifyCalls = 0;
          postVerifyNudges = 0;
          forceFinal = false;
          const readbackPath = readbackVerificationPath(name, args, toolContext);
          if (readbackPath) pendingReadbackPaths.add(readbackPath);
          else readbackBlocked = true;
        }
        if (verified) {
          verifyRan = true;
          verifyOk = !isError;
          postVerifyCalls = 0;
          postVerifyNudges = 0;
          forceFinal = false;
          if (!isError) {
            lastVerificationCommand = args?.command ?? '';
            pendingReadbackPaths.clear();
            readbackBlocked = false;
          } else {
            // A content read must never hide a known failing executable check.
            readbackBlocked = true;
          }
        } else if (!edited) {
          const readbackPath = !isError
            ? fullReadbackPath(name, args, output, toolContext)
            : null;
          if (!readbackBlocked && pendingReadbackPaths.has(readbackPath)) {
            pendingReadbackPaths.delete(readbackPath);
            if (pendingReadbackPaths.size === 0) {
              verifyRan = true;
              verifyOk = true;
              lastVerificationCommand = `read_file ${args.path}`;
              postVerifyCalls = 0;
              postVerifyNudges = 0;
              forceFinal = false;
            }
          } else if (verifyOk) {
            postVerifyCalls++;
          }
        }

        const failureSignature = responseSignature([{
          function: { name, arguments: args },
        }]);
        if (isError) {
          const attempts = (failedToolAttempts.get(failureSignature) ?? 0) + 1;
          failedToolAttempts.set(failureSignature, attempts);
          const diagnostic = name === 'bash' ? bashFailureDiagnostic(output) : null;
          const diagnosticAttempts = diagnostic ? (failedDiagnostics.get(diagnostic) ?? 0) + 1 : 0;
          if (diagnostic) failedDiagnostics.set(diagnostic, diagnosticAttempts);
          if (attempts >= 2) {
            repeatedFailure = { name, args, attempts, signature: failureSignature };
            nextCallIndex++;
            break;
          } else if (diagnosticAttempts >= 3) {
            repeatedFailure = { name, args, attempts: diagnosticAttempts, diagnostic, signature: failureSignature };
            nextCallIndex++;
            break;
          }
        } else {
          failedToolAttempts.delete(failureSignature);
        }
      }

      // A model/tool interrupt is a terminal state for this runner. Any
      // call declared by the assistant still needs a matching tool result or
      // the saved history is invalid for OpenAI/Anthropic on resume.
      if (signal?.aborted) {
        for (const call of calls.slice(nextCallIndex)) {
          const name = call.function?.name;
          const args = parseArgs(call.function?.arguments);
          if (!announcedCalls.has(call)) await emit('tool_call', { name, args, call });
          const output = 'Error: Tool call cancelled before execution because the turn was interrupted.';
          toolCalls.push({ name, args, isError: true });
          await emit('tool_result', { name, args, result: output, isError: true, cancelled: true });
          await append({ role: 'tool', content: output, ...(call.id ? { tool_call_id: call.id } : {}) });
        }
        await emit('cancelled', { iteration });
        return finish('cancelled');
      }

      if (repeatedFailure) {
        for (const call of calls.slice(nextCallIndex)) {
          const name = call.function?.name;
          const args = parseArgs(call.function?.arguments);
          if (!announcedCalls.has(call)) await emit('tool_call', { name, args, call });
          const output = 'Error: Tool call cancelled because repeated tool failures reached the retry limit.';
          toolCalls.push({ name, args, isError: true });
          await emit('tool_result', { name, args, result: output, isError: true, cancelled: true });
          await append({ role: 'tool', content: output, ...(call.id ? { tool_call_id: call.id } : {}) });
        }
        const nudge = buildToolFailureLimitNudge(repeatedFailure.name, repeatedFailure.args, repeatedFailure);
        await emit('tool_failure_limit', { ...repeatedFailure, nudge });
        await append({ role: 'user', content: nudge });
        forceFinal = true;
        postVerifyCalls = 0;
        postVerifyNudges = 0;
        repeater.reset();
        await emit('iteration_end', { iteration });
        continue;
      }

      // Only reading, never editing? Append a forcing nudge to the last tool
      // result rather than adding a message — that keeps the tool_call /
      // tool_result pairing valid for every provider.
      const nudge = nudger.takeNudge();
      if (nudge) {
        const last = messages[messages.length - 1];
        if (last?.role === 'tool') last.content += `\n\n${nudge}`;
        await emit('act_nudge', { streak: nudger.streak, nudge });
      }

      await emit('iteration_end', { iteration });

      // Steering input injected before the next request rides along with the
      // tool results the model is waiting on.
      const followUps = takeFollowUps ? await takeFollowUps() : null;
      if (followUps) {
        forceFinal = false;
        failedToolAttempts.clear();
        failedDiagnostics.clear();
        postVerifyCalls = 0;
        postVerifyNudges = 0;
        await append(followUps);
        repeater.reset(); // the user changed the context; judge repetition afresh
      } else {
        let completionNudged = false;
        if (postVerifyGuard > 0 && verifyOk && postVerifyCalls >= postVerifyGuard) {
          postVerifyNudges++;
          forceFinal = postVerifyNudges >= POST_VERIFY_MAX_NUDGES;
          const completionNudge = buildPostVerifyNudge(
            postVerifyCalls, lastVerificationCommand, forceFinal,
          );
          postVerifyCalls = 0;
          completionNudged = true;
          await emit('post_verify_nudge', {
            attempt: postVerifyNudges,
            forceFinal,
            verificationCommand: lastVerificationCommand,
            nudge: completionNudge,
          });
          await append({ role: 'user', content: completionNudge });
        }

        // The same tool calls over and over, learning nothing: nudge, and if the
        // model ignores that, end the turn instead of spending the whole
        // iteration budget on a degenerate loop. Checked here rather than before
        // executing the batch so tool_call/tool_result pairing stays valid, and
        // in the else-branch so it never stacks a second adjacent user message
        // on top of a delivered follow-up.
        const repeatNudge = completionNudged ? null : repeater.record(signature);
        if (repeatNudge) {
          if (repeater.nudges > REPEAT_MAX) {
            await emit('repeating', { iterations: iteration, signature });
            return finish('repeating');
          }
          await emit('repeat_nudge', { attempt: repeater.nudges, nudge: repeatNudge });
          await append({ role: 'user', content: repeatNudge });
        }
      }
    }

    await emit('max_iterations', { iterations: iteration });
    if (onMaxIterations && await onMaxIterations({ iterations: iteration })) {
      budget = iteration + maxIterations; // fresh budget, same turn
      continue;
    }
    return finish('max_iterations');
  }
}
