import {createHmac,timingSafeEqual} from 'node:crypto';
import {membership,reject,scope} from './db.mjs';
import {idempotent,lockStore} from './jobs.mjs';

const owner='/v1/stores/:storeId/email-addresses/:emailId/streaming-binding';
const worker='/v1/netflix-worker/stores/:storeId';
const active=['QUEUED','BINDING','WAITING_FOR_USER','VERIFYING','RECONCILING'];
const lease=(auth,row)=>createHmac('sha256',auth.token).update(`netflix:${row.email_id}:${row.generation}:${row.fence}`).digest('base64url');
const result=(reply,[status,body])=>reply.code(status).send(body??undefined);
const expired=row=>row?.status==='WAITING_FOR_USER'&&row.challenge_until<=new Date();
const snapshot=row=>({provider:'netflix',mode:'mock',status:expired(row)?'AUTH_EXPIRED':row?.status??'UNBOUND',
  generation:row?.generation??0,
  verification_state:expired(row)?'OTP_EXPIRED':row?.verification_state??null,last_verified_at:row?.verified_at?.toISOString()??null,last_error:row?.last_error??null});
async function current(q,store,email){
  const {rows:[row]}=await q('SELECT * FROM netflix_bindings WHERE (store_id,email_id)=($1,$2)',[store,email]);
  return row;
}
async function registry(q,store,email){
  const {rows:[row]}=await q(`SELECT g.status='CONNECTED' AND g.email=e.email AND (g.evidence->>'identity_match')='true'
    AND (g.evidence->>'provenance')=upper(g.mode) AND (g.mode='mock' OR v.expires_at>now()) AS gmail_ready
    FROM streaming_email_addresses e LEFT JOIN gmail_connections g ON (g.store_id,g.email_id)=(e.store_id,e.id)
    LEFT JOIN gmail_vault v ON (v.store_id,v.email_id)=(g.store_id,g.email_id)
    WHERE (e.store_id,e.id)=($1,$2) AND e.archived_at IS NULL`,[store,email]);
  if(!row) reject(404,'EMAIL_NOT_FOUND');
  return row.gmail_ready===true;
}
async function audit(q,row,actor){
  await q('INSERT INTO netflix_binding_events(store_id,email_id,generation,status,actor) VALUES($1,$2,$3,$4,$5)',
    [row.store_id,row.email_id,row.generation,[row.status,row.verification_state].filter(Boolean).join(':'),actor]);
}
async function transition(q,store,email,status,verification,actor,error=null){
  const {rows:[row]}=await q(`UPDATE netflix_bindings SET status=$3,verification_state=$4,last_error=$5,
    updated_at=clock_timestamp(),lease_until=NULL,
    challenge_until=CASE WHEN $3='WAITING_FOR_USER' THEN clock_timestamp()+interval '5 minutes' END,
    verified_at=CASE WHEN $3='BOUND' THEN clock_timestamp() WHEN $3='UNBOUND' THEN NULL ELSE verified_at END
    WHERE (store_id,email_id)=($1,$2) RETURNING *`,[store,email,status,verification,error]);
  await audit(q,row,actor);
  return row;
}
function requireKey(req){
  if(!/^[a-zA-Z0-9_-]{8,128}$/.test(req.headers['idempotency-key']??'')) reject(400,'INVALID_REQUEST');
}
export function registerNetflixBindings(secured){
  secured('GET',owner,async(q,auth,{params:{storeId:s,emailId:e}})=>{
    await membership(q,auth,s,['OWNER']);
    return {...snapshot(await current(q,s,e)),gmail_ready:await registry(q,s,e)};
  });
  for(const action of ['bind','verify','rebind','disconnect','cancel','manual','reconcile']){
    secured('POST',owner+'/'+action,async(q,auth,req)=>{
      const {storeId:s,emailId:e}=req.params;
      await lockStore(q,s);
      await membership(q,auth,s,['OWNER']);
      requireKey(req);
      const ready=await registry(q,s,e);
      const row=await current(q,s,e);
      if(action==='manual'){
        // Never put a verification code, or its digest, in the idempotency table.
        if(row?.status==='VERIFYING'&&req.body?.generation===row.generation) return [200,snapshot(row)];
        if(row?.status!=='WAITING_FOR_USER'||req.body?.generation!==row.generation) reject(409,'INVALID_TRANSITION');
        const changed=row.challenge_until<=new Date()?await transition(q,s,e,'AUTH_EXPIRED','OTP_EXPIRED',auth.id):
          !ready?await transition(q,s,e,'AUTH_EXPIRED','VERIFICATION_FAILED',auth.id,'AUTH_REQUIRED'):
          req.body?.code==='123456'?await transition(q,s,e,'VERIFYING','VERIFYING',auth.id):
          await transition(q,s,e,'FAILED','VERIFICATION_FAILED',auth.id,'MOCK_CODE_INVALID');
        return [200,snapshot(changed)];
      }
      return idempotent(q,auth,s,req,async()=>{
        if(action==='cancel'||action==='disconnect'||action==='reconcile'){
          if(req.body?.confirm!==true) reject(400,'CONFIRM_REQUIRED');
          if(!row||action==='cancel'&&!active.includes(row.status)||
            action==='reconcile'&&row.status!=='RECONCILING'||
            action==='disconnect'&&row.status!=='BOUND') reject(409,'INVALID_TRANSITION');
          return [200,snapshot(await transition(q,s,e,action==='disconnect'?'UNBOUND':'CANCELLED',null,auth.id))];
        }
        if(!ready) reject(409,'AUTH_REQUIRED');
        if(active.includes(row?.status)&&!expired(row)) reject(409,'BINDING_IN_PROGRESS');
        if(action==='verify'&&row?.status!=='BOUND'||action==='bind'&&row?.status==='BOUND') reject(409,'INVALID_TRANSITION');
        const challenge=action==='verify'?'AUTO':req.body?.challenge??'AUTO';
        if(!['AUTO','MANUAL'].includes(challenge)) reject(400,'INVALID_REQUEST');
        const {rows:[next]}=await q(`INSERT INTO netflix_bindings(store_id,email_id,status,challenge)
          VALUES($1,$2,'QUEUED',$3) ON CONFLICT(store_id,email_id) DO UPDATE SET
          generation=netflix_bindings.generation+1,status='QUEUED',verification_state=NULL,challenge=excluded.challenge,
          worker_id=NULL,lease_until=NULL,challenge_until=NULL,last_error=NULL,updated_at=clock_timestamp() RETURNING *`,[s,e,challenge]);
        await audit(q,next,auth.id);
        return [202,snapshot(next)];
      });
    },false,result);
  }
  for(const action of ['claim','heartbeat','report']){
    const path=worker+(action==='claim'?'/claim':'/:emailId/'+action);
    secured('POST',path,async(q,auth,req)=>{
      const {storeId:s,emailId:e}=req.params;
      const b=req.body??{};
      if(b.worker_id!==auth.id||!(await q(`SELECT 1 FROM netflix_workers n JOIN worker_stores w USING(worker_id)
        WHERE (n.worker_id,w.store_id)=($1,$2)`,[auth.id,s])).rowCount) reject(403,'FORBIDDEN');
      requireKey(req);
      await lockStore(q,s);
      await scope(q,auth,s);
      const [code,body]=await idempotent(q,auth,s,req,async()=>{
        if(action==='claim'){
          const {rows:expired}=await q(`SELECT email_id FROM netflix_bindings WHERE store_id=$1 AND status IN ('BINDING','VERIFYING')
            AND lease_until<=clock_timestamp()`,[s]);
          for(const {email_id} of expired) await transition(q,s,email_id,'RECONCILING','VERIFICATION_FAILED',auth.id,'LEASE_EXPIRED');
          const {rows:[row]}=await q(`SELECT * FROM netflix_bindings WHERE store_id=$1
            AND (status='QUEUED' OR status='VERIFYING' AND lease_until IS NULL)
            AND (SELECT count(*) FROM jobs WHERE store_id=$1 AND status IN ('LEASED','RUNNING') AND lease_until>clock_timestamp())+
                (SELECT count(*) FROM gmail_jobs WHERE store_id=$1 AND status IN ('LEASED','RUNNING') AND lease_until>clock_timestamp())+
                (SELECT count(*) FROM netflix_bindings WHERE store_id=$1 AND lease_until>clock_timestamp())<4
            ORDER BY updated_at,email_id LIMIT 1`,[s]);
          if(!row) return [204,null];
          const {rows:[claimed]}=await q(`UPDATE netflix_bindings SET status=CASE WHEN status='QUEUED' THEN 'BINDING' ELSE status END,
            worker_id=$3,fence=fence+1,lease_until=clock_timestamp()+interval '90 seconds'
            WHERE (store_id,email_id)=($1,$2) RETURNING *`,[s,row.email_id,auth.id]);
          await audit(q,claimed,auth.id);
          return [200,{email_id:claimed.email_id,generation:claimed.generation,fence:claimed.fence,
            challenge:claimed.challenge,status:claimed.status,mode:'mock'}];
        }
        const row=await current(q,s,e);
        if(!row?.lease_until||row.lease_until<=new Date()||row.worker_id!==auth.id||
          row.generation!==b.generation||row.fence!==b.fence||typeof b.lease_token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.lease_token)||
          !timingSafeEqual(Buffer.from(b.lease_token),Buffer.from(lease(auth,row)))) reject(409,'STALE_FENCING_TOKEN');
        if(action==='heartbeat'){
          await q("UPDATE netflix_bindings SET lease_until=clock_timestamp()+interval '90 seconds' WHERE (store_id,email_id)=($1,$2)",[s,e]);
          return [200,snapshot(row)];
        }
        if(b.provenance!=='MOCK') reject(400,'INVALID_REQUEST');
        if(!await registry(q,s,e)) return [200,snapshot(await transition(q,s,e,'AUTH_EXPIRED','VERIFICATION_FAILED',auth.id,'AUTH_REQUIRED'))];
        const progress={OTP_REQUESTED:null,WAITING_FOR_EMAIL:'OTP_REQUESTED',EMAIL_RECEIVED:'WAITING_FOR_EMAIL'};
        if(Object.hasOwn(progress,b.outcome)){
          if(row.status!=='BINDING'||row.verification_state!==progress[b.outcome]||
            b.outcome==='EMAIL_RECEIVED'&&row.challenge!=='AUTO') reject(409,'INVALID_TRANSITION');
          const {rows:[updated]}=await q(`UPDATE netflix_bindings SET verification_state=$3,updated_at=clock_timestamp()
            WHERE (store_id,email_id)=($1,$2) RETURNING *`,[s,e,b.outcome]);
          await audit(q,updated,auth.id);
          return [200,snapshot(updated)];
        }
        if(b.outcome==='WAITING_FOR_USER'&&row.status==='BINDING'&&row.challenge==='MANUAL'&&row.verification_state==='WAITING_FOR_EMAIL'){
          return [200,snapshot(await transition(q,s,e,'WAITING_FOR_USER','WAITING_FOR_MANUAL_VERIFICATION',auth.id))];
        }
        if(b.outcome==='VERIFIED'&&(row.status==='VERIFYING'||row.status==='BINDING'&&row.challenge==='AUTO'&&row.verification_state==='EMAIL_RECEIVED')){
          return [200,snapshot(await transition(q,s,e,'BOUND','VERIFIED',auth.id))];
        }
        if(b.outcome==='FAILED') return [200,snapshot(await transition(q,s,e,'FAILED','VERIFICATION_FAILED',auth.id,'MOCK_VERIFICATION_FAILED'))];
        reject(409,'INVALID_TRANSITION');
      });
      return [code,action==='claim'&&body?{...body,lease_token:lease(auth,body)}:body];
    },true,result);
  }
}
