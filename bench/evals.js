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
//       "files":  { "src/config.js": {"includes": "90", "excludes": "30"},
//                   "src/config.js.bak": {"absent": true} },
//       "unchangedFiles": ["oracle_test.js"],       // exact seeded bytes
//       "maxToolCalls": 6,                          // efficiency budget
//       "answer": { "matches": "done", "notMatches": "unsupported claim" }
//                                                     // positive/negative final-text regexes
//     }
//   }
//
// `includes`/`excludes` take a string or an array of them. `excludes` is how a
// case catches collateral damage — the asked-for change landed, but the model
// rewrote the file and lost the rest. `maxToolCalls` is how correctness ties
// break: several models get the right answer, fewer get it without flailing.
// `allowedFiles` entries are exact paths unless they end in `/**`, which allows
// a generated directory tree such as `.venv/**` while keeping all siblings out.
//
// Arg matching: expected string values must be contained in the actual value
// (substring), everything else compares strictly. Repeating a case N times
// (--repeat) reports pass@k (any iteration passed) and pass^k (all passed) —
// the standard way to surface flaky tool-calling behaviour.
//
// node bench/evals.js --list
// node bench/evals.js --all --model anthropic/claude-opus-4-8 --repeat 3
// node bench/evals.js --case edit-config --verbose
// node bench/evals.js --case edit-config --cache    # replay recorded replies

import '../src/env-autoload.js'; // load .env before anything reads process.env
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatStream, defaultCloudModels, getModels } from '../src/provider.js';
import { TOOL_DEFS } from '../src/tools.js';
import { runAgent } from '../src/agent-runner.js';
import { EVIDENCE_GUIDANCE } from '../src/evidence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CASES_DIR = path.join(__dirname, 'evals');
const REPORTS_DIR = path.join(__dirname, 'runs', 'evals');

const SYSTEM_PROMPT = [
  'You are a coding agent operating inside a sandbox workspace.',
  'Use the provided tools to complete the task. All paths are relative to the workspace root.',
  'Make minimal, targeted changes when changes are requested. When the task is complete, reply with a short final answer and no further tool calls.',
  EVIDENCE_GUIDANCE,
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
    status: 'running',
    assistantResponses: [],
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

    // The same loop the CLI runs — that is the point. This harness used to carry
    // its own copy, so it silently measured an agent without the re-read guard,
    // the action nudge, or the verification gate.
    const run = await runAgent({
      model,
      messages,
      tools: TOOL_DEFS,
      toolContext: { cwd: sandbox, workspace: sandbox },
      chatFn: trim
        ? chatFn
        // `--no-trim` measures the un-trimmed baseline: undo the runner's
        // payload trimming by handing the provider the full message list.
        : (opts => chatFn({ ...opts, messages })),
      maxIterations: maxTurns,
      emit: (type, data) => {
        if (type === 'iteration_start') record.turns = data.iteration;
        else if (type === 'assistant_text') {
          record.assistantResponses.push({
            iteration: data.iteration,
            content: truncate(data.content ?? '', 500),
            toolCalls: (data.toolCalls ?? []).map(call => call.function?.name ?? '(missing)'),
          });
        }
        else if (type === 'usage') {
          const inTok = data.last?.promptTokens ?? 0;
          if (inTok > record.peakInputTokens) record.peakInputTokens = inTok;
        } else if (type === 'tool_result') {
          record.toolCalls.push({ name: data.name, args: data.args, isError: data.isError, output: truncate(data.result, 2000) });
        }
      },
    });

    record.status = run.status;
    record.finalText = run.status === 'completed' ? run.content : '';
    record.promptTokens = run.usage.promptTokens;
    record.completionTokens = run.usage.completionTokens;
    if (run.status === 'failed') {
      throw new Error(`agent run failed after ${run.iterations} iterations: ` +
        `${run.error?.message ?? 'no error reported'}`);
    }

    const { pass, failures } = await evaluateExpectations(
      record, caseDef.expect ?? {}, sandbox, caseDef.files ?? {},
    );
    record.pass = pass;
    record.failures = failures;
  } catch (err) {
    if (record.status === 'running') record.status = 'failed';
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

export async function evaluateExpectations(record, expect, sandbox, fixtureFiles = {}) {
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

  if (expect.noToolErrors && record.toolCalls.some(call => call.isError)) {
    const failed = record.toolCalls.filter(call => call.isError).map(call => call.name);
    failures.push(`tool errors are forbidden; failed calls: ${failed.join(', ')}`);
  }

  for (const [rel, check] of Object.entries(expect.files ?? {})) {
    let content = null;
    try {
      content = await fs.readFile(path.join(sandbox, rel), 'utf8');
    } catch {
      // `absent: true` is the only expectation a missing file satisfies.
      if (!check.absent) failures.push(`expected file missing: ${rel}`);
      continue;
    }
    if (check.absent) {
      failures.push(`file ${rel} should not exist`);
      continue;
    }
    if (check.equals != null && content !== check.equals) {
      failures.push(`file ${rel} does not exactly equal ${JSON.stringify(check.equals)}`);
    }
    for (const want of [].concat(check.includes ?? [])) {
      if (!content.includes(want)) {
        failures.push(`file ${rel} does not include ${JSON.stringify(want)}`);
      }
    }
    // `excludes` is what catches collateral damage: the edit landed, but the
    // model rewrote the file and dropped everything it was not asked to touch.
    for (const unwanted of [].concat(check.excludes ?? [])) {
      if (content.includes(unwanted)) {
        failures.push(`file ${rel} still includes ${JSON.stringify(unwanted)}`);
      }
    }
  }

  for (const rel of expect.unchangedFiles ?? []) {
    const original = fixtureFiles[rel];
    if (typeof original !== 'string') {
      failures.push(`unchanged file is not a seeded fixture: ${rel}`);
      continue;
    }
    try {
      const content = await fs.readFile(path.join(sandbox, rel), 'utf8');
      if (content !== original) failures.push(`seeded file changed: ${rel}`);
    } catch {
      failures.push(`seeded file missing: ${rel}`);
    }
  }


  if (expect.allowedFiles) {
    const allowed = expect.allowedFiles.map(value => String(value).split(path.sep).join('/'));
    const exact = new Set(allowed.filter(value => !value.endsWith('/**')));
    const prefixes = allowed
      .filter(value => value.endsWith('/**') && value.length > 3)
      .map(value => value.slice(0, -2));
    const actual = await listSandboxFiles(sandbox);
    for (const rel of actual) {
      if (!exact.has(rel) && !prefixes.some(prefix => rel.startsWith(prefix))) {
        failures.push(`unexpected file created: ${rel}`);
      }
    }
  }

  // A budget, not a cap: the loop is not interrupted, the case just fails when a
  // model brute-forces its way to a correct answer. Ties on correctness break here.
  if (expect.maxToolCalls != null && record.toolCalls.length > expect.maxToolCalls) {
    failures.push(`used ${record.toolCalls.length} tool calls, budget is ${expect.maxToolCalls}`);
  }

  if (expect.answer?.matches) {
    const re = new RegExp(expect.answer.matches, 'i');
    if (!re.test(record.finalText)) {
      failures.push(`final answer does not match /${expect.answer.matches}/i: ` +
        JSON.stringify(truncate(record.finalText, 200)));
    }
  }

  if (expect.answer?.notMatches) {
    const re = new RegExp(expect.answer.notMatches, 'i');
    if (re.test(record.finalText)) failures.push('final answer contains a forbidden claim');
  }

  return { pass: failures.length === 0, failures };
}

async function listSandboxFiles(root, current = root) {
  const files = [];
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) files.push(...await listSandboxFiles(root, absolute));
    else files.push(relative);
  }
  return files;
}

// ─── Case loading / CLI ───────────────────────────────────────────────────────

export async function loadCases(casesDir = CASES_DIR) {
  const entries = await fs.readdir(casesDir, { withFileTypes: true });
  const cases = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Finder/Archive Utility sidecars such as `._case.json` carry binary
    // metadata, not benchmark definitions. Ignore all hidden and non-file
    // entries before extension matching so cross-platform copies stay valid.
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue;
    cases.push(JSON.parse(await fs.readFile(path.join(casesDir, entry.name), 'utf8')));
  }
  return cases;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.CLAUDETTE_BENCH_CACHE = args.cache ? '1' : '0';
  // A model comparison must not silently finish on another route. Rotation is
  // useful in production, but invalidates model identity, timings, and scores.
  process.env.CLAUDETTE_MODEL_ROTATION = args.rotation ? '1' : '0';
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

  const available = args.model ? [] : await getModels().catch(() => []);
  const model = args.model ?? available[0]?.name ?? defaultCloudModels()?.agent;
  if (!model) {
    throw new Error(
      'No --model given and no cloud API key in env: set one in .env ' +
      '(e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY) or pass --model.'
    );
  }

  const startedAt = Date.now();
  if (!args.json) {
    console.log(`context trimming: ${args.trim ? 'ON (default)' : 'OFF (--no-trim baseline)'}` +
      `  |  response cache: ${args.cache ? 'ON (--cache; timings are not measurements)' : 'OFF (default)'}` +
      `  |  model rotation: ${args.rotation ? 'ON (--rotation)' : 'OFF (comparison default)'}`);
  }
  const results = [];
  for (const caseDef of selected) {
    const repeat = args.repeat ?? caseDef.repeat ?? 1;
    const iterations = [];
    for (let i = 1; i <= repeat; i++) {
      if (!args.json) process.stdout.write(`─ ${caseDef.id} (${i}/${repeat}) ... `);
      const record = await runEvalIteration(caseDef, { model, keepSandbox: args.keep, trim: args.trim });
      iterations.push(record);
      const tok = `in=${record.promptTokens} peak=${record.peakInputTokens} out=${record.completionTokens}`;
      if (!args.json) {
        console.log(`${record.pass ? 'pass' : `FAIL  [${record.failures.join(' | ')}]`}  (${record.toolCalls.length} tools, ${tok})`);
      }
      if (args.verbose && !args.json) {
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

  const summary = {
    model,
    generatedAt: new Date().toISOString(),
    trim: args.trim,
    // Recorded so a report is interpretable later: with the cache on, the
    // durations and token counts may belong to a run from another day.
    cache: args.cache,
    rotation: args.rotation,
    totals: {
      cases: results.length,
      passed: results.filter(r => r.passAtK).length,
      passedAll: results.filter(r => r.passAllK).length,
      durationMs: Date.now() - startedAt,
      promptTokens: results.reduce((a, r) => a + r.avgPromptTokens * r.repeat, 0),
      completionTokens: results.reduce((a, r) => a + r.avgCompletionTokens * r.repeat, 0),
      peakInputTokens: Math.max(0, ...results.map(r => r.avgPeakInputTokens)),
    },
    results,
  };

  if (args.json) {
    // One JSON document on stdout and nothing else, so a caller can pipe it.
    console.log(JSON.stringify(summary));
    await writeReport(summary, model);
    if (results.some(r => r.passes === 0)) process.exitCode = 1;
    return;
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

  const file = await writeReport(summary, model);
  console.log(`\nreport: ${path.relative(process.cwd(), file)}`);

  if (results.some(r => r.passes === 0)) {
    process.exitCode = 1;
  }
}

async function writeReport(summary, model) {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const stamp = summary.generatedAt.replace(/[:.]/g, '-');
  const file = path.join(REPORTS_DIR, `${stamp}-${model.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(summary, null, 2));
  return file;
}

export function parseArgs(argv) {
  const args = { cases: [], all: false, list: false, model: null, repeat: null, keep: false, verbose: false, cache: false, trim: true, json: false, rotation: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--case') args.cases.push(argv[++i]);
    else if (arg === '--all') args.all = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--repeat') args.repeat = Number(argv[++i]);
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--verbose') args.verbose = true;
    // The response cache replays a recorded reply for an identical (model,
    // messages) key. That is what you want while writing a case, and the wrong
    // thing by default: a replayed run reports the tokens recorded whenever it
    // was captured and a near-zero duration, so a cached model looks both cheap
    // and instant next to one being measured for real. It cost an afternoon —
    // an Anthropic run kept reporting 2 input tokens per request after the bug
    // that caused it had already been fixed.
    else if (arg === '--cache') args.cache = true;
    else if (arg === '--no-cache') args.cache = false;   // now the default; kept so old commands still run
    else if (arg === '--json') args.json = true;
    else if (arg === '--rotation') args.rotation = true;
    else if (arg === '--no-rotation') args.rotation = false;
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
