// Provider-call resilience: error shaping, retry policy, and stall detection.
//
// Before this, a single 429 or a transient 502 killed the whole turn — at
// iteration 80 of a long agent run that threw away every edit's worth of
// accumulated context, and the usage logs are full of turns that died with
// tools=0 for no reason the user could act on. A hung provider was worse: with
// no timeout anywhere, `fetch` waited forever and the CLI just sat there.
//
// Kept free of provider imports so the adapters (which provider.js imports) can
// use the error shaping without a cycle.

// HTTP statuses worth another attempt. 4xx is generally the caller's fault and
// retrying just burns latency, with these exceptions: 408/409/425 are explicitly
// transient, and 429 is the one we most want to survive.
export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// Transport-level failures. Node surfaces most as a generic "fetch failed" with
// the real reason on `cause.code`.
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_SOCKET',
]);

/**
 * Build the Error an adapter throws for a non-OK HTTP response, carrying the
 * status and any Retry-After hint so the retry policy can act on facts instead
 * of pattern-matching the message text.
 */
export function providerHttpError(label, res, text = '') {
  const err = new Error(`${label} chat (${res.status}): ${text}`);
  err.status = res.status;
  const after = retryAfterMs(res.headers);
  if (after != null) err.retryAfterMs = after;
  return err;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Should this error be retried? Deliberately conservative: a bad model slug, a
 * missing key, or a malformed request must fail loudly on the first attempt
 * rather than three times slower. User cancellation is never retried.
 */
export function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  if (err.stall) return true; // our own stall abort — the provider went quiet
  if (typeof err.status === 'number') return RETRYABLE_STATUS.has(err.status);

  const code = err.cause?.code ?? err.code;
  if (code && RETRYABLE_CODES.has(code)) return true;

  const msg = String(err.message ?? '').toLowerCase();
  // Adapters that predate `err.status`, plus undici's opaque wrapper.
  if (/\b(408|409|425|429|500|502|503|504)\b/.test(msg) && /chat \(/.test(msg)) return true;
  return /fetch failed|socket hang up|network|timed? ?out|temporarily unavailable|overloaded/.test(msg);
}

export function resolveMaxRetries(env = process.env) {
  const n = Number(env.CLAUDETTE_MAX_RETRIES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2; // 3 attempts total
}

// Silence tolerated between stream events before we give up on a request. Not a
// total-duration cap: a legitimate long generation keeps resetting it, so only a
// genuinely dead connection trips it. 0 disables.
export function resolveStallTimeout(env = process.env) {
  const n = Number(env.CLAUDETTE_STALL_TIMEOUT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300_000;
}

/**
 * Is this "the server is not answering the socket" rather than "the server
 * answered with an error"? The two need very different waits: a 429 clears in
 * milliseconds, a process that has gone away needs seconds to come back.
 */
export function isConnectionFailure(err) {
  if (typeof err?.status === 'number') return false; // it answered, just not OK
  const code = err?.cause?.code ?? err?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return /fetch failed|socket hang up|econnrefused|econnreset/i.test(String(err?.message ?? ''));
}

/**
 * Exponential backoff with half jitter, floored by any server Retry-After hint.
 * Jitter matters with parallel calls: without it, N callers that hit the same
 * 429 all wake at the same instant and trigger the next one. It is *half*
 * jitter, not full, because full jitter draws from [0, exponential] and can
 * return ~0 — three attempts inside 800ms, which is not a retry policy.
 *
 * Connection failures start from a much larger base. Measured cause: Ollama
 * auto-updated itself mid-run, SIGTERMed the server, and took 8.4s to come back
 * — an eternity next to the old 500ms base, so the run died with the whole
 * eval case's context thrown away. Local model servers restart; cloud
 * endpoints refuse connections during a deploy. Waiting is cheap, re-running is not.
 */
export function backoffMs(attempt, err, { base, cap = 30_000, random = Math.random } = {}) {
  const start = base ?? (isConnectionFailure(err) ? 3_000 : 500);
  const exponential = Math.min(cap, start * 2 ** attempt);
  const jittered = Math.round(exponential / 2 + random() * (exponential / 2));
  const hinted = Number(err?.retryAfterMs);
  return Number.isFinite(hinted) ? Math.max(hinted, jittered) : jittered;
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms);
  function done() { cleanup(); resolve(); }
  function onAbort() { cleanup(); reject(signal.reason ?? new Error('Aborted')); }
  function cleanup() {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

/**
 * Run `attempt(attemptNumber)` with bounded exponential backoff.
 *
 * `canRetry(err, attempt)` lets the caller veto — provider.js uses it to refuse
 * a retry once bytes have already been streamed to the user, since replaying
 * would duplicate the visible output.
 */
export async function withRetry(attempt, {
  maxRetries = resolveMaxRetries(),
  signal,
  onRetry,
  canRetry = () => true,
  sleep = defaultSleep,
  random = Math.random,
} = {}) {
  let lastErr;
  for (let i = 0; ; i++) {
    try {
      return await attempt(i);
    } catch (err) {
      lastErr = err;
      const exhausted = i >= maxRetries;
      if (exhausted || signal?.aborted || !isRetryable(err) || !canRetry(err, i)) throw err;
      const delay = backoffMs(i, err, { random });
      onRetry?.(err, i + 1, delay);
      await sleep(delay, signal);
    }
  }
  /* c8 ignore next */
  throw lastErr;
}

/**
 * Abort a request that goes silent. Returns a signal to hand the provider plus
 * a `touch()` to call on every stream event. A stall is surfaced as a plain
 * Error, never an AbortError — the agent loop reads AbortError as "the user
 * pressed Ctrl+C" and would record a real failure as a clean cancellation.
 */
export function createStallGuard({ timeoutMs = resolveStallTimeout(), signal, label = 'Provider' } = {}) {
  const controller = new AbortController();
  const signals = [controller.signal, ...(signal ? [signal] : [])];
  let timer = null;
  let stalled = false;

  const trip = () => {
    stalled = true;
    controller.abort(new Error('stalled'));
  };
  const touch = () => {
    if (!timeoutMs || stalled) return;
    clearTimeout(timer);
    timer = setTimeout(trip, timeoutMs);
    timer.unref?.(); // never hold the process open on our own watchdog
  };

  touch();

  return {
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    touch,
    done() { clearTimeout(timer); timer = null; },
    /** Translate our abort into an actionable error; pass anything else through. */
    rethrow(err) {
      if (!stalled) throw err;
      const seconds = Math.round(timeoutMs / 1000);
      const stallErr = new Error(
        `${label} sent nothing for ${seconds}s — giving up on this request. ` +
        `Raise CLAUDETTE_STALL_TIMEOUT (ms) if the model legitimately thinks for longer, or set it to 0 to wait indefinitely.`
      );
      stallErr.stall = true;
      throw stallErr;
    },
  };
}
