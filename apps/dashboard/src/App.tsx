import { useEffect, useState } from 'react';
import * as api from './api.ts';
import { Audit } from './pages/Audit.tsx';
import { Chat } from './pages/Chat.tsx';
import { Invite } from './pages/Invite.tsx';
import { Keys } from './pages/Keys.tsx';
import { Login } from './pages/Login.tsx';
import { Servers } from './pages/Servers.tsx';
import { Users } from './pages/Users.tsx';
import type { Session } from './types.ts';
import { navigate, usePath } from './ui.ts';

export function App() {
  const path = usePath();
  const [session, setSession] = useState<Session | null>();

  useEffect(() => {
    api.me().then(setSession, () => setSession(null));
  }, []);

  if (session === undefined) return <div className="center dim">Loading…</div>;

  if (!session) {
    const invite = path.match(/^\/invite\/(.+)$/);
    if (invite) return <Invite token={invite[1]!} onDone={setSession} />;
    return <Login onDone={setSession} />;
  }

  const { user, chatEnabled } = session;
  const admin = user.role === 'admin';

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Urumi Gateway</div>
        <nav>
          {chatEnabled && <Link path={path} to="/chat" label="Chat" />}
          <Link path={path} to="/servers" label="Servers" />
          {admin && <Link path={path} to="/users" label="Users" />}
          <Link path={path} to="/keys" label="API keys" />
          <Link path={path} to="/audit" label="Audit log" />
        </nav>
        <footer>
          <div>{user.email}</div>
          <div className="dim">{user.role}</div>
          <button
            className="link"
            style={{ paddingLeft: 0 }}
            onClick={() => api.logout().then(() => setSession(null))}
          >
            Sign out
          </button>
        </footer>
      </aside>
      <main>
        <Route path={path} admin={admin} chatEnabled={chatEnabled} userId={user.id} />
      </main>
    </div>
  );
}

function Link({ path, to, label }: { path: string; to: string; label: string }) {
  return (
    <a href={`#${to}`} aria-current={path === to ? 'page' : undefined}>
      {label}
    </a>
  );
}

function Route({ path, admin, chatEnabled, userId }: { path: string; admin: boolean; chatEnabled: boolean; userId: string }) {
  switch (path) {
    case '/chat':
      return chatEnabled ? <Chat /> : <Missing />;
    case '/servers':
      return <Servers admin={admin} />;
    case '/users':
      return admin ? <Users meId={userId} /> : <Missing />;
    case '/keys':
      return <Keys />;
    case '/audit':
      return <Audit admin={admin} />;
    default:
      navigate(chatEnabled ? '/chat' : '/servers');
      return null;
  }
}

const Missing = () => <p className="dim">Not available for your account.</p>;
