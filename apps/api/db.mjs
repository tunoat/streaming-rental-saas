import pg from 'pg';
import { createHash, randomBytes, argon2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(argon2);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export async function transaction(fn) {
  for (let i = 0; ; i++) {
    const client = await pool.connect();
    const query = client.query.bind(client);
    try {
      await query('BEGIN');
      const result = await fn(query);
      await query('COMMIT');
      return result;
    } catch (error) {
      await query('ROLLBACK');
      if (i >= 2 || !['40001','40P01'].includes(error.code)) throw error;
    } finally {
      client.release();
    }
  }
}
export async function scope(q, auth, store) {
  await q("SELECT set_config('app.auth',$1,true),set_config('app.store',$2,true)", [auth.token, store]);
}
export function reject(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, errorCode: code });
}
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) reject(400,'PASSWORD_POLICY');
  return encodePassword(password,randomBytes(16).toString('hex'));
}
async function encodePassword(password,salt) {
  const value = await derive('argon2id', { message: Buffer.from(password), nonce: Buffer.from(salt,'hex'), parallelism: 1, memory: 65536, passes: 3, tagLength: 32 });
  return salt + ':' + value.toString('hex');
}
export async function matches(password, stored) {
  const localDemo=process.env.ALLOW_SHORT_DEMO_LOGIN==='yes' && (process.env.HOST??'127.0.0.1')==='127.0.0.1';
  if (typeof password !== 'string' || password.length < (localDemo?1:12) || password.length > 128) return false;
  return timingSafeEqual(Buffer.from(await encodePassword(password,stored.split(':')[0])), Buffer.from(stored));
}
export const username = value => {
  const normalized=typeof value==='string'?value.trim().toLowerCase():'';
  if (!/^[a-z0-9_.-]{3,64}$/.test(normalized)) reject(400,'INVALID_USERNAME');
  return normalized;
};
export const emailAddress = value => {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) || value.length > 254) reject(400,'INVALID_EMAIL');
  return value.trim().toLowerCase();
};
export async function authenticate(q, request, worker) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token) reject(401,'UNAUTHORIZED');
  const hash = digest(token);
  const { rows } = await q(worker
    ? 'SELECT id FROM workers WHERE token_digest=$1 AND expires_at>now()'
    : `UPDATE sessions s SET expires_at=now()+interval '30 days' FROM users u
       WHERE s.digest=$1 AND s.user_id=u.id AND u.active AND s.expires_at>now()
       RETURNING u.id,u.is_super,u.is_admin`, [hash]);
  if (!rows[0]) reject(401,'UNAUTHORIZED');
  return { ...rows[0], digest: hash, token };
}
export async function membership(q, auth, store, roles = ['OWNER','HEAD_STAFF','STAFF']) {
  const { rows } = await q('SELECT role FROM memberships WHERE store_id=$1 AND user_id=$2',[store,auth.id]);
  if (!roles.includes(rows[0]?.role)) reject(403,'TENANT_SCOPE_DENIED');
  await scope(q,auth,store);
  return rows[0].role;
}

