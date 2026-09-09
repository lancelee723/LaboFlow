import { useEffect, useState, type ReactElement } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';
import { OverviewPage } from './pages/Overview.js';
import { UsersPage } from './pages/Users.js';
import { TeamsPage } from './pages/Teams.js';
import { WorkspacesPage } from './pages/Workspaces.js';
import { ChannelsPage } from './pages/Channels.js';
import { QuotaPage } from './pages/Quota.js';
import { LibraryPage } from './pages/Library.js';
import { AuditPage } from './pages/Audit.js';
import { SettingsPage } from './pages/Settings.js';

/**
 * T2.9 Web 管理台（SPEC §4.2.7）：九页 + 首用引导三步。
 * 单页应用、无路由库（状态切换），fetch + token，样式内联 token 对齐附录 D。
 */

const PAGES = [
  { id: 'overview', label: '仪表盘', render: () => <OverviewPage /> },
  { id: 'users', label: '用户管理', render: () => <UsersPage /> },
  { id: 'teams', label: '团队管理', render: () => <TeamsPage /> },
  { id: 'workspaces', label: '工作区', render: () => <WorkspacesPage /> },
  { id: 'channels', label: '模型渠道', render: () => <ChannelsPage /> },
  { id: 'quota', label: '配额管理', render: () => <QuotaPage /> },
  { id: 'library', label: '组织资产', render: () => <LibraryPage /> },
  { id: 'audit', label: '审计日志', render: () => <AuditPage /> },
  { id: 'settings', label: '系统设置', render: () => <SettingsPage /> },
] as const;

export default function App(): ReactElement {
  const [loggedIn, setLoggedIn] = useState(!!getToken());
  const [page, setPage] = useState<string>('overview');
  const [loginError, setLoginError] = useState('');

  useEffect(() => {
    const onUnauth = () => setLoggedIn(false);
    window.addEventListener('laboflow:unauthorized', onUnauth);
    return () => window.removeEventListener('laboflow:unauthorized', onUnauth);
  }, []);

  if (!loggedIn) {
    const doLogin = async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setLoginError('');
      const form = new FormData(e.currentTarget);
      try {
        const r = await api<{ tokens: { accessToken: string }; role: string }>('POST', '/auth/login', {
          username: form.get('username'),
          password: form.get('password'),
        });
        if (r.role !== 'sys_admin') {
          setLoginError('仅系统管理员可登录管理台');
          return;
        }
        setToken(r.tokens.accessToken);
        setLoggedIn(true);
      } catch (err) {
        setLoginError(err instanceof Error ? err.message : String(err));
      }
    };
    return (
      <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#F6F6F6', fontFamily: 'system-ui, sans-serif' }}>
        <form onSubmit={(e) => void doLogin(e)} data-testid="admin-login" style={{ background: '#fff', padding: 32, borderRadius: 12, border: '1px solid #E6E6E5', width: 320 }}>
          <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>LaboFlow 管理台</h1>
          <p style={{ fontSize: 12, color: '#555553', margin: '0 0 16px' }}>使用系统管理员账号登录</p>
          <input name="username" placeholder="用户名" required style={inputStyle} />
          <input name="password" type="password" placeholder="密码" required style={{ ...inputStyle, marginTop: 8 }} />
          {loginError && <p style={{ color: '#E11D48', fontSize: 12, marginTop: 8 }}>{loginError}</p>}
          <button type="submit" data-testid="admin-login-submit" style={{ marginTop: 12, width: '100%', padding: '8px 0', background: '#171717', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600 }}>登录</button>
        </form>
      </div>
    );
  }

  const current = PAGES.find((p) => p.id === page) ?? PAGES[0]!;
  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'system-ui, sans-serif', background: '#FAFAFA' }}>
      <nav style={{ width: 200, background: '#F6F6F6', borderRight: '1px solid #E6E6E5', padding: 12 }} data-testid="admin-nav">
        <div style={{ fontWeight: 700, fontSize: 14, padding: '8px 10px 16px' }}>LaboFlow 管理台</div>
        {PAGES.map((p) => (
          <button
            key={p.id}
            data-testid={`nav-${p.id}`}
            onClick={() => setPage(p.id)}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', marginBottom: 2,
              borderRadius: 8, border: 'none', fontSize: 13, cursor: 'pointer',
              background: page === p.id ? '#EFEFEE' : 'transparent', fontWeight: page === p.id ? 600 : 400,
              color: '#171717',
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          data-testid="admin-logout"
          onClick={() => { clearToken(); setLoggedIn(false); }}
          style={{ marginTop: 16, width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid #E6E6E5', background: '#fff', fontSize: 12, cursor: 'pointer' }}
        >
          退出登录
        </button>
      </nav>
      <main style={{ flex: 1, padding: 24, minWidth: 0 }} data-testid={`page-${page}`}>
        <h1 style={{ fontSize: 17, margin: '0 0 16px' }}>{current.label}</h1>
        {current.render()}
      </main>
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid #E6E6E5', fontSize: 13, boxSizing: 'border-box',
};
export const cardStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #E6E6E5', borderRadius: 8, padding: 16,
};
export const th: React.CSSProperties = { textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #E6E6E5', fontSize: 12, color: '#555553' };
export const td: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #EFEFEE', fontSize: 13 };

/** 首用引导三步（SPEC §4.2.7）：建团队 → 建用户 → 接模型。 */
export function Onboarding({ step }: { step: 1 | 2 | 3 }): ReactElement {
  const labels = { 1: '① 创建第一个团队', 2: '② 创建用户并分配到团队', 3: '③ 接入模型渠道' };
  return (
    <div style={{ ...cardStyle, display: 'flex', gap: 12, marginBottom: 16, fontSize: 12.5 }} data-testid="onboarding">
      {([1, 2, 3] as const).map((s) => (
        <span key={s} style={{ padding: '4px 10px', borderRadius: 6, background: s <= step ? '#171717' : '#EFEFEE', color: s <= step ? '#fff' : '#555553' }}>
          {labels[s]}
        </span>
      ))}
    </div>
  );
}
