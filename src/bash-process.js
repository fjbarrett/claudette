import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

// execFile does not forward `detached` to spawn. Foreground Bash needs an owned
// process group so its deadline/cancellation also stops ordinary descendants.
export function runBashProcess(launch, { cwd, signal, timeout }) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Command interrupted.'), { code: 'ABORT_ERR' }));
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      cwd, env: launch.env, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const streams = {
      stdout: { chunks: [], bytes: 0 },
      stderr: { chunks: [], bytes: 0 },
    };
    let failure;
    let finished = false;
    const stop = error => {
      if (finished || failure) return;
      failure = error;
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (killError) {
        if (killError.code !== 'ESRCH') failure = killError;
      }
    };
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', chunk => {
        if (failure) return;
        const capture = streams[name];
        const remaining = MAX_CAPTURE_BYTES - capture.bytes;
        if (remaining > 0) {
          const part = chunk.subarray(0, remaining);
          capture.chunks.push(part);
          capture.bytes += part.length;
        }
        if (chunk.length > remaining) {
          stop(Object.assign(new Error('Command output exceeded the capture limit.'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          }));
        }
      });
      child[name].on('error', stop);
    }
    const timer = setTimeout(() => stop(Object.assign(new Error('Command timed out.'), {
      code: 'BASH_TIMEOUT',
    })), timeout);
    const onAbort = () => stop(Object.assign(new Error('Command interrupted.'), { code: 'ABORT_ERR' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.once('error', error => { failure ??= error; });
    child.once('close', (code, terminalSignal) => {
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const output = Object.fromEntries(Object.entries(streams).map(([name, capture]) => [
        name, Buffer.concat(capture.chunks, capture.bytes).toString('utf8'),
      ]));
      if (failure || code !== 0 || terminalSignal) {
        const error = failure ?? Object.assign(new Error(
          terminalSignal ? `Command terminated by ${terminalSignal}.` : `Command exited with code ${code}.`,
        ), { code, signal: terminalSignal });
        Object.assign(error, output);
        reject(error);
      } else resolve(output);
    });
  });
}
