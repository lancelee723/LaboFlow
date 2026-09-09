import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { cardStyle, inputStyle, td, th } from '../App.js';

interface TeamRow { id: string; name: string; adminUserId: string | null; createdAt: string }

export function TeamsPage(): ReactElement {
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const reload = () => void api<TeamRow[]>('GET', '/admin/teams').then(setRows).catch(() => undefined);
  useEffect(() => { void reload(); }, []);

  const create = async () => {
    try {
      await api('POST', '/teams', { name });
      setName('');
      reload();
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 16, display: 'flex', gap: 8 }}>
        <input placeholder="团队名称（每团队仅 1 名团队管理员）" value={name} onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, width: 320 }} />
        <button onClick={() => void create()} style={{ padding: '7px 14px', background: '#171717', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13 }}>创建团队</button>
        {msg && <span style={{ color: '#E11D48', fontSize: 12, alignSelf: 'center' }}>{msg}</span>}
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
        <thead><tr><th style={th}>团队</th><th style={th}>管理员</th><th style={th}>创建时间</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}><td style={td}>{t.name}</td><td style={td}>{t.adminUserId ? '已指定' : '未指定'}</td><td style={td}>{new Date(t.createdAt).toLocaleString()}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
