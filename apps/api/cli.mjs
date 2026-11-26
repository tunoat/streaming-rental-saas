import pg from 'pg';
import { digest, passwordHash, secret, username } from './db.mjs';

if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL required');
const client = new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});
const [command, workerId, ...stores] = process.argv.slice(2);
await client.connect();
try {
  await client.query('BEGIN');
  if (command === 'bootstrap') {
    await client.query('SELECT id FROM admin_guard FOR UPDATE');
    if ((await client.query('SELECT 1 FROM users WHERE is_super LIMIT 1')).rowCount) throw new Error('Bootstrap has already been used');
    const login = username(process.env.BOOTSTRAP_USERNAME);
    const password = await passwordHash(process.env.BOOTSTRAP_PASSWORD);
    const {rows:[user]} = await client.query('INSERT INTO users(username,password_hash,is_super) VALUES($1,$2,true) RETURNING id',[login,password]);
    await client.query("INSERT INTO admin_audit(actor_id,action,subject_id) VALUES($1,'ADMIN_BOOTSTRAPPED',$1)",[user.id]);
  } else if (['worker','gmail-worker'].includes(command) && /^[a-zA-Z0-9_-]{1,128}$/.test(workerId ?? '') && stores.length) {
    const token = process.env.BOT_WORKER_TOKEN;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw new Error('Inject a random 32-byte base64url BOT_WORKER_TOKEN');
    await client.query("INSERT INTO workers VALUES($1,$2,now()+interval '24 hours')",[workerId,digest(token)]);
    for (const store of stores) await client.query('INSERT INTO worker_stores VALUES($1,$2)',[workerId,store]);
    if(command==='gmail-worker') await client.query('INSERT INTO gmail_workers VALUES($1,$2)',[workerId,process.env.GMAIL_ADAPTER??'mock']);
  } else if (command === 'generate-worker-secret') {
    process.stdout.write(secret());
  } else {
    throw new Error('Unknown CLI command');
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

