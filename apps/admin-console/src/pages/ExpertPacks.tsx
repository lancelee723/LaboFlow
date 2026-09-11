import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { cardStyle, inputStyle, td, th } from '../App.js';

/**
 * Module 01 组织专家库（FR-E-18/19, SPEC §3.4）：组织专家/专家团「定义包」发布。
 * - expert：行业分类 + 标签 + 正文（=系统提示词：人设+方法论+输出规范）
 * - team：成员专家（≤6）+ 团长风格（精细/粗放）+ 整合策略（主持人综合/摘要合并/按章节拼接）+ 正文
 * 发布幂等：同名同内容重发布版本不变；内容变化版本 +1。
 * 成员经 GET /org/bootstrap 的 expertPacks[] 收到只读副本（source=org）。
 */

interface ExpertPackRow {
  id: string;
  kind: 'expert' | 'team';
  name: string;
  description: string;
  payload: {
    industry?: string;
    tags?: string[];
    members?: string[];
    leaderStyle?: 'fine' | 'coarse';
    integration?: 'moderator' | 'summary' | 'sections';
    body?: string;
  };
  version: number;
  enabled: boolean;
}

const INDUSTRIES = ['通用', '战略与组织', '金融', '先进制造', 'TMT', '医疗健康'];

interface FormState {
  editingId: string | null;
  kind: 'expert' | 'team';
  name: string;
  description: string;
  industry: string;
  tags: string;
  members: string;
  leaderStyle: 'fine' | 'coarse';
  integration: 'moderator' | 'summary' | 'sections';
  body: string;
}

const EMPTY_FORM: FormState = {
  editingId: null, kind: 'expert', name: '', description: '', industry: '', tags: '', members: '', leaderStyle: 'fine', integration: 'moderator', body: '',
};

const splitList = (v: string) => v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);

export function ExpertPacksPage(): ReactElement {
  const [rows, setRows] = useState<ExpertPackRow[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const reload = () => {
    void api<ExpertPackRow[]>('GET', '/org/expert-packs').then(setRows).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => { reload(); }, []);

  const submit = async () => {
    setMsg(''); setError('');
    const payload: Record<string, unknown> = { body: form.body.trim() };
    if (form.kind === 'expert') {
      if (form.industry) payload.industry = form.industry;
      const tags = splitList(form.tags);
      if (tags.length) payload.tags = tags;
    } else {
      payload.members = splitList(form.members);
      payload.leaderStyle = form.leaderStyle;
      payload.integration = form.integration;
    }
    try {
      await api('POST', '/org/expert-packs', {
        kind: form.kind,
        name: form.name,
        description: form.description,
        payload,
      });
      setMsg(form.editingId ? '已重发布：内容有变化则版本 +1，未变化保持原版本' : '已发布，成员将在下次登录引导时收到只读副本');
      setForm(EMPTY_FORM);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const republish = (row: ExpertPackRow) => {
    setMsg(''); setError('');
    setForm({
      editingId: row.id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      industry: row.payload.industry ?? '',
      tags: (row.payload.tags ?? []).join(', '),
      members: (row.payload.members ?? []).join(', '),
      leaderStyle: row.payload.leaderStyle ?? 'fine',
      integration: row.payload.integration ?? 'moderator',
      body: row.payload.body ?? '',
    });
  };

  const remove = async (row: ExpertPackRow) => {
    if (!window.confirm(`确认删除「${row.name}」？成员端将不再下发。`)) return;
    setMsg(''); setError('');
    try {
      await api('DELETE', `/org/expert-packs/${row.id}`);
      setMsg(`${row.name} 已删除`);
      if (form.editingId === row.id) setForm(EMPTY_FORM);
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          {form.editingId ? `重发布「${form.name}」（内容变化则版本 +1）` : '发布组织专家/专家团（成员经登录引导收到只读副本，同名组织版优先）'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select data-testid="expert-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'expert' | 'team' })} style={{ ...inputStyle, width: 110 }} disabled={!!form.editingId}>
            <option value="expert">专家</option>
            <option value="team">专家团</option>
          </select>
          <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ ...inputStyle, width: 150 }} />
          <input placeholder="说明（可选）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ ...inputStyle, width: 200 }} />
          {form.kind === 'expert' ? (
            <>
              <select data-testid="expert-industry" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} style={{ ...inputStyle, width: 130 }}>
                <option value="">行业（不限）</option>
                {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
              <input placeholder="标签（逗号分隔）" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} style={{ ...inputStyle, width: 200 }} />
            </>
          ) : (
            <>
              <input data-testid="expert-members" placeholder="成员专家（逗号分隔，≤6）" value={form.members} onChange={(e) => setForm({ ...form, members: e.target.value })} style={{ ...inputStyle, width: 240 }} />
              <select data-testid="expert-leader-style" value={form.leaderStyle} onChange={(e) => setForm({ ...form, leaderStyle: e.target.value as 'fine' | 'coarse' })} style={{ ...inputStyle, width: 120 }}>
                <option value="fine">精细拆解</option>
                <option value="coarse">粗放拆解</option>
              </select>
              <select data-testid="expert-integration" value={form.integration} onChange={(e) => setForm({ ...form, integration: e.target.value as 'moderator' | 'summary' | 'sections' })} style={{ ...inputStyle, width: 130 }}>
                <option value="moderator">主持人综合</option>
                <option value="summary">摘要合并</option>
                <option value="sections">按章节拼接</option>
              </select>
            </>
          )}
        </div>
        <textarea
          data-testid="expert-body"
          placeholder={form.kind === 'expert' ? '正文 = 该专家的系统提示词（人设 + 方法论 + 输出规范）' : '正文 = 团长拆解指令模板 + 整合指令模板'}
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          rows={4}
          style={{ ...inputStyle, marginTop: 8, fontFamily: 'inherit', resize: 'vertical' }}
        />
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button data-testid="expert-submit" onClick={() => void submit()} disabled={!form.name.trim() || !form.body.trim()} style={{ padding: '7px 14px', background: '#171717', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, opacity: !form.name.trim() || !form.body.trim() ? 0.5 : 1 }}>
            {form.editingId ? '重发布' : '发布'}
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
            <th style={th}>版本</th>
            <th style={th}>说明</th>
            <th style={th}>状态</th>
            <th style={th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td style={td} colSpan={6}>暂无组织专家/专家团</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} data-testid={`expert-row-${r.name}`}>
              <td style={td}>{r.name}</td>
              <td style={td}>
                {r.kind === 'expert'
                  ? `专家${r.payload.industry ? `·${r.payload.industry}` : ''}`
                  : `专家团·${(r.payload.members ?? []).length}人`}
              </td>
              <td style={td}>v{r.version}</td>
              <td style={td} title={r.description}>{r.description}</td>
              <td style={td}>{r.enabled ? '已启用' : '已停用'}</td>
              <td style={td}>
                <button onClick={() => republish(r)} style={{ marginRight: 6, padding: '3px 10px', fontSize: 12, border: '1px solid #E6E6E5', borderRadius: 6, background: '#fff', cursor: 'pointer' }}>
                  重发布
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
