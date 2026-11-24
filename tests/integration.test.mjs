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
  const binding={platform:'netflix',email_id:email.id,otp:'123456',profile_count:1};
  assert.deepEqual(await ok('GET',storePath(B)+'streaming-emails',outsider),[]);
  await ok('POST',storePath(B)+'accounts',outsider,binding,400);
  await ok('POST',route+'accounts',owner,{...binding,platform:'other'},400);
  await ok('POST',route+'accounts',owner,{...binding,otp:undefined},400);
  await ok('POST',route+'accounts',owner,{...binding,otp:'000000'},400);
  await ok('POST',route+'accounts',owner,{...binding,profile_count:0},400);
  assert.deepEqual(await ok('GET',route+'accounts',owner),[]);
  const account=await ok('POST',route+'accounts',owner,binding);
  const listed=(await ok('GET',route+'streaming-emails',owner))[0];
  assert.deepEqual([listed.email,listed.bound_platforms,listed.password_set],[credential.email,['netflix'],true]);
  assert.ok(!Object.hasOwn(listed,'password_hash'));
  await ok('POST',route+'streaming-emails/'+email.id,owner,{email:uid()+'@example.invalid'},409);
  await ok('POST',route+'streaming-emails/'+email.id,owner,{password:'Updated-Demo-Mail-Password!'});
  await ok('POST',route+'accounts',owner,binding,409);
  const profiles=await ok('GET',route+'profiles',owner);
  assert.deepEqual(profiles.map(({account_id,label})=>({account_id,label})),[{account_id:account.id,label:'profile1'}]);
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
  await ok('POST',route+'allocate',owner,{account_id:account.id},409);
  await ok('POST',route+'bot-jobs',owner,{type:'VERIFY_SUBSCRIPTION',reason:'Demo check',account_id:account.id},201);
  await runMock();
  const [available]=await ok('GET',scoped,owner);
  assert.deepEqual([available.id,available.available_profiles,available.accepts_waiting_order],[account.id,1,true]);
  await ok('POST',route+'allocate',owner,{account_id:uid()},409);
  await ok('POST',route+'allocate',owner,{order_id,account_id:account.id});
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
  assert.deepEqual([entry.id,entry.platform,entry.profile_label,entry.package_days],[rental.id,'netflix','profile1',2]);
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
  assert.equal((await ok('GET',path+'profiles',owner))[0].status,'HELD');
  assert.equal((await ok('GET',path+'rentals',owner))[0].status,'REVOCATION_PENDING');
  assert.equal((await runMock()).type,'RECONCILE_REVOCATION');
  assert.equal((await ok('GET',path+'rentals',owner))[0].status,'CLOSED');
  assert.equal((await ok('GET',path+'profiles',owner))[0].status,'AVAILABLE');
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
    platform:'netflix',email_id:email.id,otp:'123456'
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
  const cleared=await ok('POST',path+contact,owner,{alias:'',url:''});
  assert.deepEqual([cleared.alias,cleared.url],[null,null]);
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
  const requests=await ok('GET','/v1/admin/store-requests',delegated);
  assert.ok(requests.some(row=>row.id===requested.id));
  const review='/v1/admin/store-requests/'+requested.id+'/review';
  await ok('POST',review,delegated,{status:'REJECTED',current_password:password},403);
  const approved=await ok('POST',review,delegated,{status:'APPROVED',current_password:password});
  const after=await ok('GET','/v1/me',firstOwner);
  assert.ok(after.stores.some(store=>store.id===approved.store_id&&store.role==='OWNER'));
});

