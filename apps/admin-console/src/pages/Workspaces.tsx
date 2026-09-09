import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { td, th } from '../App.js';

interface WsRow { id: string; name: string; teamId: string; createdAt: string }

export function WorkspacesPage(): ReactElement {
  const [rows, setRows] = useState<WsRow[]>([]);
  useEffect(() => { void api<WsRow[]>('GET', '/admin/workspaces').then(setRows).catch(() => undefined); }, []);
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
      <thead><tr><th style={th}>工作区</th><th style={th}>所属团队</th><th style={th}>创建时间</th></tr></thead>
      <tbody>
        {rows.map((w) => <tr key={w.id}><td style={td}>{w.name}</td><td style={td}>{w.teamId.slice(0, 8)}…</td><td style={td}>{new Date(w.createdAt).toLocaleString()}</td></tr>)}
      </tbody>
    </table>
  );
}
