import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import * as api from '../api.ts';

type Item =
  | { kind: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; result?: { isError: boolean; text: string; durationMs: number } };

export function Chat() {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const abort = useRef<AbortController>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;

    // The agent only takes the conversation; tool items are display-only.
    const history = [...items, { kind: 'user' as const, text }]
      .filter((i): i is { kind: 'user' | 'assistant'; text: string } => i.kind !== 'tool')
      .map((i) => ({ role: i.kind, content: i.text }));

    setItems((prev) => [...prev, { kind: 'user', text }]);
    setInput('');
    setError(undefined);
    setStreaming(true);
    const controller = new AbortController();
    abort.current = controller;

    try {
      for await (const event of api.chat(history, controller.signal)) {
        if (event.type === 'error') {
          setError(event.message);
          continue;
        }
        setItems((prev) => {
          switch (event.type) {
            case 'message':
              return [...prev, { kind: 'assistant', text: event.text }];
            case 'tool_call':
              return [...prev, { kind: 'tool', id: event.id, name: event.name, args: event.args }];
            case 'tool_result':
              return prev.map((i) =>
                i.kind === 'tool' && i.id === event.id
                  ? { ...i, result: { isError: event.isError, text: event.text, durationMs: event.durationMs } }
                  : i,
              );
          }
        });
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setStreaming(false);
      abort.current = null;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="chat">
      <h1>Chat</h1>
      <p className="sub">The agent uses the same tools, permissions and audit log as the MCP endpoint.</p>

      <div className="log">
        {items.length === 0 && (
          <p className="dim">Ask about products or orders, for example “what orders came in today?”.</p>
        )}
        {items.map((item, i) =>
          item.kind === 'tool' ? (
            <div key={item.id} className={`tool ${item.result?.isError ? 'isError' : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono">{item.name}</span>
                <span className="dim">
                  {item.result ? `${item.result.isError ? 'error' : 'ok'} · ${item.result.durationMs} ms` : 'running…'}
                </span>
              </div>
              <pre>{JSON.stringify(item.args, null, 2)}</pre>
              {item.result && <pre>{item.result.text}</pre>}
            </div>
          ) : (
            <div key={i} className={`msg ${item.kind}`}>
              {item.text}
            </div>
          ),
        )}
        {error && <div className="alert">{error}</div>}
        <div ref={logEnd} />
      </div>

      <div className="composer">
        <textarea
          rows={1}
          placeholder="Ask something…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button onClick={() => abort.current?.abort()}>Stop</button>
        ) : (
          <button className="primary" onClick={send} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
