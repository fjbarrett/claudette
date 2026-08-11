import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Write a file so a reader never sees a half-written one: write a uniquely named
 * temp file in the same directory, then rename over the target (atomic within a
 * filesystem). Without this, a crash or a kill mid-write leaves a truncated
 * session JSON that `JSON.parse` rejects — the session is then unloadable, and
 * `listSessions()` quietly drops it. Sessions are written after every tool
 * result during a turn, so the window is not theoretical.
 */
export async function writeFileAtomic(file, data, encoding = 'utf8') {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, data, encoding);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
