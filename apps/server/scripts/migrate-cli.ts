import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';

/** Apply the Drizzle schema to DATABASE_URL. Idempotent (migrations table). */
const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl) {
  console.error('[migrate] DATABASE_URL is required');
  process.exit(1);
}
const pool = new Pool({ connectionString: databaseUrl });
const applied = await migrate(drizzle(pool));
console.log(`[migrate] applied ${applied} migration(s)`);
await pool.end();
