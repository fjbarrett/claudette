#!/usr/bin/env node
// Prompt / tool-usage eval loops.
//
// A lighter, faster companion to bench/run.js: instead of spinning up a git
// worktree and driving the full CLI as a subprocess, each case runs an
// in-process agent loop (chatStream + executeTool) inside a throwaway sandbox
// directory, records every tool call, and checks declarative expectations —
// which tools were called, with what arguments, in what order, what the
// workspace looks like afterwards, and what the final answer says.
//
// Cases live in bench/evals/*.json:
//   {
//     "id": "edit-config",
//     "title": "...",
//     "prompt": "...",
//     "files": { "src/config.js": "..." },        // sandbox fixtures
//     "maxTurns": 6,
//     "repeat": 3,                                  // default loop count
//     "expect": {
//       "tools":  [ {"name": "read_file", "args": {"path": "src/config.js"}},
//                   {"name": "str_replace"} ],      // ordered subsequence
//       "forbid": ["write_file"],                   // must never be called
//       "files":  { "src/config.js": {"includes": "90"} },
//       "answer": { "matches": "done" }             // regex on final text
//     }
//   }
//
// Arg matching: expected string values must be contained in the actual value
// (substring), everything else compares strictly. Repeating a case N times
// (--repeat) reports pass@k (any iteration passed) and pass^k (all passed) —
// the standard way to surface flaky tool-calling behaviour.
//
// node bench/evals.js --list
// node bench/evals.js --all --model anthropic/claude-opus-4-8 --repeat 3
// node bench/evals.js --case edit-config --verbose

import '../src/env-autoload.js'; // load .env before anything reads process.env
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatStream, defaultCloudModels } from '../src/provider.js';
import { TOOL_DEFS, executeTool } from '../src/tools.js';
import { parseTextToolCalls } from '../src/chat.js';
import { trimToolOutputs } from '../src/context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CASES_DIR = path.join(__dirname, 'evals');
const REPORTS_DIR = path.join(__dirname, 'runs', 'evals');

const SYSTEM_PROMPT = [
  'You are a coding agent operating inside a sandbox workspace.',
  'Use the provided tools to complete the task. All paths are relative to the workspace root.',
  'Make minimal, targeted changes. When the task is complete, reply with a short final answer and no further tool calls.',
].join(' ');

// ─── Agent loop ───────────────────────────────────────────────────────────────

/**
 * Run one iteration of a case: fresh sandbox, agent loop, expectation check.
 * `chatFn` is injectable so tests can drive the loop with a scripted model.
 */
export async function runEvalIteration(caseDef, { model, chatFn = chatStream, keepSandbox = false, trim = true } = {}) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `claudette-eval-${caseDef.id}-`));
  const started = Date.now();
  const record = {
    caseId: caseDef.id,
    model,
    sandbox,
    trim,
    toolCalls: [],
    finalText: '',
    turns: 0,
    durationMs: 0,
    // Token accounting so the context-management effect is measurable: total
    // input tokens billed across the loop, and the single largest request (the
    // blowup the trimming targets — re-sent tool outputs accumulate per turn).
    promptTokens: 0,
    completionTokens: 0,
    peakInputTokens: 0,
    pass: false,
    failures: [],
    error: null,
  };

  try {
    for (const [rel, content] of Object.entries(caseDef.files ?? {})) {
      const abs = path.join(sandbox, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: caseDef.prompt },
    ];
    const maxTurns = caseDef.maxTurns ?? 8;

    for (let turn = 1; turn <= maxTurns; turn++) {
      record.turns = turn;
      const result = await chatFn({
        model,
        // Mirror the interactive agent loop: collapse old tool outputs in the
        // payload (not in stored `messages`) so a long tool loop stops re-sending
        // every file read. `trim:false` measures the un-trimmed baseline.
        messages: trim ? trimToolOutputs(messages) : messages,
        tools: TOOL_DEFS,
        onDelta: () => {},
      });

      const inTok = result.promptTokens ?? 0;
      record.promptTokens += inTok;
      record.completionTokens += result.completionTokens ?? 0;
      if (inTok > record.peakInputTokens) record.peakInputTokens = inTok;

      // Merge text-emitted tool calls the same way the interactive CLI does.
      let toolCalls = result.toolCalls ?? [];
      if (result.content) {
        const textParsed = parseTextToolCalls(result.content);
        if (textParsed.length) {
          const apiKeys = new Set(toolCalls.map(c => JSON.stringify(c.function)));
          const novel = textParsed.filter(c => !apiKeys.has(JSON.stringify(c.function)));
          toolCalls = [...novel, ...toolCalls];
        }
      }

      if (!toolCalls.length) {
        record.finalText = result.content ?? '';
        break;
      }

      messages.push({ role: 'assistant', content: result.content ?? '', tool_calls: toolCalls });

      for (const call of toolCalls) {
        const name = call.function?.name;
        let args;
        try {
          args = typeof call.function?.arguments === 'string'
            ? JSON.parse(call.function.arguments)
            : (call.function?.arguments ?? {});
        } catch {
          args = { raw: call.function?.arguments };
        }

        let output;
        let isError = false;
        try {
          output = String(await executeTool(name, args, { cwd: sandbox, workspace: sandbox }));
        } catch (err) {
          output = `Error: ${err.message}`;
          isError = true;
        }

        record.toolCalls.push({ name, args, isError, output: truncate(output, 2000) });
        messages.push({ role: 'tool', content: output, ...(call.id ? { tool_call_id: call.id } : {}) });
      }
    }

    const { pass, failures } = await evaluateExpectations(record, caseDef.expect ?? {}, sandbox);
    record.pass = pass;
    record.failures = failures;
  } catch (err) {
    record.error = err.message;
    record.failures = [`run error: ${err.message}`];
  } finally {
    record.durationMs = Date.now() - started;
    if (!keepSandbox) {
      await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
      record.sandbox = null;
    }
  }

  return record;
}

// ─── Expectation matching ─────────────────────────────────────────────────────

/** Expected string arg values match by substring; everything else strictly. */
export function argsMatch(actual, expected) {
  for (const [key, want] of Object.entries(expected ?? {})) {
    const got = actual?.[key];
    if (typeof want === 'string') {
      if (typeof got !== 'string' || !got.includes(want)) return false;
    } else if (got !== want) {
      return false;
    }
  }
  return true;
}

/**
 * Match expected tool calls as an ordered subsequence of the actual calls.
 * Returns { ok, missing } where missing is the first unmatched expectation.
 */
export function matchToolCalls(actualCalls, expectedCalls) {
  let cursor = 0;
  for (const want of expectedCalls ?? []) {
    let found = false;
    while (cursor < actualCalls.length) {
      const got = actualCalls[cursor++];
      if (got.name === want.name && argsMatch(got.args, want.args)) {
        found = true;
        break;
      }
    }
    if (!found) {
      return { ok: false, missing: want };
    }
  }
  return { ok: true, missing: null };
}

export async function evaluateExpectations(record, expect, sandbox) {
  const failures = [];

  const { ok, missing } = matchToolCalls(record.toolCalls, expect.tools);
  if (!ok) {
    failures.push(`missing tool call: ${missing.name}(${JSON.stringify(missing.args ?? {})}); ` +
      `actual: [${record.toolCalls.map(c => c.name).join(', ') || 'none'}]`);
  }

  for (const name of expect.forbid ?? []) {
    if (record.toolCalls.some(c => c.name === name)) {
      failures.push(`forbidden tool was called: ${name}`);
    }
  }

  for (const [rel, check] of Object.entries(expect.files ?? {})) {
    let content = null;
    try {
      content = await fs.readFile(path.join(sandbox, rel), 'utf8');
    } catch {
      failures.push(`expected file missing: ${rel}`);
      continue;
    }
    if (check.includes && !content.includes(check.includes)) {
      failures.push(`file ${rel} does not include ${JSON.stringify(check.includes)}`);
    }
  }

  if (expect.answer?.matches) {
    const re = new RegExp(expect.answer.matches, 'i');
    if (!re.test(record.finalText)) {
      failures.push(`final answer does not match /${expect.answer.matches}/i: ` +
        JSON.stringify(truncate(record.finalText, 200)));
    }
  }

  return { pass: failures.length === 0, failures };
}

// ─── Case loading / CLI ───────────────────────────────────────────────────────

export async function loadCases() {
  const entries = await fs.readdir(CASES_DIR);
  const cases = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    cases.push(JSON.parse(await fs.readFile(path.join(CASES_DIR, entry), 'utf8')));
  }
  return cases;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.CLAUDETTE_BENCH_CACHE = args.noCache ? '0' : '1';
  const cases = await loadCases();


  if (args.list) {
    for (const c of cases) {
      console.log(`${c.id.padEnd(24)} repeat=${String(c.repeat ?? 1).padEnd(3)} ${c.title}`);
    }
    return;
  }

  const selected = args.all ? cases : cases.filter(c => args.cases.includes(c.id));
  if (!selected.length) {
    throw new Error(args.cases.length
      ? `Unknown case(s): ${args.cases.join(', ')}`
      : 'Use --case <id>, --all, or --list');
  }

  const model = args.model ?? defaultCloudModels()?.agent;
  if (!model) {
    throw new Error(
      'No --model given and no cloud API key in env: set one in .env ' +
      '(e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY) or pass --model.'
    );
  }

  console.log(`context trimming: ${args.trim ? 'ON (default)' : 'OFF (--no-trim baseline)'}`);
  const results = [];
  for (const caseDef of selected) {
    const repeat = args.repeat ?? caseDef.repeat ?? 1;
    const iterations = [];
    for (let i = 1; i <= repeat; i++) {
      process.stdout.write(`─ ${caseDef.id} (${i}/${repeat}) ... `);
      const record = await runEvalIteration(caseDef, { model, keepSandbox: args.keep, trim: args.trim });
      iterations.push(record);
      const tok = `in=${record.promptTokens} peak=${record.peakInputTokens} out=${record.completionTokens}`;
      console.log(`${record.pass ? 'pass' : `FAIL  [${record.failures.join(' | ')}]`}  (${record.toolCalls.length} tools, ${tok})`);
      if (args.verbose) {
        for (const call of record.toolCalls) {
          console.log(`    ${call.isError ? '✗' : '·'} ${call.name}(${truncate(JSON.stringify(call.args), 120)})`);
        }
      }
    }
    const passes = iterations.filter(r => r.pass).length;
    const avg = (sel) => Math.round(iterations.reduce((a, r) => a + sel(r), 0) / iterations.length);
    results.push({
      caseId: caseDef.id,
      title: caseDef.title,
      model,
      trim: args.trim,
      repeat,
      passes,
      passAtK: passes > 0,
      passAllK: passes === repeat,
      avgPromptTokens: avg(r => r.promptTokens),
      avgPeakInputTokens: avg(r => r.peakInputTokens),
      avgCompletionTokens: avg(r => r.completionTokens),
      iterations,
    });
  }

  console.log('\n═══ Eval summary ═══');
  for (const r of results) {
    const rate = `${r.passes}/${r.repeat}`;
    console.log(
      `${r.caseId.padEnd(24)} ${rate.padEnd(6)} pass@k=${r.passAtK ? 'yes' : 'NO'}  ` +
      `pass^k=${r.passAllK ? 'yes' : 'no'}  avgIn=${String(r.avgPromptTokens).padStart(7)} ` +
      `avgPeakIn=${String(r.avgPeakInputTokens).padStart(7)} avgOut=${String(r.avgCompletionTokens).padStart(6)}`
    );
  }

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(REPORTS_DIR, `${stamp}-${model.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify({ model, generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nreport: ${path.relative(process.cwd(), file)}`);

  if (results.some(r => r.passes === 0)) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const args = { cases: [], all: false, list: false, model: null, repeat: null, keep: false, verbose: false, noCache: false, trim: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--case') args.cases.push(argv[++i]);
    else if (arg === '--all') args.all = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--repeat') args.repeat = Number(argv[++i]);
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--no-cache') args.noCache = true;
    else if (arg === '--trim') args.trim = true;       // context trimming on (default)
    else if (arg === '--no-trim') args.trim = false;   // baseline: re-send everything
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return args;
}


function truncate(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Run the CLI only when invoked directly (so tests can import the helpers).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
