import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { cardStyle, Onboarding, td, th } from '../App.js';

interface Overview {
  users: number; teams: number; workspaces: number; sharedSessions: number;
  deliverables: number; orgSkills: number;
  usage7d: { tokens: number; calls: number; activeUsers: number };
}

export function OverviewPage(): ReactElement {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<Overview>('GET', '/admin/overview').then(setData).catch((e) => setError(String(e.message)));
  }, []);
  if (error) return <p style={{ color: '#E11D48', fontSize: 13 }}>{error}</p>;
  if (!data) return <div className="skeleton" style={{ height: 120, ...cardStyle }} />;
  const cards: Array<[string, string | number]> = [
    ['用户', data.users], ['团队', data.teams], ['工作区', data.workspaces], ['共享会话', data.sharedSessions],
    ['交付物', data.deliverables], ['组织 Skill', data.orgSkills],
    ['7 日 Tokens', data.usage7d.tokens], ['7 日调用', data.usage7d.calls], ['7 日活跃用户', data.usage7d.activeUsers],
  ];
  const needsOnboarding = data.teams === 0 || data.users <= 1 || data.orgSkills === 0;
  return (
    <div data-testid="overview-cards">
      {needsOnboarding && <Onboarding step={data.teams === 0 ? 1 : data.users <= 1 ? 2 : 3} />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {cards.map(([label, value]) => (
          <div key={label} style={cardStyle}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
            <div style={{ fontSize: 12, color: '#555553' }}>{label}</div>
          </div>
        ))}
      </div>
      <table style={{ marginTop: 16, borderCollapse: 'collapse', width: '100%', background: '#fff', borderRadius: 8 }}>
        <thead><tr><th style={th}>最近 7 日用量汇总</th><th style={th}>数值</th></tr></thead>
        <tbody>
          <tr><td style={td}>Tokens（输入+输出）</td><td style={td}>{data.usage7d.tokens.toLocaleString()}</td></tr>
          <tr><td style={td}>网关调用次数</td><td style={td}>{data.usage7d.calls}</td></tr>
          <tr><td style={td}>活跃用户</td><td style={td}>{data.usage7d.activeUsers}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
