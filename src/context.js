import fsp from 'node:fs/promises';
import path from 'node:path';
import { guardWorkspacePath } from './workspace-path.js';

// Project-instruction files loaded into context at each level, in priority
// order: a Claudette-specific CLAUDETTE.md augments/overrides CLAUDE.md.
const CONTEXT_FILES = ['CLAUDE.md', 'CLAUDETTE.md'];

/**
 * Walk up from cwd collecting CLAUDE.md / CLAUDETTE.md files (parent-first so
 * innermost wins). Returns combined content, or empty string if none found.
 */
const claudeMdCache = new Map(); // absolute instruction file -> { signature, content }

export async function loadClaudeMd(cwd) {
  const parts = [];
  let dir = path.resolve(cwd);

  while (true) {
    const levelParts = [];
    for (const name of CONTEXT_FILES) {
      const candidate = path.join(dir, name);
      try {
        const content = await readInstructionFile(candidate);
        const label = path.relative(cwd, candidate) || name;
        levelParts.push(`[${label}]\n${content.trim()}`);
      } catch { /* not found at this level */ }
    }
    // Prepend this level's files together (deeper, more specific levels stay
    // last in the final string), preserving CLAUDE.md → CLAUDETTE.md order.
    if (levelParts.length) parts.unshift(...levelParts);

    // Stop at git repository roots so we don't bleed into parent repos.
    const gitEntry = path.join(dir, '.git');
    try {
      await fsp.access(gitEntry);
      break; // .git exists here — this is a repo root, stop walking up
    } catch { /* no .git here, keep walking */ }

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return parts.join('\n\n---\n\n');
}

async function readInstructionFile(file) {
  try {
    // Validate every contributing file, including ancestors. inode/ctime also
    // detect atomic replacements and edits that preserve modification times.
    const stat = await fsp.stat(file, { bigint: true });
    const signature = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    const cached = claudeMdCache.get(file);
    if (cached?.signature === signature) return cached.content;
    const content = await fsp.readFile(file, 'utf8');
    claudeMdCache.set(file, { signature, content });
    if (claudeMdCache.size > 100) {
      const first = claudeMdCache.keys().next().value;
      claudeMdCache.delete(first);
    }
    return content;
  } catch (error) {
    // Missing and temporarily unreadable files must be retried on the next run.
    claudeMdCache.delete(file);
    throw error;
  }
}

export function invalidateClaudeMdCache() {
  // A parent file may contribute to many working directories. Clearing this
  // small file cache also honors callers that pass a cwd to invalidate.
  claudeMdCache.clear();
}

/**
 * Collapse old tool-result content in the model payload so large outputs (file
 * reads, command dumps) aren't re-sent verbatim on every agent iteration — the
 * dominant driver of context-token blowup (real sessions hit 1M+ input tokens in
 * a single turn from ~30 accumulated file reads). The most recent `keep` tool
 * results stay full (the model is still acting on them); older large ones become
 * a short placeholder. `maxTotalChars` additionally excerpts every result to a
 * shared character budget; this matters for providers whose Free-tier TPM limit
 * is smaller than their context window. Returns a new array; stored history is
 * never mutated, so transcripts/debugging keep the full content.
 */
export function trimToolOutputs(messages, { keep = 6, minChars = 600, maxTotalChars = Infinity } = {}) {
  const toolPositions = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'tool') toolPositions.push(i);
  }
  if (!toolPositions.length) return messages;

  const collapse = new Set(
    toolPositions.length > keep
      ? toolPositions.slice(0, toolPositions.length - keep)
      : [],
  );
  const replacements = new Map();
  const candidates = toolPositions.map((position) => {
    const m = messages[position];
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (!collapse.has(position) || content.length <= minChars) return content;
    const collapsed = `[earlier tool output omitted to save context — ${content.length} chars; re-read the file or re-run the command if you need it again]`;
    replacements.set(position, collapsed);
    return collapsed;
  });

  const totalBudget = Number.isFinite(maxTotalChars)
    ? Math.max(0, Math.floor(maxTotalChars))
    : Infinity;
  const totalChars = candidates.reduce((sum, content) => sum + content.length, 0);
  if (totalChars > totalBudget) {
    const budgets = allocateFairBudgets(candidates.map(content => content.length), totalBudget);
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].length <= budgets[i]) continue;
      replacements.set(toolPositions[i], excerptToolOutput(candidates[i], budgets[i]));
    }
  }

  if (!replacements.size) return messages;
  return messages.map((m, i) => replacements.has(i) ? { ...m, content: replacements.get(i) } : m);
}

/** Free hosted routes need bounded outbound tool results for efficient loops. */
export function resolveToolOutputTrimOptions(model, env = process.env) {
  if (typeof model !== 'string') return undefined;
  const isGroq = model.startsWith('groq/');
  const isOpenRouter = model.startsWith('openrouter/');
  if (!isGroq && !isOpenRouter) return undefined;
  const configured = Number(env[isGroq ? 'GROQ_TOOL_OUTPUT_CHARS' : 'OPENROUTER_TOOL_OUTPUT_CHARS']);
  const maxTotalChars = Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : (isGroq ? 8_000 : 12_000);
  return maxTotalChars === 0 ? undefined : { maxTotalChars };
}

function allocateFairBudgets(lengths, totalBudget) {
  const budgets = new Array(lengths.length).fill(0);
  let remaining = totalBudget;
  let pending = lengths.map((_, index) => index);

  while (pending.length) {
    const share = Math.floor(remaining / pending.length);
    const small = pending.filter(index => lengths[index] <= share);
    if (!small.length) {
      for (const index of pending) budgets[index] = share;
      break;
    }
    const settled = new Set(small);
    for (const index of small) {
      budgets[index] = lengths[index];
      remaining -= lengths[index];
    }
    pending = pending.filter(index => !settled.has(index));
  }

  return budgets;
}

function excerptToolOutput(content, maxChars) {
  if (content.length <= maxChars) return content;
  if (maxChars <= 0) return '';
  const marker = `\n[tool output excerpted from ${content.length} chars]\n`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  const available = maxChars - marker.length;
  const headChars = Math.ceil(available * 0.75);
  const tailChars = available - headChars;
  return `${content.slice(0, headChars)}${marker}${tailChars ? content.slice(-tailChars) : ''}`;
}

/**
 * Replace @path tokens in text with file contents.
 * Returns { text, files: string[] }
 */
export async function expandFiles(text, cwd, workspace) {
  const files = [];
  let expanded = text;

  for (const match of [...text.matchAll(/(^|\s)@([^\s,;:)\}\]]+)/g)]) {
    const token = match[2];
    try {
      const abs = await guardWorkspacePath(token, cwd, workspace);
      const rel = path.relative(workspace, abs);

      const content = await fsp.readFile(abs, 'utf8');
      const LIMIT = 50_000;
      const body = content.length > LIMIT
        ? content.slice(0, LIMIT) + '\n[truncated]'
        : content;

      files.push(rel || path.basename(abs));
      expanded = expanded.replace(
        `@${token}`,
        `\n\n[file: ${rel}]\n\`\`\`\n${body}\n\`\`\`\n`
      );
    } catch { /* file not found or not readable — leave @token as-is */ }
  }

  return { text: expanded, files };
}
