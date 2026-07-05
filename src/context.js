import fsp from 'node:fs/promises';
import path from 'node:path';

// Project-instruction files loaded into context at each level, in priority
// order: a Claudette-specific CLAUDETTE.md augments/overrides CLAUDE.md.
const CONTEXT_FILES = ['CLAUDE.md', 'CLAUDETTE.md'];

/**
 * Walk up from cwd collecting CLAUDE.md / CLAUDETTE.md files (parent-first so
 * innermost wins). Returns combined content, or empty string if none found.
 */
export async function loadClaudeMd(cwd) {
  const parts = [];
  let dir = path.resolve(cwd);

  while (true) {
    const levelParts = [];
    for (const name of CONTEXT_FILES) {
      const candidate = path.join(dir, name);
      try {
        const content = await fsp.readFile(candidate, 'utf8');
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

/**
 * Collapse old tool-result content in the model payload so large outputs (file
 * reads, command dumps) aren't re-sent verbatim on every agent iteration — the
 * dominant driver of context-token blowup (real sessions hit 1M+ input tokens in
 * a single turn from ~30 accumulated file reads). The most recent `keep` tool
 * results stay full (the model is still acting on them); older large ones become
 * a short placeholder. Returns a new array; the stored history is never mutated,
 * so transcripts/debugging keep the full content.
 */
export function trimToolOutputs(messages, { keep = 6, minChars = 600 } = {}) {
  const toolPositions = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'tool') toolPositions.push(i);
  }
  if (toolPositions.length <= keep) return messages;

  const collapse = new Set(toolPositions.slice(0, toolPositions.length - keep));
  let changed = false;
  const out = messages.map((m, i) => {
    if (!collapse.has(i)) return m;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (content.length <= minChars) return m; // small results aren't worth collapsing
    changed = true;
    return { ...m, content: `[earlier tool output omitted to save context — ${content.length} chars; re-read the file or re-run the command if you need it again]` };
  });
  return changed ? out : messages;
}

/**
 * Replace @path tokens in text with file contents.
 * Returns { text, files: string[] }
 */
export async function expandFiles(text, cwd, workspace) {
  const files = [];
  let expanded = text;

  // Match @token not inside backticks (simple approach: just match word boundaries)
  for (const match of [...text.matchAll(/(^|\s)@([\S]+)/g)]) {
    const token = match[2];
    try {
      const abs = path.resolve(cwd, token);
      // Workspace boundary check
      const rel = path.relative(workspace, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

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
