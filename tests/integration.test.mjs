import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import pg from 'pg';

const enabled=Boolean(process.env.TEST_DATABASE_URL && process.env.DATABASE_URL);
let app, pool, db, base, admin, secondAdmin, owner, outsider, A, B, worker, client;
const password='Disposable-Test-2026!';
const uid=()=>randomUUID();
const token=()=>randomBytes(32).toString('base64url');
const json=async (method,path,auth,body,key=uid())=>{
  const response=await fetch(base+path,{method,headers:{
    ...(auth&&{authorization:'Bearer '+auth}),
    ...(body&&{'content-type':'application/json','idempotency-key':key,'x-request-id':uid()})},
    body:body?JSON.stringify(body):undefined});
  return [response.status,response.status===204?null:await response.json()];
};
async function ok(method,path,auth,body,expected=200,key) {
  const [status,result]=await json(method,path,auth,body,key);
  assert.equal(status,expected,JSON.stringify(result));
  return result;
}
before(async()=>{
  if (!enabled) return;
  process.env.BOT_LEASE_SECONDS='15';
  process.env.PROFILE_PIN_KEY=randomBytes(32).toString('hex');
  ({pool}=await import('../apps/api/db.mjs'));
  const {appServer}=await import('../apps/api/server.mjs');
  const {passwordHash,digest}=await import('../apps/api/db.mjs');
  const {WorkerClient}=await import('../packages/shared/worker-client.mts');
  db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const adminUsername='root-'+uid();
  await db.query('INSERT INTO users(username,password_hash,is_super) VALUES($1,$2,true)',[adminUsername,await passwordHash(password)]);
  app=await appServer();
  base=await app.listen({port:0,host:'127.0.0.1'});
  admin=(await ok('POST','/v1/login',null,{username:adminUsername.toUpperCase(),password})).token;
  const secondUsername='second-'+uid();
  secondAdmin=await ok('POST','/v1/admin/users',admin,{username:secondUsername,role:'ADMIN',current_password:password,password});
  async function store() {
    const username='owner-'+uid();
    const user=await ok('POST','/v1/admin/users',admin,{username,role:'OWNER',current_password:password,password});
    const data=await ok('POST','/v1/admin/stores',admin,{name:'Isolated test store',owner_id:user.id,current_password:password});
    return [data.id,(await ok('POST','/v1/login',null,{username,password})).token];
  }
  [A,owner]=await store();
  [B,outsider]=await store();
  worker={id:'test-'+uid(),token:token()};
  await db.query("INSERT INTO workers VALUES($1,$2,now()+interval '1 day')",[worker.id,digest(worker.token)]);
  await db.query('INSERT INTO worker_stores VALUES($1,$2)',[worker.id,A]);
  client=new WorkerClient(base,worker.token,worker.id);
});
after(async()=>{
  if (!enabled) return;
  await app?.close();
  await pool?.end();
  await db?.end();
});
const storePath=(id=A)=>'/v1/stores/'+id+'/';
const verify=()=>({type:'HEALTH_CHECK',reason:'Confirm sandbox worker',requested_priority:1});
const runMock=async()=> (await import('../apps/mock-worker/worker.mjs')).runOnce(client);
const integration=(name,fn)=>test(name,{skip:!enabled&&'Set TEST_DATABASE_URL and DATABASE_URL on a migrated disposable PostgreSQL database'},fn);
integration('scoped HTTP worker completes job, rejects wrong audience and isolates two stores',async()=>{
  const badPath=storePath(B)+'bot-jobs';
  const other=await ok('POST',badPath,outsider,verify(),201);
  await ok('GET',badPath,owner,undefined,403);
  await ok('GET',storePath()+'customers',admin,undefined,403);
  assert.equal(await client.claim(['HEALTH_CHECK']),null);
  await ok('POST','/v1/worker/jobs/claim',owner,{worker_id:worker.id,capabilities:['HEALTH_CHECK']},401);
  await ok('GET',storePath()+'bot-jobs',worker.token,undefined,401);
  const key=uid();
  const job=await ok('POST',storePath()+'bot-jobs',owner,verify(),201,key);
  assert.equal(job.priority,4);
  assert.deepEqual(await ok('POST',storePath()+'bot-jobs',owner,verify(),201,key),job);
  await ok('POST',storePath()+'bot-jobs',owner,{...verify(),reason:'Different payload'},409,key);
  assert.equal((await runMock()).id,job.id);
  const data=await ok('GET',storePath()+'bot-jobs/'+job.id,owner);
  assert.equal(data.status,'SUCCEEDED');
  assert.deepEqual(data.history.map(event=>event.event_type).sort(),['job.claimed','job.heartbeat','job.queued','job.started','job.succeeded']);
  assert.equal((await ok('GET',badPath+'/'+other.id,outsider)).status,'QUEUED');
});
integration('parallel claims reserve four slots and stale completion stays rejected',async()=>{
  for(let i=0;i<5;i++) await ok('POST',storePath()+'bot-jobs',owner,verify(),201);
  const claims=(await Promise.all(Array.from({length:5},()=>client.claim(['HEALTH_CHECK'])))).filter(Boolean);
  assert.equal(claims.length,4);
  assert.equal(new Set(claims.map(c=>c.job.id)).size,4);
  const adapter=new (await import('../apps/mock-worker/worker.mjs')).MockStreamingProviderAdapter();
  for (const {job,lease_token,fencing_token} of claims) {
    const lease={lease_token,fencing_token,worker_id:worker.id};
    await client.start(job.id,lease);
    if (job.id===claims[0].job.id) {
      await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE store_id=$1 AND id=$2",[A,job.id]);
      await assert.rejects(client.report(job.id,{...lease,...adapter.execute(job)}),/409/);
    } else await client.report(job.id,{...lease,...adapter.execute(job)});
  }
  await runMock();
  const jobs=await ok('GET',storePath()+'bot-jobs?status=RETRY_WAIT',owner);
  assert.equal(jobs.items.length,1);
  await ok('POST',storePath()+'bot-jobs/'+jobs.items[0].id+'/cancel',owner,{reason:'Discard test job'});
});
integration('owner can approve mock credit and allocate verified inventory to mock rental',async()=>{
  const route=storePath();
  const customer=await ok('POST',route+'customers',owner,{name:'Demo customer'});
  const credential={platform:'netflix',email:uid()+'@example.invalid',password:'Demo-Bind-Only!'};
  await ok('POST',route+'streaming-emails',owner,{email:credential.email,password:'short'},400);
  const email=await ok('POST',route+'streaming-emails',owner,{email:credential.email,password:credential.password});
  const binding={platform:'netflix',email_id:email.id,otp:'123456',profile_count:2,broker_amount:'0',subscription_amount:'0'};
  assert.deepEqual(await ok('GET',storePath(B)+'streaming-emails',outsider),[]);
  await ok('POST',storePath(B)+'accounts',outsider,binding,400);
  await ok('POST',route+'accounts',owner,{...binding,platform:'other'},400);
  await ok('POST',route+'accounts',owner,{...binding,otp:'000000'},400);
  await ok('POST',route+'accounts',owner,{...binding,profile_count:0},400);
  await ok('POST',route+'accounts',owner,{...binding,broker_amount:undefined},400);
  assert.deepEqual(await ok('GET',route+'accounts',owner),[]);
  const account=await ok('POST',route+'accounts',owner,{...binding,otp:undefined});
  const listed=(await ok('GET',route+'streaming-emails',owner))[0];
  assert.deepEqual([listed.email,listed.bound_platforms,listed.password_set],[credential.email,['netflix'],true]);
  assert.ok(!Object.hasOwn(listed,'password_hash'));
  await ok('POST',route+'streaming-emails/'+email.id,owner,{email:uid()+'@example.invalid'},409);
  await ok('POST',route+'streaming-emails/'+email.id,owner,{password:'Updated-Demo-Mail-Password!'});
  await ok('POST',route+'accounts',owner,binding,409);
  const profiles=await ok('GET',route+'profiles',owner);
  assert.deepEqual(profiles.map(({label,is_primary})=>[label,is_primary]),[['profile1',true],['profile2',false]]);
  const [primary,rentable]=profiles;
  const primaryPath=route+'accounts/'+account.id+'/profiles/'+primary.id+'/';
  await ok('POST',primaryPath+'archive',owner,{confirm:true},409);
  await ok('POST',primaryPath+'rename',owner,{label:'Main profile'});
  const request=await ok('POST',route+'payment-requests',owner,{customer_id:customer.id,amount:'100'});
  const transfer=await ok('POST',route+'transfers',owner,{payment_id:request.id,amount:'100',evidence:'mock-'+uid()});
  await ok('POST',route+'transfers/'+transfer.id+'/approve',owner,{confirm:true});
  await ok('POST',route+'transfers/'+transfer.id+'/approve',owner,{confirm:true});
  const offer=await ok('POST',route+'packages',owner,{platform:'netflix',name:'Two day test',amount:'60',days:2});
  const purchase={customer_id:customer.id,amount:'60',days:2,confirm:true};
  await ok('POST',route+'orders',owner,purchase,400);
  const results=await Promise.all(Array.from({length:2},()=>json('POST',route+'orders',owner,{...purchase,package_id:offer.id})));
  assert.deepEqual(results.map(([status])=>status).sort(),[200,409]);
  const order_id=results.find(([status])=>status===200)[1].id;
  const otherEmail=uid()+'@example.invalid';
  await db.query('INSERT INTO streaming_email_addresses(store_id,email) VALUES($1,$2)',[A,otherEmail]);
  await db.query("INSERT INTO streaming_emails(store_id,platform,email) VALUES($1,'zzz-other',$2)",[A,otherEmail]);
  const {rows:[other]}=await db.query(`INSERT INTO accounts(store_id,platform,email,health,checked_at,subscription_until)
    VALUES($1,'zzz-other',$2,'HEALTHY',now(),now()+interval '30 days') RETURNING id`,[A,otherEmail]);
  const otherProfile=await ok('POST',route+'profiles',owner,{account_id:other.id,label:'Other platform profile'});
  assert.ok((await ok('GET',route+'allocation-accounts',owner)).some(row=>row.id===other.id && row.available_profiles===1));
  const scoped=route+'allocation-accounts?order_id='+order_id;
  assert.deepEqual((await ok('GET',scoped,owner)).map(row=>row.id),[account.id]);
  await ok('GET',storePath(B)+'allocation-accounts?order_id='+order_id,outsider,undefined,404);
  await ok('POST',route+'allocate',owner,{order_id,account_id:other.id},409);
  await ok('POST',route+'accounts/'+other.id+'/profiles/'+otherProfile.id+'/archive',owner,{confirm:true});
  const [unverified]=await ok('GET',route+'allocation-accounts',owner);
  assert.deepEqual([unverified.id,unverified.available_profiles,unverified.accepts_waiting_order],[account.id,1,false]);
  assert.equal(unverified.blocked_reason,'NOT_VERIFIED');
  await ok('POST',route+'allocate',owner,{account_id:account.id},409);
  await ok('POST',route+'bot-jobs',owner,{type:'VERIFY_SUBSCRIPTION',reason:'Demo check',account_id:account.id},201);
  await runMock();
  const [available]=await ok('GET',scoped,owner);
  assert.deepEqual([available.id,available.available_profiles,available.accepts_waiting_order],[account.id,1,true]);
  assert.equal(available.blocked_reason,null);
  const {rows:[verification]}=await db.query('SELECT checked_at,subscription_until FROM accounts WHERE (store_id,id)=($1,$2)',[A,account.id]);
  await db.query("UPDATE accounts SET checked_at=now()-interval '25 hours' WHERE (store_id,id)=($1,$2)",[A,account.id]);
  assert.equal((await ok('GET',scoped,owner))[0].blocked_reason,'CHECK_EXPIRED');
  await db.query("UPDATE accounts SET checked_at=$3,subscription_until=now()+interval '1 day' WHERE (store_id,id)=($1,$2)",[A,account.id,verification.checked_at]);
  const [short]=await ok('GET',scoped,owner);
  assert.equal(short.blocked_reason,'SUBSCRIPTION_TOO_SHORT');
  assert.ok(Date.parse(short.required_until)>Date.parse(short.subscription_until));
  await db.query('UPDATE accounts SET subscription_until=$3 WHERE (store_id,id)=($1,$2)',[A,account.id,verification.subscription_until]);
  assert.deepEqual(available.profiles,[{id:rentable.id,label:'profile2'}]);
  await ok('POST',route+'allocate',owner,{order_id,account_id:account.id,profile_id:primary.id},409);
  await ok('POST',route+'allocate',owner,{account_id:uid()},409);
  await ok('POST',route+'allocate',owner,{order_id,account_id:account.id,profile_id:rentable.id});
  assert.equal((await ok('GET',route+'orders?scope=active',owner)).find(row=>row.id===order_id).status,'DELIVERING');
  const beforeDelivery=await ok('GET',route+'owner-overview',owner);
  assert.deepEqual(beforeDelivery.backlog,[{platform:'netflix',days:2,name:'Two day test',waiting:0,delivering:1}]);
  assert.deepEqual([beforeDelivery.credits_in,beforeDelivery.sales.package_sales],['100.00','60.00']);
  assert.equal((await ok('GET',route+'allocation-accounts',owner))[0].available_profiles,0);
  await runMock();
  assert.deepEqual(await ok('GET',route+'orders?scope=active',owner),[]);
  assert.equal((await ok('GET',route+'orders',owner)).find(row=>row.id===order_id).status,'FULFILLED');
  const rentals=await ok('GET',route+'rentals',owner);
  assert.equal(rentals.length,1);
  assert.equal(rentals[0].status,'ACTIVE');
  const deliveredOverview=await ok('GET',route+'owner-overview',owner);
  assert.equal(deliveredOverview.expiring,1);
  assert.deepEqual(deliveredOverview.backlog,[]);
  assert.equal((await ok('GET',route+'customers',owner))[0].balance,'40.00');
});
integration('restricted PostgreSQL role rejects unauthenticated and forged tenant context',async()=>{
  const conn=await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query("SELECT set_config('app.store',$1,true)",[A]);
    assert.equal((await conn.query('SELECT id FROM customers')).rowCount,0);
    await assert.rejects(conn.query('INSERT INTO customers(store_id,name) VALUES($1,$2)',[A,'blocked']),{code:'42501'});
    await conn.query('ROLLBACK');
    await conn.query('BEGIN');
    await conn.query("SELECT set_config('app.store',$1,true),set_config('app.auth',$2,true)",[B,owner]);
    assert.equal((await conn.query('SELECT id FROM jobs')).rowCount,0);
    await conn.query('ROLLBACK');
    await assert.rejects(conn.query('UPDATE wallet_ledger SET amount=0'),{code:'42501'});
  } finally {
    await conn.query('ROLLBACK');
    conn.release();
  }
});
integration('renewal uses the original package and compensation extends the same rental without debit',async()=>{
  const path=storePath();
  const [rental]=await ok('GET',path+'rentals',owner);
  const [payment]=await ok('GET',path+'payment-requests',owner);
  const transfer=await ok('POST',path+'transfers',owner,{payment_id:payment.id,amount:'60',evidence:'mock-'+uid()});
  await ok('POST',path+'transfers/'+transfer.id+'/approve',owner,{confirm:true});
  const endpoint=path+'rentals/'+rental.id+'/';
  const renewal={package_id:rental.package_id,amount:'60',days:2,expected_ends_at:rental.ends_at,confirm:true};
  await ok('POST',endpoint+'renew',owner,{...renewal,package_id:uid()},409);
  const renewed=await ok('POST',endpoint+'renew',owner,renewal);
  assert.equal(Date.parse(renewed.ends_at)-Date.parse(rental.ends_at),2*86400000);
  await ok('POST',endpoint+'renew',owner,renewal,409);
  const extended=await ok('POST',endpoint+'compensate',owner,{days:3,reason:'Test interruption',expected_ends_at:renewed.ends_at,confirm:true});
  assert.equal(Date.parse(extended.ends_at)-Date.parse(renewed.ends_at),3*86400000);
  assert.equal((await ok('GET',path+'customers',owner))[0].balance,'40.00');
  const orders=await ok('GET',path+'orders',owner);
  assert.equal(orders.find(row=>row.id===extended.id).amount,'0.00');
  assert.equal((await ok('GET',path+'rentals',owner)).length,1);
  const staffName='renewal-staff-'+uid();
  await ok('POST',path+'staff',owner,{username:staffName,password,role:'STAFF'});
  const staff=(await ok('POST','/v1/login',null,{username:staffName,password})).token;
  await ok('GET',path+'customers',staff,undefined,403);
  await ok('GET',path+'owner-overview',staff,undefined,403);
  const [summary]=await ok('GET',path+'customer-renewals',staff);
  assert.equal(summary.name,'Demo customer');
  assert.ok(!Object.hasOwn(summary,'balance'));
  const [entry]=summary.rentals;
  assert.deepEqual([entry.id,entry.platform,entry.profile_label,entry.package_days],[rental.id,'netflix','profile2',2]);
  assert.equal(Date.parse(entry.ends_at),Date.parse(extended.ends_at));
  await ok('GET',path+'customer-renewals',outsider,undefined,403);
});
integration('uncertain revocation holds profile and schedules a reconciliation job',async()=>{
  const path=storePath();
  const [rental]=await ok('GET',path+'rentals',owner);
  await db.query("UPDATE rentals SET starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' WHERE store_id=$1 AND id=$2",[A,rental.id]);
  assert.deepEqual(await ok('POST',path+'rentals/expire',owner,{}),{queued:1});
  const claim=await client.claim(['REVOKE_ACCESS']);
  const lease={lease_token:claim.lease_token,fencing_token:claim.fencing_token,worker_id:worker.id};
  await client.start(claim.job.id,lease);
  const observed_at=new Date().toISOString();
  const result=await client.report(claim.job.id,{...lease,observed_at,outcome:'INCONCLUSIVE',
    error_code:'ACCESS_NOT_REVOKED',evidence:{kind:'MOCK',source:'mock-provider',reference:'mock-'+uid(),observed_at}});
  assert.equal(result.status,'RECONCILING');
  assert.equal((await ok('GET',path+'profiles',owner)).find(row=>row.label==='profile2').status,'HELD');
  assert.equal((await ok('GET',path+'rentals',owner))[0].status,'REVOCATION_PENDING');
  assert.equal((await runMock()).type,'RECONCILE_REVOCATION');
  assert.equal((await ok('GET',path+'rentals',owner))[0].status,'CLOSED');
  assert.equal((await ok('GET',path+'profiles',owner)).find(row=>row.label==='profile2').status,'AVAILABLE');
});
integration('prod startup rejects mock application before constructing routes',async()=>{
  const {appServer}=await import('../apps/api/server.mjs');
  const prior=process.env.NODE_ENV;
  process.env.NODE_ENV='production';
  try { await assert.rejects(appServer(),/cannot run in production/); }
  finally { if (prior===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=prior; }
});
integration('invalid mock subscription blocks allocation and records an incident until recovery',async()=>{
  const path=storePath();
  const [account]=await ok('GET',path+'accounts',owner);
  const first=await ok('POST',path+'bot-jobs',owner,{type:'VERIFY_SUBSCRIPTION',account_id:account.id,reason:'Subscription fault fixture'},201);
  const claim=await client.claim(['VERIFY_SUBSCRIPTION']);
  assert.equal(claim.job.id,first.id);
  const lease={lease_token:claim.lease_token,fencing_token:claim.fencing_token,worker_id:worker.id};
  await client.start(first.id,lease);
  const observed_at=new Date().toISOString();
  await client.report(first.id,{...lease,observed_at,outcome:'FAIL',error_code:'SUBSCRIPTION_INVALID',
    evidence:{kind:'MOCK',source:'mock-provider',reference:'mock-'+uid(),observed_at}});
  assert.equal((await ok('GET',path+'accounts',owner))[0].health,'BLOCKED');
  assert.ok((await ok('GET',path+'incidents',owner)).some(row=>row.job_id===first.id&&row.reason==='SUBSCRIPTION_INVALID'));
  await ok('POST',path+'bot-jobs',owner,{type:'VERIFY_SUBSCRIPTION',account_id:account.id,reason:'Should require recovery'},409);
  await ok('POST',path+'bot-jobs',owner,{type:'RECOVERY_VERIFICATION',account_id:account.id,reason:'Verify account after failure'},201);
  assert.equal((await runMock()).status,'SUCCEEDED');
  assert.equal((await ok('GET',path+'accounts',owner))[0].health,'HEALTHY');
});
integration('Netflix creates five numbered profiles when no count is supplied',async()=>{
  const path=storePath();
  const email=await ok('POST',path+'streaming-emails',owner,{email:uid()+'@example.invalid',password:'Demo-Mail-Only!'});
  const updated=await ok('POST',path+'streaming-emails/'+email.id,owner,{email:uid()+'@example.invalid'});
  assert.notEqual(updated.email,email.email);
  const account=await ok('POST',path+'accounts',owner,{
    platform:'netflix',email_id:email.id,otp:'123456',broker_amount:'0',subscription_amount:'0'
  });
  const profiles=(await ok('GET',path+'profiles',owner)).filter(profile=>profile.account_id===account.id);
  assert.deepEqual(profiles.map(profile=>profile.label),['profile1','profile2','profile3','profile4','profile5']);
});
integration('store requests create a second store only after Super Admin approval',async()=>{
  const username='staff-'+uid();
  await ok('POST',storePath()+'staff',owner,{username,password,role:'STAFF'});
  const staff=(await ok('POST','/v1/login',null,{username,password})).token;
  const endpoint=storePath()+'store-requests';
  await ok('POST',endpoint,staff,{name:'Denied'},403);
  await ok('POST',endpoint,outsider,{name:'Denied'},403);
  const entry=await ok('POST',endpoint,owner,{name:'Second shop'});
  assert.equal(entry.status,'PENDING');
  await ok('POST',endpoint,owner,{name:'second shop'},409);
  assert.equal((await ok('GET','/v1/me',owner)).stores.length,1);
  assert.deepEqual(await ok('GET',storePath(B)+'store-requests',outsider),[]);
  const review='/v1/admin/store-requests/'+entry.id+'/review';
  await ok('POST',review,owner,{status:'APPROVED',current_password:password},403);
  const approved=await ok('POST',review,admin,{status:'APPROVED',current_password:password});
  await ok('POST',review,admin,{status:'APPROVED',current_password:password},409);
  const identity=await ok('GET','/v1/me',owner);
  assert.ok(identity.stores.some(store=>store.id===approved.store_id && store.role==='OWNER'));
  assert.deepEqual(await ok('GET',storePath(approved.store_id)+'accounts',owner),[]);
  await ok('GET',storePath(approved.store_id)+'accounts',outsider,undefined,403);
  const denied=await ok('POST',endpoint,owner,{name:'Denied shop'});
  const rejected=await ok('POST','/v1/admin/store-requests/'+denied.id+'/review',admin,{status:'REJECTED',current_password:password});
  assert.equal(rejected.store_id,null);
  assert.equal((await ok('GET','/v1/me',owner)).stores.length,2);
});
integration('owner password change verifies the old password and revokes other sessions',async()=>{
  const {rows:[{username}]}=await db.query(`SELECT u.username FROM users u JOIN memberships m ON m.user_id=u.id
    WHERE m.store_id=$1 AND m.role='OWNER'`,[A]);
  const other=(await ok('POST','/v1/login',null,{username,password})).token;
  const new_password='New-Disposable-Password!';
  const path=storePath()+'owner-password';
  await ok('POST',path,owner,{current_password:'wrong-password-123',new_password},403);
  await ok('POST',path,owner,{current_password:password,new_password});
  await ok('GET','/v1/me',owner);
  await ok('GET','/v1/me',other,undefined,401);
  await ok('POST','/v1/login',null,{username,password},401);
  await ok('POST','/v1/login',null,{username,password:new_password});
});
integration('Netflix package prices are store-scoped and existing orders retain their terms',async()=>{
  const path=storePath();
  const terms={platform:'netflix',name:'Netflix monthly',days:30,amount:'25.50'};
  const entry=await ok('POST',path+'packages',owner,terms);
  assert.deepEqual(await ok('GET',storePath(B)+'packages',outsider),[]);
  await ok('POST',storePath(B)+'packages/'+entry.id,outsider,terms,404);
  const customer=await ok('POST',path+'customers',owner,{name:'Package buyer'});
  const payment=await ok('POST',path+'payment-requests',owner,{customer_id:customer.id,amount:'100'});
  const transfer=await ok('POST',path+'transfers',owner,{payment_id:payment.id,amount:'100',evidence:'mock-'+uid()});
  await ok('POST',path+'transfers/'+transfer.id+'/approve',owner,{confirm:true});
  const purchase={customer_id:customer.id,package_id:entry.id,days:30,amount:'25.50',confirm:true};
  const order=await ok('POST',path+'orders',owner,purchase);
  await ok('POST',path+'packages/'+entry.id,owner,{...terms,days:28,amount:'29.90'});
  await ok('POST',path+'orders',owner,purchase,409);
  const saved=(await ok('GET',path+'orders',owner)).find(row=>row.id===order.id);
  assert.deepEqual([saved.package_id,saved.platform,saved.days,saved.amount],[entry.id,'netflix',30,'25.50']);
});
integration('customer aliases and URLs can be saved, cleared and accessed only within the store',async()=>{
  const path=storePath();
  await ok('POST',path+'customers',owner,{name:'Invalid link',url:'javascript:alert(1)'},400);
  const customer=await ok('POST',path+'customers',owner,{name:'Customer with alias',alias:'  น้องเอ  ',url:'https://example.invalid/contact'});
  assert.deepEqual([customer.alias,customer.url],['น้องเอ','https://example.invalid/contact']);
  const contact='customers/'+customer.id+'/contact';
  await ok('POST',storePath(B)+contact,outsider,{alias:'Other store',url:''},404);
  const saved=(await ok('GET',path+'customers',owner)).find(row=>row.id===customer.id);
  assert.equal(saved.alias,'น้องเอ');
  const cleared=await ok('POST',path+contact,owner,{name:'Renamed customer',alias:'',url:''});
  assert.deepEqual([cleared.name,cleared.alias,cleared.url],['Renamed customer',null,null]);
});
integration('Super Admin can suspend and reactivate a store and adjust its Bangkok expiry',async()=>{
  const path='/v1/admin/stores/'+A+'/';
  await ok('POST',path+'status',owner,{status:'SUSPENDED',expected_status:'ACTIVE'},403);
  await ok('POST',path+'status',admin,{status:'SUSPENDED',expected_status:'ACTIVE'});
  await ok('POST',storePath()+'customers',owner,{name:'Blocked creation'},409);
  await ok('POST',path+'status',admin,{status:'ACTIVE',expected_status:'ACTIVE'},409);
  await ok('POST',path+'status',admin,{status:'ACTIVE',expected_status:'SUSPENDED'});
  const {expires_at}= (await ok('GET','/v1/admin/stores',admin)).find(row=>row.id===A);
  const expiry={mode:'CALENDAR',date:'2099-01-30',expected_expiry:expires_at};
  await ok('POST',path+'expiry',owner,expiry,403);
  await ok('POST',path+'expiry',admin,{...expiry,date:'2099-02-30'},400);
  const set=await ok('POST',path+'expiry',admin,expiry);
  assert.equal(set.expires_at,'2099-01-30T17:00:00.000Z');
  const quick={mode:'ADD_MONTH',expected_expiry:set.expires_at};
  const advanced=await ok('POST',path+'expiry',admin,quick);
  assert.equal(advanced.expires_at,'2099-02-28T17:00:00.000Z');
  await ok('POST',path+'expiry',admin,quick,409);
});
integration('Super Admin can change their own password',async()=>{
  const new_password='Updated-Admin-Test-2026!';
  await ok('POST','/v1/admin/password',owner,{current_password:password,new_password},403);
  await ok('POST','/v1/admin/password',admin,{current_password:'Wrong-Admin-Password',new_password},403);
  await ok('POST','/v1/admin/password',admin,{current_password:password,new_password});
  assert.equal((await ok('GET','/v1/me',admin)).is_super,true);
});
integration('owner can rename, protect and remove a profile under the correct account',async()=>{
  const path=storePath();
  const [account,otherAccount]=await ok('GET',path+'accounts',owner);
  const profile=await ok('POST',path+'profiles',owner,{account_id:account.id,label:'New profile'});
  const action=path+'accounts/'+account.id+'/profiles/'+profile.id+'/';
  await ok('POST',path+'accounts/'+otherAccount.id+'/profiles/'+profile.id+'/rename',owner,{label:'Wrong account'},404);
  await ok('POST',action+'rename',owner,{label:'Renamed profile'});
  await ok('POST',action+'pin',owner,{pin:'123'},400);
  assert.deepEqual(await ok('POST',action+'pin',owner,{pin:'0427'}),{pin_set:true});
  const configured=(await ok('GET',path+'profiles',owner)).find(row=>row.id===profile.id);
  assert.equal(configured.label,'Renamed profile');
  assert.equal(configured.pin_set,true);
  assert.ok(!Object.hasOwn(configured,'pin_hash'));
  await db.query("UPDATE profiles SET status='HELD' WHERE store_id=$1 AND id=$2",[A,profile.id]);
  await ok('POST',action+'archive',owner,{confirm:true},409);
  await db.query("UPDATE profiles SET status='AVAILABLE' WHERE store_id=$1 AND id=$2",[A,profile.id]);
  await ok('POST',action+'archive',owner,{confirm:true});
  assert.equal((await ok('GET',path+'profiles',owner)).some(row=>row.id===profile.id),false);
  await ok('POST',action+'rename',owner,{label:'Already removed'},404);
});
integration('Super Admin sees separate per-store package sales with exact totals',async()=>{
  const path=storePath(B);
  const salesPath='/v1/admin/stores/'+B+'/sales';
  await ok('POST','/v1/admin/users',outsider,{username:'denied-'+uid(),role:'ADMIN',current_password:password,password},403);
  const customer=await ok('POST',path+'customers',outsider,{name:'Report example customer'});
  const payment=await ok('POST',path+'payment-requests',outsider,{customer_id:customer.id,amount:'200'});
  const deposit=await ok('POST',path+'transfers',outsider,{payment_id:payment.id,amount:'200',evidence:'mock-'+uid()});
  await ok('POST',path+'transfers/'+deposit.id+'/approve',outsider,{confirm:true});
  for(const [days,amount,count] of [[1,'15',5],[7,'39',3],[30,'95',0]]){
    const entry=await ok('POST',path+'packages',outsider,{platform:'netflix',name:'Netflix '+days+' days',days,amount});
    for(let i=0;i<count;i++) await ok('POST',path+'orders',outsider,{customer_id:customer.id,package_id:entry.id,amount,days,confirm:true});
  }
  await ok('GET',salesPath,outsider,undefined,403);
  await assert.rejects(pool.query('SELECT public.admin_store_sales($1,$2)',[B,outsider]),{code:'42501'});
  const report=await ok('GET',salesPath,admin);
  assert.deepEqual([report.purchase_count,report.packages_sold,report.total_sales],[8,8,'192.00']);
  assert.deepEqual(report.packages.map(row=>[row.days,row.unit_price,row.sold,row.total]),[
    [1,'15.00',5,'75.00'],[7,'39.00',3,'117.00'],[30,'95.00',0,'0.00']
  ]);
  const overview=await ok('GET',path+'owner-overview',outsider);
  assert.deepEqual([overview.credits_in,overview.sales.package_sales,overview.sales.packages_sold],['200.00','192.00',8]);
  assert.deepEqual(overview.backlog.map(row=>[row.days,row.waiting,row.delivering]),[[1,5,0],[7,3,0]]);
  const otherReport=await ok('GET','/v1/admin/stores/'+A+'/sales',admin);
  assert.equal(otherReport.compensation_count,1);
  assert.notEqual(otherReport.total_sales,report.total_sales);
});
integration('delegated Admin can create an Owner and approve a first store but cannot manage the platform',async()=>{
  const delegated=(await ok('POST','/v1/login',null,{username:secondAdmin.username,password})).token;
  const identity=await ok('GET','/v1/me',delegated);
  assert.deepEqual([identity.is_super,identity.is_admin],[false,true]);
  for(const endpoint of ['/v1/admin/stores','/v1/admin/admins','/v1/admin/owners','/v1/admin/stores/'+A+'/sales']){
    await ok('GET',endpoint,delegated,undefined,403);
  }
  const username='first-owner-'+uid();
  const credentials={username,password,current_password:password};
  await ok('POST','/v1/admin/users',delegated,{...credentials,role:'ADMIN'},403);
  const created=await ok('POST','/v1/admin/users',delegated,{...credentials,role:'OWNER'});
  await ok('POST','/v1/admin/stores',delegated,{name:'Unauthorized direct creation',owner_id:created.id,current_password:password},403);
  const firstOwner=(await ok('POST','/v1/login',null,{username,password})).token;
  const before=await ok('GET','/v1/me',firstOwner);
  assert.equal(before.is_owner,true);
  assert.deepEqual(before.stores,[]);
  const requested=await ok('POST','/v1/owner/store-requests',firstOwner,{name:'First store'});
  const {count}=await ok('GET','/v1/admin/store-requests/pending-count',delegated);
  await ok('GET','/v1/admin/store-requests/pending-count',firstOwner,undefined,403);
  const requests=await ok('GET','/v1/admin/store-requests?scope=pending',delegated);
  assert.ok(requests.some(row=>row.id===requested.id));
  assert.ok(requests.every(row=>row.status==='PENDING'));
  const review='/v1/admin/store-requests/'+requested.id+'/review';
  await ok('POST',review,delegated,{status:'REJECTED',current_password:password},403);
  const approved=await ok('POST',review,delegated,{status:'APPROVED',current_password:password});
  assert.equal((await ok('GET','/v1/admin/store-requests/pending-count',delegated)).count,count-1);
  const history=await ok('GET','/v1/admin/store-requests?scope=history&page=0',delegated);
  const reviewed=history.find(row=>row.id===requested.id);
  assert.deepEqual([reviewed.status,reviewed.reviewer],['APPROVED',secondAdmin.username]);
  assert.ok(reviewed.reviewed_at);
  assert.ok(history.every(row=>row.status!=='PENDING'));
  const after=await ok('GET','/v1/me',firstOwner);
  assert.ok(after.stores.some(store=>store.id===approved.store_id&&store.role==='OWNER'));
});
integration('monthly fixed fees and daily order profit use the two cost components independently',async()=>{
  const path=storePath(B);
  async function addAccount(target,profile_count,broker_amount,subscription_amount) {
    const email=await ok('POST',target+'streaming-emails',outsider,{email:uid()+'@example.invalid',password:'Demo-Mail-Only!'});
    const account=await ok('POST',target+'accounts',outsider,{platform:'netflix',email_id:email.id,otp:'123456',profile_count,broker_amount,subscription_amount});
    return {...account,email_id:email.id};
  }
  const netflix=await addAccount(path,5,'20','400');
  const idle=await addAccount(path,1,'0','199');
  const costPath=path+'accounts/'+netflix.id+'/cost';
  await ok('GET',costPath,owner,undefined,403);
  const rate=await ok('GET',costPath,outsider);
  assert.deepEqual([rate.broker_amount,rate.subscription_amount,rate.amount],['20.00','400.00','420.00']);
  assert.deepEqual([rate.profile_monthly_cost,rate.profile_daily_cost],['105.00','3.50']);
  const initial=(await ok('GET',path+'owner-overview',outsider)).monthly_cost;
  assert.deepEqual(initial,{month:initial.month,total:'619.00',income:'192.00',configured:2,unconfigured:0});
  assert.match(initial.month,/^\d{4}-\d{2}$/);
  const {digest}=await import('../apps/api/db.mjs');
  const {WorkerClient}=await import('../packages/shared/worker-client.mts');
  const {MockStreamingProviderAdapter}=await import('../apps/mock-worker/worker.mjs');
  const workerId='sales-'+uid(), workerToken=token();
  await db.query("INSERT INTO workers VALUES($1,$2,now()+interval '1 day')",[workerId,digest(workerToken)]);
  await db.query('INSERT INTO worker_stores VALUES($1,$2)',[workerId,B]);
  const salesWorker=new WorkerClient(base,workerToken,workerId);
  async function complete(type,id) {
    const {job,lease_token,fencing_token}=await salesWorker.claim([type]);
    assert.equal(job.id,id);
    const lease={worker_id:workerId,lease_token,fencing_token};
    await salesWorker.start(job.id,lease);
    assert.equal((await salesWorker.report(job.id,{...lease,...new MockStreamingProviderAdapter().execute(job)})).status,'SUCCEEDED');
  }
  const verification=await ok('POST',path+'bot-jobs',outsider,{type:'VERIFY_SUBSCRIPTION',account_id:netflix.id,reason:'Monthly cost verification'},201);
  await complete('VERIFY_SUBSCRIPTION',verification.id);
  const oneDay=(await ok('GET',path+'orders?scope=active',outsider)).find(row=>row.days===1);
  const payment=await ok('POST',path+'payment-requests',outsider,{customer_id:oneDay.customer_id,amount:'179'});
  const transfer=await ok('POST',path+'transfers',outsider,{payment_id:payment.id,amount:'179',evidence:'mock-'+uid()});
  await ok('POST',path+'transfers/'+transfer.id+'/approve',outsider,{confirm:true});
  const plan=await ok('POST',path+'packages',outsider,{platform:'netflix',name:'Monthly margin test',amount:'179',days:30});
  const thirtyDays=await ok('POST',path+'orders',outsider,{customer_id:oneDay.customer_id,package_id:plan.id,amount:'179',days:30,confirm:true});
  for(const order_id of [oneDay.id,thirtyDays.id]){
    const job=await ok('POST',path+'allocate',outsider,{order_id,account_id:netflix.id});
    const [day]=await ok('GET',path+'monthly-sales',outsider);
    const line=(await ok('GET',path+'monthly-sales/'+day.day,outsider)).find(row=>row.order_id===order_id);
    const expected=order_id===oneDay.id?['3.50','11.50']:['105.00','74.00'];
    assert.deepEqual([line.status,line.cost,line.profit],['DELIVERING',...expected]);
    await complete('DELIVER_ACCESS',job.job_id);
  }
  await ok('POST',costPath,outsider,{broker_amount:'50',subscription_amount:'449'});
  const [today]=await ok('GET',path+'monthly-sales',outsider);
  assert.deepEqual([today.sales,today.cost,today.profit,today.sold,today.pending],['371.00','108.50','85.50',9,7]);
  const details=await ok('GET',path+'monthly-sales/'+today.day,outsider);
  for(const [id,cost,profit] of [[oneDay.id,'3.50','11.50'],[thirtyDays.id,'105.00','74.00']]){
    const row=details.find(entry=>entry.order_id===id);
    assert.deepEqual([row.cost,row.profit],[cost,profit]);
  }
  await ok('GET',path+'monthly-sales',owner,undefined,403);
  const monthly=(await ok('GET',path+'owner-overview',outsider)).monthly_cost;
  assert.deepEqual(monthly,{month:initial.month,total:'698.00',income:'371.00',configured:2,unconfigured:0});
  assert.deepEqual((await ok('GET','/v1/admin/stores/'+B+'/sales',admin)).monthly_cost,monthly);
  const {rows:[{user_id}]}=await db.query("SELECT user_id FROM memberships WHERE store_id=$1 AND role='OWNER'",[B]);
  const additional=await ok('POST','/v1/admin/stores',admin,{
    name:'Another cost store',owner_id:user_id,current_password:'Updated-Admin-Test-2026!'
  });
  const otherPath=storePath(additional.id);
  await addAccount(otherPath,2,'10','40');
  const rollup=(await ok('GET','/v1/admin/owners/'+user_id+'/overview',admin)).monthly_cost;
  assert.deepEqual(rollup,{month:initial.month,total:'748.00',income:'371.00',configured:3,unconfigured:0});
  const archive=account=>path+'accounts/'+account.id+'/archive';
  await ok('POST',archive(netflix),outsider,{confirm:true},409);
  await ok('POST',archive(idle),owner,{confirm:true},403);
  await ok('POST',archive(idle),outsider,{},400);
  await ok('POST',archive(idle),outsider,{confirm:true});
  for(const endpoint of ['accounts','allocation-accounts','profiles']){
    const rows=await ok('GET',path+endpoint,outsider);
    assert.ok(rows.every(row=>row.id!==idle.id&&row.account_id!==idle.id));
  }
  await ok('GET',path+'accounts/'+idle.id+'/cost',outsider,undefined,404);
  const after=(await ok('GET',path+'owner-overview',outsider)).monthly_cost;
  assert.deepEqual(after,{...monthly,total:'499.00',configured:1});
  const rental=(await ok('GET',path+'rentals',outsider)).find(row=>row.order_id===thirtyDays.id);
  await db.query("UPDATE rental_service_periods SET starts_at=now()-interval '1 day' WHERE (store_id,order_id)=($1,$2)",[B,thirtyDays.id]);
  await db.query(`UPDATE rentals r SET starts_at=p.starts_at FROM rental_service_periods p
    WHERE (r.store_id,r.id)=(p.store_id,p.rental_id) AND (p.store_id,p.order_id)=($1,$2)`,[B,thirtyDays.id]);
  await ok('POST',path+'rentals/'+rental.id+'/cancel',outsider,{refund:false});
  const readClosedOrder=async()=> (await ok('GET',path+'monthly-sales/'+today.day,outsider)).find(row=>row.order_id===thirtyDays.id);
  const closedOrder=await readClosedOrder();
  assert.deepEqual([closedOrder.cost,closedOrder.profit],['3.50','175.50']);
  await db.query('UPDATE rentals SET closed_at=NULL WHERE (store_id,id)=($1,$2)',[B,rental.id]);
  assert.equal((await readClosedOrder()).cost,null);
  await db.query('UPDATE rentals SET confirmed_usage_days=1 WHERE (store_id,id)=($1,$2)',[B,rental.id]);
  assert.deepEqual([(await readClosedOrder()).cost,(await readClosedOrder()).profit],['3.50','175.50']);
  assert.deepEqual((await ok('GET',path+'owner-overview',outsider)).monthly_cost,after);
  const rebound=await ok('POST',path+'accounts',outsider,{platform:'netflix',email_id:idle.email_id,
    otp:'123456',profile_count:1,broker_amount:'0',subscription_amount:'0'});
  assert.notEqual(rebound.id,idle.id);
});
integration('manual credit is audited without payment and early cancellation credits six unused days after revocation',async()=>{
  const path=storePath(B);
  const customer=await ok('POST',path+'customers',outsider,{name:'Cancellation fixture'});
  const adjustment=path+'customers/'+customer.id+'/credit-adjustments';
  const deposit={direction:'ADD',amount:'80',reason:'Demo adjustment',confirm:true};
  const key=uid();
  const posted=await ok('POST',adjustment,outsider,deposit,200,key);
  assert.deepEqual(await ok('POST',adjustment,outsider,deposit,200,key),posted);
  await ok('POST',adjustment,outsider,{...deposit,amount:'81'},409,key);
  await ok('POST',adjustment,outsider,{...deposit,direction:'REMOVE',amount:'81'},409);
  await ok('POST',adjustment,outsider,{...deposit,direction:'REMOVE',amount:'10'});
  const plan=await ok('POST',path+'packages',outsider,{platform:'netflix',name:'Cancellation seven days',days:7,amount:'70'});
  const order=await ok('POST',path+'orders',outsider,{customer_id:customer.id,package_id:plan.id,days:7,amount:'70',confirm:true});
  const account=(await ok('GET',path+'accounts',outsider)).find(row=>row.health==='HEALTHY');
  const profile=(await ok('GET',path+'profiles',outsider))
    .find(row=>row.account_id===account.id&&row.status==='AVAILABLE'&&!row.is_primary);
  await ok('POST',path+'accounts/'+account.id+'/profiles/'+profile.id+'/pin',outsider,{pin:'0427'});
  const delivery=await ok('POST',path+'allocate',outsider,{order_id:order.id,account_id:account.id,profile_id:profile.id});
  const {digest,matches}=await import('../apps/api/db.mjs');
  const {WorkerClient}=await import('../packages/shared/worker-client.mts');
  const {MockStreamingProviderAdapter}=await import('../apps/mock-worker/worker.mjs');
  const workerId='refund-'+uid(), workerToken=token();
  await db.query("INSERT INTO workers VALUES($1,$2,now()+interval '1 day')",[workerId,digest(workerToken)]);
  await db.query('INSERT INTO worker_stores VALUES($1,$2)',[workerId,B]);
  const refundWorker=new WorkerClient(base,workerToken,workerId);
  async function complete(type,id) {
    const {job,lease_token,fencing_token}=await refundWorker.claim([type]);
    assert.equal(job.id,id);
    const lease={worker_id:workerId,lease_token,fencing_token};
    await refundWorker.start(job.id,lease);
    await refundWorker.report(job.id,{...lease,...new MockStreamingProviderAdapter().execute(job)});
  }
  await complete('DELIVER_ACCESS',delivery.job_id);
  const rental=(await ok('GET',path+'rentals',outsider)).find(row=>row.order_id===order.id);
  await db.query(`UPDATE rentals SET starts_at=starts_at-interval '36 hours',ends_at=ends_at-interval '36 hours'
    WHERE (store_id,id)=($1,$2)`,[B,rental.id]);
  await db.query(`UPDATE rental_service_periods SET starts_at=starts_at-interval '36 hours',ends_at=ends_at-interval '36 hours'
    WHERE (store_id,order_id)=($1,$2)`,[B,order.id]);
  const cancel=path+'rentals/'+rental.id+'/cancel';
  const quote=await ok('GET',cancel+'-quote',outsider);
  assert.deepEqual(quote,{used_days:1,remaining_days:6,credit_amount:'60.00'});
  await ok('POST',cancel,outsider,{reason:'Demo cancellation',expected_credit:'50.00',confirm:true},409);
  const revoke=await ok('POST',cancel,outsider,{reason:'Demo cancellation',expected_credit:quote.credit_amount,confirm:true});
  const balance=async()=> (await ok('GET',path+'customers',outsider)).find(row=>row.id===customer.id).balance;
  assert.equal(await balance(),'0.00');
  const readProfile=async()=> (await db.query('SELECT status,pin_hash FROM profiles WHERE (store_id,id)=($1,$2)',[B,profile.id])).rows[0];
  const prior=await readProfile();
  assert.equal(prior.status,'OCCUPIED');
  assert.equal(await matches('streaming-profile-pin:0427',prior.pin_hash),true);
  await ok('POST',cancel,outsider,{reason:'Duplicate',expected_credit:quote.credit_amount,confirm:true},409);
  await complete('REVOKE_ACCESS',revoke.job_id);
  const released=await readProfile();
  assert.equal(released.status,'AVAILABLE');
  assert.ok(released.pin_hash);
  assert.equal(await matches('streaming-profile-pin:0427',released.pin_hash),false);
  assert.equal(await balance(),'60.00');
  const {rows:ledger}=await db.query('SELECT amount,source FROM wallet_adjustments WHERE store_id=$1 AND customer_id=$2 ORDER BY amount',[B,customer.id]);
  assert.deepEqual(ledger,[{amount:'-10.00',source:'MANUAL_NO_PAYMENT'},{amount:'60.00',source:'RENTAL_CANCEL_CREDIT'},{amount:'80.00',source:'MANUAL_NO_PAYMENT'}]);
  assert.equal((await ok('GET',path+'owner-overview',outsider)).credits_in,'379.00');
  const movableOrder=await ok('POST',path+'orders',outsider,{customer_id:customer.id,package_id:plan.id,days:7,amount:'70',confirm:true},409);
  assert.equal(movableOrder.code,'INSUFFICIENT_CREDIT');
  await ok('POST',adjustment,outsider,{...deposit,amount:'10'});
  const next=await ok('POST',path+'orders',outsider,{customer_id:customer.id,package_id:plan.id,days:7,amount:'70',confirm:true});
  const pinPath=path+'accounts/'+account.id+'/profiles/'+profile.id+'/pin';
  await ok('POST',pinPath,outsider,{pin:'1234'});
  assert.deepEqual(await ok('GET',pinPath,outsider),{pin:'1234',pin_set:true});
  await ok('GET',pinPath,owner,undefined,403);
  const nextDelivery=await ok('POST',path+'allocate',outsider,{order_id:next.id,account_id:account.id,profile_id:profile.id});
  await complete('DELIVER_ACCESS',nextDelivery.job_id);
  const getRental=async()=> (await ok('GET',path+'rentals',outsider)).find(row=>row.order_id===next.id);
  const original=await getRental();
  const rentalPath=path+'rentals/'+original.id;
  const shortened=await ok('POST',rentalPath+'/remaining-days',outsider,{remaining_days:3,expected_ends_at:original.ends_at});
  assert.equal(shortened.remaining_days,3);
  await ok('POST',rentalPath+'/remaining-days',outsider,{remaining_days:5,expected_ends_at:original.ends_at},409);
  const extended=await ok('POST',rentalPath+'/remaining-days',outsider,{remaining_days:5,expected_ends_at:shortened.ends_at});
  const clear=await ok('POST',rentalPath+'/release-profile',outsider,{profile_id:profile.id});
  assert.equal(clear.remaining_days,5);
  assert.equal((await readProfile()).status,'AVAILABLE');
  const unassigned=await getRental();
  assert.deepEqual([unassigned.status,unassigned.profile_unassigned,unassigned.profile_label,unassigned.ends_at],['ACTIVE',true,null,extended.ends_at]);
  assert.equal(await balance(),'0.00');
  const newPin=(await ok('GET',pinPath,outsider)).pin;
  assert.match(newPin,/^[0-9]{4}$/);
  assert.notEqual(newPin,'1234');
  assert.equal((await ok('GET',path+'accounts/'+account.id+'/profile-pins',outsider))[profile.id],newPin);
  const [replacement]=await ok('GET',rentalPath+'/replacement',outsider);
  const different=replacement.profiles.find(row=>row.id!==profile.id);
  assert.ok(different);
  const target={account_id:replacement.id,profile_id:different.id};
  const assigned=await ok('POST',rentalPath+'/replacement',outsider,target);
  assert.equal((await getRental()).assignment_pending,true);
  await ok('POST',rentalPath+'/replacement',outsider,target,409);
  await complete('DELIVER_ACCESS',assigned.job_id);
  const result=await getRental();
  assert.deepEqual([result.profile_id,result.profile_unassigned,result.ends_at],[target.profile_id,false,extended.ends_at]);
  assert.equal(await balance(),'0.00');
  const email=(await ok('GET',path+'streaming-emails',outsider)).find(row=>row.email===account.email);
  const emailPath=path+'streaming-emails/'+email.id;
  const emailDetails=await ok('GET',emailPath,outsider);
  assert.equal(emailDetails.password,'Demo-Mail-Only!');
  assert.deepEqual(emailDetails.accounts,[{id:account.id,platform:'netflix'}]);
  await ok('GET',emailPath,owner,undefined,403);
  assert.equal((await ok('POST',emailPath+'/archive',outsider,{})).accounts_removed,1);
  await ok('GET',emailPath,outsider,undefined,404);
  assert.ok((await ok('GET',path+'accounts',outsider)).every(row=>row.id!==account.id));
  const afterRemoval=await getRental();
  assert.deepEqual([afterRemoval.profile_unassigned,afterRemoval.ends_at],[true,extended.ends_at]);
  const adjusted=await ok('POST',rentalPath+'/adjust-days',outsider,{
    direction:'REMOVE',days:1,expected_ends_at:extended.ends_at
  });
  assert.equal(adjusted.remaining_days,4);
  const quoted=await ok('GET',rentalPath+'/cancel-quote',outsider);
  assert.deepEqual([quoted.remaining_days,quoted.credit_amount],[4,'40.00']);
  await ok('POST',rentalPath+'/cancel',outsider,{refund:true,expected_credit:'70.00'},409);
  await ok('POST',rentalPath+'/cancel',outsider,{refund:true,expected_credit:'40.00'});
  assert.equal((await getRental()).status,'CLOSED');
  assert.equal(await balance(),'40.00');
  const other=(await ok('GET',path+'rentals',outsider)).find(row=>row.status==='ACTIVE'&&row.remaining_days>0);
  assert.ok(other);
  const otherPath=path+'rentals/'+other.id;
  await ok('POST',otherPath+'/adjust-days',outsider,{
    direction:'REMOVE',days:other.remaining_days,expected_ends_at:other.ends_at
  });
  assert.equal((await ok('GET',path+'rentals',outsider)).find(row=>row.id===other.id).status,'CLOSED');
  const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Bangkok'}).format(new Date());
  const log=await ok('GET',path+'wallet-log/'+day,outsider);
  const entries=log.entries.filter(row=>row.customer==='Cancellation fixture');
  assert.equal(entries.filter(row=>row.kind==='RENTAL_CANCEL_CREDIT').length,2);
  assert.ok(entries.some(row=>row.kind==='RENTAL_CANCEL_CREDIT'&&row.amount===40&&row.reference===original.id));
  assert.ok(entries.some(row=>row.kind==='ORDER'&&row.amount===-70&&row.reference===next.id));
  await ok('GET',path+'wallet-log/'+day,owner,undefined,403);
});

integration('Super Admin removal cascades store data and removes shared staff access',async()=>{
  const current_password='Updated-Admin-Test-2026!';
  const create=async role=>ok('POST','/v1/admin/users',admin,{role,username:'remove-'+uid(),password,current_password});
  const target=await create('OWNER');
  const staff=await create('OWNER');
  const delegated=await create('ADMIN');
  const login=async user=>(await ok('POST','/v1/login',null,{username:user.username,password})).token;
  const [staffToken,delegatedToken,targetToken]=await Promise.all([login(staff),login(delegated),login(target)]);
  const doomed=await ok('POST','/v1/admin/stores',admin,{name:'Deletion fixture',owner_id:target.id,current_password});
  const doomedPath=storePath(doomed.id);
  await db.query("INSERT INTO memberships VALUES($1,$3,'STAFF'),($2,$3,'HEAD_STAFF')",[doomed.id,B,staff.id]);
  await ok('POST',doomedPath+'customers',targetToken,{name:'Deleted customer'});
  const email=await ok('POST',doomedPath+'streaming-emails',targetToken,{email:uid()+'@example.invalid',password});
  await ok('POST',doomedPath+'accounts',targetToken,{platform:'netflix',email_id:email.id,otp:'123456',broker_amount:'10',subscription_amount:'50'});
  await ok('POST',doomedPath+'bot-jobs',targetToken,verify(),201);
  const body={current_password,confirm:true};
  await ok('POST','/v1/admin/owners/'+target.id+'/remove',delegatedToken,{...body,current_password:password},403);
  await ok('POST','/v1/admin/owners/'+target.id+'/remove',admin,body);
  for(const table of ['memberships','customers','accounts','profiles','jobs','job_events','streaming_account_cost_rates']){
    assert.equal((await db.query('SELECT 1 FROM '+table+' WHERE store_id=$1',[doomed.id])).rowCount,0);
  }
  assert.equal((await db.query('SELECT 1 FROM stores WHERE id=$1',[doomed.id])).rowCount,0);
  assert.equal((await db.query('SELECT 1 FROM stores WHERE id=$1',[B])).rowCount,1);
  assert.equal((await db.query('SELECT 1 FROM memberships WHERE user_id=$1',[staff.id])).rowCount,0);
  await ok('GET','/v1/me',targetToken,undefined,401);
  await ok('GET','/v1/me',staffToken,undefined,401);
  await ok('POST','/v1/admin/admins/'+delegated.id+'/remove',admin,body);
  await ok('GET','/v1/me',delegatedToken,undefined,401);
  assert.ok((await ok('GET','/v1/admin/admins',admin)).every(row=>row.id!==delegated.id));
});

