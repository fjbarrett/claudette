// Wire framing shared by the streaming providers. Keep decoded UTF-8 state
// across byte chunks, including a CRLF whose two bytes arrive separately.
export async function* readStreamLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let skipLF = false;
  let ended = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      ended = done;
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (skipLF) {
          skipLF = false;
          if (char === '\n') { start = i + 1; continue; }
        }
        if (char !== '\r' && char !== '\n') continue;
        pending += text.slice(start, i);
        const line = pending;
        pending = '';
        start = i + 1;
        skipLF = char === '\r';
        yield line;
      }
      pending += text.slice(start);
      if (done) break;
    }
    // NDJSON endpoints may omit a final newline. SSE still requires an empty
    // line to dispatch an event, handled separately below.
    if (pending) yield pending;
  } finally {
    try {
      if (!ended) await reader.cancel();
    } catch { /* cleanup must not replace a provider/consumer exception */ }
    reader.releaseLock();
  }
}

// SSE data can span multiple fields and uses LF, CRLF, or CR line endings.
// https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
export async function* readSSEData(stream) {
  let data = [];
  for await (const line of readStreamLines(stream)) {
    if (line === '') {
      if (data.length) yield data.join('\n');
      data = [];
    } else if (line === 'data') {
      data.push('');
    } else if (line.startsWith('data:')) {
      const value = line.slice(5);
      data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  // An event without its terminating empty line is incomplete, even at EOF.
}

export function parseStreamJSON(data, label) {
  let value;
  try { value = JSON.parse(data); } catch (cause) {
    throw new Error(`${label}: invalid JSON in streamed response`, { cause });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected an object in streamed response`);
  }
  if (value.error) {
    const message = typeof value.error === 'string'
      ? value.error : (value.error.message || value.error.type || 'unknown provider error');
    throw new Error(`${label} stream: ${message}`);
  }
  return value;
}
