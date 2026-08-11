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

import { chatStream } from './provider.js';
import { executeTool } from './tools.js';
import { trimToolOutputs } from './context.js';
import { parseTextToolCalls } from './tool-call-parser.js';

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
// Long-running servers (npm run dev / start) are deliberately excluded — they
// don't verify correctness.
const VERIFY_RE = /^(sudo\s+)?(time\s+)?(npx\s+|pnpm\s+|yarn\s+|bun\s+)?(npm\s+(run\s+)?(build|test|lint|typecheck|type-check|check)\b|(pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|check)\b|next\s+(build|lint)\b|vite\s+build\b|tsc\b|eslint\b|ruff\b|flake8\b|mypy\b|pyright\b|pytest\b|jest\b|vitest\b|phpunit\b|rspec\b|node\s+--(check|test)\b|go\s+(build|test|vet)\b|cargo\s+(build|test|check|clippy)\b|make\b|mvn\b|gradle\b|python3?\s+-m\s+(pytest|unittest|mypy|py_compile)\b)/i;

// Running the thing you just wrote is verification too. The list above only knows
// package-manager and test-runner invocations, so on a Terminal-Bench task with no
// package.json the gate kept firing at an agent that WAS verifying: it ran
// `python3 check_cert.py` five times and got nudged after every one, turning an
// 8-call task into 20 calls and 80k input tokens.
const RUN_SCRIPT_RE = /^(sudo\s+)?(time\s+)?(python3?|node|deno|bun|ruby|perl|php|bash|sh|zsh)\s+(\S+\/)?(\S+\.(py|js|mjs|cjs|ts|rb|pl|php|sh))\s*$|^\.\/\S+\s*$/i;

// …with one exception. These names are conventionally a server's entry point, and
// starting a server proves nothing — it just blocks until the bash timeout. A
// script that genuinely checks something is not called `app.js`.
const SERVER_ENTRY_RE = /^(app|server|index|main|start|dev)\.(js|mjs|cjs|ts|py)$/i;

export function looksLikeVerification(command) {
  return String(command || '')
    .split(/&&|\|\||;|\n/)
    .some(seg => {
      const s = seg.trim();
      if (VERIFY_RE.test(s)) return true;
      const script = RUN_SCRIPT_RE.exec(s);
      if (!script) return false;
      const basename = (script[5] ?? s).split('/').pop();
      return !SERVER_ENTRY_RE.test(basename);
    });
}

export function buildVerifyNudge(verifyRan) {
  if (verifyRan) {
    return '[automated check] Your last build/test/typecheck did not pass. Fix the errors and re-run it — do not finish with a failing check.';
  }
  return "[automated check] You edited files but haven't verified the result works. Before finishing, run the project's build, typecheck, or tests " +
    '(e.g. `npm run build`, `npx tsc --noEmit`, or the test command) and fix any errors. Do not report the task complete until a check passes. ' +
    'If it can only be exercised by a long-running server (e.g. `npm run dev`) that cannot finish here, say so explicitly and explain how you otherwise confirmed the change works.';
}

const VERIFY_MAX = 2; // gate fires at most twice per turn (initial + one fix cycle)

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
  const textParsed = parseTextToolCalls(result.content);
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
 * where status is 'completed' | 'cancelled' | 'failed' | 'max_iterations'.
 */
export async function runAgent({
  model,
  messages,
  tools = [],
  toolContext = {},
  chatFn = chatStream,
  effort = null,
  signal = undefined,
  maxIterations = resolveMaxIterations(),
  actNudge = resolveActNudge(),
  verifyGate = resolveVerifyGate(),
  emit = () => {},
  onDelta = null,
  approve = null,
  takeFollowUps = null,
  onMaxIterations = null,
} = {}) {
  // Per-turn read cache: short-circuits identical re-reads of unchanged files.
  // Usage logs showed the agent re-reading the same files dozens of times in one
  // turn (one file 23×; 69% of reads redundant), stalling progress and bloating
  // context. Fresh per run so a later turn always sees current files.
  const readCache = toolContext.readCache ?? new Map();
  const nudger = createActNudger(actNudge);
  const usage = { promptTokens: 0, completionTokens: 0 };
  const toolCalls = [];

  let iteration = 0;
  let budget = maxIterations;
  let content = '';
  // Verification-gate state: did this turn edit files, and has a build/test/
  // typecheck actually passed since?
  let turnEdited = false, verifyRan = false, verifyOk = false, verifyNudges = 0;

  const append = async (message) => {
    messages.push(message);
    await emit('message', { message });
    return message;
  };
  const finish = (status) => ({ status, content, messages, usage, iterations: iteration, toolCalls });

  while (true) {
    while (iteration < budget) {
      iteration++;
      await emit('iteration_start', { iteration, maxIterations: budget });

      const controller = new AbortController();
      const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      await emit('request_start', { iteration, controller });

      let streamed = false;
      let result;
      try {
        result = await chatFn({
          model,
          // Collapse old tool outputs in the payload (not in stored history) so a
          // long tool loop doesn't re-send every file read on every iteration,
          // and strip orphan tool messages the provider would reject outright.
          messages: dropOrphanToolMessages(trimToolOutputs(messages)),
          tools,
          signal: requestSignal,
          onDelta: (delta) => {
            if (!streamed) {
              streamed = true;
              void emit('stream_started', { iteration });
            }
            onDelta?.(delta);
          },
          ...(effort ? { effort } : {}),
        });
      } catch (err) {
        await emit('request_end', { iteration, error: err, streamed });
        if (err.name === 'AbortError') {
          await emit('cancelled', { iteration });
          return finish('cancelled');
        }
        await emit('failed', { iteration, error: err });
        return finish('failed');
      }
      await emit('request_end', { iteration, result, streamed });

      usage.promptTokens += result.promptTokens ?? 0;
      usage.completionTokens += result.completionTokens ?? 0;
      await emit('usage', { iteration, ...usage, last: result });

      // With no tools offered, text that merely looks like a tool call is just
      // text. `/tools off` used to still execute it, because the text parser ran
      // regardless of whether tools were enabled.
      const calls = tools.length ? mergeToolCalls(result) : null;
      content = result.content ?? '';

      // ── No tool calls → the model is trying to finish ──────────────────────
      if (!calls?.length) {
        await emit('assistant_text', { content, streamed, iteration, final: true });
        await append({ role: 'assistant', content });

        // Safe boundary: steering input queued during this turn keeps the same
        // loop alive instead of ending the turn.
        const followUps = takeFollowUps ? await takeFollowUps() : null;
        if (followUps) { await append(followUps); continue; }

        // Don't let a turn that edited files finish without a passing check.
        if (verifyGate && turnEdited && !verifyOk && verifyNudges < VERIFY_MAX) {
          verifyNudges++;
          await emit('verify_nudge', { verifyRan, attempt: verifyNudges });
          await append({ role: 'user', content: buildVerifyNudge(verifyRan) });
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

      for (const call of calls) {
        const name = call.function?.name;
        const args = parseArgs(call.function?.arguments);
        await emit('tool_call', { name, args, call });

        if (approve && !(await approve(name, args))) {
          await emit('tool_denied', { name, args });
          await append({ role: 'tool', content: 'User denied permission for this operation.', ...(call.id ? { tool_call_id: call.id } : {}) });
          continue;
        }

        let output;
        let isError = false;
        try {
          output = String(await executeTool(name, args, { ...toolContext, readCache, signal }));
        } catch (err) {
          output = `Error: ${err.message}`;
          isError = true;
        }

        toolCalls.push({ name, args, isError });
        await emit('tool_result', { name, args, result: output, isError });
        await append({ role: 'tool', content: output, ...(call.id ? { tool_call_id: call.id } : {}) });

        nudger.record(name, isError); // a failed action doesn't count as progress
        if (!isError && EDIT_TOOLS.has(name)) turnEdited = true;
        if (name === 'bash' && looksLikeVerification(args?.command)) { verifyRan = true; verifyOk = !isError; }
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
      if (followUps) await append(followUps);
    }

    await emit('max_iterations', { iterations: iteration });
    if (onMaxIterations && await onMaxIterations({ iterations: iteration })) {
      budget = iteration + maxIterations; // fresh budget, same turn
      continue;
    }
    return finish('max_iterations');
  }
}
