import * as api from '../api.ts';
import { fmtTime, useLoad } from '../ui.ts';

export function Audit({ admin }: { admin: boolean }) {
  const { data, error, reload } = useLoad(() => api.listAudit(100));

  return (
    <>
      <h1>Audit log</h1>
      <p className="sub">
        {admin ? 'Every tool call through this gateway.' : 'Your tool calls through this gateway.'} Newest first,
        last 100.
      </p>

      {error && <div className="alert">{error}</div>}

      <button onClick={reload} style={{ marginBottom: 14 }}>
        Refresh
      </button>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>When</th>
              {admin && <th>User</th>}
              <th>Via</th>
              <th>Tool</th>
              <th>Outcome</th>
              <th>Took</th>
            </tr>
          </thead>
          <tbody>
            {data?.entries.map((e) => (
              <tr key={e.id}>
                <td className="dim">{fmtTime(e.ts)}</td>
                {admin && <td>{e.userEmail}</td>}
                <td>{e.via}</td>
                <td className="mono">
                  {e.server && e.tool ? `${e.server}__${e.tool}` : (e.tool ?? '—')}
                  {e.error && (
                    <div className="dim" style={{ fontFamily: 'inherit' }}>
                      {e.error}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`badge ${e.outcome}`}>{e.outcome}</span>
                </td>
                <td className="dim">{e.durationMs} ms</td>
              </tr>
            ))}
            {data?.entries.length === 0 && (
              <tr>
                <td colSpan={admin ? 6 : 5} className="dim">
                  Nothing logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
