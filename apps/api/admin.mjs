import { digest, matches, membership, passwordHash, reject, secret, transaction, username } from './db.mjs';
import { uuid } from './jobs.mjs';

const eligibleOwners=`NOT u.is_super AND NOT u.is_admin AND u.active AND (
  EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.role='OWNER')
  OR EXISTS (SELECT 1 FROM admin_audit a WHERE a.subject_id=u.id AND a.action='OWNER_CREATED')
  OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=u.id)
)`;
const isOwner=`EXISTS (SELECT 1 FROM memberships WHERE user_id=$1 AND role='OWNER')
  OR EXISTS (SELECT 1 FROM admin_audit WHERE subject_id=$1 AND action='OWNER_CREATED')`;

async function createStore(q, name, ownerId, actorId) {
  const {rows:[store]} = await q('INSERT INTO stores(name) VALUES($1) RETURNING id,name',[name]);
  await q("INSERT INTO memberships VALUES($1,$2,'OWNER')",[store.id,ownerId]);
  await q("INSERT INTO admin_audit(actor_id,action,subject_id) VALUES($1,'STORE_CREATED',$2)",[actorId,store.id]);
  return store;
}
function storeName(value) {
  const name=typeof value==='string'?value.trim():'';
  if (!name || name.length>100) reject(400,'INVALID_NAME');
  return name;
}

export function registerAdmin(app, secured) {
  app.post('/v1/login', async (req, reply) => {
    const login = username(req.body?.username);
    const result = await transaction(async q => {
      const { rows: [user] } = await q('SELECT * FROM users WHERE username=$1 FOR UPDATE',[login]);
      const dummy = '0'.repeat(32)+':'+'0'.repeat(64);
      const ok = await matches(req.body?.password,user?.password_hash ?? dummy);
      if (!user?.active || (user.locked_until && user.locked_until > new Date())) return;
      if (!ok) {
        await q(`UPDATE users SET
          failed=CASE WHEN failed_since>now()-interval '15 minutes' THEN failed+1 ELSE 1 END,
          locked_until=CASE WHEN failed_since>now()-interval '15 minutes' AND failed>=4 THEN now()+interval '15 minutes' END,
          failed_since=CASE WHEN failed_since>now()-interval '15 minutes' THEN failed_since ELSE now() END WHERE id=$1`,[user.id]);
        return;
      }
      await q('UPDATE users SET failed=0,failed_since=NULL,locked_until=NULL WHERE id=$1',[user.id]);
      const token = secret();
      await q("INSERT INTO sessions VALUES ($1,$2,now()+interval '30 days')",[digest(token),user.id]);
      return {token};
    });
    if (!result) reject(401,'UNAUTHORIZED');
    return reply.header('cache-control','no-store').send(result);
  });
  secured('POST','/v1/logout',async(q,auth) => {
    await q('DELETE FROM sessions WHERE digest=$1',[auth.digest]);
    return { ok:true };
  });
  secured('GET','/v1/me',async(q,auth) => ({
    is_super:auth.is_super,
    is_admin:auth.is_admin,
    is_owner:!auth.is_super&&!auth.is_admin&&(await q('SELECT '+isOwner+' AS available',[auth.id])).rows[0].available,
    stores:(await q('SELECT s.id,s.name,m.role FROM stores s JOIN memberships m ON m.store_id=s.id WHERE m.user_id=$1',[auth.id])).rows
  }));
  secured('GET','/v1/admin/stores',async(q,auth,{query}) => {
    if (!auth.is_super) reject(403,'FORBIDDEN');
    const owner=query.owner_id??null;
    if (owner!==null&&(typeof owner!=='string'||!uuid.test(owner))) reject(400,'INVALID_ID');
    return (await q(`SELECT s.id,s.name,s.plan,s.status,s.expires_at FROM stores s
      WHERE $1::uuid IS NULL OR EXISTS (SELECT 1 FROM memberships m
        WHERE m.store_id=s.id AND m.user_id=$1 AND m.role='OWNER') ORDER BY s.name,s.id`,[owner])).rows;
  });
  secured('GET','/v1/admin/stores/:storeId/sales',async(q,auth,{params:{storeId}})=>{
    if (!auth.is_super) reject(403,'FORBIDDEN');
    const {rows:[{report,monthly_cost}]}=await q(`SELECT public.admin_store_sales($1,$2) AS report,
      public.admin_monthly_account_cost(NULL,$1,$2) AS monthly_cost`,[storeId,auth.token]);
    if (!report) reject(404,'NOT_FOUND');
    return {...report,monthly_cost};
  });
  secured('GET','/v1/admin/owners',async(q,auth)=>{
    if (!auth.is_super) reject(403,'FORBIDDEN');
    return (await q(`SELECT u.id,u.username,u.active,
      (SELECT count(*)::int FROM memberships m WHERE m.user_id=u.id AND m.role='OWNER') AS store_count
      FROM users u WHERE u.removed_at IS NULL AND ((${eligibleOwners}) OR EXISTS (
        SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.role='OWNER') OR EXISTS (
        SELECT 1 FROM admin_audit a WHERE a.subject_id=u.id AND a.action='OWNER_CREATED'))
      ORDER BY u.username,u.id`)).rows;
  });
  secured('GET','/v1/admin/owners/:ownerId/overview',async(q,auth,{params:{ownerId}})=>{
    if (!auth.is_super) reject(403,'FORBIDDEN');
    const {rows:[owner]}=await q(`SELECT id,username,public.admin_monthly_account_cost(id,NULL,$2) AS monthly_cost
      FROM users WHERE id=$1 AND removed_at IS NULL AND NOT is_super AND NOT is_admin AND (${isOwner})`,[ownerId,auth.token]);
    if (!owner) reject(404,'NOT_FOUND');
    return owner;
  });
  secured('POST','/v1/admin/stores/:storeId/status',async(q,auth,{body,params:{storeId}})=>{
    if (!auth.is_super) reject(403,'FORBIDDEN');
    if (!['ACTIVE','SUSPENDED'].includes(body?.status)) reject(400,'INVALID_STORE_STATUS');
    await q('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[storeId]);
    const {rows:[store]}=await q(`UPDATE stores SET status=$2 WHERE id=$1 AND status=$3 AND status IN ('ACTIVE','SUSPENDED')
      RETURNING id,status,expires_at`,[storeId,body.status,body.expected_status??null]);
    if (!store) reject(409,'STORE_SETTINGS_CHANGED');
    await q("INSERT INTO admin_audit(actor_id,action,subject_id) VALUES($1,$2,$3)",[auth.id,'STORE_'+store.status,storeId]);
    return store;
  });
  secured('POST','/v1/admin/stores/:storeId/expiry',async(q,auth,{body,params:{storeId}})=>{
    if (!auth.is_super) reject(403,'FORBIDDEN');
    if (!['CALENDAR','ADD_MONTH'].includes(body?.mode)) reject(400,'INVALID_EXPIRY');
    const day=body.date;
    if (body.mode==='CALENDAR' && (typeof day!=='string'||!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(day)||
      !Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)) reject(400,'INVALID_EXPIRY');
    await q('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[storeId]);
    const {rows:[current]}=await q('SELECT status,expires_at FROM stores WHERE id=$1',[storeId]);
    if (!current || current.status==='CLOSED' || current.expires_at.toISOString()!==body.expected_expiry) reject(409,'STORE_SETTINGS_CHANGED');
    const {rows:[store]}=await q(`UPDATE stores SET expires_at=CASE WHEN $2='CALENDAR'
      THEN (($3::date+1)::timestamp AT TIME ZONE 'Asia/Bangkok')
      ELSE ((greatest(expires_at-interval '1 microsecond',clock_timestamp()) AT TIME ZONE 'Asia/Bangkok')
        +interval '1 month'+interval '1 microsecond') AT TIME ZONE 'Asia/Bangkok'
      END WHERE id=$1 RETURNING id,status,expires_at`,[storeId,body.mode,body.mode==='CALENDAR'?day:null]);
    await q("INSERT INTO admin_audit(actor_id,action,subject_id) VALUES($1,'STORE_EXPIRY_CHANGED',$2)",[auth.id,storeId]);
    return store;
  });
  async function confirm(q,auth,password,allowAdmin=false) {
    if (!auth.is_super && !(allowAdmin&&auth.is_admin)) reject(403,'FORBIDDEN');
    await q('SELECT id FROM admin_guard FOR UPDATE');
    const {rows:[actor]} = await q('SELECT active,password_hash FROM users WHERE id=$1 FOR UPDATE',[auth.id]);
    if (!actor?.active || !await matches(password,actor.password_hash)) reject(403,'REAUTH_REQUIRED');
  }
  for (const [directory,kind] of [['owners','OWNER'],['admins','ADMIN']]) {
    secured('POST','/v1/admin/'+directory+'/:userId/remove',async(q,auth,{body,params:{userId}})=>{
      await confirm(q,auth,body?.current_password);
      if (body.confirm!==true) reject(400,'CONFIRM_REQUIRED');
      if (!uuid.test(userId)) reject(400,'INVALID_ID');
      const {rows:[result]}=await q('SELECT public.remove_platform_user($1,$2,$3) AS removed',[userId,kind,auth.token]);
      if (!result.removed) reject(404,'NOT_FOUND');
      return {ok:true};
    });
  }
  secured('GET','/v1/admin/admins',async(q,auth) => {
    if (!auth.is_super) reject(403,'FORBIDDEN');
    return (await q(`SELECT id,username,active,CASE WHEN is_super THEN 'Super Admin' ELSE 'Admin' END AS role
      FROM users WHERE is_super OR is_admin ORDER BY username`)).rows;
  });
  secured('POST','/v1/admin/users',async(q,auth,{body}) => {
    await confirm(q,auth,body?.current_password,true);
    if (!['ADMIN','OWNER'].includes(body.role)) reject(400,'INVALID_ROLE');
    if (body.role==='ADMIN'&&!auth.is_super) reject(403,'FORBIDDEN');
    const {rows:[user]} = await q('INSERT INTO users(username,password_hash,is_admin) VALUES($1,$2,$3) RETURNING id,username,active',
      [username(body.username),await passwordHash(body.password),body.role==='ADMIN']);
    await q('INSERT INTO admin_audit(actor_id,action,subject_id) VALUES($1,$2,$3)',[auth.id,body.role+'_CREATED',user.id]);
    return {...user,role:body.role};
  });
  secured('POST','/v1/admin/admins/:userId/status',async(q,auth,{body,params}) => {
    await confirm(q,auth,body?.current_password);
    if (typeof body.active !== 'boolean') reject(400,'INVALID_INPUT');
    const {rows:[subject]} = await q('SELECT active,is_super FROM users WHERE id=$1 AND (is_super OR is_admin) FOR UPDATE',[params.userId]);
    if (!subject) reject(404,'NOT_FOUND');
    const {rows:[{count}]} = await q('SELECT count(*)::int AS count FROM users WHERE is_super AND active');
    if (subject.is_super && subject.active && !body.active && count <= 1) reject(409,'LAST_ACTIVE_ADMIN');
    await q('UPDATE users SET active=$2 WHERE id=$1',[params.userId,body.active]);
    if (!body.active) await q('DELETE FROM sessions WHERE user_id=$1',[params.userId]);
    await q("INSERT INTO admin_audit(actor_id,action,subject_id) VALUES($1,$2,$3)",[auth.id,body.active?'ADMIN_ACTIVATED':'ADMIN_DISABLED',params.userId]);
    return {ok:true};
  });
  secured('POST','/v1/admin/stores',async(q,auth,{body}) => {
    await confirm(q,auth,body?.current_password);
    const name = storeName(body.name);
    if (typeof body.owner_id!=='string'||!uuid.test(body.owner_id)) reject(400,'INVALID_ID');
    const {rows:[user]} = await q(`SELECT u.id FROM users u WHERE u.id=$1 AND ${eligibleOwners} FOR UPDATE`,[body.owner_id]);
    if (!user) reject(409,'OWNER_UNAVAILABLE');
    return createStore(q,name,user.id,auth.id);
  });
  secured('POST','/v1/stores/:storeId/store-requests',async(q,auth,{body,params:{storeId}}) => {
    await membership(q,auth,storeId,['OWNER']);
    await q('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[storeId]);
    const active=await q("SELECT 1 FROM stores WHERE id=$1 AND status='ACTIVE' AND expires_at>now()",[storeId]);
    if (!active.rowCount) reject(409,'STORE_NOT_OPEN_FOR_SALES');
    return createStoreRequest(q,auth.id,body?.name);
  });
  async function createStoreRequest(q,userId,name) {
    const {rows:[entry]}=await q(`INSERT INTO store_creation_requests(requester_id,name) VALUES($1,$2)
      ON CONFLICT DO NOTHING RETURNING id,name,status`,[userId,storeName(name)]);
    if (!entry) reject(409,'STORE_REQUEST_PENDING');
    return entry;
  }
  async function assertOwner(q,auth) {
    if (auth.is_super||auth.is_admin||!(await q('SELECT '+isOwner+' AS available',[auth.id])).rows[0].available)
      reject(403,'FORBIDDEN');
  }
  const storeRequests=async(q,userId)=>(await q(`SELECT id,name,status,store_id FROM store_creation_requests
    WHERE requester_id=$1 ORDER BY created_at DESC,id LIMIT 100`,[userId])).rows;
  secured('GET','/v1/stores/:storeId/store-requests',async(q,auth,{params:{storeId}}) => {
    await membership(q,auth,storeId,['OWNER']);
    return storeRequests(q,auth.id);
  });
  secured('GET','/v1/owner/store-requests',async(q,auth)=>{
    await assertOwner(q,auth);
    return storeRequests(q,auth.id);
  });
  secured('POST','/v1/owner/store-requests',async(q,auth,{body})=>{
    await assertOwner(q,auth);
    const owned=await q("SELECT 1 FROM memberships WHERE user_id=$1 AND role='OWNER'",[auth.id]);
    if (owned.rowCount) reject(409,'USE_ACTIVE_STORE');
    return createStoreRequest(q,auth.id,body?.name);
  });
  secured('GET','/v1/admin/store-requests/pending-count',async(q,auth) => {
    if (!auth.is_super&&!auth.is_admin) reject(403,'FORBIDDEN');
    return (await q("SELECT count(*)::int AS count FROM store_creation_requests WHERE status='PENDING'")).rows[0];
  });
  secured('GET','/v1/admin/store-requests',async(q,auth,{query}) => {
    if (!auth.is_super&&!auth.is_admin) reject(403,'FORBIDDEN');
    const scope=query.scope??'all', page=Number(query.page??0);
    if (!['all','pending','history'].includes(scope)||!Number.isSafeInteger(page)||page<0||page>100000) reject(400,'INVALID_INPUT');
    return (await q(`SELECT r.id,r.name,r.status,u.username,reviewer.username AS reviewer,r.reviewed_at
      FROM store_creation_requests r JOIN users u ON u.id=r.requester_id LEFT JOIN users reviewer ON reviewer.id=r.reviewer_id
      WHERE ($1='all' OR ($1='pending' AND r.status='PENDING') OR ($1='history' AND r.status<>'PENDING'))
      ORDER BY (r.status='PENDING') DESC,coalesce(r.reviewed_at,r.created_at) DESC,r.id LIMIT $2 OFFSET $3`,
      [scope,scope==='history'?36:100,scope==='history'?page*35:0])).rows;
  });
  secured('POST','/v1/admin/store-requests/:requestId/review',async(q,auth,{body,params:{requestId}}) => {
    await confirm(q,auth,body?.current_password,true);
    if (!['APPROVED','REJECTED'].includes(body?.status)) reject(400,'INVALID_INPUT');
    if (!auth.is_super&&body.status!=='APPROVED') reject(403,'FORBIDDEN');
    const {rows:[entry]}=await q('SELECT * FROM store_creation_requests WHERE id=$1 FOR UPDATE',[requestId]);
    if (!entry) reject(404,'NOT_FOUND');
    if (entry.status!=='PENDING') reject(409,'STORE_REQUEST_REVIEWED');
    let storeId=null;
    if (body.status==='APPROVED') {
      const requester=await q('SELECT 1 FROM users WHERE id=$1 AND active FOR UPDATE',[entry.requester_id]);
      if (!requester.rowCount) reject(409,'REQUESTER_INACTIVE');
      storeId=(await createStore(q,entry.name,entry.requester_id,auth.id)).id;
    }
    await q(`UPDATE store_creation_requests SET status=$2,reviewer_id=$3,reviewed_at=now(),store_id=$4 WHERE id=$1`,
      [entry.id,body.status,auth.id,storeId]);
    return {status:body.status,store_id:storeId};
  });
  async function changePassword(q,auth,body) {
    const {rows:[user]}=await q('SELECT password_hash FROM users WHERE id=$1 AND active FOR UPDATE',[auth.id]);
    if (!user || !await matches(body?.current_password,user.password_hash)) reject(403,'REAUTH_REQUIRED');
    if (body.new_password===body.current_password) reject(400,'PASSWORD_UNCHANGED');
    await q('UPDATE users SET password_hash=$2,failed=0,failed_since=NULL,locked_until=NULL WHERE id=$1',
      [auth.id,await passwordHash(body.new_password)]);
    await q('DELETE FROM sessions WHERE user_id=$1 AND digest<>$2',[auth.id,auth.digest]);
    await q("INSERT INTO admin_audit(actor_id,action,subject_id) VALUES($1,'PASSWORD_CHANGED',$1)",[auth.id]);
    return {ok:true};
  }
  secured('POST','/v1/stores/:storeId/owner-password',async(q,auth,{body,params:{storeId}}) => {
    await membership(q,auth,storeId,['OWNER']);
    return changePassword(q,auth,body);
  });
  secured('POST','/v1/admin/password',async(q,auth,{body})=>{
    if (!auth.is_super&&!auth.is_admin) reject(403,'FORBIDDEN');
    return changePassword(q,auth,body);
  });
  secured('POST','/v1/owner/password',async(q,auth,{body})=>{
    await assertOwner(q,auth);
    return changePassword(q,auth,body);
  });
  secured('POST','/v1/stores/:storeId/staff',async(q,auth,{body,params:{storeId}}) => {
    await membership(q,auth,storeId,['OWNER']);
    await q('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[storeId]);
    const {rows:[store]} = await q('SELECT plan,status,expires_at FROM stores WHERE id=$1',[storeId]);
    const {rows:[{count}]} = await q("SELECT count(*)::int AS count FROM memberships WHERE store_id=$1 AND role<>'OWNER'",[storeId]);
    if (store.status!=='ACTIVE' || store.expires_at<=new Date() || count>=({STARTER:2,PRO:4,BUSINESS:8})[store.plan]) reject(409,'STAFF_LIMIT');
    if (!['HEAD_STAFF','STAFF'].includes(body?.role)) reject(400,'INVALID_ROLE');
    const {rows:[user]} = await q('INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id,username',
      [username(body.username),await passwordHash(body.password)]);
    await q('INSERT INTO memberships VALUES($1,$2,$3)',[storeId,user.id,body.role]);
    return user;
  });
}

