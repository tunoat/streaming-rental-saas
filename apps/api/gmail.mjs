import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import YAML from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {authenticate,digest,membership,reject,scope,secret,transaction} from './db.mjs';
import {idempotent,lockStore} from './jobs.mjs';
import {exchangeGoogle,gmailConfig,googleAuthorization,readScope,refreshGoogle,revokeGoogle,seal,unseal} from './gmail-provider.mjs';

const ownerPath='/v1/stores/:storeId/email-addresses/:emailId';
const workerPath='/v1/email-worker/stores/:storeId/jobs';
const liveJobStatuses=['QUEUED','LEASED','RUNNING'];
const safeErrors=['AUTH_REQUIRED','IDENTITY_MISMATCH','IDENTITY_INVALID','SCOPE_INVALID','SCOPE_EXCESS','PROVIDER_UNAVAILABLE',
  'PROVIDER_REJECTED','TOKEN_REJECTED','EVIDENCE_INVALID','LEASE_EXPIRED'];
const opaque=/^[a-zA-Z0-9_-]{43}$/;
const cookieName=state=>'gmail_'+digest(state).slice(0,24);
const vaultContext=(store,email,generation)=>['gmail-vault',store,email,generation];
const authContext=(store,email,state)=>['gmail-state',store,email,state];
const leaseToken=(auth,job)=>createHmac('sha256',auth.token).update('gmail:'+job.id+':'+job.fence).digest('base64url');
const send=(reply,[code,body])=>reply.code(code).send(body??undefined);
const schemas=YAML.parse(readFileSync(new URL('../../contracts/openapi.email-bot.v1.yaml',import.meta.url),'utf8')).components.schemas;
const ajv=new Ajv({strict:false});
addFormats(ajv);
const payloads=Object.fromEntries(['Worker','Lease','TokenRequest','Verification','Failure'].map(name=>[name,ajv.compile(schemas[name])]));
function validate(name,body){
  if(!payloads[name](body)) reject(400,'INVALID_REQUEST');
}

async function registry(q,store,email){
  const {rows:[row]}=await q(`SELECT e.email,c.generation,c.subject,c.mode,c.status,c.verified_at,c.error,c.evidence
    FROM streaming_email_addresses e LEFT JOIN gmail_connections c ON (c.store_id,c.email_id)=(e.store_id,e.id)
    WHERE (e.store_id,e.id)=($1,$2) AND e.archived_at IS NULL`,[store,email]);
  if(!row) reject(404,'EMAIL_NOT_FOUND');
  return row;
}

async function cancelJobs(q,store,email){
  await q("UPDATE gmail_jobs SET status='CANCELLED',lease_until=NULL WHERE (store_id,email_id)=($1,$2) AND status=ANY($3)",[store,email,liveJobStatuses]);
}

async function queue(q,store,email,generation,mode){
  const {rows:[job]}=await q(`INSERT INTO gmail_jobs(store_id,email_id,generation,mode) VALUES($1,$2,$3,$4)
    ON CONFLICT(store_id,email_id,generation) WHERE status IN ('QUEUED','LEASED','RUNNING')
    DO UPDATE SET generation=excluded.generation RETURNING id`,[store,email,generation,mode]);
  return job.id;
}

function key(req){
  const value=req.headers['idempotency-key'];
  if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) reject(400,'INVALID_REQUEST');
  return value;
}

async function ownerRoute(q,auth,req,write=false){
  const {storeId:store,emailId:email}=req.params;
  await membership(q,auth,store,['OWNER']);
  if(write) await lockStore(q,store);
  return [store,email];
}

async function workerRoute(q,auth,req,config){
  const store=req.params.storeId;
  const {rowCount}=await q(`SELECT 1 FROM gmail_workers gw JOIN worker_stores ws ON ws.worker_id=gw.worker_id
    WHERE gw.worker_id=$1 AND gw.mode=$2 AND ws.store_id=$3`,[auth.id,config.mode,store]);
  if(!rowCount||req.body?.worker_id!==auth.id) reject(403,'EMAIL_WORKER_FORBIDDEN');
  await lockStore(q,store);
  await scope(q,auth,store);
  return store;
}

export function registerGmail(app,secured,config=gmailConfig(),provider={}){
  const exchange=provider.exchange??exchangeGoogle;
  const refresh=provider.refresh??refreshGoogle;
  const revoke=provider.revoke??revokeGoogle;
  const cookieFlags='; HttpOnly; SameSite=Lax; Path=/v1/oauth/; Max-Age=300'+
    (config.redirect?.protocol==='https:'?'; Secure':'');
  secured('GET',ownerPath+'/connection',async(q,auth,req)=>{
    const [store,email]=await ownerRoute(q,auth,req);
    const row=await registry(q,store,email);
    const pending=await q(`SELECT 1 FROM gmail_oauth_states WHERE (store_id,email_id)=($1,$2)
      AND generation=$3 AND session_digest=$4 AND expires_at>now() AND consumed_at IS NULL LIMIT 1`,
    [store,email,row.generation??0,auth.digest]);
    const mismatch=!!row.mode&&row.mode!==config.mode&&row.status!=='DISCONNECTED';
    return {provider:'gmail',mode:mismatch?row.mode:config.mode,
      status:mismatch?'AUTH_REQUIRED':pending.rowCount?'AUTHORIZING':row.status??'NOT_CONNECTED',
      last_verified_at:row.verified_at?.toISOString()??null,error:mismatch?'MODE_MISMATCH':row.error??null,
      evidence:row.evidence??null};
  });
  secured('POST',ownerPath+'/connections/gmail/authorize',async(q,auth,req)=>{
    const [store,email]=await ownerRoute(q,auth,req,true);
    if(config.mode==='live'&&(req.headers.host!==config.redirect.host||req.protocol!==config.redirect.protocol.slice(0,-1)))
      reject(400,'GMAIL_CALLBACK_ORIGIN_MISMATCH');
    const row=await registry(q,store,email);
    const requestKey=key(req);
    await q(`DELETE FROM gmail_oauth_states WHERE store_id=$1 AND expires_at<=now()`,[store]);
    const {rows:[previous]}=await q(`SELECT * FROM gmail_oauth_states
      WHERE (store_id,email_id,session_digest,request_key)=($1,$2,$3,$4)`,[store,email,auth.digest,requestKey]);
    if(previous?.consumed_at||previous&&previous.generation!==(row.generation??0)) reject(409,'OAUTH_STATE_USED');
    if(!previous){
      const limit=await q(`SELECT 1 FROM gmail_oauth_states WHERE (store_id,email_id,session_digest)=($1,$2,$3)
        OFFSET 9 LIMIT 1`,[store,email,auth.digest]);
      if(limit.rowCount) reject(429,'OAUTH_RATE_LIMIT');
    }
    const state=previous?unseal(config,previous.sealed_state,authContext(store,email,previous.state_digest)):
      {state:secret(),verifier:secret(),nonce:secret()};
    const stateDigest=digest(state.state);
    const expires=previous?.expires_at??new Date(Date.now()+300000);
    if(!previous) await q(`INSERT INTO gmail_oauth_states VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [store,email,stateDigest,requestKey,auth.digest,row.generation??0,seal(config,state,authContext(store,email,stateDigest)),expires]);
    const challenge=createHash('sha256').update(state.verifier).digest('base64url');
    const url=config.mode==='mock'?'/v1/oauth/mock/consent?state='+state.state:googleAuthorization(config,state.state,state.nonce,challenge);
    const cookie=seal(config,{token:auth.token,store,email},['gmail-cookie',stateDigest]);
    return {body:{authorization_url:url,expires_at:expires.toISOString()},cookie:cookieName(state.state)+'='+cookie+cookieFlags};
  },false,(reply,result)=>reply.header('set-cookie',result.cookie).send(result.body));

  app.get('/v1/oauth/mock/consent',(req,reply)=>{
    const state=req.query.state;
    if(config.mode!=='mock'||typeof state!=='string'||!opaque.test(state)) return reply.code(404).send();
    reply.header('referrer-policy','no-referrer');
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><meta charset="utf-8">
      <title>Mock Gmail consent</title><h1>Mock Gmail consent</h1>
      <p>Allow simulated inbox verification for the selected address?</p>
      <form action="/v1/oauth/google/callback"><input type="hidden" name="state" value="${state}">
      <button type="submit" name="decision" value="allow">Allow</button>
      <button type="submit" name="decision" value="deny">Deny</button></form></html>`);
  });
  const returnPath='/gmail-consent-result?status=';
  app.get('/gmail-consent-result',(req,reply)=>{
    const status=req.query.status;
    const message=status==='accepted'?'Gmail verification queued':status==='denied'?'Gmail consent declined':
      status==='gmail_scope_missing'?'Google did not grant Gmail read access':
      status==='gmail_scope_excess'?'Google returned permissions beyond the requested access':'Gmail authorization failed';
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><meta charset="utf-8">
      <title>Gmail</title><h1>${message}</h1><p>Close this tab and return to the store dashboard.</p></html>`);
  });

  app.get('/v1/oauth/google/callback',async(req,reply)=>{
    reply.header('referrer-policy','no-referrer');
    const {state,code,error,decision}=req.query;
    if(typeof state!=='string'||!opaque.test(state)) return reply.redirect(returnPath+'failed',303);
    const name=cookieName(state), stateDigest=digest(state);
    const cookie=(req.headers.cookie??'').split(';').map(part=>part.trim()).find(part=>part.startsWith(name+'='))?.slice(name.length+1);
    if(!cookie) return reply.redirect(returnPath+'failed',303);
    reply.header('set-cookie',name+'='+cookieFlags.replace('Max-Age=300','Max-Age=0'));
    let proof,started;
    try{
      proof=unseal(config,cookie,['gmail-cookie',stateDigest]);
      started=await transaction(async q=>{
        const auth=await authenticate(q,{headers:{authorization:'Bearer '+proof.token}});
        await membership(q,auth,proof.store,['OWNER']);
        await lockStore(q,proof.store);
        const row=await registry(q,proof.store,proof.email);
        const {rows:[entry]}=await q(`UPDATE gmail_oauth_states SET consumed_at=clock_timestamp()
          WHERE (store_id,email_id,state_digest,session_digest,generation)=($1,$2,$3,$4,$5)
          AND consumed_at IS NULL AND expires_at>now() RETURNING sealed_state`,
        [proof.store,proof.email,stateDigest,auth.digest,row.generation??0]);
        if(!entry) reject(409,'OAUTH_STATE_USED');
        return {row,state:unseal(config,entry.sealed_state,authContext(proof.store,proof.email,stateDigest))};
      });
    }catch{return reply.redirect(returnPath+'failed',303);}
    if(error==='access_denied'||config.mode==='mock'&&decision==='deny') return reply.redirect(returnPath+'denied',303);
    if(error!==undefined) return reply.redirect(returnPath+'failed',303);
    const {store,email}=proof;
    try{
      if(config.mode==='mock'&&decision!=='allow'||config.mode==='live'&&(typeof code!=='string'||code.length>4096))
        reject(400,'INVALID_REQUEST');
      const result=config.mode==='mock'?{subject:'mock:'+started.row.email,scopes:[readScope]}:
        await exchange(config,code,started.state,started.row.email);
      await transaction(async q=>{
        const auth=await authenticate(q,{headers:{authorization:'Bearer '+proof.token}});
        await membership(q,auth,store,['OWNER']);
        await lockStore(q,store);
        const row=await registry(q,store,email);
        if(row.email!==started.row.email||(row.generation??0)!==(started.row.generation??0)) reject(409,'STALE_CONNECTION');
        const generation=(row.generation??0)+1;
        const token=result.token;
        if(token) await q('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[result.subject]);
        if(token&&!token.refresh){
          const {rows:[vault]}=await q('SELECT encrypted_tokens FROM gmail_vault WHERE (store_id,email_id)=($1,$2)',[store,email]);
          if(vault&&row.mode==='live'&&row.subject===result.subject)
            token.refresh=unseal(config,vault.encrypted_tokens,vaultContext(store,email,row.generation)).refresh;
          if(!token.refresh) reject(409,'AUTH_REQUIRED');
        }
        await cancelJobs(q,store,email);
        await q(`INSERT INTO gmail_connections (store_id,email_id,generation,mode,status,subject,email,scopes)
          VALUES($1,$2,$3,$4,'VERIFYING',$5,$6,$7) ON CONFLICT(store_id,email_id) DO UPDATE SET
          generation=excluded.generation,mode=excluded.mode,status=excluded.status,subject=excluded.subject,email=excluded.email,
          scopes=excluded.scopes,verified_at=NULL,evidence=NULL,error=NULL`,[store,email,generation,config.mode,result.subject,row.email,result.scopes]);
        await q('DELETE FROM gmail_vault WHERE (store_id,email_id)=($1,$2)',[store,email]);
        if(token) await q('INSERT INTO gmail_vault VALUES($1,$2,$3,$4)',
          [store,email,seal(config,token,vaultContext(store,email,generation)),token.expires]);
        await queue(q,store,email,generation,config.mode);
      });
      return reply.redirect(returnPath+'accepted',303);
    }catch(error){
      await transaction(async q=>{
        const auth=await authenticate(q,{headers:{authorization:'Bearer '+proof.token}});
        await membership(q,auth,store,['OWNER']);
        await lockStore(q,store);
        const row=await registry(q,store,email);
        if(row.email!==started.row.email||(row.generation??0)!==(started.row.generation??0)||
          ![undefined,null,'AUTH_REQUIRED','FAILED','DISCONNECTED'].includes(row.status)) return;
        const reason=safeErrors.includes(error.providerCode)?error.providerCode:'AUTH_REQUIRED';
        await q(`INSERT INTO gmail_connections(store_id,email_id,mode,status,error)
          VALUES($1,$2,$3,'AUTH_REQUIRED',$4) ON CONFLICT(store_id,email_id) DO UPDATE
          SET status='AUTH_REQUIRED',error=excluded.error`,[store,email,config.mode,reason]);
      }).catch(()=>{});
      const status=error.providerCode==='SCOPE_INVALID'?'gmail_scope_missing':
        error.providerCode==='SCOPE_EXCESS'?'gmail_scope_excess':'failed';
      return reply.redirect(returnPath+status,303);
    }
  });

  secured('POST',ownerPath+'/connection/verify',async(q,auth,req)=>{
    const [store,email]=await ownerRoute(q,auth,req,true);
    key(req);
    return idempotent(q,auth,store,req,async()=>{
      const row=await registry(q,store,email);
      if(row.mode!==config.mode||!['CONNECTED','VERIFYING','FAILED'].includes(row.status)) reject(409,'AUTH_REQUIRED');
      if(config.mode==='live'&&!(await q('SELECT 1 FROM gmail_vault WHERE (store_id,email_id)=($1,$2)',[store,email])).rowCount)
        reject(409,'AUTH_REQUIRED');
      const job=await queue(q,store,email,row.generation,config.mode);
      await q("UPDATE gmail_connections SET status='VERIFYING',error=NULL WHERE (store_id,email_id)=($1,$2)",[store,email]);
      return [202,{job_id:job}];
    });
  },false,send);

  // Persist local invalidation first. Provider revocation is a separate best-effort action.
  secured('POST',ownerPath+'/connection/disconnect',async(q,auth,req)=>{
    const [store,email]=await ownerRoute(q,auth,req,true);
    key(req);
    if(req.body?.confirm!==true) reject(400,'CONFIRM_REQUIRED');
    let remote;
    const result=await idempotent(q,auth,store,req,async()=>{
      const row=await registry(q,store,email);
      const {rows:[vault]}=await q('DELETE FROM gmail_vault WHERE (store_id,email_id)=($1,$2) RETURNING encrypted_tokens',[store,email]);
      let revocation='NOT_APPLICABLE';
      if(vault&&row.mode==='live'){
        revocation='UNCONFIRMED';
        if(config.mode==='live') try{
          remote={token:unseal(config,vault.encrypted_tokens,vaultContext(store,email,row.generation)).refresh,subject:row.subject};
        }catch{}
      }
      await cancelJobs(q,store,email);
      await q('DELETE FROM gmail_oauth_states WHERE (store_id,email_id)=($1,$2)',[store,email]);
      await q(`INSERT INTO gmail_connections(store_id,email_id,generation,mode,status) VALUES($1,$2,1,$3,'DISCONNECTED')
        ON CONFLICT(store_id,email_id) DO UPDATE SET generation=gmail_connections.generation+1,mode=excluded.mode,
        status='DISCONNECTED',subject=NULL,email=NULL,scopes=NULL,verified_at=NULL,error=NULL,evidence=NULL`,[store,email,config.mode]);
      return [200,{status:'DISCONNECTED',remote_revocation:revocation}];
    });
    return {result,remote};
  },false,async(reply,{result,remote})=>{
    if(remote?.token&&remote.subject) try{
      const remoteStatus=await transaction(async q=>{
        await q('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[remote.subject]);
        const {rows:[row]}=await q('SELECT public.gmail_has_shared_grant($1) AS shared',[remote.subject]);
        if(row.shared) return 'SHARED_GRANT';
        await revoke(remote.token);
        return 'SUCCEEDED';
      });
      result[1]={...result[1],remote_revocation:remoteStatus};
    }catch{}
    return send(reply,result);
  });

  secured('POST',workerPath+'/claim',async(q,auth,req)=>{
    validate('Worker',req.body);
    const store=await workerRoute(q,auth,req,config);
    key(req);
    const [status,body]=await idempotent(q,auth,store,req,async()=>{
      const {rows:expired}=await q(`UPDATE gmail_jobs SET status=CASE WHEN attempts>=3 THEN 'FAILED' ELSE 'QUEUED' END,
        lease_until=NULL WHERE store_id=$1 AND status IN ('LEASED','RUNNING') AND lease_until<=clock_timestamp()
        RETURNING email_id,generation,status`,[store]);
      for(const job of expired.filter(row=>row.status==='FAILED')) await q(`UPDATE gmail_connections SET status='FAILED',error='LEASE_EXPIRED'
        WHERE (store_id,email_id,generation)=($1,$2,$3)`,[store,job.email_id,job.generation]);
      const {rows:[job]}=await q(`WITH eligible AS (
        SELECT j.id FROM gmail_jobs j JOIN gmail_connections c ON (c.store_id,c.email_id,c.generation)=(j.store_id,j.email_id,j.generation)
        WHERE j.store_id=$1 AND j.mode=$2 AND j.status='QUEUED'
          AND (SELECT count(*) FROM jobs WHERE store_id=$1 AND status IN ('LEASED','RUNNING') AND lease_until>clock_timestamp())+
              (SELECT count(*) FROM gmail_jobs WHERE store_id=$1 AND status IN ('LEASED','RUNNING'))<4
        ORDER BY j.created_at,j.id LIMIT 1
      ) UPDATE gmail_jobs j SET status='LEASED',worker_id=$3,fence=j.fence+1,attempts=j.attempts+1,token_count=0,
        lease_until=clock_timestamp()+interval '90 seconds',started_at=NULL
        FROM eligible WHERE (j.store_id,j.id)=($1,eligible.id) RETURNING j.id,j.email_id,j.generation,j.mode,j.fence`,[store,config.mode,auth.id]);
      return job?[200,job]:[204,null];
    });
    return [status,body&&{...body,lease_token:leaseToken(auth,body)}];
  },true,send);

  for(const action of ['start','heartbeat','access-token','complete','fail']){
    secured('POST',workerPath+'/:jobId/'+action,async(q,auth,req)=>{
      validate({'access-token':'TokenRequest',complete:'Verification',fail:'Failure'}[action]??'Lease',req.body);
      const store=await workerRoute(q,auth,req,config);
      if(action!=='access-token') key(req);
      const run=async()=>{
        const b=req.body;
        const {rows:[job]}=await q(`SELECT j.*,c.email,c.status AS connection_status FROM gmail_jobs j JOIN gmail_connections c
          ON (c.store_id,c.email_id,c.generation)=(j.store_id,j.email_id,j.generation)
          WHERE (j.store_id,j.id,j.worker_id,j.mode)=($1,$2,$3,$4) AND j.lease_until>clock_timestamp() FOR UPDATE OF j`,
        [store,req.params.jobId,auth.id,config.mode]);
        if(!job||job.fence!==b.fencing_token||typeof b.lease_token!=='string'||!opaque.test(b.lease_token)||
          !timingSafeEqual(Buffer.from(b.lease_token),Buffer.from(leaseToken(auth,job)))) reject(409,'STALE_FENCING_TOKEN');
        if(job.connection_status!=='VERIFYING'||job.status!==(action==='start'?'LEASED':'RUNNING')) reject(409,'INVALID_TRANSITION');
        const ids=[store,job.id];
        if(action==='start'||action==='heartbeat'){
          await q(`UPDATE gmail_jobs SET status='RUNNING',started_at=coalesce(started_at,clock_timestamp()),
            lease_until=clock_timestamp()+interval '90 seconds' WHERE (store_id,id)=($1,$2)`,ids);
          return [200,{status:'RUNNING'}];
        }
        if(action==='access-token'){
          if(config.mode!=='live') reject(403,'TOKEN_UNAVAILABLE');
          if(job.token_count>=2||b.refresh===true&&job.token_count!==1) reject(429,'TOKEN_RATE_LIMIT');
          const context=vaultContext(store,job.email_id,job.generation);
          const {rows:[vault]}=await q('SELECT encrypted_tokens FROM gmail_vault WHERE (store_id,email_id)=($1,$2)',[store,job.email_id]);
          let token;
          try{
            token=unseal(config,vault?.encrypted_tokens,context);
            if(b.refresh===true||Date.parse(token.expires)<Date.now()+60000){
              token=await refresh(config,token.refresh);
              await q('UPDATE gmail_vault SET encrypted_tokens=$3,expires_at=$4 WHERE (store_id,email_id)=($1,$2)',
                [store,job.email_id,seal(config,token,context),token.expires]);
            }
          }catch(error){
            const code=['AUTH_REQUIRED','SCOPE_INVALID','TOKEN_REJECTED'].includes(error.providerCode)?'AUTH_REQUIRED':'PROVIDER_UNAVAILABLE';
            await q('UPDATE gmail_jobs SET token_count=token_count+1 WHERE (store_id,id)=($1,$2)',ids);
            return [code==='AUTH_REQUIRED'?409:503,{code}];
          }
          const counted=await q(`UPDATE gmail_jobs SET token_count=token_count+1 WHERE (store_id,id)=($1,$2)
            AND lease_until>clock_timestamp()`,ids);
          if(!counted.rowCount) reject(409,'STALE_FENCING_TOKEN');
          return [200,{access_token:token.access,expires_at:token.expires,email:job.email}];
        }
        if(b.generation!==job.generation) reject(409,'STALE_CONNECTION');
        let evidence=null,error=null;
        if(action==='complete'){
          const time=typeof b.observed_at==='string'?Date.parse(b.observed_at):NaN;
          if(b.provenance!==config.mode.toUpperCase()||b.identity_match!==true||b.profile_ok!==true||b.list_ok!==true||
            typeof b.empty_inbox!=='boolean'||b.metadata_read!==!b.empty_inbox||!Number.isFinite(time)||
            time<job.started_at.getTime()-1000||time>Date.now()+5000||config.mode==='live'&&job.token_count===0)
            reject(400,'EVIDENCE_INVALID');
          evidence={provenance:b.provenance,identity_match:true,profile_ok:true,list_ok:true,
            empty_inbox:b.empty_inbox,metadata_read:b.metadata_read,observed_at:new Date(time).toISOString()};
        }else{
          if(!safeErrors.includes(b.error)) reject(400,'EVIDENCE_INVALID');
          error=b.error;
        }
        const status=action==='complete'?'CONNECTED':
          ['AUTH_REQUIRED','IDENTITY_MISMATCH','SCOPE_INVALID','TOKEN_REJECTED'].includes(error)?'AUTH_REQUIRED':'FAILED';
        await q("UPDATE gmail_jobs SET status=$3,lease_until=NULL WHERE (store_id,id)=($1,$2)",[...ids,action==='complete'?'SUCCEEDED':'FAILED']);
        await q(`UPDATE gmail_connections SET status=$4,error=$5,evidence=$6,
          verified_at=CASE WHEN $4='CONNECTED' THEN clock_timestamp() ELSE verified_at END
          WHERE (store_id,email_id,generation)=($1,$2,$3)`,[store,job.email_id,job.generation,status,error,evidence]);
        return [200,{status}];
      };
      return action==='access-token'?run():idempotent(q,auth,store,req,run);
    },true,send);
  }
}
