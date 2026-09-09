import { type ReactElement } from 'react';
import { cardStyle } from '../App.js';

export function SettingsPage(): ReactElement {
  return (
    <div style={{ ...cardStyle, fontSize: 13, lineHeight: 2 }}>
      <div>服务器时区：取宿主机时区（配额自然日历口径）</div>
      <div>告警 Webhook：配额 80% / 95% 阈值告警（随 T2.9 安全收尾接入）</div>
      <div>备份：pg_dump 每日 + 交付物卷 tar，保留 14 天（deploy/backup.sh）</div>
      <div>审计保留：180 天（追加写，REVOKE UPDATE/DELETE 随安全收尾）</div>
      <div style={{ color: '#919191', fontSize: 12 }}>部署变更后 docker compose pull && up -d；api 启动自动跑迁移（迁移前自动快照）。</div>
    </div>
  );
}
