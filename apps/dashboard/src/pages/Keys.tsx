import { type FormEvent, useState } from 'react';
import * as api from '../api.ts';
import { fmtTime, useLoad } from '../ui.ts';

export function Keys() {
  const { data, error, reload } = useLoad(api.listKeys);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [secret, setSecret] = useState<string>();

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setActionError(undefined);
    try {
      const { secret: value } = await api.createKey(name);
      setSecret(value);
      setName('');
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string, label: string) {
    if (!confirm(`Revoke “${label}”? Calls using it stop working immediately.`)) return;
    setActionError(undefined);
    try {
      await api.revokeKey(id);
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <>
      <h1>API keys</h1>
      <p className="sub">Use a key to reach every tool you are allowed from an MCP client.</p>

      {error && <div className="alert">{error}</div>}
      {actionError && <div className="alert">{actionError}</div>}

      {secret && (
        <div className="notice">
          <strong>Copy this key now — it is not shown again</strong>
          <div className="mono">{secret}</div>
          <button className="link" style={{ paddingLeft: 0 }} onClick={() => setSecret(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      <form className="card row" onSubmit={create}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="keyName">Key name</label>
          <input
            id="keyName"
            required
            placeholder="Claude Code on my laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="primary" disabled={busy} style={{ alignSelf: 'end' }}>
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </form>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.keys.map((k) => (
              <tr key={k.id}>
                <td>
                  {k.name}
                  <div className="dim">created {fmtTime(k.createdAt)}</div>
                </td>
                <td className="mono">{k.prefix}…</td>
                <td className="dim">{k.lastUsedAt ? fmtTime(k.lastUsedAt) : 'never'}</td>
                <td>
                  {k.revokedAt ? (
                    <span className="badge disabled">revoked</span>
                  ) : (
                    <button className="danger" onClick={() => revoke(k.id, k.name)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data?.keys.length === 0 && (
              <tr>
                <td colSpan={4} className="dim">
                  No keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Connecting a client</h2>
      <div className="card">
        <table>
          <tbody>
            <tr>
              <th style={{ width: 120 }}>Endpoint</th>
              <td className="mono">{location.origin}/mcp</td>
            </tr>
            <tr>
              <th>Transport</th>
              <td>Streamable HTTP</td>
            </tr>
            <tr>
              <th>Header</th>
              <td className="mono">Authorization: Bearer &lt;your key&gt;</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
