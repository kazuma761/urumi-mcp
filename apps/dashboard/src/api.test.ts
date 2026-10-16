import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chat } from './api.ts';
import type { ChatEvent } from './types.ts';

/** Serves `chunks` as the response body, so line splits land mid-JSON. */
function stubFetch(chunks: string[], ok = true) {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(c) {
            for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
            c.close();
          },
        }),
        { status: ok ? 200 : 500 },
      ),
    )) as typeof fetch;
}

const drain = async () => {
  const out: ChatEvent[] = [];
  for await (const e of chat([], new AbortController().signal)) out.push(e);
  return out;
};

test('reassembles events split across chunks', async () => {
  const line = JSON.stringify({ type: 'message', text: 'hello world' });
  stubFetch([line.slice(0, 9), line.slice(9) + '\n']);
  assert.deepEqual(await drain(), [{ type: 'message', text: 'hello world' }]);
});

test('yields several events and a last line without a newline', async () => {
  stubFetch([
    '{"type":"tool_call","id":"1","name":"woo__list_orders","args":{}}\n{"type":"too',
    'l_result","id":"1","isError":false,"text":"[]","durationMs":12}\n',
    '{"type":"message","text":"none today"}',
  ]);
  const events = await drain();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.type), ['tool_call', 'tool_result', 'message']);
  assert.equal(events[2]!.type === 'message' && events[2].text, 'none today');
});

test('blank lines are skipped', async () => {
  stubFetch(['\n\n{"type":"message","text":"ok"}\n\n']);
  assert.deepEqual(await drain(), [{ type: 'message', text: 'ok' }]);
});

test('a failed response throws the server message', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ error: 'chat is disabled' }), { status: 503 }))) as typeof fetch;
  await assert.rejects(drain(), /chat is disabled/);
});
