import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { cardStyle, inputStyle, td, th } from '../App.js';

/**
 * Module 05 知识库下发条目（FR-KB-02/10/11）：组织知识库「交付项」配置。
 * - mcp：知识检索 MCP 服务（transport stdio|http + url + apiKey，key 仅存服务端，列表只见尾 4 位）
 * - web：网页端入口（内嵌浏览器打开）
 * 成员经 GET /org/bootstrap 的 kbServers[] 按 scope 收到下发。
 */

interface KbRow {
  id: string;
  kind: 'mcp' | 'web';
  name: string;
  transport: string;
  url: string;
  description: string;
  scope: 'all' | 'teams';
  teamIds: string[];
  enabled: boolean;
  keyTail: string;
}

interface TeamRow { id: string; name: string }

interface FormState {
  editingId: string | null;
  kind: 'mcp' | 'web';
  name: string;
  transport: 'stdio' | 'http';
  url: string;
  apiKey: string;
  description: string;
  scope: 'all' | 'teams';
  teamIds: string[];
}

const EMPTY_FORM: FormState = {
  editingId: null, kind: 'mcp', name: '', transport: 'http', url: '', apiKey: '', description: '', scope: 'all', teamIds: [],
};

export function KnowledgeBasePage(): ReactElement {
  const [rows, setRows] = useState<KbRow[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const reload = () => {
    void api<KbRow[]>('GET', '/org/kb-servers').then(setRows).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void api<TeamRow[]>('GET', '/admin/teams').then(setTeams).catch(() => undefined);
  };
  useEffect(() => { reload(); }, []);

  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  const submit = async () => {
    setMsg(''); setError('');
    const payload: Record<string, unknown> = {
      kind: form.kind,
      name: form.name,
      url: form.url,
      description: form.description,
      scope: form.scope,
      teamIds: form.scope === 'teams' ? form.teamIds : [],
    };
    if (form.kind === 'mcp') payload.transport = form.transport;
    if (form.apiKey) payload.apiKey = form.apiKey; // 编辑时留空 = 不修改 key
    try {
      if (form.editingId) {
        await api('PATCH', `/org/kb-servers/${form.editingId}`, payload);
        setMsg('知识库条目已更新（API Key 留空则保持不变）');
      } else {
        await api('POST', '/org/kb-servers', payload);
        setMsg('知识库条目已创建，成员将在下次登录引导时收到下发');
      }
      setForm(EMPTY_FORM);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggle = async (row: KbRow) => {
    setMsg(''); setError('');
    try {
      await api('PATCH', `/org/kb-servers/${row.id}`, { enabled: !row.enabled });
      setMsg(`${row.name} 已${row.enabled ? '停用' : '启用'}`);
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const remove = async (row: KbRow) => {
    if (!window.confirm(`确认删除知识库「${row.name}」？成员端将不再下发。`)) return;
    setMsg(''); setError('');
    try {
      await api('DELETE', `/org/kb-servers/${row.id}`);
      setMsg(`${row.name} 已删除`);
      if (form.editingId === row.id) setForm(EMPTY_FORM);
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const edit = (row: KbRow) => {
    setMsg(''); setError('');
    setForm({
      editingId: row.id,
      kind: row.kind,
      name: row.name,
      transport: row.transport === 'stdio' ? 'stdio' : 'http',
      url: row.url,
      apiKey: '', // 不回显明文（服务端也不存明文）
      description: row.description,
      scope: row.scope,
      teamIds: row.teamIds,
    });
  };

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          {form.editingId ? `编辑知识库条目（${form.editingId.slice(0, 8)}…）` : '接入知识库（成员经登录引导收到：检索 MCP 服务 / 网页端入口）'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select data-testid="kb-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'mcp' | 'web' })} style={{ ...inputStyle, width: 130 }} disabled={!!form.editingId}>
            <option value="mcp">检索 MCP 服务</option>
            <option value="web">网页端入口</option>
          </select>
          <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ ...inputStyle, width: 140 }} />
          {form.kind === 'mcp' && (
            <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as 'stdio' | 'http' })} style={{ ...inputStyle, width: 90 }}>
              <option value="http">http</option>
              <option value="stdio">stdio</option>
            </select>
          )}
          <input
            placeholder={form.kind === 'mcp' && form.transport === 'stdio' ? '启动命令（如 uvx …）' : 'URL（如 https://kb.example.com/mcp）'}
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            style={{ ...inputStyle, width: 260 }}
          />
          {form.kind === 'mcp' && (
            <input
              type="password"
              placeholder={form.editingId ? 'API Key（留空不修改）' : 'API Key'}
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              style={{ ...inputStyle, width: 180 }}
            />
          )}
          <input placeholder="说明（可选）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ ...inputStyle, width: 160 }} />
          <select data-testid="kb-scope" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as 'all' | 'teams' })} style={{ ...inputStyle, width: 110 }}>
            <option value="all">全员可见</option>
            <option value="teams">指定团队</option>
          </select>
          {form.scope === 'teams' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }} data-testid="kb-teams">
              {teams.length === 0 && <span style={{ fontSize: 12, color: '#555553' }}>（暂无团队）</span>}
              {teams.map((t) => (
                <label key={t.id} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 3 }}>
                  <input
                    type="checkbox"
                    checked={form.teamIds.includes(t.id)}
                    onChange={(e) => setForm({
                      ...form,
                      teamIds: e.target.checked ? [...form.teamIds, t.id] : form.teamIds.filter((id) => id !== t.id),
                    })}
                  />
                  {t.name}
                </label>
              ))}
            </div>
          )}
          <button data-testid="kb-submit" onClick={() => void submit()} style={{ padding: '7px 14px', background: '#171717', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13 }}>
            {form.editingId ? '保存' : '接入'}
          </button>
          {form.editingId && (
            <button onClick={() => setForm(EMPTY_FORM)} style={{ padding: '7px 14px', background: '#fff', color: '#171717', border: '1px solid #E6E6E5', borderRadius: 8, fontSize: 13 }}>
              取消
            </button>
          )}
        </div>
        {msg && <p style={{ fontSize: 12, color: '#555553' }}>{msg}</p>}
        {error && <p style={{ fontSize: 12, color: '#E11D48' }}>{error}</p>}
      </div>

      <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
        <thead>
          <tr>
            <th style={th}>名称</th>
            <th style={th}>类型</th>
            <th style={th}>URL / 命令</th>
            <th style={th}>说明</th>
            <th style={th}>范围</th>
            <th style={th}>Key</th>
            <th style={th}>状态</th>
            <th style={th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td style={td} colSpan={8}>暂无知识库条目</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} data-testid={`kb-row-${r.name}`}>
              <td style={td}>{r.name}</td>
              <td style={td}>{r.kind === 'mcp' ? `MCP·${r.transport}` : '网页'}</td>
              <td style={td} title={r.url}>{r.url.length > 40 ? `${r.url.slice(0, 40)}…` : r.url}</td>
              <td style={td}>{r.description}</td>
              <td style={td}>
                {r.scope === 'all' ? '全员' : `团队：${r.teamIds.map(teamName).join('、') || '（未选）'}`}
              </td>
              <td style={td}>{r.kind === 'mcp' ? `****${r.keyTail}` : '—'}</td>
              <td style={td}>{r.enabled ? '已启用' : '已停用'}</td>
              <td style={td}>
                <button onClick={() => void toggle(r)} style={{ marginRight: 6, padding: '3px 10px', fontSize: 12, border: '1px solid #E6E6E5', borderRadius: 6, background: '#fff', cursor: 'pointer' }}>
                  {r.enabled ? '停用' : '启用'}
                </button>
                <button onClick={() => edit(r)} style={{ marginRight: 6, padding: '3px 10px', fontSize: 12, border: '1px solid #E6E6E5', borderRadius: 6, background: '#fff', cursor: 'pointer' }}>
                  编辑
                </button>
                <button onClick={() => void remove(r)} style={{ padding: '3px 10px', fontSize: 12, border: '1px solid #E11D48', borderRadius: 6, background: '#fff', color: '#E11D48', cursor: 'pointer' }}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
