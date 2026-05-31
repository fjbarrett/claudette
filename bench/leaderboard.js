#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORTS_DIR = path.join(__dirname, 'runs', 'reports');
const OUTPUT_FILE = path.join(__dirname, 'LEADERBOARD.md');

async function main() {
  const args = new Set(process.argv.slice(2));
  const reports = await loadLatestReports();
  const markdown = renderMarkdown(reports);

  if (args.has('--write')) {
    await fs.writeFile(OUTPUT_FILE, markdown, 'utf8');
    console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_FILE)}`);
    return;
  }

  process.stdout.write(markdown);
}

async function loadLatestReports() {
  const entries = await fs.readdir(REPORTS_DIR);
  const latest = new Map();

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(REPORTS_DIR, entry);
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    const key = `${report.model}||${report.task.id}`;
    const stamp = report.completedAt ?? report.startedAt ?? entry;
    const prev = latest.get(key);
    if (!prev || stamp > prev.stamp) {
      latest.set(key, { stamp, report, entry });
    }
  }

  return [...latest.values()].map(item => ({
    file: item.entry,
    model: item.report.model,
    taskId: item.report.task.id,
    overall: Number(item.report.summary?.overallScore ?? 0),
    hard: Number(item.report.summary?.hardScore ?? 0),
    judge: item.report.summary?.judgeScore ?? null,
  }));
}

function renderMarkdown(reports) {
  const generatedAt = new Date().toISOString();
  const byModel = groupBy(reports, report => report.model);
  const modelRows = [...byModel.entries()]
    .map(([model, rows]) => summarizeModel(model, rows))
    .sort((a, b) => b.avgOverall - a.avgOverall || b.avgHard - a.avgHard || a.model.localeCompare(b.model));
  const taskIds = [...new Set(reports.map(report => report.taskId))].sort();

  const lines = [
    '# Benchmark Leaderboard',
    '',
    `Generated: ${generatedAt}`,
    '',
    'Latest result per `(model, task)` from `bench/runs/reports/*.json`.',
    '',
    '## Model Summary',
    '',
    '| Model | Tasks | Avg Overall | Avg Hard | >=9 | 6-8.9 | <6 |',
    '|-------|------:|------------:|---------:|----:|------:|---:|',
    ...modelRows.map(row => `| \`${row.model}\` | ${row.count} | ${fmt(row.avgOverall)} | ${fmt(row.avgHard)} | ${row.high} | ${row.mid} | ${row.low} |`),
    '',
    '## Latest Scores By Task',
    '',
    '| Task | ' + modelRows.map(row => `\`${row.model}\``).join(' | ') + ' |',
    '|------|' + modelRows.map(() => '---:').join('|') + '|',
    ...taskIds.map(taskId => renderTaskRow(taskId, modelRows, byModel)),
    '',
    '## Coverage Notes',
    '',
    ...modelRows.map(row => `- \`${row.model}\`: ${row.count} tasks covered; latest low-score tasks: ${row.lowTasks.join(', ') || 'none'}.`),
    '',
    '## Source Reports',
    '',
    '| Model | Task | Overall | Hard | Judge | Report |',
    '|-------|------|--------:|-----:|------:|--------|',
    ...reports
      .sort((a, b) => a.model.localeCompare(b.model) || a.taskId.localeCompare(b.taskId))
      .map(report => `| \`${report.model}\` | \`${report.taskId}\` | ${fmt(report.overall)} | ${fmt(report.hard)} | ${report.judge ?? 'n/a'} | \`${report.file}\` |`),
    '',
  ];

  return lines.join('\n');
}

function summarizeModel(model, rows) {
  const avgOverall = average(rows.map(row => row.overall));
  const avgHard = average(rows.map(row => row.hard));
  const high = rows.filter(row => row.overall >= 9).length;
  const mid = rows.filter(row => row.overall >= 6 && row.overall < 9).length;
  const lowRows = rows
    .filter(row => row.overall < 6)
    .sort((a, b) => a.overall - b.overall || a.taskId.localeCompare(b.taskId))
    .slice(0, 3);

  return {
    model,
    count: rows.length,
    avgOverall,
    avgHard,
    high,
    mid,
    low: rows.length - high - mid,
    lowTasks: lowRows.map(row => `${row.taskId} (${fmt(row.overall)})`),
  };
}

function renderTaskRow(taskId, modelRows, byModel) {
  const cells = modelRows.map(modelRow => {
    const row = byModel.get(modelRow.model)?.find(item => item.taskId === taskId);
    return row ? fmt(row.overall) : '';
  });
  return `| \`${taskId}\` | ${cells.join(' | ')} |`;
}

function groupBy(items, selector) {
  const grouped = new Map();
  for (const item of items) {
    const key = selector(item);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fmt(value) {
  return Number(value).toFixed(1);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
