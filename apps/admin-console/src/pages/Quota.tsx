import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { cardStyle, inputStyle, td, th } from '../App.js';

interface PolicyRow { id: string; scope: string; teamId: string | null; subject: string; kind: string; limitValue: string | number; period: string }

export function QuotaPage(): ReactElement {
  const [rows, setRows] = useState<PolicyRow[]>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState({ scope: 'system', teamId: '', kind: 'tokens', limitValue: '', period: 'monthly' });
  const [msg, setMsg] = useState('');
  const reload = () => void api<PolicyRow[]>('GET', '/admin/quota/policies').then(setRows).catch(() => undefined);
  useEffect(() => {
    void reload();
    void api<Array<{ id: string; name: string }>>('GET', '/admin/teams').then(setTeams).catch(() => undefined);
  }, []);

  const create = async () => {
    setMsg('');
    try {
      await api('PUT', '/quota/policies', { ...form, limitValue: Number(form.limitValue), teamId: form.teamId || undefined });
      setMsg('策略已生效（系统级为下限，团队级不得宽于系统级）');
      setForm({ ...form, limitValue: '' });
      reload();
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>新建配额策略（会话数 / Tokens × 日 / 周 / 月；任一触顶即限制；冲突取严）</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value, teamId: '' })} style={inputStyle}>
            <option value="system">系统级（全局下限）</option>
            <option value="team">团队级</option>
          </select>
          {form.scope === 'team' && (
            <select value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })} style={inputStyle}>
              <option value="">选择团队…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={inputStyle}>
            <option value="tokens">Tokens</option>
            <option value="sessions">会话数</option>
          </select>
          <input placeholder="限值" value={form.limitValue} onChange={(e) => setForm({ ...form, limitValue: e.target.value })} style={{ ...inputStyle, width: 120 }} />
          <select value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} style={inputStyle}>
            <option value="daily">每日</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
          </select>
          <button onClick={() => void create()} style={{ padding: '7px 14px', background: '#171717', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13 }}>生效</button>
        </div>
        {msg && <p style={{ fontSize: 12, color: '#555553' }}>{msg}</p>}
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
        <thead><tr><th style={th}>级别</th><th style={th}>对象</th><th style={th}>类型</th><th style={th}>限值</th><th style={th}>周期</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td style={td}>{p.scope}</td>
              <td style={td}>{p.teamId ? `${p.teamId.slice(0, 8)}…` : '全局'}</td>
              <td style={td}>{p.kind}</td>
              <td style={td}>{Number(p.limitValue).toLocaleString()}</td>
              <td style={td}>{p.period}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
