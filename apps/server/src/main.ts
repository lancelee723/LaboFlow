import 'reflect-metadata';
import { bootstrap } from './app.controller.js';

/**
 * T2.1 server entry. Config via env (deploy/docker-compose.yml wires them):
 *   DATABASE_URL          postgres://…          (required)
 *   JWT_SECRET            ≥32 chars             (required)
 *   SERVER_ENCRYPTION_KEY 静态密钥主键（AES-256-GCM，知识库 apiKey 等；未设时由 JWT_SECRET 派生，生产建议独立设置）
 *   PORT                  default 3000
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  if (!databaseUrl || !jwtSecret) {
    console.error('[laboflow-server] DATABASE_URL and JWT_SECRET are required');
    process.exit(1);
  }
  const { app, port } = await bootstrap({
    databaseUrl,
    jwtSecret,
    port: Number(process.env.PORT ?? 3000),
  });
  console.log(`[laboflow-server] listening on :${port} (P2 beta)`);
  app.enableShutdownHooks();
}

void main().catch((err) => {
  console.error('[laboflow-server] fatal:', err);
  process.exit(1);
});
