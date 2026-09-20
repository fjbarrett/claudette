import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readSSEData } from '../src/streaming.js';
import { chatStream as ollama } from '../src/ollama.js';
import { chatStream as anthropic } from '../src/anthropic.js';
import { chatCompletionsStream as openai } from '../src/openai.js';

const providers = { ollama, anthropic, openai };
const texts = ['Hello world', '日本語 🧪 café', 'e\u0301 👩🏽‍💻', 'line one\nline two\tend', '"\\$`<&>', ' x '.repeat(1024)];

function eventsFor(provider, text) {
  if (provider === 'ollama') return [
    { message: { content: text } },
    { done: true, prompt_eval_count: 17, eval_count: 23 },
  ];
  if (provider === 'anthropic') return [
    { type: 'message_start', message: { usage: { input_tokens: 17 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_delta', usage: { output_tokens: 23 } },
    { type: 'message_stop' },
  ];
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [], usage: { prompt_tokens: 17, completion_tokens: 23 } },
    '[DONE]',
  ];
}

function encodeEvents(provider, events, { newline = '\n', multiline = false, finalNewline = true } = {}) {
  if (provider === 'ollama') return events.map(e => JSON.stringify(e)).join(newline) + (finalNewline ? newline : '');
  return '\uFEFF: heartbeat' + newline + newline + events.map(event => {
    const data = typeof event === 'string' ? event : JSON.stringify(event, null, multiline ? 2 : undefined);
    return data.split('\n').map(line => `data: ${line}`).join(newline) + newline + newline;
  }).join('');
}

// Exact byte boundaries cannot be guaranteed by TCP writes: fetch may coalesce
// them. A real Web ReadableStream makes UTF-8 and CRLF split cases reproducible.
function responseFor(wire, { chunkSize = 1, seed = 1, holdOpen = false, cancelError = null, readError = null } = {}) {
  const bytes = Buffer.from(wire);
  let offset = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        if (readError) controller.error(readError);
        else if (!holdOpen) controller.close();
        return;
      }
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const count = chunkSize === 'random' ? 1 + seed % 37 : chunkSize;
      const end = Math.min(bytes.length, offset + count);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() { cancelled = true; if (cancelError) throw cancelError; },
  });
  return { response: new Response(body), body, cancelled: () => cancelled };
}

async function withAdapter(t, provider, wire, options = {}) {
  const fixture = responseFor(wire, options);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => fixture.response);
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'stream-test-placeholder';
  const deltas = [];
  try {
    const result = await providers[provider]({
      model: 'fixture', baseUrl: 'http://127.0.0.1:1', apiKey: 'stream-test-placeholder',
      messages: [{ role: 'user', content: 'fixture' }],
      signal: options.signal,
      onDelta: options.onDelta ?? (delta => deltas.push(delta)),
    });
    return { result, deltas, ...fixture };
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
    options.onFinally?.(fixture);
  }
}

test('stream transports preserve text and usage across seeded byte and newline boundaries', async t => {
  let cases = 0;
  for (const provider of Object.keys(providers)) {
    for (const text of texts) {
      const frames = provider === 'ollama'
        ? [{ newline: '\n' }, { newline: '\r\n' }, { finalNewline: false }]
        : ['\n', '\r\n', '\r'].flatMap(newline => [false, true].map(multiline => ({ newline, multiline })));
      for (const frame of frames) {
        for (const chunkSize of [1, 2, 3, 7, 64, 'random']) {
          const label = JSON.stringify({ provider, text: text.slice(0, 24), frame, chunkSize });
          const { result, deltas, body } = await withAdapter(t, provider, encodeEvents(provider, eventsFor(provider, text), frame), { chunkSize, seed: cases + 1 });
          assert.equal(result.content, text.trim(), label);
          assert.equal(deltas.join(''), text, label);
          assert.equal(result.promptTokens, 17, label);
          assert.equal(result.completionTokens, 23, label);
          assert.equal(body.locked, false, `reader released: ${label}`);
          cases++;
        }
      }
    }
  }
  t.diagnostic(`${cases} deterministic transport scenarios`);
});

for (const provider of Object.keys(providers)) {
  test(`${provider}: streamed errors reject after partial text and release the reader`, async t => {
    const events = eventsFor(provider, 'partial').slice(provider === 'anthropic' ? 1 : 0, provider === 'anthropic' ? 2 : 1);
    events.push(provider === 'ollama' ? { error: 'fixture overloaded' } : { type: 'error', error: { message: 'fixture overloaded', type: 'overloaded_error' } });
    const seen = [];
    await assert.rejects(withAdapter(t, provider, encodeEvents(provider, events), {
      holdOpen: true, chunkSize: 7, onDelta: delta => seen.push(delta),
      onFinally: ({ body, cancelled }) => {
        assert.equal(body.locked, false);
        assert.equal(cancelled(), true);
      },
    }), /fixture overloaded/);
    assert.deepEqual(seen, ['partial']);
  });

  test(`${provider}: a consumer exception cancels the body and remains the reported error`, async t => {
    const expected = new Error('consumer fixture failed');
    await assert.rejects(withAdapter(t, provider, encodeEvents(provider, eventsFor(provider, 'hello')), {
      holdOpen: true, onDelta() { throw expected; },
      onFinally: ({ body, cancelled }) => {
        assert.equal(body.locked, false);
        assert.equal(cancelled(), true);
      },
    }), error => error === expected);
  });

  test(`${provider}: the terminal event completes without waiting for the socket to close`, { timeout: 1000 }, async t => {
    const { result, body, cancelled } = await withAdapter(t, provider, encodeEvents(provider, eventsFor(provider, 'done')), { holdOpen: true });
    assert.equal(result.content, 'done');
    assert.equal(body.locked, false);
    assert.equal(cancelled(), true);
  });

  test(`${provider}: malformed or non-object records fail instead of reporting success`, async t => {
    for (const invalid of ['{"broken":', 'null', 'false', '[]', '"text"']) {
      const wire = provider === 'ollama' ? invalid + '\n' : `data: ${invalid}\n\n`;
      await assert.rejects(withAdapter(t, provider, wire), /invalid JSON|expected an object/);
    }
  });

  test(`${provider}: a response ending before completion rejects instead of returning partial success`, async t => {
    const events = eventsFor(provider, 'partial');
    events.pop();
    for (const wire of ['', encodeEvents(provider, events)]) {
      await assert.rejects(withAdapter(t, provider, wire), /ended before|incomplete|truncated/);
    }
  });

  test(`${provider}: aborting a delta suppresses later events already in the same byte chunk`, async t => {
    const controller = new AbortController();
    const events = eventsFor(provider, 'first');
    const textEvent = events[provider === 'anthropic' ? 1 : 0];
    events.splice(provider === 'anthropic' ? 2 : 1, 0, textEvent);
    const deltas = [];
    await assert.rejects(withAdapter(t, provider, encodeEvents(provider, events), {
      chunkSize: 65536, signal: controller.signal,
      onDelta(delta) { deltas.push(delta); controller.abort(); },
    }), error => error.name === 'AbortError');
    assert.deepEqual(deltas, ['first']);
  });

  test(`${provider}: cleanup failures cannot replace the consumer's original exception`, async t => {
    const expected = new Error('consumer failed first');
    await assert.rejects(withAdapter(t, provider, encodeEvents(provider, eventsFor(provider, 'hello')), {
      holdOpen: true, cancelError: new Error('cleanup failed later'), onDelta() { throw expected; },
      onFinally: ({ body }) => assert.equal(body.locked, false),
    }), error => error === expected);
  });

  test(`${provider}: a broken response body preserves its error and releases the reader`, async t => {
    const expected = new Error('socket fixture reset');
    const events = eventsFor(provider, 'partial');
    events.pop();
    await assert.rejects(withAdapter(t, provider, encodeEvents(provider, events), {
      readError: expected,
      onFinally: ({ body }) => assert.equal(body.locked, false),
    }), error => error === expected);
  });
}

test('seeded stream fuzz preserves randomized content and framing', async t => {
  const initialSeed = Number(process.env.CLAUDETTE_STRESS_SEED ?? 20260905);
  const cases = Number(process.env.CLAUDETTE_STRESS_CASES ?? 300);
  assert.ok(Number.isSafeInteger(initialSeed) && initialSeed >= 0 && initialSeed <= 0xffffffff, 'seed must be a uint32');
  assert.ok(Number.isSafeInteger(cases) && cases > 0 && cases <= 100000, 'cases must be between 1 and 100000');
  let state = initialSeed;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 0x100000000 * n); };
  const alphabet = ['a', 'Z', ' ', '\n', '\r', '\t', '日', '🧪', 'e\u0301', '👩🏽‍💻', '"', '\\', '\0', '<', '&', '☕'];
  for (let i = 0; i < cases; i++) {
    const provider = Object.keys(providers)[random(3)];
    const text = Array.from({ length: 1 + random(500) }, () => alphabet[random(alphabet.length)]).join('');
    const frame = {
      newline: (provider === 'ollama' ? ['\n', '\r\n'] : ['\n', '\r\n', '\r'])[random(provider === 'ollama' ? 2 : 3)],
      multiline: random(2) === 0,
      finalNewline: random(2) === 0,
    };
    const byteSeed = state;
    const { result, deltas } = await withAdapter(t, provider, encodeEvents(provider, eventsFor(provider, text), frame), { chunkSize: 'random', seed: byteSeed });
    const label = `seed=${initialSeed}, case=${i}, provider=${provider}, byteSeed=${byteSeed}`;
    assert.equal(result.content, text.trim(), label);
    assert.equal(deltas.join(''), text, label);
    assert.equal(result.promptTokens, 17, label);
    assert.equal(result.completionTokens, 23, label);
  }
  t.diagnostic(`seed=${initialSeed}: ${cases} generated cases`);
});

test('OpenAI-compatible finish_reason allows EOF while retaining later usage', async t => {
  const events = [
    { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 17, completion_tokens: 23 } },
  ];
  const { result } = await withAdapter(t, 'openai', encodeEvents('openai', events));
  assert.equal(result.content, 'done');
  assert.equal(result.promptTokens, 17);
  assert.equal(result.completionTokens, 23);
});

test('large responses preserve every byte across all provider formats', async t => {
  const text = '日本語 🧪 café "quote"\\slash\n'.repeat(32768);
  for (const provider of Object.keys(providers)) {
    const { result, deltas } = await withAdapter(t, provider, encodeEvents(provider, eventsFor(provider, text)), { chunkSize: 4093 });
    assert.equal(result.content, text.trim(), provider);
    assert.equal(deltas.join(''), text, provider);
  }
});

test('96 simultaneous requests keep their text, usage and reader state independent', async t => {
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'stream-test-placeholder';
  const fixtures = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { model } = JSON.parse(options.body);
    const provider = model.split('-')[0];
    const fixture = responseFor(encodeEvents(provider, eventsFor(provider, model + ' 日本語 🧪')), { chunkSize: 'random', seed: Number(model.split('-')[1]) + 1 });
    fixtures.push(fixture);
    return fixture.response;
  });
  try {
    const requests = Array.from({ length: 96 }, async (_, index) => {
      const provider = Object.keys(providers)[index % 3];
      const model = `${provider}-${index}`;
      const deltas = [];
      const result = await providers[provider]({
        model, baseUrl: 'http://127.0.0.1:1', apiKey: 'stream-test-placeholder', messages: [],
        onDelta: text => deltas.push(text),
      });
      assert.equal(result.content, model + ' 日本語 🧪');
      assert.equal(deltas.join(''), result.content);
      assert.equal(result.promptTokens, 17);
      assert.equal(result.completionTokens, 23);
    });
    await Promise.all(requests);
    assert.equal(fixtures.length, 96);
    assert.ok(fixtures.every(f => !f.body.locked));
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
  }
});

test('SSE only dispatches complete events and preserves data field semantics', async () => {
  const fixtures = [
    ['data: one\ndata: two\n\n', ['one\ntwo']],
    ['data: one\n', []],
    ['data: one', []],
    ['data\n\n', ['']],
    ['data:  space\n\n', [' space']],
    [' Data: wrong\ndatax: wrong\nevent: ignored\n: comment\n\n', []],
    ['data: first\n\ndata: incomplete\n', ['first']],
    ['data: first\r\n\r\ndata: second\r\r', ['first', 'second']],
  ];
  for (const [wire, expected] of fixtures) {
    for (const chunkSize of [1, 2, 3, 8, 4096]) {
      const { body } = responseFor(wire, { chunkSize });
      const actual = [];
      for await (const data of readSSEData(body)) actual.push(data);
      assert.deepEqual(actual, expected, `${JSON.stringify(wire)}, chunk=${chunkSize}`);
      assert.equal(body.locked, false);
    }
  }
});

test('stream transports assemble multiple interleaved tool calls with fragmented Unicode JSON', async t => {
  const args = [{ path: '日本語/a 🧪.js', text: 'line\n"quote"\\slash' }, { count: 0, empty: '', yes: true, value: null }];
  const expected = args.map((arguments_, i) => ({ id: `call_${i}`, function: { name: `tool_${i}`, arguments: arguments_ } }));
  for (const provider of Object.keys(providers)) {
    const events = [];
    if (provider === 'ollama') {
      for (const call of expected) events.push({ message: { tool_calls: [call] } });
      events.push({ done: true });
    } else {
      for (let i = 0; i < args.length; i++) {
        events.push(provider === 'anthropic'
          ? { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `call_${i}`, name: `tool_${i}`, input: {} } }
          : { choices: [{ delta: { tool_calls: [{ index: i, id: `call_${i}`, function: { name: `tool_${i}`, arguments: '' } }] } }] });
      }
      const json = args.map(value => JSON.stringify(value));
      for (let offset = 0; offset < Math.max(...json.map(s => s.length)); offset++) {
        for (let i = 0; i < json.length; i++) {
          if (offset >= json[i].length) continue;
          events.push(provider === 'anthropic'
            ? { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json[i][offset] } }
            : { choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: json[i][offset] } }] } }] });
        }
      }
      events.push(provider === 'anthropic' ? { type: 'message_stop' } : '[DONE]');
    }
    for (const chunkSize of [1, 2, 7, 'random', 65536]) {
      const { result } = await withAdapter(t, provider, encodeEvents(provider, events), { chunkSize });
      assert.deepEqual(result.toolCalls, expected, `${provider}/${chunkSize}`);
      assert.equal(result.hadApiToolCalls, true);
    }
  }
});

test('real HTTP streams cancel before headers or after the first Unicode delta', { timeout: 15000 }, async () => {
  const previous = Object.fromEntries(['OLLAMA_BASE_URL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'].map(key => [key, process.env[key]]));
  let activeProvider;
  const server = http.createServer((req, res) => {
    req.resume();
    const events = eventsFor(activeProvider, 'partial 日本語 🧪');
    if (activeProvider === 'anthropic') events.shift();
    res.writeHead(200, { 'Content-Type': activeProvider === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' });
    res.write(encodeEvents(activeProvider, events.slice(0, 1)));
    // Deliberately keep the socket open. The client's abort must finish it.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.OLLAMA_BASE_URL = baseUrl;
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  process.env.ANTHROPIC_API_KEY = 'stream-test-placeholder';
  try {
    const { chatStream: localOllama } = await import(`../src/ollama.js?cancel=${server.address().port}`);
    for (const [provider, adapter] of Object.entries({ ...providers, ollama: localOllama })) {
      activeProvider = provider;
      for (const when of ['before', 'delta']) {
        const controller = new AbortController();
        if (when === 'before') controller.abort();
        const deltas = [];
        await assert.rejects(adapter({
          model: 'fixture', baseUrl, apiKey: 'stream-test-placeholder', messages: [], signal: controller.signal,
          onDelta(delta) { deltas.push(delta); controller.abort(); },
        }), error => error.name === 'AbortError');
        assert.deepEqual(deltas, when === 'before' ? [] : ['partial 日本語 🧪'], `${provider}/${when}`);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
