import { randomBytes } from 'node:crypto';

const CHANNEL = 'claudette-bash-broker';
const VERSION = 1;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_COMMAND_CHARS = 1_000_000;
const MAX_CWD_CHARS = 16_384;
const MAX_ID_CHARS = 128;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
}

function sameToken(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  // The capability has 256 bits of entropy and never enters an environment or
  // command line. A constant-time comparison is unnecessary for local IPC, but
  // this loop also avoids accidentally weakening the check to a prefix match.
  let mismatch = 0;
  for (let index = 0; index < expected.length; index++) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function safeSend(channel, message, onError = () => {}) {
  if (channel.connected === false || typeof channel.send !== 'function') {
    onError(new Error('Bash broker IPC channel is disconnected.'));
    return;
  }
  try {
    channel.send(message, error => {
      if (error) onError(error);
    });
  } catch (error) {
    onError(error);
  }
}

function setIpcReferenced(channel, referenced) {
  const ipcHandle = channel?.channel;
  if (referenced) ipcHandle?.ref?.();
  else ipcHandle?.unref?.();
}

/**
 * Attach the unsandboxed launcher-side half of the Bash broker to its direct
 * child. The caller supplies the only executor the protocol can reach; IPC
 * messages cannot select an executable, profile, environment, or workspace.
 */
export function attachBashBroker(child, {
  workspace,
  execute,
  authenticationToken = null,
  onAuthenticated = () => {},
  onAuthenticationFailure = () => {},
}) {
  if (!child || typeof child.on !== 'function' || typeof child.send !== 'function') {
    throw new Error('Bash broker requires a child process with a private IPC channel.');
  }
  if (typeof workspace !== 'string' || !workspace || typeof execute !== 'function') {
    throw new Error('Bash broker requires a fixed workspace and executor.');
  }

  const token = randomBytes(32).toString('base64url');
  const active = new Map();
  let closed = false;
  let authenticated = false;

  const rejectMessage = (id, message) => {
    safeSend(child, {
      channel: CHANNEL,
      version: VERSION,
      type: 'rejected',
      id: validId(id) ? id : null,
      error: message,
    });
  };

  const onMessage = message => {
    if (!isRecord(message) || message.channel !== CHANNEL) return;

    if (message.type === 'hello') {
      const helloKeys = authenticationToken
        ? ['channel', 'version', 'type', 'authenticationToken']
        : ['channel', 'version', 'type'];
      if (!hasExactKeys(message, helloKeys)
          || message.version !== VERSION
          || (authenticationToken && !sameToken(message.authenticationToken, authenticationToken))) {
        rejectMessage(null, 'Malformed Bash broker handshake.');
        onAuthenticationFailure();
        return;
      }
      authenticated = true;
      safeSend(child, { channel: CHANNEL, version: VERSION, type: 'ready', token });
      onAuthenticated();
      return;
    }

    if (message.type === 'request') {
      const keys = ['channel', 'version', 'type', 'token', 'id', 'command', 'cwd'];
      if (!hasExactKeys(message, keys)
          || message.version !== VERSION
          || !authenticated
          || !sameToken(message.token, token)
          || !validId(message.id)
          || typeof message.command !== 'string'
          || message.command.length === 0
          || message.command.length > MAX_COMMAND_CHARS
          || typeof message.cwd !== 'string'
          || message.cwd.length === 0
          || message.cwd.length > MAX_CWD_CHARS) {
        rejectMessage(message.id, 'Malformed or unauthorized Bash broker request.');
        return;
      }
      if (active.has(message.id)) {
        rejectMessage(message.id, 'Duplicate Bash broker request id.');
        return;
      }

      const controller = new AbortController();
      active.set(message.id, controller);
      let execution;
      try {
        execution = execute({
          command: message.command,
          cwd: message.cwd,
          workspace,
          signal: controller.signal,
        });
      } catch (error) {
        // An executor may fail before returning a promise. Keep the launcher
        // alive and report that failure through the same per-request path.
        execution = Promise.reject(error);
      }
      Promise.resolve(execution).then(result => String(result)).then(
        result => {
          if (active.get(message.id) !== controller) return;
          active.delete(message.id);
          safeSend(child, {
            channel: CHANNEL,
            version: VERSION,
            type: 'result',
            id: message.id,
            result,
          });
        },
        error => {
          if (active.get(message.id) !== controller) return;
          active.delete(message.id);
          safeSend(child, {
            channel: CHANNEL,
            version: VERSION,
            type: 'error',
            id: message.id,
            error: errorMessage(error, 'Bash broker command failed.'),
          });
        },
      );
      return;
    }

    if (message.type === 'cancel') {
      const keys = ['channel', 'version', 'type', 'token', 'id'];
      if (!hasExactKeys(message, keys)
          || message.version !== VERSION
          || !authenticated
          || !sameToken(message.token, token)
          || !validId(message.id)) {
        rejectMessage(message.id, 'Malformed or unauthorized Bash broker cancellation.');
        return;
      }
      active.get(message.id)?.abort();
      return;
    }

    rejectMessage(message.id, 'Unsupported Bash broker message.');
  };

  const close = () => {
    if (closed) return;
    closed = true;
    child.off('message', onMessage);
    child.off('disconnect', close);
    for (const controller of active.values()) controller.abort();
    active.clear();
  };

  child.on('message', onMessage);
  child.once('disconnect', close);
  return close;
}

/** Create the sandboxed main-process half. Exported for lifecycle tests. */
export function createBashBrokerClient(channel = process, { authenticationToken = null } = {}) {
  if (!channel || typeof channel.on !== 'function' || typeof channel.send !== 'function') {
    throw new Error('Bash broker is unavailable: the launcher IPC channel is missing.');
  }

  const pending = new Map();
  let token = null;
  let closedError = null;
  let requestSequence = 0;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The singleton always observes this promise through run(); suppress a
  // process-level unhandled rejection if the broker dies before the first call.
  ready.catch(() => {});

  const fail = error => {
    if (closedError) return;
    closedError = error instanceof Error ? error : new Error(String(error));
    rejectReady(closedError);
    for (const request of pending.values()) {
      request.cleanup();
      request.reject(closedError);
    }
    pending.clear();
    setIpcReferenced(channel, false);
  };

  const onMessage = message => {
    if (!isRecord(message) || message.channel !== CHANNEL || message.version !== VERSION) return;
    if (message.type === 'ready'
        && hasExactKeys(message, ['channel', 'version', 'type', 'token'])
        && typeof message.token === 'string'
        && message.token.length >= 32) {
      token = message.token;
      clearTimeout(handshakeTimer);
      resolveReady();
      if (pending.size === 0) setIpcReferenced(channel, false);
      return;
    }
    if (!validId(message.id)) return;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.type === 'result'
        && hasExactKeys(message, ['channel', 'version', 'type', 'id', 'result'])
        && typeof message.result === 'string') {
      pending.delete(message.id);
      request.cleanup();
      if (pending.size === 0) setIpcReferenced(channel, false);
      request.resolve(message.result);
    } else if ((message.type === 'error' || message.type === 'rejected')
        && hasExactKeys(message, ['channel', 'version', 'type', 'id', 'error'])
        && typeof message.error === 'string') {
      pending.delete(message.id);
      request.cleanup();
      if (pending.size === 0) setIpcReferenced(channel, false);
      request.reject(new Error(message.error));
    }
  };

  const onDisconnect = () => {
    fail(new Error('Bash broker disconnected before the command completed.'));
  };

  channel.on('message', onMessage);
  channel.once('disconnect', onDisconnect);
  const handshakeTimer = setTimeout(() => {
    fail(new Error('Bash broker handshake timed out.'));
  }, HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();
  const hello = { channel: CHANNEL, version: VERSION, type: 'hello' };
  if (authenticationToken) hello.authenticationToken = authenticationToken;
  safeSend(channel, hello, error => {
    fail(new Error(`Bash broker handshake failed: ${error.message}`));
  });

  return {
    ready() {
      return ready;
    },
    async run(command, cwd, signal) {
      if (closedError) throw closedError;
      if (signal?.aborted) throw new Error('Command interrupted by the user before it started.');

      let abortReady;
      const abortedWhileConnecting = new Promise((_, reject) => {
        abortReady = () => reject(new Error('Command interrupted by the user before it started.'));
        signal?.addEventListener('abort', abortReady, { once: true });
      });
      try {
        await (signal ? Promise.race([ready, abortedWhileConnecting]) : ready);
      } finally {
        signal?.removeEventListener('abort', abortReady);
      }
      if (closedError) throw closedError;
      if (signal?.aborted) throw new Error('Command interrupted by the user before it started.');

      const id = `${process.pid}-${++requestSequence}`;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.cleanup();
          if (pending.size === 0) setIpcReferenced(channel, false);
          safeSend(channel, { channel: CHANNEL, version: VERSION, type: 'cancel', token, id });
          reject(new Error('Command interrupted by the user before it finished.'));
        };
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        setIpcReferenced(channel, true);
        pending.set(id, { resolve, reject, cleanup });
        signal?.addEventListener('abort', onAbort, { once: true });
        safeSend(channel, {
          channel: CHANNEL,
          version: VERSION,
          type: 'request',
          token,
          id,
          command,
          cwd,
        }, error => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.cleanup();
          if (pending.size === 0) setIpcReferenced(channel, false);
          reject(new Error(`Bash broker request failed: ${error.message}`));
        });
      });
    },
    close() {
      const activeIds = [...pending.keys()];
      clearTimeout(handshakeTimer);
      channel.off('message', onMessage);
      channel.off('disconnect', onDisconnect);
      fail(new Error('Bash broker client closed.'));
      // Closing this client must not leave its commands running in the launcher.
      // Keep the shared IPC channel open; only cancel requests owned here.
      for (const id of activeIds) {
        safeSend(channel, { channel: CHANNEL, version: VERSION, type: 'cancel', token, id });
      }
      setIpcReferenced(channel, false);
    },
  };
}

let processClient = null;

export function bashBrokerRequired(env = process.env) {
  return env.CLAUDETTE_BASH_BROKER === '1';
}

export function requestBrokeredBash(command, cwd, signal) {
  if (!bashBrokerRequired()) throw new Error('Bash broker was not requested for this process.');
  if (!processClient) throw new Error('Bash broker is unavailable: the authenticated launcher connection is closed.');
  return processClient.run(command, cwd, signal);
}

/** Authenticate the direct launcher channel before any model Bash can run. */
export async function initializeProcessBashBroker(env = process.env) {
  if (!bashBrokerRequired(env)) return null;
  if (processClient) return processClient;
  if (!process.connected || typeof process.send !== 'function') {
    throw new Error('Bash broker is unavailable: the direct launcher IPC channel is missing.');
  }
  const client = createBashBrokerClient(process);
  try {
    await client.ready();
  } catch (error) {
    client.close();
    throw error;
  }
  processClient = client;
  return client;
}
