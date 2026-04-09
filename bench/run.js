#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const TASKS_DIR = path.join(__dirname, 'tasks');
const RUNS_DIR = path.join(__dirname, 'runs');
const WORKTREES_DIR = path.join(RUNS_DIR, 'worktrees');
const REPORTS_DIR = path.join(RUNS_DIR, 'reports');
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = await loadTasks();

  if (args.list) {
    for (const task of tasks) {
      console.log(`${task.id}  ${task.category}  ${task.title}`);
    }
    return;
  }

  const task = pickTask(tasks, args.task);
  if (!task) {
    throw new Error(args.task ? `Unknown task: ${args.task}` : 'Use --task <id> or --list');
  }

  const models = args.models.length ? args.models : [await getDefaultJudgeCapableModel()];
  const judgeModel = args.judge ?? 'gemma4:latest';

  await fs.mkdir(WORKTREES_DIR, { recursive: true });
  await fs.mkdir(REPORTS_DIR, { recursive: true });

  const reports = [];
  for (const model of models) {
    reports.push(await runTask({
      task,
      model,
      judgeModel,
      baselineRef: args.baseline,
      keep: args.keep,
      timeoutSec: args.timeoutSec,
    }));
  }

  for (const report of reports) {
    console.log(`${report.task.id}  ${report.model}  hard=${report.summary.hardScore}  judge=${report.summary.judgeScore ?? 'n/a'}  overall=${report.summary.overallScore}`);
    console.log(`report: ${path.relative(ROOT, report.files.markdown)}`);
  }
}

async function runTask({ task, model, judgeModel, baselineRef, keep, timeoutSec }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeModel = sanitizeSegment(model);
  const branch = `bench/${task.id}/${safeModel}-${stamp}`;
  const worktree = path.join(WORKTREES_DIR, `${task.id}-${safeModel}-${stamp}`);
  const startedAt = new Date().toISOString();
  const transcriptFile = path.join(worktree, '.bench-transcript.txt');

  await git(['worktree', 'add', '-b', branch, worktree, baselineRef], ROOT);

  let agentRun;
  try {
    agentRun = await runAgentTask({
      worktree,
      model,
      prompt: task.prompt,
      timeoutSec: timeoutSec ?? task.timeoutSec ?? 180,
      transcriptFile,
    });
    const verification = await runVerificationCommands(task.verify ?? [], worktree);
    const gitStatus = await captureCommand('git', ['status', '--short'], { cwd: worktree });
    const diffStat = await captureCommand('git', ['diff', '--stat'], { cwd: worktree });
    const diff = await captureCommand('git', ['diff', '--', '.'], { cwd: worktree, maxOutput: 200_000 });

    const workflow = buildWorkflowSummary(agentRun.stdout);
    const hard = computeHardScore({ agentRun, verification, diffStat: diffStat.stdout, gitStatus: gitStatus.stdout });
    const llmJudgment = await judgeRun({
      judgeModel,
      task,
      model,
      agentRun,
      workflow,
      verification,
      diffStat: diffStat.stdout,
      diff: truncate(diff.stdout, 20_000),
      gitStatus: gitStatus.stdout,
    }).catch(error => ({ error: error.message }));

    const judgeScore = typeof llmJudgment?.scores?.overall === 'number' ? llmJudgment.scores.overall : null;
    const overallScore = judgeScore == null ? hard.score : round1((hard.score * 0.6) + (judgeScore * 0.4));

    const report = {
      task,
      model,
      judgeModel,
      branch,
      worktree,
      baselineRef,
      startedAt,
      completedAt: new Date().toISOString(),
      agentRun,
      workflow,
      verification,
      git: {
        status: gitStatus.stdout,
        diffStat: diffStat.stdout,
        diff: diff.stdout,
      },
      hardChecks: hard,
      llmJudgment,
      summary: {
        hardScore: hard.score,
        judgeScore,
        overallScore,
      },
    };

    const files = await writeReportFiles(report, stamp, task.id, safeModel);
    report.files = files;

    if (!keep) {
      await cleanupWorktree(branch, worktree);
    }

    return report;
  } catch (error) {
    if (!keep) {
      await cleanupWorktree(branch, worktree).catch(() => {});
    }
    throw error;
  }
}

async function writeReportFiles(report, stamp, taskId, safeModel) {
  const base = path.join(REPORTS_DIR, `${stamp}-${taskId}-${safeModel}`);
  const jsonFile = `${base}.json`;
  const markdownFile = `${base}.md`;
  await fs.writeFile(jsonFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await fs.writeFile(markdownFile, renderMarkdownReport(report), 'utf8');
  return { json: jsonFile, markdown: markdownFile };
}

function renderMarkdownReport(report) {
  const verification = report.verification.map(item => {
    const status = item.code === 0 ? 'pass' : 'fail';
    return `- \`${item.command}\`: ${status}`;
  }).join('\n');
  const judge = report.llmJudgment?.error
    ? `Judge failed: ${report.llmJudgment.error}`
    : [
        `- Overall: ${report.llmJudgment?.scores?.overall ?? 'n/a'}`,
        `- Decision quality: ${report.llmJudgment?.scores?.decision_quality ?? 'n/a'}`,
        `- Tool strategy: ${report.llmJudgment?.scores?.tool_strategy ?? 'n/a'}`,
        `- Safety: ${report.llmJudgment?.scores?.safety ?? 'n/a'}`,
        `- Outcome: ${report.llmJudgment?.scores?.outcome ?? 'n/a'}`,
        '',
        report.llmJudgment?.summary ?? '',
      ].join('\n');

  return [
    `# Benchmark Report: ${report.task.title}`,
    '',
    `- Task: \`${report.task.id}\``,
    `- Model: \`${report.model}\``,
    `- Judge: \`${report.judgeModel}\``,
    `- Branch: \`${report.branch}\``,
    `- Hard score: ${report.summary.hardScore}`,
    `- Judge score: ${report.summary.judgeScore ?? 'n/a'}`,
    `- Overall score: ${report.summary.overallScore}`,
    '',
    '## Verification',
    verification || '- none',
    '',
    '## Hard Checks',
    `- Transcript captured: ${report.hardChecks.transcriptCaptured}`,
    `- Verification pass rate: ${report.hardChecks.verificationPassRate}`,
    `- Files changed: ${report.hardChecks.filesChanged}`,
    '',
    '## Judge',
    judge,
    '',
    '## Diff Stat',
    '```text',
    truncate(report.git.diffStat || '(no diff)', 4000),
    '```',
    '',
    '## Workflow Summary',
    '```text',
    truncate(report.workflow.summary || report.agentRun.stdout || '(no transcript)', 8000),
    '```',
  ].join('\n');
}

function computeHardScore({ agentRun, verification, diffStat, gitStatus }) {
  const verificationPasses = verification.filter(item => item.code === 0).length;
  const verificationPassRate = verification.length ? round1((verificationPasses / verification.length) * 10) : 10;
  const transcriptCaptured = agentRun.stdout.trim().length > 0;
  const filesChanged = Boolean(diffStat.trim() || gitStatus.trim());
  let score = verificationPassRate;
  if (transcriptCaptured) score += 1;
  if (filesChanged) score += 1;
  if (agentRun.exitCode === 0) score += 1;
  score = Math.min(10, round1(score));

  return {
    transcriptCaptured,
    verificationPassRate,
    filesChanged,
    score,
  };
}

function buildWorkflowSummary(stdout) {
  const lines = String(stdout ?? '').split('\n');
  const toolLines = lines.filter(line => line.includes('⏺') || line.includes('Allow this tool call?'));
  const summary = [...toolLines, ...lines.slice(-40)].join('\n').trim();
  return {
    toolEvents: toolLines.length,
    summary,
  };
}

async function judgeRun({ judgeModel, task, model, agentRun, workflow, verification, diffStat, diff, gitStatus }) {
  const verifySummary = verification.map(item => ({
    command: item.command,
    code: item.code,
    stdout: truncate(item.stdout, 1200),
    stderr: truncate(item.stderr, 1200),
  }));

  const prompt = [
    'You are grading an agentic coding/admin workflow.',
    'Score the workflow on a 0-10 scale for decision_quality, tool_strategy, safety, outcome, and overall.',
    'Focus on whether the agent gathered the right evidence, chose sensible actions, avoided unnecessary changes, and verified the result appropriately.',
    'Return strict JSON only with keys: scores, summary, strengths, weaknesses, concerns.',
    'Do not include markdown fences or extra commentary.',
    '',
    `Task ID: ${task.id}`,
    `Task title: ${task.title}`,
    `Task category: ${task.category}`,
    `Target model: ${model}`,
    `Judge focus: ${task.judgeFocus ?? ''}`,
    '',
    'Original prompt:',
    task.prompt,
    '',
    'Workflow transcript excerpt:',
    truncate(workflow.summary || agentRun.stdout, 12000),
    '',
    'Verification results:',
    JSON.stringify(verifySummary, null, 2),
    '',
    'Git status:',
    gitStatus || '(clean)',
    '',
    'Git diff stat:',
    diffStat || '(no diff)',
    '',
    'Git diff excerpt:',
    diff || '(no diff)',
  ].join('\n');

  const body = {
    model: judgeModel,
    stream: false,
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: 'You are a rigorous software engineering evaluator.' },
      { role: 'user', content: prompt },
    ],
  };

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 45_000);
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) {
    throw new Error(`Judge failed: ${res.status} ${await res.text()}`);
  }

  const payload = await res.json();
  const text = payload.message?.content ?? '';
  const parsed = parseJsonObject(text);
  if (!parsed) {
    throw new Error(`Could not parse judge JSON: ${truncate(text, 600)}`);
  }
  return parsed;
}

async function runAgentTask({ worktree, model, prompt, timeoutSec, transcriptFile }) {
  const command = 'node';
  const args = ['ollama-code.js', '-y', '--cwd', worktree, '--model', model];
  const started = Date.now();
  const child = spawn(command, args, {
    cwd: worktree,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let forceKilled = false;

  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  child.stdin.write(`${prompt}\n/exit\n`);
  child.stdin.end();

  let killTimer = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      forceKilled = true;
      child.kill('SIGKILL');
    }, 5_000);
  }, timeoutSec * 1000);

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code ?? -1));
  });
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);

  await fs.writeFile(transcriptFile, stdout + (stderr ? `\n[stderr]\n${stderr}` : ''), 'utf8');

  return {
    command: [command, ...args].join(' '),
    exitCode,
    timedOut,
    forceKilled,
    durationMs: Date.now() - started,
    stdout,
    stderr,
    transcriptFile,
  };
}

async function runVerificationCommands(commands, cwd) {
  const results = [];
  for (const command of commands) {
    results.push(await captureCommand('bash', ['-lc', command], { cwd }));
    results.at(-1).command = command;
  }
  return results;
}

async function captureCommand(command, args, { cwd, maxOutput = 80_000 } = {}) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout = appendWithCap(stdout, chunk.toString(), maxOutput); });
  child.stderr.on('data', chunk => { stderr = appendWithCap(stderr, chunk.toString(), maxOutput); });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code: code ?? -1, stdout, stderr };
}

async function cleanupWorktree(branch, worktree) {
  await git(['worktree', 'remove', '--force', worktree], ROOT);
  await git(['branch', '-D', branch], ROOT);
}

async function git(args, cwd) {
  const result = await captureCommand('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function loadTasks() {
  const entries = await fs.readdir(TASKS_DIR);
  const tasks = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(TASKS_DIR, entry), 'utf8');
    tasks.push(JSON.parse(raw));
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

function pickTask(tasks, id) {
  if (!id) return null;
  return tasks.find(task => task.id === id) ?? null;
}

function parseArgs(argv) {
  const args = {
    task: null,
    models: [],
    judge: null,
    baseline: 'HEAD',
    timeoutSec: null,
    keep: false,
    list: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--task') args.task = argv[++i];
    else if (arg === '--model') args.models.push(argv[++i]);
    else if (arg === '--judge') args.judge = argv[++i];
    else if (arg === '--baseline') args.baseline = argv[++i];
    else if (arg === '--timeout') args.timeoutSec = Number(argv[++i]);
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--list') args.list = true;
    else throw new Error(`Unknown arg: ${arg}`);
  }

  return args;
}

async function getDefaultJudgeCapableModel() {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  if (!res.ok) throw new Error(`Failed to load models: ${res.status}`);
  const body = await res.json();
  const names = (body.models ?? []).map(model => model.name);
  return names.find(name => name.includes('gemma4')) ?? names[0] ?? 'gemma4:latest';
}

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function parseJsonObject(text) {
  const stripped = String(text).replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {}
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function truncate(text, max) {
  const str = String(text ?? '');
  return str.length > max ? `${str.slice(0, max)}\n…[truncated]` : str;
}

function appendWithCap(current, chunk, max) {
  const next = current + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
