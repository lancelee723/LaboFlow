import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { cardStyle, td, th } from '../App.js';

interface CatalogRow { name: string; latestVersion: string; versions: string[] }

export function LibraryPage(): ReactElement {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const reload = () => void api<CatalogRow[]>('GET', '/library/skills').then(setRows).catch(() => undefined);
  useEffect(() => { void reload(); }, []);
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
      <thead><tr><th style={th}>Skill</th><th style={th}>最新版本</th><th style={th}>全部版本</th><th style={th}>下发状态</th></tr></thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.name}><td style={td}>{s.name}</td><td style={td}>{s.latestVersion}</td><td style={td}>{s.versions.join(', ')}</td><td style={td}>登录自动下发（客户端只读安装）</td></tr>
        ))}
      </tbody>
    </table>
  );
}
