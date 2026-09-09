import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { hash } from '@node-rs/argon2';
import { users } from '../src/db/schema.js';

/**
 * SPEC §5.6 first-boot seed: create the system administrator directly.
 * Usage: DATABASE_URL=… tsx scripts/seed-admin.ts [username] [password]
 * Skips when the user already exists so reruns are safe.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl) {
  console.error('[seed-admin] DATABASE_URL is required');
  process.exit(1);
}
const username = process.argv[2] ?? 'admin';
const password = process.argv[3] ?? 'InitPass123';

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool);
const existing = await db.select().from(users);
if (existing.some((row) => row.username === username)) {
  console.log(`[seed-admin] ${username} already exists — skipped`);
} else {
  await db.insert(users).values({
    username,
    displayName: '系统管理员',
    passwordHash: await hash(password),
    mustChangePassword: true,
    role: 'sys_admin',
  });
  console.log(`[seed-admin] seeded ${username} (mustChangePassword=true)`);
}
await pool.end();
