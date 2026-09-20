import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

export function resolveDataDir(env = process.env) {
  return env.CLAUDETTE_DATA_DIR
    ? path.resolve(env.CLAUDETTE_DATA_DIR)
    : DEFAULT_DATA_DIR;
}

// The sandbox launcher sets CLAUDETTE_DATA_DIR before application modules load,
// so every persistent writer lands below the workspace root.
export const DATA_DIR = resolveDataDir();
