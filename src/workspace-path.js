import fsp from 'node:fs/promises';
import path from 'node:path';

export function isWithinPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function realpathOrSelf(target) {
  try {
    return await fsp.realpath(target);
  } catch {
    return target;
  }
}

// Resolve the deepest existing ancestor, then append the not-yet-created tail.
// This makes writes to new files subject to the same symlink boundary as reads.
export async function resolveDeepest(target) {
  const missing = [];
  let current = target;
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return missing.length ? path.join(real, ...[...missing].reverse()) : real;
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function guardWorkspacePath(filePath, cwd, workspace) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`Missing required 'path' argument (got: ${JSON.stringify(filePath)}). Pass a path relative to the workspace root, e.g. "src/index.js".`);
  }
  const abs = path.resolve(cwd, filePath);
  if (!isWithinPath(path.resolve(workspace), abs)) {
    throw new Error(`Path '${filePath}' is outside the workspace root. Use a path relative to the workspace (no leading '/' and no '..'); the workspace is the project you are working in.`);
  }

  const realRoot = await realpathOrSelf(workspace);
  const realAbs = await resolveDeepest(abs);
  if (!isWithinPath(realRoot, realAbs)) {
    throw new Error(`Path '${filePath}' is a symlink that resolves outside the workspace root (${realAbs}). Only files that genuinely live inside the workspace can be read or written.`);
  }
  return abs;
}
