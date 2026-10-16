import { type FormEvent, useState } from 'react';
import * as api from '../api.ts';
import type { Session } from '../types.ts';

export function Invite({ token, onDone }: { token: string; onDone: (s: Session) => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    setError(undefined);
    try {
      const session = await api.acceptInvite(token, password);
      location.hash = '/';
      onDone(session);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form onSubmit={submit}>
        <h1>Set your password</h1>
        {error && <div className="alert">{error}</div>}
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label htmlFor="confirm">Confirm password</label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Set password and sign in'}
        </button>
      </form>
    </div>
  );
}
