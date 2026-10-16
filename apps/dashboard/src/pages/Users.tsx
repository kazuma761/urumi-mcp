import { type FormEvent, useState } from 'react';
import * as api from '../api.ts';
import type { Role } from '../types.ts';
import { fmtTime, useLoad } from '../ui.ts';

const inviteLink = (token: string) => `${location.origin}/#/invite/${token}`;

export function Users({ meId }: { meId: string }) {
  const { data, error, reload } = useLoad(api.listUsers);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [invite, setInvite] = useState<{ email: string; link: string }>();
  const [secret, setSecret] = useState<{ name: string; secret: string }>();

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setActionError(undefined);
    try {
      const { user, inviteToken } = await api.createUser(email, role);
      setInvite({ email: user.email, link: inviteLink(inviteToken) });
      setEmail('');
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function issueKey(userId: string, userEmail: string) {
    const name = prompt(`Name for the key issued to ${userEmail}?`);
    if (!name) return;
    await act(async () => {
      const { secret: value } = await api.createKey(name, userId);
      setSecret({ name, secret: value });
    });
  }

  return (
    <>
      <h1>Users</h1>
      <p className="sub">Members see only the tools you allow them. Invite links set a password.</p>

      {error && <div className="alert">{error}</div>}
      {actionError && <div className="alert">{actionError}</div>}

      {invite && (
        <div className="notice">
          <strong>Invite link for {invite.email}</strong>
          <div className="mono">{invite.link}</div>
          <button className="link" style={{ paddingLeft: 0 }} onClick={() => setInvite(undefined)}>
            Dismiss
          </button>
        </div>
      )}
      {secret && (
        <div className="notice">
          <strong>API key “{secret.name}” — shown once</strong>
          <div className="mono">{secret.secret}</div>
          <button className="link" style={{ paddingLeft: 0 }} onClick={() => setSecret(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      <form className="card row" onSubmit={add}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="newEmail">Email</label>
          <input
            id="newEmail"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="newRole">Role</label>
          <select id="newRole" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button className="primary" disabled={busy} style={{ alignSelf: 'end' }}>
          {busy ? 'Inviting…' : 'Invite'}
        </button>
      </form>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Keys</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.email}
                  {u.pending && <span className="badge pending" style={{ marginLeft: 8 }}>pending</span>}
                  <div className="dim">joined {fmtTime(u.createdAt)}</div>
                </td>
                <td>
                  <span className={`badge ${u.role}`}>{u.role}</span>
                </td>
                <td>
                  {u.keys.length === 0 && <span className="dim">none</span>}
                  {u.keys.map((k) => (
                    <div key={k.id} className="row" style={{ gap: 6 }}>
                      <span className="mono">{k.prefix}…</span>
                      <span className="dim">{k.name}</span>
                      {k.revokedAt ? (
                        <span className="badge disabled">revoked</span>
                      ) : (
                        <button
                          className="link danger"
                          onClick={() => confirm(`Revoke “${k.name}”?`) && act(() => api.revokeKey(k.id))}
                        >
                          revoke
                        </button>
                      )}
                    </div>
                  ))}
                </td>
                <td>
                  <div className="row">
                    <button onClick={() => issueKey(u.id, u.email)}>Issue key</button>
                    <button
                      onClick={() =>
                        act(async () => {
                          const { inviteToken } = await api.reinvite(u.id);
                          setInvite({ email: u.email, link: inviteLink(inviteToken) });
                        })
                      }
                    >
                      {u.pending ? 'New invite' : 'Reset password'}
                    </button>
                    {/* No button for yourself: the last admin must not be able to lock everyone out. */}
                    {u.id !== meId && (
                      <button
                        className="link danger"
                        onClick={() =>
                          confirm(`Remove ${u.email}? Their API keys stop working immediately.`) &&
                          act(() => api.deleteUser(u.id))
                        }
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
