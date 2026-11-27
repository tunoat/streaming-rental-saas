import { createHmac, randomUUID } from 'node:crypto';
import { digest, membership, reject, scope } from './db.mjs';
import { jobTypes, jobStatuses, operations } from './contract.mjs';
import { applyEvidence, validateTarget } from './workflow.mjs';

const audits = {QUEUED:'job.queued',LEASED:'job.claimed',RUNNING:'job.started',SUCCEEDED:'job.succeeded',FAILED:'job.failed',RETRY_WAIT:'job.retry_scheduled',RECONCILING:'job.reconciling',CANCELLED:'job.cancelled',DEAD_LETTER:'job.failed'};
const uncertainType = new Set(['DELIVER_ACCESS','REVOKE_ACCESS','RECONCILE_DELIVERY','RECONCILE_REVOCATION']);
const leaseSeconds = Number(process.env.BOT_LEASE_SECONDS ?? 120);
if (!Number.isInteger(leaseSeconds) || leaseSeconds<1 || leaseSeconds>600) throw new Error('Invalid lease duration');
const leaseToken = (auth, id, fence) => createHmac('sha256',auth.token).update(id+':'+fence).digest('base64url');
export const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const publicJob = ({id,store_id,type,status,priority,attempt,created_at,account_id,profile_id,order_id,rental_id}) => ({
  id,store_id,type,status,priority,attempt,created_at:created_at.toISOString(),
  ...(account_id && {account_id}), ...(profile_id && {profile_id}), ...(order_id && {order_id}), ...(rental_id && {rental_id})
});
function priority(type) {
  if (type.startsWith('RECONCILE') || type==='RECOVERY_VERIFICATION') return 1;
  if (type==='DELIVER_ACCESS') return 2;
  if (type==='REVOKE_ACCESS') return 3;
  return 4;
}
async function audit(q, job, actor, requestId, event = audits[job.status]) {
  await q('INSERT INTO job_events(store_id,job_id,event_type,actor,request_id) VALUES($1,$2,$3,$4,$5)',
    [job.store_id,job.id,event,actor,requestId]);
}
async function incident(q,job,reason,actor,requestId) {
  const added=await q('INSERT INTO incidents(store_id,job_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [job.store_id,job.id,reason]);
  if (added.rowCount) await audit(q,job,actor,requestId,'incident.opened');
}
export async function enqueue(q,store,b,actor,requestId, parent=null) {
  const {rows:[job]}=await q(`INSERT INTO jobs(store_id,type,priority,account_id,profile_id,order_id,rental_id,reconciles_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [store,b.type,priority(b.type),b.account_id??null,b.profile_id??null,b.order_id??null,b.rental_id??null,parent]);
  await audit(q,job,actor,requestId);
  return job;
}
async function updateStatus(q,job,status,error=null) {
  const {rows:[row]} = await q(`UPDATE jobs SET status=$3,error_code=$4,lease_digest=NULL,lease_until=NULL,
    ready_at=now()+CASE WHEN $3='RETRY_WAIT' THEN (power(2,attempt)*5+random()*3)*interval '1 second' ELSE interval '0 seconds' END
    WHERE store_id=$1 AND id=$2 RETURNING *`,[job.store_id,job.id,status,error]);
  return row;
}
const maxAttempts = job => job.type==='REVOKE_ACCESS' ? 4 : 3;
async function uncertain(q,job,actor,requestId) {
  if (job.profile_id) await q("UPDATE profiles SET status='HELD' WHERE store_id=$1 AND id=$2",[job.store_id,job.profile_id]);
  await incident(q,job,'RECONCILIATION_REQUIRED',actor,requestId);
  if (job.type.startsWith('RECONCILE')) return updateStatus(q,job,'DEAD_LETTER');
  const type = job.type==='DELIVER_ACCESS' ? 'RECONCILE_DELIVERY' : 'RECONCILE_REVOCATION';
  await enqueue(q,job.store_id,{...job,type},actor,requestId,job.id);
  return updateStatus(q,job,'RECONCILING');
}
async function reap(q,store,actor,requestId) {
  const {rows} = await q("SELECT * FROM jobs WHERE store_id=$1 AND status IN ('LEASED','RUNNING') AND lease_until<=clock_timestamp() FOR UPDATE",[store]);
  for (const job of rows) {
    const changed = job.status==='RUNNING' && uncertainType.has(job.type)
      ? await uncertain(q,job,actor,requestId)
      : await updateStatus(q,job,job.attempt<maxAttempts(job)?'RETRY_WAIT':'DEAD_LETTER','TIMEOUT');
    await audit(q,changed,actor,requestId);
  }
}
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
export async function idempotent(q,auth,store,req,fn) {
  const key=req.headers['idempotency-key'];
  const fingerprint=digest(JSON.stringify(canonical(req.body)));
  const route=req.url.split('?')[0];
  const params=[store,auth.id,route,key];
  const {rows:[saved]}=await q('SELECT fingerprint,status,response FROM requests WHERE store_id=$1 AND actor=$2 AND route=$3 AND key=$4',params);
  if (saved) {
    if (saved.fingerprint!==fingerprint) reject(409,'IDEMPOTENCY_CONFLICT');
    return [saved.status,saved.response];
  }
  const [status,response] = await fn();
  await q('INSERT INTO requests VALUES($1,$2,$3,$4,$5,$6,$7)',[...params,fingerprint,status,response]);
  return [status,response];
}
export async function lockStore(q,store) {
  await q('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[store]);
}
function completedEvidence(b,job,action) {
  if (b.evidence.kind!=='MOCK' || b.evidence.source!=='mock-provider' || !/^mock-[a-z0-9-]{1,100}$/.test(b.evidence.reference))
    reject(400,'EVIDENCE_REQUIRED');
  const observed = Date.parse(b.observed_at);
  if (observed > Date.now()+5000 || observed < job.run_at.getTime()-1000 || b.evidence.observed_at!==b.observed_at)
    reject(409,'STALE_EVIDENCE');
  if ((action==='complete')!==(b.outcome==='PASS')) reject(409,'INVALID_TRANSITION');
  if (action==='fail') return;
  const checks = {
    VERIFY_LOGIN:['login'], VERIFY_SUBSCRIPTION:['subscription'], VERIFY_PROFILE_READINESS:['profile_readiness'],
    HEALTH_CHECK:['login','subscription','profile_readiness'], RECOVERY_VERIFICATION:['login','subscription','profile_readiness']
  }[job.type] ?? [];
  if (checks.some(key=>b.checks?.[key]!=='PASS') ||
      (checks.includes('subscription') && !(Date.parse(b.subscription_expires_at)>observed))) reject(400,'EVIDENCE_REQUIRED');
  const time = job.type.includes('DELIVERY') || job.type==='DELIVER_ACCESS' ? b.delivery_occurred_at :
    job.type.includes('REVO') ? b.access_revoked_at : undefined;
  if (uncertainType.has(job.type) && (!time || Date.parse(time)<job.created_at.getTime()-1000 || Date.parse(time)>observed))
    reject(400,'EVIDENCE_REQUIRED');
}
async function action(q,job,auth,req,operation) {
  const b=req.body;
  if (b.worker_id!==auth.id) reject(403,'FORBIDDEN');
  if (!job.lease_until || !job.lease_live || b.fencing_token!==job.fence ||
      digest(b.lease_token)!==job.lease_digest) reject(409,'STALE_FENCING_TOKEN');
  const expected=operation==='start'?'LEASED':'RUNNING';
  if(job.status!==expected) reject(409,'INVALID_TRANSITION');
  if (operation==='start' || operation==='heartbeat') {
    const {rows:[changed]}=await q(`UPDATE jobs SET status='RUNNING',run_at=COALESCE(run_at,clock_timestamp()),
      lease_until=clock_timestamp()+$3*interval '1 second' WHERE store_id=$1 AND id=$2 RETURNING *`,
      [job.store_id,job.id,leaseSeconds]);
    await audit(q,changed,auth.id,req.id,operation==='heartbeat'?'job.heartbeat':undefined);
    return changed;
  }
  completedEvidence(b,job,operation);
  const evidence = {outcome:b.outcome, evidence:b.evidence && {kind:b.evidence.kind,source:b.evidence.source,reference:b.evidence.reference,observed_at:b.evidence.observed_at}};
  await q('UPDATE jobs SET result=$3 WHERE store_id=$1 AND id=$2',[job.store_id,job.id,evidence]);
  await applyEvidence(q,job,b);
  if (job.account_id && b.outcome!=='PASS' && ['ACCOUNT_LOCKED','SUBSCRIPTION_INVALID'].includes(b.error_code))
    await incident(q,job,b.error_code,auth.id,req.id);
  let changed;
  if (operation==='complete') changed=await updateStatus(q,job,'SUCCEEDED');
  else if (uncertainType.has(job.type) && !(job.type==='REVOKE_ACCESS' && ['NETWORK_ERROR','TIMEOUT'].includes(b.error_code) && job.attempt<maxAttempts(job))) changed=await uncertain(q,job,auth.id,req.id);
  else {
    const retry=['NETWORK_ERROR','TIMEOUT'].includes(b.error_code);
    changed=await updateStatus(q,job,retry?(job.attempt<maxAttempts(job)?'RETRY_WAIT':'DEAD_LETTER'):'FAILED',b.error_code);
  }
  await audit(q,changed,auth.id,req.id);
  return changed;
}
function send(reply,op,status,body) {
  if (op.schemas[status] && !op.schemas[status](body)) throw new Error('Invalid API response');
  return reply.code(status).send(body ?? undefined);
}
export function registerJobs(secured) {
  for (const op of operations) {
    const worker=op.path.startsWith('/v1/worker/');
    secured(op.method,op.route,async(q,auth,req,reply) => {
      const {storeId,jobId}=req.params;
      if ((storeId && !uuid.test(storeId)) || (jobId && !uuid.test(jobId))) reject(400,'INVALID_ID');
      if (op.body && (!op.body(req.body) || !/^[a-zA-Z0-9_-]{8,128}$/.test(req.headers['idempotency-key']??'') ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(req.headers['x-request-id']??''))) reject(400,'INVALID_REQUEST');
      const operation=op.path.split('/').at(-1);
      if (!worker) {
        await membership(q,auth,storeId,['cancel','retry'].includes(operation)?['OWNER','HEAD_STAFF']:undefined);
        if (op.method==='GET') {
          if (jobId) {
            const {rows:[job]}=await q('SELECT * FROM jobs WHERE store_id=$1 AND id=$2',[storeId,jobId]);
            if (!job) reject(404,'JOB_NOT_FOUND');
            const {rows:history}=await q('SELECT event_id,event_type,occurred_at FROM job_events WHERE store_id=$1 AND job_id=$2 ORDER BY occurred_at,event_id',[storeId,jobId]);
            return [200,{...publicJob(job),history}];
          }
          const {status,type,cursor}=req.query;
          if ((status && !jobStatuses.includes(status)) || (type && !jobTypes.includes(type)) || (cursor && !uuid.test(cursor))) reject(400,'INVALID_FILTER');
          const {rows}=await q(`SELECT * FROM jobs WHERE store_id=$1 AND ($2::text IS NULL OR status=$2)
            AND ($3::text IS NULL OR type=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 51`,[storeId,status??null,type??null,cursor??null]);
          return [200,{items:rows.slice(0,50).map(publicJob),next_cursor:rows.length>50?rows[49].id:null}];
        }
        await lockStore(q,storeId);
        return idempotent(q,auth,storeId,req,async()=>{
          if (!jobId) {
            await validateTarget(q,storeId,req.body);
            return [201,publicJob(await enqueue(q,storeId,req.body,auth.id,req.id))];
          }
          const {rows:[job]}=await q('SELECT * FROM jobs WHERE store_id=$1 AND id=$2 FOR UPDATE',[storeId,jobId]);
          if (!job) reject(404,'JOB_NOT_FOUND');
          if (operation==='retry' && ['FAILED','RETRY_WAIT'].includes(job.status) && job.attempt<maxAttempts(job) && !uncertainType.has(job.type)) {
            await validateTarget(q,storeId,job);
            const changed=await updateStatus(q,job,'QUEUED');
            await audit(q,changed,auth.id,req.id);
            return [200,publicJob(changed)];
          }
          if (operation!=='cancel' || !['QUEUED','LEASED','RUNNING','RETRY_WAIT'].includes(job.status)) reject(409,'INVALID_TRANSITION');
          if (uncertainType.has(job.type) && job.status!=='RUNNING') reject(409,'INVALID_TRANSITION');
          const changed=uncertainType.has(job.type) ? await uncertain(q,job,auth.id,req.id) : await updateStatus(q,job,'CANCELLED');
          await audit(q,changed,auth.id,req.id);
          return [200,publicJob(changed)];
        });
      }
      if ((await q('SELECT 1 FROM gmail_workers WHERE worker_id=$1 UNION ALL SELECT 1 FROM netflix_workers WHERE worker_id=$1',[auth.id])).rowCount) reject(403,'FORBIDDEN');
      const {rows:stores}=await q('SELECT store_id FROM worker_stores WHERE worker_id=$1 ORDER BY store_id',[auth.id]);
      if (req.body && req.body.worker_id!==auth.id) reject(403,'FORBIDDEN');
      if (operation==='claim') {
        if (!stores.length) reject(403,'TENANT_SCOPE_DENIED');
        const ids=stores.map(row=>row.store_id);
        const home=ids[0];
        await lockStore(q,home);
        await scope(q,auth,home);
        const [status,saved]=await idempotent(q,auth,home,req,async()=>{
          for (const store of ids) {
            if (store!==home) await lockStore(q,store);
            await scope(q,auth,store);
            await reap(q,store,auth.id,req.id);
            const {rows:[job]}=await q(`SELECT * FROM jobs WHERE store_id=$1 AND status IN ('QUEUED','RETRY_WAIT')
              AND type=ANY($2::text[]) AND ready_at<=now()
              AND (SELECT count(*) FROM jobs WHERE store_id=$1 AND status IN ('LEASED','RUNNING'))+
                  (SELECT count(*) FROM gmail_jobs WHERE store_id=$1 AND status IN ('LEASED','RUNNING') AND lease_until>clock_timestamp())+
                  (SELECT count(*) FROM netflix_bindings WHERE store_id=$1 AND lease_until>clock_timestamp())<4
              ORDER BY CASE WHEN created_at<now()-interval '30 minutes' THEN least(priority,2) ELSE priority END,
              created_at,id LIMIT 1 FOR UPDATE`,[store,req.body.capabilities]);
            if (!job) continue;
            const fence=job.fence+1;
            const {rows:[changed]}=await q(`UPDATE jobs SET status='LEASED',worker_id=$3,fence=$4,lease_digest=$5,
              lease_until=clock_timestamp()+$6*interval '1 second',attempt=attempt+1,run_at=NULL
              WHERE store_id=$1 AND id=$2 RETURNING *`,[store,job.id,auth.id,fence,digest(leaseToken(auth,job.id,fence)),leaseSeconds]);
            await audit(q,changed,auth.id,req.id);
            await scope(q,auth,home);
            return [200,{job:publicJob(changed),fencing_token:fence,lease_expires_at:changed.lease_until.toISOString(),execution_context:{adapter:'MOCK'}}];
          }
          await scope(q,auth,home);
          return [204,null];
        });
        return [status,saved && {...saved,lease_token:leaseToken(auth,saved.job.id,saved.fencing_token)}];
      }
      for (const {store_id:store} of stores) {
        await scope(q,auth,store);
        const found=await q('SELECT 1 FROM jobs WHERE store_id=$1 AND id=$2 AND worker_id=$3',[store,jobId,auth.id]);
        if (!found.rowCount) continue;
        if (op.method==='GET') {
          const {rows:[job]}=await q('SELECT * FROM jobs WHERE store_id=$1 AND id=$2 AND worker_id=$3',[store,jobId,auth.id]);
          if (!job) reject(404,'JOB_NOT_FOUND');
          return [200,publicJob(job)];
        }
        await lockStore(q,store);
        return idempotent(q,auth,store,req,async()=>{
          const {rows:[job]}=await q('SELECT *,lease_until>clock_timestamp() AS lease_live FROM jobs WHERE store_id=$1 AND id=$2 AND worker_id=$3 FOR UPDATE',[store,jobId,auth.id]);
          if (!job) reject(409,'STALE_FENCING_TOKEN');
          return [200,publicJob(await action(q,job,auth,req,operation))];
        });
      }
      reject(404,'JOB_NOT_FOUND');
    },worker,(reply,[status,body])=>send(reply,op,status,body));
  }
}

