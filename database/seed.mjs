import pg from 'pg';
import { passwordHash } from '../apps/api/db.mjs';

if (process.env.NODE_ENV==='production' || process.env.ALLOW_DEMO_SEED!=='yes') throw new Error('Set ALLOW_DEMO_SEED=yes for disposable local seed');
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL required');
const client=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(710626)');
  for (const [suffix,name,id] of [
    ['a','Demo A','11111111-1111-4111-8111-111111111111'],
    ['b','Demo B','22222222-2222-4222-8222-222222222222']
  ]) {
    const {rows:[user]}=await client.query(`INSERT INTO users(username,password_hash) VALUES($1,$2)
      ON CONFLICT(username) DO NOTHING RETURNING id`,['owner-'+suffix,await passwordHash('Local-Demo-Owner-2026!')]);
    if (!user) continue;
    await client.query('INSERT INTO stores(id,name) VALUES($1,$2)',[id,name]);
    await client.query("INSERT INTO memberships VALUES($1,$2,'OWNER')",[id,user.id]);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { await client.end(); }

