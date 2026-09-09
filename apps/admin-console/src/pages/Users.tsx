import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { cardStyle, inputStyle, td, th } from '../App.js';

interface UserRow { id: string; username: string; displayName: string; role: string; teamId: string | null; disabledAt: string | null; mustChangePassword: boolean }

export function UsersPage(): ReactElement {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'member', teamId: '' });
  const [msg, setMsg] = useState('');

  const reload = () => void api<UserRow[]>('GET', '/admin/users').then(setRows).catch((e) => setError(String(e.message)));
  useEffect(() => {
    reload();
    void api<Array<{ id: string; name: string }>>('GET', '/admin/teams').then(setTeams).catch(() => undefined);
  }, []);

  const create = async () => {
    setMsg('');
    try {
      await api('POST', '/users', { ...form, teamId: form.teamId || null });
      setMsg(`已创建 ${form.username}（初始密码已交由管理员告知，首登强制改密）`);
      setForm({ username: '', displayName: '', password: '', role: 'member', teamId: '' });
      reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleDisable = async (u: UserRow) => {
    await api('POST', `/admin/users/${u.id}/disable`, { disabled: !u.disabledAt });
    reload();
  };

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>新建用户（账号仅管理员创建；初始密码一次性告知，首登强制改密）</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input data-testid="new-username" placeholder="用户名" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} style={{ ...inputStyle, width: 140 }} />
          <input placeholder="显示名" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} style={{ ...inputStyle, width: 140 }} />
          <input placeholder="初始密码（≥10位含字母数字）" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={{ ...inputStyle, width: 220 }} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={inputStyle}>
            <option value="member">普通用户</option>
            <option value="team_admin">团队管理员</option>
          </select>
          <select value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })} style={inputStyle}>
            <option value="">（无团队）</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button data-testid="create-user" onClick={() => void create()} style={{ padding: '7px 14px', background: '#171717', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13 }}>创建</button>
        </div>
        {msg && <p style={{ fontSize: 12, color: '#555553', marginTop: 8 }}>{msg}</p>}
        {error && <p style={{ fontSize: 12, color: '#E11D48' }}>{error}</p>}
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }} data-testid="users-table">
        <thead><tr><th style={th}>用户名</th><th style={th}>显示名</th><th style={th}>角色</th><th style={th}>状态</th><th style={th}>操作</th></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td style={td}>{u.username}</td>
              <td style={td}>{u.displayName}</td>
              <td style={td}>{u.role}</td>
              <td style={td}>{u.disabledAt ? '已禁用' : u.mustChangePassword ? '待首登改密' : '正常'}</td>
              <td style={td}>
                <button onClick={() => void toggleDisable(u)} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #E6E6E5', background: '#fff', fontSize: 12 }}>
                  {u.disabledAt ? '启用' : '禁用'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
