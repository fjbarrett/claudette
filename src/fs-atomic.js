import fs from 'node:fs';
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
  await ensurePrivateDirectory(path.dirname(file));
  // Do not append to the target basename: an otherwise legal long filename can
  // exceed NAME_MAX once the uniqueness suffix is added.
  const tmp = path.join(path.dirname(file), `.claudette-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    const options = typeof encoding === 'string'
      ? { encoding, mode: 0o600 }
      : { ...encoding, mode: 0o600 };
    await fsp.writeFile(tmp, data, options);
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, file);
    await fsp.chmod(file, 0o600);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function ensurePrivateDirectory(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
}

export function ensurePrivateDirectorySync(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function appendPrivateFileSync(file, data, encoding = 'utf8') {
  ensurePrivateDirectorySync(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, data, { encoding });
  } finally {
    fs.closeSync(fd);
  }
}
