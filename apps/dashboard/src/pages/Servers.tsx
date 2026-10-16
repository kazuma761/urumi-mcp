import { type FormEvent, useEffect, useState } from 'react';
import * as api from '../api.ts';
import type { AuthType, Server } from '../types.ts';
import { useLoad } from '../ui.ts';

export function Servers({ admin }: { admin: boolean }) {
  const { data, error, reload } = useLoad(api.listServers);
  const [open, setOpen] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string>();
  // Status changes on its own (an upstream dies or comes back), so poll while the page is open.
  useEffect(() => {
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  return (
    <>
      <h1>Servers</h1>
      <p className="sub">
        {admin
          ? 'Upstream MCP servers. Their tools are exposed as slug__tool through this gateway.'
          : 'Tools you can use through this gateway and the chat agent.'}
      </p>

      {error && <div className="alert">{error}</div>}
      {actionError && <div className="alert">{actionError}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Server</th>
              <th>Status</th>
              <th>Tools</th>
              {admin && <th />}
            </tr>
          </thead>
          <tbody>
            {data?.servers.map((s) => (
              <tr key={s.id}>
                <td>
                  <button className="link" onClick={() => setOpen(open === s.id ? undefined : s.id)}>
                    {open === s.id ? '▾' : '▸'} {s.name}
                  </button>
                  <div className="dim mono">{s.slug}</div>
                  {s.managed && <span className="dim">managed by Helm</span>}
                  {open === s.id && <Tools server={s} admin={admin} onChange={reload} />}
                  {s.error && <div className="dim">{s.error}</div>}
                  {admin && editing === s.id && (
                    <EditServer
                      server={s}
                      onCancel={() => setEditing(undefined)}
                      onSaved={() => {
                        setEditing(undefined);
                        reload();
                      }}
                    />
                  )}
                </td>
                <td>
                  <span className={`badge ${s.status}`}>{s.status}</span>
                </td>
                <td>{s.tools.length}</td>
                {admin && (
                  <td>
                    <div className="row">
                      <button onClick={() => act(() => api.updateServer(s.id, { enabled: !s.enabled }))}>
                        {s.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => setEditing(editing === s.id ? undefined : s.id)}>Edit</button>
                      {!s.managed && (
                        <button
                          className="danger"
                          onClick={() =>
                            confirm(`Delete ${s.name}? Its tools stop being exposed.`) &&
                            act(() => api.deleteServer(s.id))
                          }
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {data?.servers.length === 0 && (
              <tr>
                <td colSpan={admin ? 4 : 3} className="dim">
                  No servers registered.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {admin &&
        (adding ? (
          <AddServer
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        ) : (
          <button className="primary" onClick={() => setAdding(true)}>
            Register a server
          </button>
        ))}
    </>
  );
}

function Tools({ server, admin, onChange }: { server: Server; admin: boolean; onChange: () => void }) {
  const [error, setError] = useState<string>();
  if (server.tools.length === 0) return <p className="dim">No tools.</p>;

  async function toggle(tool: string, memberAllowed: boolean) {
    setError(undefined);
    try {
      await api.setToolAccess(`${server.slug}__${tool}`, memberAllowed);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div style={{ margin: '10px 0 4px' }}>
      {error && <div className="alert">{error}</div>}
      <table>
        <tbody>
          {server.tools.map((t) => (
            <tr key={t.name}>
              <td className="mono">
                {server.slug}__{t.name}
                <div className="dim" style={{ fontFamily: 'inherit' }}>
                  {t.description}
                </div>
              </td>
              {admin && (
                <td style={{ width: 150 }}>
                  <label className="row" style={{ marginBottom: 0, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={t.memberAllowed}
                      onChange={(e) => toggle(t.name, e.target.checked)}
                    />
                    members
                  </label>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddServer({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ slug: '', name: '', url: '', authType: 'none' as AuthType, authHeader: '', credential: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.createServer({
        slug: f.slug,
        name: f.name,
        url: f.url,
        authType: f.authType,
        ...(f.authType === 'header' ? { authHeader: f.authHeader } : {}),
        ...(f.authType === 'none' ? {} : { credential: f.credential }),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2 style={{ marginTop: 0 }}>Register a server</h2>
      {error && <div className="alert">{error}</div>}
      <div className="grid">
        <div>
          <label htmlFor="slug">Slug</label>
          <input
            id="slug"
            required
            pattern="[a-z][a-z0-9-]{1,30}"
            title="lowercase, starts with a letter, 2 to 31 characters"
            value={f.slug}
            onChange={(e) => setF({ ...f, slug: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="name">Name</label>
          <input id="name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <label htmlFor="url">MCP URL</label>
        <input
          id="url"
          type="url"
          required
          placeholder="http://host:3000/mcp"
          value={f.url}
          onChange={(e) => setF({ ...f, url: e.target.value })}
        />
      </div>
      <AuthFields f={f} setF={setF} credentialLabel="Credential" />
      <div className="row" style={{ marginTop: 14 }}>
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Register'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EditServer({
  server,
  onCancel,
  onSaved,
}: {
  server: Server;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: server.name,
    url: server.url ?? '',
    authType: server.authType ?? 'none',
    authHeader: server.authHeader ?? '',
    credential: '',
  });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.updateServer(server.id, {
        name: f.name,
        url: f.url,
        authType: f.authType,
        authHeader: f.authType === 'header' ? f.authHeader : undefined,
        // Blank means "keep the stored credential".
        ...(f.credential ? { credential: f.credential } : {}),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ margin: '10px 0', paddingTop: 10, borderTop: '1px solid var(--line)' }}>
      {error && <div className="alert">{error}</div>}
      <div className="grid">
        <div>
          <label>Name</label>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div>
          <label>MCP URL</label>
          <input type="url" required value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
        </div>
      </div>
      <AuthFields
        f={f}
        setF={setF}
        credentialLabel={server.hasCredential ? 'Replace credential (blank keeps it)' : 'Credential'}
      />
      <div className="row" style={{ marginTop: 14 }}>
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type AuthShape = { authType: AuthType; authHeader: string; credential: string };

function AuthFields<T extends AuthShape>({
  f,
  setF,
  credentialLabel,
}: {
  f: T;
  setF: (next: T) => void;
  credentialLabel: string;
}) {
  return (
    <div className="grid" style={{ marginTop: 10 }}>
      <div>
        <label>Auth</label>
        <select value={f.authType} onChange={(e) => setF({ ...f, authType: e.target.value as AuthType })}>
          <option value="none">none</option>
          <option value="bearer">bearer</option>
          <option value="header">header</option>
        </select>
      </div>
      {f.authType === 'header' && (
        <div>
          <label>Header name</label>
          <input
            required
            placeholder="X-Api-Key"
            value={f.authHeader}
            onChange={(e) => setF({ ...f, authHeader: e.target.value })}
          />
        </div>
      )}
      {f.authType !== 'none' && (
        <div>
          <label>{credentialLabel}</label>
          <input
            type="password"
            autoComplete="off"
            value={f.credential}
            onChange={(e) => setF({ ...f, credential: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
