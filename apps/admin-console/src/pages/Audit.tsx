import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { td, th } from '../App.js';

interface AuditRow { id: number; ts: string; actorId: string | null; action: string; target: string }

export function AuditPage(): ReactElement {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<AuditRow[]>('GET', '/admin/audit?limit=200').then(setRows).catch((e) => setError(String(e.message)));
  }, []);
  if (error) return <p style={{ color: '#E11D48', fontSize: 13 }}>{error}</p>;
  return (
    <div>
      <p style={{ fontSize: 12, color: '#555553', marginBottom: 8 }}>追加写审计（登录/管理操作/资产发布…保留 180 天，仅系统管理员可导出）</p>
      <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
        <thead><tr><th style={th}>时间</th><th style={th}>动作</th><th style={th}>对象</th><th style={th}>操作者</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td style={td}>{new Date(a.ts).toLocaleString()}</td>
              <td style={td}>{a.action}</td>
              <td style={td}>{a.target || '—'}</td>
              <td style={td}>{a.actorId ? `${a.actorId.slice(0, 8)}…` : '系统'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
