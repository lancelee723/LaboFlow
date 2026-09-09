import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { cardStyle, inputStyle, td, th } from '../App.js';

interface ChannelRow { id: string; name: string; protocol: string; baseUrl: string; models: string[]; health: string }

export function ChannelsPage(): ReactElement {
  const [rows, setRows] = useState<ChannelRow[]>([]);
  const [form, setForm] = useState({ name: '', protocol: 'openai', baseUrl: '', apiKey: '', models: '' });
  const [msg, setMsg] = useState('');
  const reload = () => void api<ChannelRow[]>('GET', '/admin/channels').then(setRows).catch(() => undefined);
  useEffect(() => { void reload(); }, []);

  const create = async () => {
    try {
      await api('POST', '/gateway/channels', { ...form, models: form.models.split(',').map((m) => m.trim()).filter(Boolean) });
      setForm({ name: '', protocol: 'openai', baseUrl: '', apiKey: '', models: '' });
      setMsg('渠道已创建（真实 Key 加密存储于服务端，不出组织边界）');
      reload();
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>接入上游渠道（真实 Key 仅存服务端；客户端只拿虚拟 Key）</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ ...inputStyle, width: 120 }} />
          <select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })} style={inputStyle}>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <input placeholder="BaseURL" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} style={{ ...inputStyle, width: 240 }} />
          <input placeholder="API Key" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} style={{ ...inputStyle, width: 180 }} />
          <input placeholder="模型（逗号分隔）" value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} style={{ ...inputStyle, width: 200 }} />
          <button onClick={() => void create()} style={{ padding: '7px 14px', background: '#171717', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13 }}>接入</button>
        </div>
        {msg && <p style={{ fontSize: 12, color: '#555553' }}>{msg}</p>}
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
        <thead><tr><th style={th}>名称</th><th style={th}>协议</th><th style={th}>BaseURL</th><th style={th}>模型</th><th style={th}>健康</th></tr></thead>
        <tbody>
          {rows.map((c) => <tr key={c.id}><td style={td}>{c.name}</td><td style={td}>{c.protocol}</td><td style={td}>{c.baseUrl}</td><td style={td}>{(c.models as string[]).join(', ')}</td><td style={td}>{c.health}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
