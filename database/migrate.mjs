import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL required');
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const client = await pool.connect();
const folder = new URL('./migrations/', import.meta.url);
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(710625)');
  await client.query('CREATE TABLE IF NOT EXISTS migration_history (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(folder)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, folder), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const known = (await client.query('SELECT checksum FROM migration_history WHERE version=$1', [name])).rows[0];
    if (known?.checksum !== undefined && known.checksum !== checksum) throw new Error('Migration checksum mismatch: ' + name);
    if (known) continue;
    await client.query(sql);
    await client.query('INSERT INTO migration_history(version,checksum) VALUES ($1,$2)', [name, checksum]);
    console.log('Applied ' + name);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}

