import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import pg from 'pg';
import {exchangeGoogle,gmailConfig,googleJson,readScope,seal,unseal} from '../apps/api/gmail-provider.mjs';
import {GmailWorkerClient} from '../packages/shared/gmail-worker-client.mts';
import {GoogleGmailAdapter,runGmailOnce} from '../apps/gmail-worker/worker.mjs';

const integration=Boolean(process.env.TEST_DATABASE_URL&&process.env.DATABASE_URL);
const opts={skip:!integration&&'Use a disposable migrated PostgreSQL database'};
const syntheticPassword='Local-Gmail-Fixture-Only!';
const mock=gmailConfig({});
const live=gmailConfig({GMAIL_ADAPTER:'live',GMAIL_LIVE_TEST_ENABLED:'true',NODE_ENV:'test',
  GOOGLE_CLIENT_ID:'synthetic-client',GOOGLE_CLIENT_SECRET:'synthetic-secret',
  GOOGLE_REDIRECT_URI:'http://127.0.0.1/v1/oauth/google/callback',EMAIL_TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex')});
let db,pool,mockApp,liveApp,mockBase,liveBase,store,otherStore,owner,outsider,staff,createWorker;
const sampleToken={access:'synthetic-access',refresh:'synthetic-refresh',expires:new Date(Date.now()+3600000).toISOString()};
const contact='authorized@example.invalid';
let refreshCalls=0;

async function call(base,path,{token,body,status=200,key=randomUUID(),headers={}}={}){
  const reply=await fetch(base+path,{method:body===undefined?'GET':'POST',redirect:'manual',
    headers:{...headers,...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{
      'content-type':'application/json','idempotency-key':key})},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal(reply.status,status,path+' returned '+reply.status);
  return {headers:reply.headers,data:reply.status===204||reply.status===303?null:await reply.json()};
}
const route=(s,email)=>'/v1/stores/'+s+'/email-addresses/'+email;
const authorize=(base,path,token,key)=>call(base,path+'/connections/gmail/authorize',{token,body:{},key});
const fromConsent=result=>({state:new URL(result.data.authorization_url,'http://127.0.0.1').searchParams.get('state'),
  cookie:result.headers.get('set-cookie').split(';')[0]});
const callback=(base,proof,query,headers={cookie:proof.cookie})=>call(base,
  '/v1/oauth/google/callback?'+new URLSearchParams({state:proof.state,...query}),{status:303,headers});
const statusOf=async(base,path)=>(await call(base,path+'/connection',{token:owner})).data;

before(async()=>{
  if(!integration) return;
  process.env.NODE_ENV='test';
  db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const mod=await import('../apps/api/db.mjs');
  ({pool}=mod);
  const {appServer}=await import('../apps/api/server.mjs');
  mockApp=await appServer({config:mock});
  liveApp=await appServer({config:live,provider:{
    exchange:async(_config,code,_proof,email)=>{
      if(code==='wrong') throw Object.assign(new Error('fake'),{providerCode:'IDENTITY_MISMATCH'});
      return {subject:'google-fixture-'+email,scopes:[readScope],
        token:{...sampleToken,...(code==='no-refresh'&&{refresh:undefined})}};
    },
    refresh:async()=>{refreshCalls++;return {...sampleToken,access:'refreshed-fixture'};},
    revoke:async()=>{}
  }});
  mockBase=await mockApp.listen({host:'127.0.0.1',port:0});
  liveBase=await liveApp.listen({host:'127.0.0.1',port:0});
  live.redirect=new URL('/v1/oauth/google/callback',liveBase);
  const hash=await mod.passwordHash(syntheticPassword);
  async function createUser(){
    const username='gmail-test-'+randomUUID();
    const {rows:[user]}=await db.query('INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id',[username,hash]);
    const response=await call(mockBase,'/v1/login',{body:{username,password:syntheticPassword}});
    return {...user,token:response.data.token};
  }
  const [first,second,third]=await Promise.all([createUser(),createUser(),createUser()]);
  owner=first.token;outsider=second.token;staff=third.token;
  async function createStore(user){
    const {rows:[s]}=await db.query("INSERT INTO stores(name) VALUES('Gmail fixture') RETURNING id");
    await db.query("INSERT INTO memberships VALUES($1,$2,'OWNER')",[s.id,user.id]);
    return s.id;
  }
  store=await createStore(first);otherStore=await createStore(second);
  await db.query("INSERT INTO memberships VALUES($1,$2,'STAFF')",[store,third.id]);
  createWorker=async(mode,scope=store)=>{
    const id='gmail-test-'+randomUUID(),token=randomBytes(32).toString('base64url');
    await db.query("INSERT INTO workers VALUES($1,$2,now()+interval '1 day')",[id,mod.digest(token)]);
    await db.query('INSERT INTO worker_stores VALUES($1,$2)',[id,scope]);
    if(mode) await db.query('INSERT INTO gmail_workers VALUES($1,$2)',[id,mode]);
    return {id,token,client:new GmailWorkerClient(mode==='live'?liveBase:mockBase,token,id,scope)};
  };
});
after(async()=>{
  if(!integration) return;
  await mockApp?.close();await liveApp?.close();await pool?.end();await db?.end();
});

async function emailFixture(email=contact){
  return (await call(mockBase,'/v1/stores/'+store+'/streaming-emails',{token:owner,body:{email}})).data.id;
}

test('vault requires matching context and key version',()=>{
  const secret={refresh:'synthetic-only'};
  const encrypted=seal(mock,secret,['store-a','connection-1',1]);
  assert.ok(!encrypted.includes(secret.refresh));
  assert.notEqual(encrypted,seal(mock,secret,['store-a','connection-1',1]));
  assert.deepEqual(unseal(mock,encrypted,['store-a','connection-1',1]),secret);
  assert.throws(()=>unseal(mock,encrypted,['store-b','connection-1',1]),/AUTH_REQUIRED/);
  assert.throws(()=>unseal({...mock,version:'2'},encrypted,['store-a','connection-1',1]),/AUTH_REQUIRED/);
  assert.throws(()=>gmailConfig({GMAIL_ADAPTER:'live'}),/loopback/);
});

test('real exchange validates signed OIDC identity, nonce, email, profile and read-only scope',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'fake-key',use:'sig'};
  const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken=claims=>{
    const body=enc({alg:'RS256',kid:jwk.kid})+'.'+enc({iss:'https://accounts.google.com',aud:live.clientId,
      exp:Math.floor(Date.now()/1000)+100,nonce:'test-nonce',email_verified:true,sub:'synthetic',email:contact,...claims});
    return body+'.'+sign('RSA-SHA256',Buffer.from(body),privateKey).toString('base64url');
  };
  const send=(claims={},scope=readScope,profile=contact)=>async(url,options)=>{
    if(url.endsWith('/token')){
      assert.equal(options.body.get('code_verifier'),'pkce-fixture');
      return Response.json({token_type:'Bearer',access_token:'fake',refresh_token:'fake-refresh',
        expires_in:100,scope,id_token:idToken(claims)});
    }
    if(url.endsWith('/certs')) return Response.json({keys:[jwk]});
    assert.match(url,/\/profile\?/);
    return Response.json({emailAddress:profile});
  };
  const proof={nonce:'test-nonce',verifier:'pkce-fixture'};
  assert.equal((await exchangeGoogle(live,'synthetic',proof,contact,send())).subject,'synthetic');
  for(const claims of [{nonce:'wrong'},{email_verified:false},{aud:'wrong'},{exp:1},{iss:'other'}])
    await assert.rejects(exchangeGoogle(live,'synthetic',proof,contact,send(claims)),/IDENTITY_INVALID/);
  await assert.rejects(exchangeGoogle(live,'synthetic',proof,contact,send({},'openid')),/SCOPE_INVALID/);
  await assert.rejects(exchangeGoogle(live,'synthetic',proof,contact,send({},readScope+' https://www.googleapis.com/auth/gmail.modify')),/SCOPE_EXCESS/);
  await assert.rejects(exchangeGoogle(live,'synthetic',proof,contact,send({},readScope,'other@example.invalid')),/IDENTITY_MISMATCH/);
});

test('provider retries bounded transient errors and maps invalid_grant',async()=>{
  let attempts=0;
  const result=await googleJson('https://example.invalid',{},async()=>{
    attempts++;
    return attempts===1?new Response(null,{status:429,headers:{'retry-after':'0'}}):
      attempts===2?new Response(null,{status:503}):Response.json({ok:true});
  });
  assert.deepEqual(result,{ok:true});
  assert.equal(attempts,3);
  await assert.rejects(googleJson('https://example.invalid',{},async()=>Response.json({error:'invalid_grant'},{status:400})),/AUTH_REQUIRED/);
});

test('mock OAuth state is bound, one-time, denied safely and verified by its own worker',opts,async()=>{
  const email=await emailFixture(),path=route(store,email);
  await call(mockBase,path+'/connection',{token:staff,status:403});
  await call(mockBase,path+'/connection',{token:outsider,status:403});
  await call(mockBase,route(otherStore,email)+'/connection',{token:outsider,status:404});
  assert.equal((await statusOf(mockBase,path)).status,'NOT_CONNECTED');
  const first=fromConsent(await authorize(mockBase,path,owner));
  assert.match((await callback(mockBase,first,{decision:'allow'},{})).headers.get('location'),/failed$/);
  assert.match((await callback(mockBase,first,{decision:'deny'})).headers.get('location'),/denied$/);
  assert.match((await callback(mockBase,first,{decision:'allow'})).headers.get('location'),/failed$/);
  assert.equal((await statusOf(mockBase,path)).status,'NOT_CONNECTED');
  const key=randomUUID();
  const state=fromConsent(await authorize(mockBase,path,owner,key));
  const same=fromConsent(await authorize(mockBase,path,owner,key));
  assert.equal(state.state,same.state);
  assert.equal((await statusOf(mockBase,path)).status,'AUTHORIZING');
  assert.match((await callback(mockBase,state,{decision:'allow'})).headers.get('location'),/accepted$/);
  assert.equal((await statusOf(mockBase,path)).status,'VERIFYING');
  const streaming=await createWorker();
  await assert.rejects(streaming.client.claim(),/EMAIL_WORKER_FORBIDDEN/);
  const worker=await createWorker('mock');
  assert.equal((await runGmailOnce(worker.client)).status,'CONNECTED');
  const final=await statusOf(mockBase,path);
  assert.equal(final.evidence.provenance,'MOCK');
  assert.equal(final.evidence.empty_inbox,true);
  assert.equal(final.evidence.metadata_read,false);
  assert.equal((await statusOf(liveBase,path)).status,'AUTH_REQUIRED');
  const verifyKey=randomUUID();
  const verify=await call(mockBase,path+'/connection/verify',{token:owner,body:{},key:verifyKey,status:202});
  const dup=await call(mockBase,path+'/connection/verify',{token:owner,body:{},key:verifyKey,status:202});
  assert.deepEqual(verify.data,dup.data);
  const job=await worker.client.claim();
  const lease={lease_token:job.lease_token,fencing_token:job.fence};
  await worker.client.start(job.id,lease);
  await assert.rejects(worker.client.tokenFor(job.id,lease),/TOKEN_UNAVAILABLE/);
  await call(mockBase,path+'/connection/disconnect',{token:owner,body:{confirm:true}});
  await assert.rejects(worker.client.heartbeat(job.id,lease),/STALE_FENCING_TOKEN/);
  assert.equal((await statusOf(mockBase,path)).status,'DISCONNECTED');
});

test('fake live verification brokers lease-only tokens, refreshes once, and stores evidence without email content',opts,async()=>{
  const email=await emailFixture('other@example.invalid'),path=route(store,email);
  const state=fromConsent(await authorize(liveBase,path,owner));
  assert.match((await callback(liveBase,state,{code:'accepted'})).headers.get('location'),/accepted$/);
  assert.equal((await statusOf(liveBase,path)).status,'VERIFYING');
  const encrypted=(await db.query('SELECT encrypted_tokens FROM gmail_vault WHERE (store_id,email_id)=($1,$2)',[store,email])).rows[0].encrypted_tokens;
  assert.ok(!encrypted.includes(sampleToken.refresh)&&!encrypted.includes(sampleToken.access));
  const worker=await createWorker('live');
  const foreign=await createWorker('live',otherStore);
  const job=await worker.client.claim(),lease={lease_token:job.lease_token,fencing_token:job.fence};
  await assert.rejects(worker.client.tokenFor(job.id,lease),/INVALID_TRANSITION/);
  await worker.client.start(job.id,lease);
  await assert.rejects(foreign.client.tokenFor(job.id,lease),/STALE_FENCING_TOKEN/);
  await assert.rejects(worker.client.tokenFor(job.id,{...lease,fencing_token:lease.fencing_token+1}),/STALE_FENCING_TOKEN/);
  let first=true;
  const paths=[];
  const adapter=new GoogleGmailAdapter(async(url,options)=>{
    assert.equal(new URL(url).hostname,'gmail.googleapis.com');
    assert.equal(options.method,undefined);
    paths.push(new URL(url).pathname);
    if(first){first=false;return new Response(null,{status:401});}
    assert.equal(options.headers.authorization,'Bearer refreshed-fixture');
    if(url.includes('/profile?')) return Response.json({emailAddress:'other@example.invalid'});
    if(url.includes('/messages?')) return Response.json({messages:[{id:'synthetic'}]});
    assert.match(url,/format=metadata/);
    return Response.json({id:'synthetic',payload:{headers:[{name:'Subject',value:'must-not-be-stored'}]}});
  });
  const evidence=await adapter.inspect(refresh=>worker.client.tokenFor(job.id,lease,refresh));
  assert.equal(refreshCalls,1);
  assert.equal(paths.length,4);
  await worker.client.complete(job.id,lease,{...evidence,generation:job.generation,observed_at:new Date().toISOString()});
  assert.equal((await statusOf(liveBase,path)).evidence.metadata_read,true);
  const {rows:[stored]}=await db.query('SELECT evidence::text FROM gmail_connections WHERE (store_id,email_id)=($1,$2)',[store,email]);
  assert.ok(!stored.evidence.includes('must-not-be-stored')&&!stored.evidence.includes('synthetic'));
  const cached=await db.query("SELECT 1 FROM requests WHERE store_id=$1 AND response::text LIKE '%refreshed-fixture%'",[store]);
  assert.equal(cached.rowCount,0);
  const wrong=fromConsent(await authorize(liveBase,path,owner));
  assert.match((await callback(liveBase,wrong,{code:'wrong'})).headers.get('location'),/failed$/);
  assert.equal((await statusOf(liveBase,path)).status,'CONNECTED');
  const disconnected=await call(liveBase,path+'/connection/disconnect',{token:owner,body:{confirm:true}});
  assert.equal(disconnected.data.remote_revocation,'SUCCEEDED');
  assert.equal((await db.query('SELECT 1 FROM gmail_vault WHERE (store_id,email_id)=($1,$2)',[store,email])).rowCount,0);
});

test('expired or revoked Owner consent cannot queue work, and only one concurrent callback wins',opts,async()=>{
  const email=await emailFixture('state@example.invalid'),path=route(store,email);
  const stale=fromConsent(await authorize(mockBase,path,owner));
  await db.query('UPDATE gmail_oauth_states SET expires_at=now() WHERE (store_id,email_id)=($1,$2)',[store,email]);
  assert.match((await callback(mockBase,stale,{decision:'allow'})).headers.get('location'),/failed$/);
  const [a,b]=await Promise.all([authorize(mockBase,path,owner),authorize(mockBase,path,owner)]);
  const outcomes=await Promise.all([a,b].map(result=>callback(mockBase,fromConsent(result),{decision:'allow'})));
  assert.deepEqual(outcomes.map(result=>result.headers.get('location').split('=').at(-1)).sort(),['accepted','failed']);
  const queued=await db.query('SELECT id FROM gmail_jobs WHERE (store_id,email_id)=($1,$2)',[store,email]);
  assert.equal(queued.rowCount,1);
  const reconnect=fromConsent(await authorize(mockBase,path,owner));
  await call(mockBase,path+'/connection/disconnect',{token:owner,body:{confirm:true}});
  assert.match((await callback(mockBase,reconnect,{decision:'allow'})).headers.get('location'),/failed$/);
  assert.equal((await statusOf(mockBase,path)).status,'DISCONNECTED');
});

test('missing Google refresh token requires consent and an empty live inbox is valid',opts,async()=>{
  const email=await emailFixture('empty@example.invalid'),path=route(store,email);
  const missing=fromConsent(await authorize(liveBase,path,owner));
  assert.match((await callback(liveBase,missing,{code:'no-refresh'})).headers.get('location'),/failed$/);
  assert.equal((await statusOf(liveBase,path)).status,'AUTH_REQUIRED');
  const consent=fromConsent(await authorize(liveBase,path,owner));
  assert.match((await callback(liveBase,consent,{code:'accepted'})).headers.get('location'),/accepted$/);
  const worker=await createWorker('live');
  const reads=[];
  const adapter=new GoogleGmailAdapter(async url=>{
    reads.push(url);
    return url.includes('/profile?')?Response.json({emailAddress:'empty@example.invalid'}):Response.json({resultSizeEstimate:0});
  });
  assert.equal((await runGmailOnce(worker.client,'live',adapter)).status,'CONNECTED');
  const state=await statusOf(liveBase,path);
  assert.deepEqual([state.evidence.provenance,state.evidence.empty_inbox,state.evidence.metadata_read],['LIVE',true,false]);
  assert.equal(reads.length,2);
  const retry=fromConsent(await authorize(liveBase,path,owner));
  assert.match((await callback(liveBase,retry,{code:'no-refresh'})).headers.get('location'),/accepted$/);
  assert.equal((await runGmailOnce(worker.client,'live',adapter)).status,'CONNECTED');
  await call(liveBase,path+'/connection/disconnect',{token:owner,body:{confirm:true}});
});

test('Gmail and streaming claims share four slots and expired leases are fenced',opts,async()=>{
  const email=await emailFixture('capacity@example.invalid'),path=route(store,email);
  const consent=fromConsent(await authorize(mockBase,path,owner));
  assert.match((await callback(mockBase,consent,{decision:'allow'})).headers.get('location'),/accepted$/);
  const worker=await createWorker('mock');
  const {WorkerClient}=await import('../packages/shared/worker-client.mts');
  const streaming=await createWorker();
  const client=new WorkerClient(mockBase,streaming.token,streaming.id);
  const streamJob=()=>call(mockBase,'/v1/stores/'+store+'/bot-jobs',{token:owner,body:{type:'HEALTH_CHECK',reason:'Combined capacity'},
    headers:{'x-request-id':randomUUID()},status:201});
  for(let index=0;index<4;index++) await streamJob();
  const leases=await Promise.all(Array.from({length:4},()=>client.claim(['HEALTH_CHECK'])));
  assert.ok(leases.every(Boolean));
  assert.equal(await worker.client.claim(),null);
  await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE (store_id,id)=($1,$2)",[store,leases[0].job.id]);
  const initial=await worker.client.claim();
  assert.ok(initial);
  await streamJob();
  assert.equal(await client.claim(['HEALTH_CHECK']),null);
  const lease={lease_token:initial.lease_token,fencing_token:initial.fence};
  await worker.client.start(initial.id,lease);
  await db.query("UPDATE gmail_jobs SET lease_until=now()-interval '1 second' WHERE (store_id,id)=($1,$2)",[store,initial.id]);
  await assert.rejects(worker.client.heartbeat(initial.id,lease),/STALE_FENCING_TOKEN/);
  const reclaimed=await worker.client.claim();
  assert.equal(reclaimed.id,initial.id);
  assert.equal(reclaimed.fence,initial.fence+1);
});
