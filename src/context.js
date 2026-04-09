import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Walk up from cwd collecting CLAUDE.md files (parent-first so innermost wins).
 * Returns combined content, or empty string if none found.
 */
export async function loadClaudeMd(cwd) {
  const parts = [];
  let dir = path.resolve(cwd);

  while (true) {
    const candidate = path.join(dir, 'CLAUDE.md');
    try {
      const content = await fsp.readFile(candidate, 'utf8');
      const label = path.relative(cwd, candidate) || 'CLAUDE.md';
      parts.unshift(`[${label}]\n${content.trim()}`);
    } catch { /* not found at this level */ }

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return parts.join('\n\n---\n\n');
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
