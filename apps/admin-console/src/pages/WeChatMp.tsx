import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { cardStyle, inputStyle, td, th } from '../App.js';

/**
 * Module 04 公众号通道配置（FR-IM-11/13, SPEC §2.2/§3.4）：管理台维护公众号
 * 凭证（AppID/AppSecret/EncodingAESKey/Token，只存服务端 AES-256-GCM 密文，
 * 列表只见尾 4 位）+ 绑定哪位成员的桌面客户端收发（allow_user_ids）。
 * 回调地址：<server>/bots/webhook/wechat（GET 验签 + POST 消息，明文或安全
 * 模式均支持；AESKey 留空 = 明文模式）。成员桌面端经 wechat_mp 通道适配器
 * 5s 轮询取件，回复走客服消息 API（48h/5 条窗口）。
 */

interface WechatBotRow {
  id: string;
  name: string;
  appId: string;
  token: string;
  secretTail: string;
  aesKeyTail: string;
  allowUserIds: string[];
  enabled: boolean;
}

interface UserRow { id: string; username: string; displayName: string; role: string }

interface FormState {
  editingId: string | null;
  name: string;
  appId: string;
  appSecret: string;
  encodingAesKey: string;
  token: string;
  allowUserIds: string[];
}

const EMPTY_FORM: FormState = {
  editingId: null, name: '', appId: '', appSecret: '', encodingAesKey: '', token: '', allowUserIds: [],
};

export function WeChatMpPage(): ReactElement {
  const [rows, setRows] = useState<WechatBotRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const reload = () => {
    void api<WechatBotRow[]>('GET', '/org/wechat-mp/bots').then(setRows).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void api<UserRow[]>('GET', '/admin/users').then(setUsers).catch(() => undefined);
  };
  useEffect(() => { reload(); }, []);

  const userName = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? `${u.displayName}（${u.username}）` : id.slice(0, 8);
  };

  const submit = async () => {
    setMsg(''); setError('');
    const payload: Record<string, unknown> = {
      name: form.name,
      appId: form.appId,
      token: form.token,
      allowUserIds: form.allowUserIds,
    };
    if (form.appSecret) payload.appSecret = form.appSecret; // 编辑留空 = 不修改
    if (form.encodingAesKey) payload.encodingAesKey = form.encodingAesKey; // 留空 = 不修改
    if (!form.editingId) payload.encodingAesKey = form.encodingAesKey; // 新建可为空 → 明文模式
    try {
      if (form.editingId) {
        await api('PATCH', `/org/wechat-mp/bots/${form.editingId}`, payload);
        setMsg('公众号接入已更新（AppSecret / EncodingAESKey 留空则保持不变）');
      } else {
        if (!form.appSecret) { setError('AppSecret 不能为空'); return; }
        await api('POST', '/org/wechat-mp/bots', payload);
        setMsg('公众号已接入。请在公众平台「服务器配置」填写回调 URL /bots/webhook/wechat 与相同 Token');
      }
      setForm(EMPTY_FORM);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggle = async (row: WechatBotRow) => {
    setMsg(''); setError('');
    try {
      await api('PATCH', `/org/wechat-mp/bots/${row.id}`, { enabled: !row.enabled });
      setMsg(`${row.name} 已${row.enabled ? '停用' : '启用'}`);
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const remove = async (row: WechatBotRow) => {
    if (!window.confirm(`确认删除公众号接入「${row.name}」？其离线暂存消息将一并清除。`)) return;
    setMsg(''); setError('');
    try {
      await api('DELETE', `/org/wechat-mp/bots/${row.id}`);
      setMsg(`${row.name} 已删除`);
      if (form.editingId === row.id) setForm(EMPTY_FORM);
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const edit = (row: WechatBotRow) => {
    setMsg(''); setError('');
    setForm({
      editingId: row.id,
      name: row.name,
      appId: row.appId,
      appSecret: '', // 不回显明文（服务端也不存明文）
      encodingAesKey: '',
      token: row.token,
      allowUserIds: row.allowUserIds,
    });
  };

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          {form.editingId ? `编辑公众号接入（${form.editingId.slice(0, 8)}…）` : '接入微信公众号（回调必须公网：经 LaboFlow Server 中继，桌面端绑定用户收发）'}
        </div>
        <div style={{ fontSize: 12, color: '#555553', marginBottom: 8 }}>
          公众号后台「服务器配置」：URL 填 <code>{'{server}'}<b>/bots/webhook/wechat</b></code>；Token 与下方一致；消息加解密方式选「明文模式」或「安全模式」（安全模式需填 EncodingAESKey）。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ ...inputStyle, width: 140 }} />
          <input placeholder="AppID（开发者ID）" value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} style={{ ...inputStyle, width: 190 }} disabled={!!form.editingId} />
          <input
            type="password"
            placeholder={form.editingId ? 'AppSecret（留空不修改）' : 'AppSecret'}
            value={form.appSecret}
            onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
            style={{ ...inputStyle, width: 190 }}
          />
          <input
            type="password"
            placeholder="EncodingAESKey（43位，安全模式；可空）"
            value={form.encodingAesKey}
            onChange={(e) => setForm({ ...form, encodingAesKey: e.target.value })}
            style={{ ...inputStyle, width: 250 }}
          />
          <input placeholder="Token（回调验签令牌）" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} style={{ ...inputStyle, width: 160 }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }} data-testid="wechat-mp-users">
            {users.length === 0 && <span style={{ fontSize: 12, color: '#555553' }}>（暂无用户）</span>}
            {users.map((u) => (
              <label key={u.id} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 3 }}>
                <input
                  type="checkbox"
                  checked={form.allowUserIds.includes(u.id)}
                  onChange={(e) => setForm({
                    ...form,
                    allowUserIds: e.target.checked ? [...form.allowUserIds, u.id] : form.allowUserIds.filter((id) => id !== u.id),
                  })}
                />
                {u.displayName}
              </label>
            ))}
          </div>
          <button data-testid="wechat-mp-submit" onClick={() => void submit()} style={{ padding: '7px 14px', background: '#171717', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13 }}>
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
            <th style={th}>AppID</th>
            <th style={th}>Token</th>
            <th style={th}>Secret / AESKey</th>
            <th style={th}>绑定桌面用户</th>
            <th style={th}>状态</th>
            <th style={th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td style={td} colSpan={7}>暂无公众号接入</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} data-testid={`wechat-mp-row-${r.name}`}>
              <td style={td}>{r.name}</td>
              <td style={td}>{r.appId}</td>
              <td style={td}>{r.token}</td>
              <td style={td}>****{r.secretTail} / {r.aesKeyTail ? `****${r.aesKeyTail}` : '明文模式'}</td>
              <td style={td}>{r.allowUserIds.map(userName).join('、') || '（未绑定）'}</td>
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
