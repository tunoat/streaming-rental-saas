import { createCipheriv, createDecipheriv, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { emailAddress, matches, membership, passwordHash, reject } from './db.mjs';
import { enqueue, uuid } from './jobs.mjs';

const protectedJobs=['DELIVER_ACCESS','REVOKE_ACCESS','RECONCILE_DELIVERY','RECONCILE_REVOCATION'];
const rentableProfile=alias=>`${alias}.archived_at IS NULL AND NOT ${alias}.is_primary AND lower(btrim(${alias}.label))<>'profile1'`;
const pinKey=process.env.PROFILE_PIN_KEY;
if (pinKey && !/^[0-9a-f]{64}$/i.test(pinKey)) throw new Error('PROFILE_PIN_KEY must be a 32-byte hex key');
const assignmentPending=`EXISTS (SELECT 1 FROM jobs j JOIN profiles jp ON (jp.store_id,jp.id)=(j.store_id,j.profile_id)
  WHERE (j.store_id,j.rental_id)=(r.store_id,r.id)
    AND j.type IN ('DELIVER_ACCESS','RECONCILE_DELIVERY')
    AND j.status NOT IN ('SUCCEEDED','CANCELLED') AND jp.status IN ('RESERVED','HELD'))`;
function encryptCredential(value,store,subject) {
  if (!pinKey) return null;
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(pinKey,'hex'),iv);
  cipher.setAAD(Buffer.from(store+':'+subject));
  return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
}
function decryptCredential(value,store,subject) {
  if (!pinKey || !value) return null;
  const bytes=Buffer.from(value,'base64');
  if (bytes.length<=28) return null;
  const decipher=createDecipheriv('aes-256-gcm',Buffer.from(pinKey,'hex'),bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(store+':'+subject));
  decipher.setAuthTag(bytes.subarray(-16));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
async function releaseMockProfile(q,store,profile) {
  const {rows:[previous]}=await q('SELECT pin_hash FROM profiles WHERE (store_id,id)=($1,$2)',[store,profile]);
  let pin;
  do {pin=String(randomInt(10000)).padStart(4,'0');}
  while(previous.pin_hash&&await matches('streaming-profile-pin:'+pin,previous.pin_hash));
  await q("UPDATE profiles SET status='AVAILABLE',pin_hash=$3,encrypted_pin=$4 WHERE (store_id,id)=($1,$2)",
    [store,profile,await passwordHash('streaming-profile-pin:'+pin),encryptCredential(pin,store,profile)]);
}
async function recordServicePeriod(q,store,order,rental,profile,start,end) {
  await q(`INSERT INTO rental_service_periods(store_id,order_id,rental_id,account_id,starts_at,ends_at,cost_rate_id,profile_count)
    SELECT p.store_id,$2,$3,p.account_id,$5,$6,
      CASE WHEN slots.count>0 THEN rate.id END,
      CASE WHEN rate.id IS NOT NULL AND slots.count>0 THEN slots.count END
    FROM profiles p CROSS JOIN LATERAL (
      SELECT count(*)::int FROM profiles active WHERE (active.store_id,active.account_id)=(p.store_id,p.account_id)
        AND ${rentableProfile('active')}
    ) slots LEFT JOIN LATERAL (
      SELECT id FROM streaming_account_cost_rates WHERE (store_id,account_id)=(p.store_id,p.account_id)
        AND effective_at<=clock_timestamp() ORDER BY effective_at DESC,id DESC LIMIT 1
    ) rate ON true WHERE (p.store_id,p.id)=($1,$4)`,[store,order,rental,profile,start,end]);
}
export async function validateTarget(q,store,b) {
  if (protectedJobs.includes(b.type)) reject(409,'USE_WORKFLOW_ACTION');
  if (b.order_id || b.rental_id) reject(400,'INVALID_TARGET');
  if (!b.account_id && b.type!=='HEALTH_CHECK') reject(400,'ACCOUNT_REQUIRED');
  if (b.account_id) {
    const {rows:[account]}=await q('SELECT health FROM accounts WHERE store_id=$1 AND id=$2 AND archived_at IS NULL',[store,b.account_id]);
    if (!account) reject(400,'INVALID_TARGET');
    if (account.health==='BLOCKED' && b.type!=='RECOVERY_VERIFICATION') reject(409,'ACCOUNT_BLOCKED');
  }
  if (b.profile_id) {
    const found=await q('SELECT 1 FROM profiles WHERE store_id=$1 AND id=$2 AND account_id=$3 AND archived_at IS NULL',[store,b.profile_id,b.account_id]);
    if (!found.rowCount) reject(400,'INVALID_TARGET');
  }
}

export async function applyEvidence(q,job,b) {
  const {store_id:store,account_id:account,order_id:order,profile_id:profile,rental_id:rental}=job;
  if (account && ['ACCOUNT_LOCKED','SUBSCRIPTION_INVALID'].includes(b.error_code) && b.outcome!=='PASS') {
    await q("UPDATE accounts SET health='BLOCKED',blocked_at=clock_timestamp(),checked_at=NULL,subscription_until=NULL WHERE store_id=$1 AND id=$2",[store,account]);
  }
  if (b.outcome!=='PASS') return;
  if (account && ['HEALTH_CHECK','VERIFY_SUBSCRIPTION','RECOVERY_VERIFICATION'].includes(job.type)) {
    const changed=await q(`UPDATE accounts SET health='HEALTHY',checked_at=$3,subscription_until=$4
      WHERE store_id=$1 AND id=$2 AND (health<>'BLOCKED' OR
        ($5='RECOVERY_VERIFICATION' AND $3>=blocked_at AND $3>=clock_timestamp()-interval '15 minutes'))
      AND (checked_at IS NULL OR checked_at<=$3)`,[store,account,b.observed_at,b.subscription_expires_at,job.type]);
    if (!changed.rowCount) reject(409,'STALE_EVIDENCE');
  }
  if (['DELIVER_ACCESS','RECONCILE_DELIVERY'].includes(job.type) && rental) {
    const assigned=await q(`UPDATE rentals r SET profile_unassigned=false,profile_id=p.id,release_requested_at=NULL
      FROM profiles p JOIN accounts a ON (a.store_id,a.id)=(p.store_id,p.account_id)
      WHERE (r.store_id,r.id,r.order_id)=($1,$2,$3) AND (p.store_id,p.id)=($1,$4)
        AND r.status='ACTIVE' AND r.profile_unassigned
        AND p.status IN ('RESERVED','HELD') AND ${rentableProfile('p')}`,[store,rental,order,profile]);
    if (!assigned.rowCount) reject(409,'DELIVERY_NOT_ELIGIBLE');
    await q("UPDATE profiles SET status='OCCUPIED' WHERE (store_id,id)=($1,$2)",[store,profile]);
  } else if (['DELIVER_ACCESS','RECONCILE_DELIVERY'].includes(job.type)) {
    const {rows:[orderRow]}=await q(`SELECT o.days,a.subscription_until FROM orders o
      JOIN profiles p ON p.store_id=o.store_id AND p.id=o.profile_id
      JOIN accounts a ON a.store_id=p.store_id AND a.id=p.account_id
      WHERE o.store_id=$1 AND o.id=$2 AND o.profile_id=$3 AND o.status='DELIVERING'
      AND ${rentableProfile('p')}
      AND p.status IN ('RESERVED','HELD') AND a.health='HEALTHY' AND a.checked_at>now()-interval '24 hours'`,
      [store,order,profile]);
    if (!orderRow || orderRow.subscription_until.getTime()<Date.parse(b.delivery_occurred_at)+orderRow.days*86400000) reject(409,'DELIVERY_NOT_ELIGIBLE');
    const {rows:[created]}=await q(`INSERT INTO rentals(store_id,order_id,profile_id,starts_at,ends_at)
      VALUES($1,$2,$3,$4::timestamptz,$4::timestamptz+$5*interval '24 hours') RETURNING id,starts_at,ends_at`,
      [store,order,profile,b.delivery_occurred_at,orderRow.days]);
    await recordServicePeriod(q,store,order,created.id,profile,created.starts_at,created.ends_at);
    await q("UPDATE profiles SET status='OCCUPIED' WHERE store_id=$1 AND id=$2",[store,profile]);
    await q("UPDATE orders SET status='FULFILLED' WHERE store_id=$1 AND id=$2",[store,order]);
  }
  if (['REVOKE_ACCESS','RECONCILE_REVOCATION'].includes(job.type)) {
    const closed=await q(`UPDATE rentals r SET
      status=CASE WHEN release_requested_at IS NULL THEN 'CLOSED' ELSE 'ACTIVE' END,
      closed_at=CASE WHEN release_requested_at IS NULL THEN $3::timestamptz END,
      profile_unassigned=release_requested_at IS NOT NULL
      WHERE r.store_id=$1 AND r.id=$2 AND r.status='REVOCATION_PENDING'
      AND COALESCE(release_requested_at,(SELECT requested_at FROM rental_cancellations c WHERE (c.store_id,c.rental_id)=(r.store_id,r.id)),r.ends_at)<=$3
      RETURNING release_requested_at`,
      [store,rental,b.access_revoked_at]);
    if (!closed.rowCount) reject(409,'REVOCATION_NOT_ELIGIBLE');
    const {rows:[cancelled]}=await q(`UPDATE rental_cancellations SET completed_at=$3
      WHERE (store_id,rental_id)=($1,$2) AND completed_at IS NULL RETURNING customer_id,actor_id,reason,credit_amount`,
      [store,rental,b.access_revoked_at]);
    if (cancelled&&Number(cancelled.credit_amount)>0) await q(`INSERT INTO wallet_adjustments(store_id,customer_id,actor_id,reason,amount,source,rental_id)
      VALUES($1,$2,$3,$4,$5,'RENTAL_CANCEL_CREDIT',$6)`,[store,cancelled.customer_id,cancelled.actor_id,cancelled.reason,cancelled.credit_amount,rental]);
    if (cancelled||closed.rows[0].release_requested_at) await releaseMockProfile(q,store,profile);
    else await q("UPDATE profiles SET status='AVAILABLE' WHERE store_id=$1 AND id=$2",[store,profile]);
  }
  if (job.reconciles_id) await q("UPDATE jobs SET status='SUCCEEDED' WHERE store_id=$1 AND id=$2 AND status='RECONCILING'",[store,job.reconciles_id]);
}

const validId = v => {
  if (!uuid.test(v??'')) reject(400,'INVALID_ID');
  return v;
};
const shortText = v => {
  if (typeof v!=='string' || !v.trim() || v.length>150) reject(400,'INVALID_INPUT');
  return v.trim();
};
function customerUrl(value) {
  if (value===undefined || value===null || value==='') return null;
  if (typeof value!=='string' || value.length>2048) reject(400,'INVALID_CUSTOMER_URL');
  const input=value.trim();
  if (!input) return null;
  const url=URL.canParse(input)?new URL(input):null;
  if (!url || !['https:','http:'].includes(url.protocol) || !/^https?:\/\//i.test(input) ||
      url.username || url.password || url.href.length>2048) reject(400,'INVALID_CUSTOMER_URL');
  return url.href;
}
const customerAlias=value=>value==null || (typeof value==='string' && !value.trim())?null:shortText(value);
const money = (v,allowZero=false) => {
  if (typeof v!=='string' || !/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,2})?$/.test(v) || (!allowZero&&Number(v)<=0)) reject(400,'INVALID_AMOUNT');
  return v;
};
function accountCostParts(body) {
  const broker=money(body.broker_amount,true), subscription=money(body.subscription_amount,true);
  const cents=value=>{
    const [whole,fraction='']=value.split('.');
    return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  };
  if (cents(broker)+cents(subscription)>999999999999999999n) reject(400,'INVALID_AMOUNT');
  return [broker,subscription];
}
async function saveAccountCost(q,store,account,actor,[broker,subscription]) {
  const {rows:[rate]}=await q(`INSERT INTO streaming_account_cost_rates(store_id,account_id,amount,actor_id,broker_amount,subscription_amount)
    SELECT store_id,id,$3::numeric+$4::numeric,$5,$3::numeric,$4::numeric FROM accounts
    WHERE (store_id,id)=($1,$2) AND archived_at IS NULL RETURNING amount,broker_amount,subscription_amount,effective_at`,[store,account,broker,subscription,actor]);
  if (!rate) reject(404,'NOT_FOUND');
  return rate;
}
const streamingPlatform = value => {
  const platform=shortText(value).toLowerCase();
  if (platform!=='netflix') reject(400,'UNSUPPORTED_STREAMING_PLATFORM');
  return platform;
};
const duration = value => {
  if (!Number.isInteger(value) || value<1 || value>365) reject(400,'INVALID_DURATION');
  return value;
};
const availableProfile=`p.status='AVAILABLE' AND ${rentableProfile('p')}`;
const eligibleOrder=`o.store_id=a.store_id AND o.status='PAID_WAITING' AND a.health='HEALTHY'
  AND a.archived_at IS NULL
  AND (o.platform IS NULL OR a.platform=o.platform)
  AND a.checked_at>now()-interval '24 hours' AND a.subscription_until>=now()+(o.days*interval '24 hours')`;
const entities = {
  customers:'SELECT c.id,c.name,c.alias,c.url,COALESCE(sum(l.amount),0)::numeric(18,2) AS balance FROM customers c LEFT JOIN wallet_entries l ON c.store_id=l.store_id AND c.id=l.customer_id WHERE c.store_id=$1 GROUP BY c.store_id,c.id ORDER BY c.name,c.id',
  'customer-directory':'SELECT id,name,alias,url FROM customers WHERE store_id=$1 ORDER BY name,id',
  accounts:'SELECT id,platform,email,health,subscription_until FROM accounts WHERE store_id=$1 AND archived_at IS NULL ORDER BY platform,email',
  'streaming-emails':`SELECT e.id,e.email,e.password_hash IS NOT NULL AS password_set,coalesce(array_agg(a.platform ORDER BY a.platform)
    FILTER (WHERE a.id IS NOT NULL),ARRAY[]::text[]) AS bound_platforms
    FROM streaming_email_addresses e LEFT JOIN accounts a ON (a.store_id,a.email)=(e.store_id,e.email) AND a.archived_at IS NULL
    WHERE e.store_id=$1 AND e.archived_at IS NULL GROUP BY e.store_id,e.id ORDER BY e.email`,
  profiles:`SELECT id,account_id,label,status,is_primary OR lower(btrim(label))='profile1' AS is_primary,
    pin_hash IS NOT NULL AS pin_set FROM profiles
    WHERE store_id=$1 AND archived_at IS NULL AND EXISTS (
      SELECT 1 FROM accounts a WHERE (a.store_id,a.id)=(profiles.store_id,profiles.account_id) AND a.archived_at IS NULL
    ) ORDER BY account_id,length(label),label,id`,
  'payment-requests':'SELECT id,customer_id,amount,status FROM payment_requests WHERE store_id=$1 LIMIT 100',
  transfers:'SELECT id,payment_id,amount,approved_at FROM transfers WHERE store_id=$1 LIMIT 100',
  packages:'SELECT id,platform,name,days,amount FROM streaming_packages WHERE store_id=$1 ORDER BY platform,days,name,id',
  rentals:`SELECT r.id,r.order_id,r.starts_at,r.ends_at,r.status,o.package_id,o.customer_id,
    c.name AS customer_name,c.alias AS customer_alias,a.platform,
    CASE WHEN NOT r.profile_unassigned THEN a.email END AS account_email,
    CASE WHEN NOT r.profile_unassigned THEN p.label END AS profile_label,k.name AS package_name,
    r.profile_id,r.profile_unassigned,r.status='REVOCATION_PENDING' AND r.release_requested_at IS NOT NULL AS release_pending,
    greatest(0,ceil(extract(epoch FROM r.ends_at-clock_timestamp())/86400))::int AS remaining_days,
    r.profile_unassigned AND ${assignmentPending} AS assignment_pending,
    x.rental_id IS NOT NULL AS cancellation_requested
    FROM rentals r JOIN orders o ON (o.store_id,o.id)=(r.store_id,r.order_id)
    JOIN customers c ON (c.store_id,c.id)=(r.store_id,o.customer_id)
    JOIN profiles p ON (p.store_id,p.id)=(r.store_id,r.profile_id)
    JOIN accounts a ON (a.store_id,a.id)=(p.store_id,p.account_id)
    LEFT JOIN streaming_packages k ON (k.store_id,k.id)=(o.store_id,o.package_id)
    LEFT JOIN rental_cancellations x ON (x.store_id,x.rental_id)=(r.store_id,r.id)
    WHERE r.store_id=$1 AND ($2::uuid IS NULL OR a.id=$2)
    ORDER BY (r.status='CLOSED'),r.ends_at,r.id LIMIT 100`,
  incidents:'SELECT id,job_id,reason,created_at FROM incidents WHERE store_id=$1 ORDER BY created_at DESC LIMIT 100'
};
export function registerWorkflow(secured) {
  const register=(method,path,handler,{owner=false,sale=false}={})=>secured(method,'/v1/stores/:storeId/'+path,async(q,auth,req)=>{
    const store=validId(req.params.storeId);
    req.storeRole=await membership(q,auth,store,owner?['OWNER']:undefined);
    if (method==='POST') await q('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[store]);
    if (sale) {
      const {rows:[open]}=await q("SELECT plan FROM stores WHERE id=$1 AND status='ACTIVE' AND expires_at>now()",[store]);
      if (!open) reject(409,'STORE_NOT_OPEN_FOR_SALES');
      req.plan=open.plan;
    }
    return handler(q,store,req.body??{},req,auth);
  });
  for (const [path,sql] of Object.entries(entities)) {
    register('GET',path,async(q,s,b,req)=>(await q(sql,path==='rentals'?
      [s,req.query.account_id===undefined?null:validId(req.query.account_id)]:[s])).rows,
    {owner:['payment-requests','transfers','customers'].includes(path)});
  }
  register('GET','orders',async(q,s,b,req)=>(await q(`SELECT id,customer_id,amount,days,status,package_id,platform,kind,rental_id,reason
    FROM orders WHERE store_id=$1 AND (NOT $2::boolean OR status IN ('PAID_WAITING','DELIVERING'))
    ORDER BY created_at,id LIMIT 100`,[s,req.query.scope==='active'])).rows);
  register('GET','owner-overview',async(q,s)=>(await q(`
    WITH backlog AS (
      SELECT o.platform,o.days,COALESCE(p.name,'ออเดอร์เดิม') AS name,
        count(*) FILTER (WHERE o.status='PAID_WAITING')::int AS waiting,
        count(*) FILTER (WHERE o.status='DELIVERING')::int AS delivering
      FROM orders o LEFT JOIN streaming_packages p ON (p.store_id,p.id)=(o.store_id,o.package_id)
      WHERE o.store_id=$1 AND o.status IN ('PAID_WAITING','DELIVERING')
      GROUP BY o.platform,o.package_id,o.days,p.name
    )
    SELECT
      COALESCE((SELECT jsonb_agg(to_jsonb(backlog) ORDER BY platform,days,name) FROM backlog),'[]'::jsonb) AS backlog,
      (SELECT count(*)::int FROM rentals WHERE store_id=$1 AND status='ACTIVE'
        AND ends_at>now() AND ends_at<=now()+interval '72 hours') AS expiring,
      (SELECT count(*)::int FROM transfers WHERE store_id=$1 AND approved_at IS NULL) AS payments_pending,
      (SELECT count(*)::int FROM incidents WHERE store_id=$1) AS incident_count,
      (SELECT COALESCE(sum(amount),0.00)::text FROM wallet_ledger WHERE store_id=$1 AND transfer_id IS NOT NULL) AS credits_in,
      public.store_sales_summary($1) AS sales,
      (SELECT jsonb_build_object('month',to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM'),
        'total',round(f.total,2)::text,'income',round(public.store_monthly_booked_sales($1),2)::text,
        'configured',f.configured,'unconfigured',f.unconfigured)
        FROM public.store_monthly_account_cost($1) f) AS monthly_cost,
      jsonb_build_object(
        'packages',EXISTS (SELECT 1 FROM streaming_packages WHERE store_id=$1),
        'accounts',EXISTS (SELECT 1 FROM accounts WHERE store_id=$1 AND health='HEALTHY' AND archived_at IS NULL),
        'profiles',EXISTS (SELECT 1 FROM profiles WHERE store_id=$1 AND archived_at IS NULL),
        'customers',EXISTS (SELECT 1 FROM customers WHERE store_id=$1),
        'rentals',EXISTS (SELECT 1 FROM rentals WHERE store_id=$1)
      ) AS setup`,[s])).rows[0],{owner:true});
  register('GET','monthly-sales',async(q,s)=>(await q(`
    WITH dates AS (
      SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today,
        date_trunc('month',now() AT TIME ZONE 'Asia/Bangkok')::date AS first_day
    ), booked AS (
      SELECT o.booked_day,count(*)::int AS orders,count(*) FILTER (WHERE o.kind IN ('PURCHASE','RENEWAL'))::int AS sold,
        sum(o.price) FILTER (WHERE o.kind IN ('PURCHASE','RENEWAL')) AS sales,
        sum(o.allocated_cost) AS known_cost,
        sum(o.price-o.allocated_cost) AS known_profit,
        count(*) FILTER (WHERE o.allocated_cost IS NULL)::int AS pending
      FROM dates d CROSS JOIN LATERAL public.store_booked_order_lines($1,d.first_day,d.today+1) o
      GROUP BY o.booked_day
    )
    SELECT (d.first_day+n)::text AS day,COALESCE(b.orders,0) AS orders,COALESCE(b.sold,0) AS sold,
      round(COALESCE(b.sales,0),2)::text AS sales,round(b.known_cost,2)::text AS cost,
      round(b.known_profit,2)::text AS profit,COALESCE(b.pending,0) AS pending
    FROM dates d CROSS JOIN LATERAL generate_series(0,d.today-d.first_day) n
    LEFT JOIN booked b ON b.booked_day=d.first_day+n ORDER BY d.first_day+n DESC`,[s])).rows,{owner:true});
  register('GET','monthly-sales/:day',async(q,s,b,{params:{day}})=>{
    if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)
      reject(400,'INVALID_EXPIRY');
    return (await q(`SELECT o.order_id,c.name AS customer_name,c.alias,o.package_name,o.platform,o.kind,o.status,o.days,
      o.price::text AS price,
      round(o.allocated_cost,2)::text AS cost,
      round(o.price-o.allocated_cost,2)::text AS profit
      FROM public.store_booked_order_lines($1,$2::date,$2::date+1) o
      JOIN customers c ON (c.store_id,c.id)=($1,o.customer_id) ORDER BY o.order_id`,[s,day])).rows;
  },{owner:true});
  register('GET','wallet-log/:day',async(q,s,b,{params:{day}})=>{
    if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)
      reject(400,'INVALID_DATE');
    const {rows:[log]}=await q(`WITH bounds AS (
      SELECT $2::date::timestamp AT TIME ZONE 'Asia/Bangkok' AS begins,
        ($2::date+1)::timestamp AT TIME ZONE 'Asia/Bangkok' AS ends
    ), entries AS (
      SELECT l.id,l.customer_id,l.amount,coalesce(t.approved_at,o.created_at) AS occurred_at,
        CASE WHEN l.transfer_id IS NOT NULL THEN 'PAYMENT' ELSE 'ORDER' END AS kind,
        coalesce(l.transfer_id,l.order_id) AS reference,k.name AS detail,NULL::text AS actor
      FROM wallet_ledger l
      LEFT JOIN transfers t ON (t.store_id,t.id)=(l.store_id,l.transfer_id)
      LEFT JOIN orders o ON (o.store_id,o.id)=(l.store_id,l.order_id)
      LEFT JOIN streaming_packages k ON (k.store_id,k.id)=(o.store_id,o.package_id)
      WHERE l.store_id=$1
      UNION ALL
      SELECT a.id,a.customer_id,a.amount,a.created_at,a.source,coalesce(a.rental_id,a.id),a.reason,u.username
      FROM wallet_adjustments a JOIN users u ON u.id=a.actor_id WHERE a.store_id=$1
    ), selected AS (
      SELECT e.id,e.occurred_at,e.kind,e.amount,e.reference,e.detail,e.actor,c.name AS customer,c.alias
      FROM entries e CROSS JOIN bounds b JOIN customers c ON (c.store_id,c.id)=($1,e.customer_id)
      WHERE e.occurred_at>=b.begins AND e.occurred_at<b.ends
    )
    SELECT coalesce(sum(amount) FILTER (WHERE amount>0),0)::numeric(18,2)::text AS credit_in,
      coalesce(-sum(amount) FILTER (WHERE amount<0),0)::numeric(18,2)::text AS credit_out,
      coalesce(jsonb_agg(to_jsonb(selected) ORDER BY occurred_at DESC,id DESC),'[]'::jsonb) AS entries
    FROM selected`,[s,day]);
    return log;
  },{owner:true});
  register('GET','customer-renewals',async(q,s,b,req)=>(await q(`
    SELECT c.id,c.name,c.alias,c.url,COALESCE(current_rentals.items,'[]'::jsonb) AS rentals
      ${req.storeRole==='OWNER'?',(SELECT COALESCE(sum(l.amount),0)::numeric(18,2) FROM wallet_entries l WHERE (l.store_id,l.customer_id)=(c.store_id,c.id)) AS balance':''}
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',r.id,'ends_at',r.ends_at,'platform',a.platform,
        'account_email',CASE WHEN NOT r.profile_unassigned THEN a.email END,
        'profile_label',CASE WHEN NOT r.profile_unassigned THEN p.label END,'package_name',k.name,'package_days',o.days)
        ORDER BY r.ends_at,r.id) AS items,min(r.ends_at) FILTER (WHERE r.ends_at>now()) AS next_expiry
      FROM orders o JOIN rentals r ON (r.store_id,r.order_id)=(o.store_id,o.id)
      JOIN profiles p ON (p.store_id,p.id)=(r.store_id,r.profile_id)
      JOIN accounts a ON (a.store_id,a.id)=(p.store_id,p.account_id)
      LEFT JOIN streaming_packages k ON (k.store_id,k.id)=(o.store_id,o.package_id)
      WHERE (o.store_id,o.customer_id)=(c.store_id,c.id) AND r.status IN ('ACTIVE','REVOCATION_PENDING')
    ) current_rentals ON true
    WHERE c.store_id=$1
    ORDER BY current_rentals.next_expiry NULLS LAST,c.name,c.id LIMIT 100`,[s])).rows);
  const insert=async(q,sql,args)=>(await q(sql,args)).rows[0];
  async function packageQuote(q,store,id,body) {
    const amount=money(body.amount), days=duration(body.days);
    const {rows:[selected]}=await q(`SELECT platform,amount=$3::numeric AND days=$4 AS matches
      FROM streaming_packages WHERE store_id=$1 AND id=$2`,[store,id,amount,days]);
    if (!selected) reject(404,'NOT_FOUND');
    if (!selected.matches) reject(409,'PACKAGE_PRICE_CHANGED');
    return {amount,days,platform:selected.platform};
  }
  async function assertCredit(q,store,customer,amount) {
    const {rows:[{eligible}]}=await q('SELECT COALESCE(sum(amount),0)>=$3::numeric AS eligible FROM wallet_entries WHERE store_id=$1 AND customer_id=$2',[store,customer,amount]);
    if (!eligible) reject(409,'INSUFFICIENT_CREDIT');
  }
  const debit=(q,store,customer,order,amount)=>q(
    'INSERT INTO wallet_ledger(store_id,customer_id,order_id,amount) VALUES($1,$2,$3,-$4::numeric)',[store,customer,order,amount]);
  register('POST','customers/:customerId/credit-adjustments',async(q,s,b,req,auth)=>{
    if (b.confirm!==true) reject(400,'CONFIRM_REQUIRED');
    if (!['ADD','REMOVE'].includes(b.direction)) reject(400,'INVALID_INPUT');
    const customer=req.params.customerId, key=validId(req.headers['idempotency-key']);
    const amount=money(b.amount), reason=shortText(b.reason);
    const delta=b.direction==='ADD'?amount:'-'+amount;
    const {rows:[existing]}=await q(`SELECT id,customer_id=$3 AND actor_id=$4 AND amount=$5::numeric AND reason=$6 AS same
      FROM wallet_adjustments WHERE store_id=$1 AND request_key=$2`,[s,key,customer,auth.id,delta,reason]);
    if (existing) {
      if (!existing.same) reject(409,'IDEMPOTENCY_CONFLICT');
      return {id:existing.id};
    }
    if (b.direction==='REMOVE') await assertCredit(q,s,customer,amount);
    return insert(q,`INSERT INTO wallet_adjustments(store_id,customer_id,actor_id,reason,amount,source,request_key)
      VALUES($1,$2,$3,$4,$5,'MANUAL_NO_PAYMENT',$6) RETURNING id`,[s,customer,auth.id,reason,delta,key]);
  },{owner:true});
  async function cancellationQuote(q,s,id){
    const {rows:[quote]}=await q(`WITH target AS (
      SELECT r.id,r.order_id,r.profile_id,r.ends_at,r.profile_unassigned,o.customer_id,p.account_id,
        date_trunc('milliseconds',clock_timestamp()) AS cutoff
      FROM rentals r JOIN orders o ON (o.store_id,o.id)=(r.store_id,r.order_id)
      JOIN profiles p ON (p.store_id,p.id)=(r.store_id,r.profile_id)
      WHERE (r.store_id,r.id)=($1,$2) AND r.status='ACTIVE' AND NOT ${assignmentPending}
        AND r.ends_at>clock_timestamp()
    ), billed AS (
      SELECT o.amount,o.days,
        least(o.days,greatest(0,ceil(extract(epoch FROM
          least(t.ends_at,p.ends_at)-greatest(t.cutoff,p.starts_at))/86400))) AS remaining
      FROM target t JOIN rental_service_periods p ON (p.store_id,p.rental_id)=($1,t.id)
      JOIN orders o ON (o.store_id,o.id)=(p.store_id,p.order_id)
    )
    SELECT t.*,totals.* FROM target t CROSS JOIN LATERAL (
      SELECT sum(b.days-b.remaining)::int AS used_days,sum(b.remaining)::int AS remaining_days,
        round(sum(b.amount*b.remaining/b.days),2)::text AS credit_amount FROM billed b
    ) totals WHERE totals.credit_amount IS NOT NULL`,[s,validId(id)]);
    if (!quote) reject(409,'CANCELLATION_UNAVAILABLE');
    return quote;
  }
  register('GET','rentals/:rentalId/cancel-quote',async(q,s,b,{params:{rentalId}})=>{
    const {used_days,remaining_days,credit_amount}=await cancellationQuote(q,s,rentalId);
    return {used_days,remaining_days,credit_amount};
  },{owner:true});
  register('POST','rentals/:rentalId/cancel',async(q,s,b,req,auth)=>{
    const id=validId(req.params.rentalId);
    if (typeof b.refund==='boolean') {
      if (!b.refund) {
        await removeRental(q,s,id);
        return {credit_amount:'0.00'};
      }
      const quote=await cancellationQuote(q,s,id);
      if (quote.credit_amount!==b.expected_credit) reject(409,'CANCELLATION_QUOTE_CHANGED');
      const reason=b.reason?shortText(b.reason):'Rental cancelled';
      await removeRental(q,s,id);
      await q(`INSERT INTO rental_cancellations(store_id,rental_id,customer_id,actor_id,reason,requested_at,credit_amount,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$6)`,[s,id,quote.customer_id,auth.id,reason,quote.cutoff,quote.credit_amount]);
      if (Number(quote.credit_amount)>0) await q(`INSERT INTO wallet_adjustments(store_id,customer_id,actor_id,reason,amount,source,rental_id)
        VALUES($1,$2,$3,$4,$5,'RENTAL_CANCEL_CREDIT',$6)`,[s,quote.customer_id,auth.id,reason,quote.credit_amount,id]);
      return {credit_amount:quote.credit_amount};
    }
    if (b.confirm!==true) reject(400,'CONFIRM_REQUIRED');
    const reason=shortText(b.reason);
    const quote=await cancellationQuote(q,s,id);
    if (quote.profile_unassigned) reject(409,'CANCELLATION_UNAVAILABLE');
    if (quote.credit_amount!==b.expected_credit) reject(409,'CANCELLATION_QUOTE_CHANGED');
    await q(`INSERT INTO rental_cancellations(store_id,rental_id,customer_id,actor_id,reason,requested_at,credit_amount)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[s,id,quote.customer_id,auth.id,reason,quote.cutoff,quote.credit_amount]);
    await q("UPDATE rentals SET status='REVOCATION_PENDING' WHERE (store_id,id)=($1,$2)",[s,id]);
    const job=await enqueue(q,s,{type:'REVOKE_ACCESS',rental_id:id,order_id:quote.order_id,
      account_id:quote.account_id,profile_id:quote.profile_id},auth.id,req.id);
    return {job_id:job.id,credit_amount:quote.credit_amount};
  },{owner:true});
  register('POST','rentals/:rentalId/release-profile',async(q,s,b,req)=>{
    const id=validId(req.params.rentalId);
    const {rows:[target]}=await q(`UPDATE rentals r SET profile_unassigned=true,release_requested_at=NULL
      WHERE (r.store_id,r.id)=($1,$2)
      AND r.status='ACTIVE' AND NOT r.profile_unassigned AND r.profile_id=$3
      RETURNING r.profile_id,r.ends_at,greatest(0,ceil(extract(epoch FROM r.ends_at-clock_timestamp())/86400))::int AS remaining_days`,
      [s,id,validId(b.profile_id)]);
    if (!target) reject(409,'RENTAL_CHANGED');
    await releaseMockProfile(q,s,target.profile_id);
    return target;
  },{owner:true});
  async function removeRental(q,s,id) {
    const pending=await q(`SELECT 1 FROM rental_cancellations
      WHERE (store_id,rental_id)=($1,$2) AND completed_at IS NULL`,[s,id]);
    if(pending.rowCount) reject(409,'REFUND_IN_PROGRESS');
    const {rows:[rental]}=await q(`UPDATE rentals SET status='CLOSED',release_requested_at=NULL
      WHERE (store_id,id)=($1,$2) AND status<>'CLOSED' RETURNING profile_id,profile_unassigned`,[s,id]);
    if (!rental) reject(409,'RENTAL_CHANGED');
    const {rows:jobs}=await q(`UPDATE jobs SET status='CANCELLED',lease_digest=NULL,lease_until=NULL
      WHERE (store_id,rental_id)=($1,$2) AND status IN ('QUEUED','LEASED','RUNNING','RETRY_WAIT','RECONCILING','DEAD_LETTER')
      RETURNING profile_id`,[s,id]);
    const profiles=new Set(rental.profile_unassigned?[]:[rental.profile_id]);
    for (const {profile_id} of jobs) {
      if (!profile_id || profiles.has(profile_id)) continue;
      const reserved=await q(`SELECT 1 FROM profiles WHERE (store_id,id)=($1,$2)
        AND status IN ('RESERVED','HELD') AND archived_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM jobs j WHERE (j.store_id,j.profile_id)=($1,$2) AND j.rental_id IS DISTINCT FROM $3::uuid
          AND j.type IN ('DELIVER_ACCESS','RECONCILE_DELIVERY')
          AND j.status IN ('QUEUED','LEASED','RUNNING','RETRY_WAIT','RECONCILING'))`,[s,profile_id,id]);
      if (reserved.rowCount) profiles.add(profile_id);
    }
    for (const profile of profiles) await releaseMockProfile(q,s,profile);
  }
  register('POST','rentals/:rentalId/remove',async(q,s,b,{params:{rentalId}})=>{
    await removeRental(q,s,validId(rentalId));
    return {ok:true};
  },{owner:true});
  register('POST','rentals/:rentalId/remaining-days',async(q,s,b,{params:{rentalId}})=>{
    const id=validId(rentalId),days=b.remaining_days;
    if (!Number.isInteger(days)||days<0||days>3650) reject(400,'INVALID_DURATION');
    const {rows:[rental]}=await q(`SELECT ends_at FROM rentals r WHERE (store_id,id)=($1,$2)
      AND status='ACTIVE' AND NOT ${assignmentPending}`,[s,id]);
    if (!rental || rental.ends_at.toISOString()!==b.expected_ends_at) reject(409,'RENTAL_CHANGED');
    if (days===0) {
      await removeRental(q,s,id);
      return {remaining_days:0};
    }
    const {rows:[updated]}=await q(`UPDATE rentals SET ends_at=greatest(starts_at,clock_timestamp())+$3::int*interval '24 hours'
      WHERE (store_id,id)=($1,$2) RETURNING ends_at`,[s,id,days]);
    return {...updated,remaining_days:days};
  },{owner:true});
  register('POST','rentals/:rentalId/adjust-days',async(q,s,b,{params:{rentalId}})=>{
    const id=validId(rentalId),days=b.days;
    if (!['ADD','REMOVE'].includes(b.direction)||!Number.isInteger(days)||days<1||days>3650)
      reject(400,'INVALID_DURATION');
    const {rows:[rental]}=await q(`SELECT ends_at,
      greatest(0,ceil(extract(epoch FROM ends_at-now())/86400))::int AS remaining
      FROM rentals r WHERE (store_id,id)=($1,$2) AND status='ACTIVE' AND NOT ${assignmentPending}`,[s,id]);
    if (!rental || rental.ends_at.toISOString()!==b.expected_ends_at) reject(409,'RENTAL_CHANGED');
    if (b.direction==='REMOVE') {
      if (days>rental.remaining) reject(400,'INVALID_DURATION');
      if (days===rental.remaining) {
        await removeRental(q,s,id);
        return {remaining_days:0,cancelled:true};
      }
    }
    const delta=b.direction==='ADD'?days:-days;
    const {rows:[updated]}=await q(`UPDATE rentals SET ends_at=greatest(ends_at,now())+$3::int*interval '24 hours'
      WHERE (store_id,id)=($1,$2) RETURNING ends_at`,[s,id,delta]);
    return {...updated,remaining_days:rental.remaining+delta};
  },{owner:true});
  const replacementPath='rentals/:rentalId/replacement';
  const replacementCandidates=`FROM rentals r JOIN orders o ON (o.store_id,o.id)=(r.store_id,r.order_id)
    JOIN profiles prior ON (prior.store_id,prior.id)=(r.store_id,r.profile_id)
    JOIN accounts previous ON (previous.store_id,previous.id)=(prior.store_id,prior.account_id)
    JOIN accounts a ON a.store_id=r.store_id AND a.platform=COALESCE(o.platform,previous.platform)
    JOIN profiles p ON (p.store_id,p.account_id)=(a.store_id,a.id) AND ${availableProfile}
    WHERE (r.store_id,r.id)=($1,$2) AND r.status='ACTIVE' AND r.profile_unassigned
      AND NOT ${assignmentPending} AND r.ends_at>clock_timestamp()
      AND a.archived_at IS NULL AND a.health='HEALTHY' AND a.checked_at>now()-interval '24 hours'
      AND a.subscription_until>=r.ends_at`;
  register('GET',replacementPath,async(q,s,b,{params:{rentalId}})=>(await q(`SELECT a.id,a.email,a.platform,
    jsonb_agg(jsonb_build_object('id',p.id,'label',p.label) ORDER BY p.label,p.id) AS profiles
    ${replacementCandidates} GROUP BY a.store_id,a.id ORDER BY a.email,a.id`,[s,validId(rentalId)])).rows,{owner:true});
  register('POST',replacementPath,async(q,s,b,req,auth)=>{
    const id=validId(req.params.rentalId);
    const {rows:[target]}=await q(`SELECT a.id AS account_id,p.id AS profile_id,r.order_id
      ${replacementCandidates} AND (a.id,p.id)=($3,$4)`,[s,id,validId(b.account_id),validId(b.profile_id)]);
    if (!target) reject(409,'NO_ELIGIBLE_ALLOCATION');
    await q("UPDATE profiles SET status='RESERVED' WHERE (store_id,id)=($1,$2)",[s,target.profile_id]);
    const job=await enqueue(q,s,{...target,rental_id:id,type:'DELIVER_ACCESS'},auth.id,req.id);
    return {job_id:job.id};
  },{owner:true});
  register('POST','packages',(q,s,b)=>insert(q,`INSERT INTO streaming_packages(store_id,platform,name,days,amount)
    VALUES($1,$2,$3,$4,$5) RETURNING id,platform,name,days,amount`,
    [s,streamingPlatform(b.platform),shortText(b.name),duration(b.days),money(b.amount)]),{owner:true,sale:true});
  register('POST','packages/:packageId',async(q,s,b,req)=>{
    const {rows:[entry]}=await q(`UPDATE streaming_packages SET name=$3,days=$4,amount=$5
      WHERE store_id=$1 AND id=$2 RETURNING id,platform,name,days,amount`,
      [s,req.params.packageId,shortText(b.name),duration(b.days),money(b.amount)]);
    if (!entry) reject(404,'NOT_FOUND');
    return entry;
  },{owner:true,sale:true});
  register('POST','customers',(q,s,b)=>insert(q,'INSERT INTO customers(store_id,name,alias,url) VALUES($1,$2,$3,$4) RETURNING id,name,alias,url',
    [s,shortText(b.name),customerAlias(b.alias),customerUrl(b.url)]),{sale:true});
  register('POST','customers/:customerId/contact',async(q,s,b,req)=>{
    const {rows:[customer]}=await q('UPDATE customers SET alias=$3,url=$4,name=coalesce($5,name) WHERE store_id=$1 AND id=$2 RETURNING id,name,alias,url',
      [s,req.params.customerId,customerAlias(b.alias),customerUrl(b.url),b.name===undefined?null:shortText(b.name)]);
    if(!customer) reject(404,'NOT_FOUND');
    return customer;
  },{owner:true});
  register('POST','streaming-emails',async(q,s,b)=>{
    const email=emailAddress(b.email);
    const {rows:[archived]}=await q(`SELECT id FROM streaming_email_addresses
      WHERE store_id=$1 AND email=$2 AND archived_at IS NOT NULL`,[s,email]);
    const id=archived?.id??randomUUID();
    return insert(q,`INSERT INTO streaming_email_addresses(store_id,email,id,password_hash,encrypted_password)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(store_id,email) DO UPDATE
      SET archived_at=NULL,password_hash=excluded.password_hash,encrypted_password=excluded.encrypted_password
      WHERE streaming_email_addresses.archived_at IS NOT NULL
      RETURNING id,email,true AS password_set`,
      [s,email,id,await passwordHash(b.password),encryptCredential(b.password,s,'email:'+id)])
      .then(entry=>entry??reject(409,'STREAMING_EMAIL_EXISTS'));
  },{owner:true,sale:true});
  register('GET','streaming-emails/:emailId',async(q,s,b,{params:{emailId}})=>{
    const {rows:[entry]}=await q(`SELECT id,email,encrypted_password,password_hash IS NOT NULL AS password_set,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'platform',a.platform) ORDER BY a.platform)
        FROM accounts a WHERE (a.store_id,a.email)=(e.store_id,e.email) AND a.archived_at IS NULL),'[]'::jsonb) AS accounts
      FROM streaming_email_addresses e WHERE (e.store_id,e.id)=($1,$2) AND e.archived_at IS NULL`,[s,validId(emailId)]);
    if (!entry) reject(404,'NOT_FOUND');
    const {encrypted_password,...details}=entry;
    return {...details,password:decryptCredential(encrypted_password,s,'email:'+emailId)};
  },{owner:true});
  register('POST','streaming-emails/:emailId',async(q,s,b,{params:{emailId}})=>{
    const {rows:[entry]}=await q(`SELECT e.email,EXISTS (SELECT 1 FROM accounts a WHERE (a.store_id,a.email)=(e.store_id,e.email)
      AND a.archived_at IS NULL) AS bound
      FROM streaming_email_addresses e
      WHERE e.store_id=$1 AND e.id=$2 AND e.archived_at IS NULL`,[s,validId(emailId)]);
    if (!entry) reject(404,'NOT_FOUND');
    const email=b.email===undefined?entry.email:emailAddress(b.email);
    if (entry.bound&&email!==entry.email) reject(409,'STREAMING_EMAIL_BOUND');
    const hash=b.password===undefined||b.password===''?null:await passwordHash(b.password);
    return insert(q,`UPDATE streaming_email_addresses SET email=$3,password_hash=COALESCE($4,password_hash),
      encrypted_password=CASE WHEN $4::text IS NULL THEN encrypted_password ELSE $5 END
      WHERE store_id=$1 AND id=$2 RETURNING id,email,password_hash IS NOT NULL AS password_set`,
      [s,emailId,email,hash,hash?encryptCredential(b.password,s,'email:'+emailId):null]);
  },{owner:true});
  register('POST','streaming-emails/:emailId/archive',async(q,s,b,{params:{emailId}})=>{
    const {rows:[entry]}=await q(`UPDATE streaming_email_addresses
      SET archived_at=clock_timestamp(),password_hash=NULL,encrypted_password=NULL
      WHERE (store_id,id)=($1,$2) AND archived_at IS NULL RETURNING email`,[s,validId(emailId)]);
    if (!entry) reject(404,'NOT_FOUND');
    const {rows:accounts}=await q(`UPDATE accounts SET archived_at=clock_timestamp()
      WHERE store_id=$1 AND email=$2 AND archived_at IS NULL RETURNING id`,[s,entry.email]);
    const ids=accounts.map(row=>row.id);
    const refunds=await q(`SELECT 1 FROM rental_cancellations c JOIN rentals r ON (r.store_id,r.id)=(c.store_id,c.rental_id)
      JOIN profiles p ON (p.store_id,p.id)=(r.store_id,r.profile_id)
      WHERE c.store_id=$1 AND p.account_id=ANY($2::uuid[]) AND c.completed_at IS NULL`,[s,ids]);
    if(refunds.rowCount) reject(409,'REFUND_IN_PROGRESS');
    await q(`UPDATE orders o SET status='PAID_WAITING',profile_id=NULL FROM profiles p
      WHERE (o.store_id,o.profile_id)=(p.store_id,p.id) AND o.store_id=$1
      AND p.account_id=ANY($2::uuid[]) AND o.status='DELIVERING'`,[s,ids]);
    await q(`UPDATE jobs j SET status='CANCELLED',lease_until=NULL,lease_digest=NULL
      WHERE j.store_id=$1 AND j.status NOT IN ('SUCCEEDED','CANCELLED') AND (
        j.account_id=ANY($2::uuid[]) OR EXISTS (SELECT 1 FROM profiles p
          WHERE (p.store_id,p.id)=(j.store_id,j.profile_id) AND p.account_id=ANY($2::uuid[])))`,[s,ids]);
    await q(`UPDATE rentals r SET profile_unassigned=true,release_requested_at=NULL,
      status=CASE WHEN r.ends_at<=clock_timestamp() OR r.status='REVOCATION_PENDING' AND r.release_requested_at IS NULL
        THEN 'CLOSED' ELSE 'ACTIVE' END
      FROM profiles p WHERE (r.store_id,r.profile_id)=(p.store_id,p.id) AND r.store_id=$1
      AND p.account_id=ANY($2::uuid[]) AND r.status<>'CLOSED' AND NOT r.profile_unassigned`,[s,ids]);
    await q(`UPDATE profiles SET status='AVAILABLE',pin_hash=NULL,encrypted_pin=NULL
      WHERE store_id=$1 AND account_id=ANY($2::uuid[])`,[s,ids]);
    return {accounts_removed:ids.length};
  },{owner:true});
  register('POST','accounts',async(q,s,b,req,auth)=>{
    if (b.otp!=='123456') reject(400,'MOCK_BIND_INVALID');
    const platform=streamingPlatform(b.platform);
    const profileCount=b.profile_count===undefined?5:b.profile_count;
    if (!Number.isInteger(profileCount) || profileCount<1 || profileCount>100)
      reject(400,'INVALID_PROFILE_COUNT');
    const costs=accountCostParts(b);
    const {rows:[credential]}=await q(`SELECT email,password_hash IS NOT NULL AS password_set FROM streaming_email_addresses
      WHERE store_id=$1 AND id=$2 AND archived_at IS NULL`,[s,validId(b.email_id)]);
    if (!credential?.password_set) reject(400,'STREAMING_EMAIL_PASSWORD_REQUIRED');
    const {email}=credential;
    const {rows:[{count}]}=await q('SELECT count(DISTINCT email)::int AS count FROM accounts WHERE store_id=$1 AND email<>$2 AND archived_at IS NULL',[s,email]);
    if (count>=({STARTER:20,PRO:100,BUSINESS:200})[req.plan]) reject(409,'EMAIL_QUOTA');
    await q('INSERT INTO streaming_emails(store_id,platform,email) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[s,platform,email]);
    const account=await insert(q,'INSERT INTO accounts(store_id,platform,email) VALUES($1,$2,$3) RETURNING id',[s,platform,email]);
    await q(`INSERT INTO profiles(store_id,account_id,label,is_primary)
      SELECT $1,$2,'profile'||number,number=1 FROM generate_series(1,$3::integer) AS series(number)`,[s,account.id,profileCount]);
    await saveAccountCost(q,s,account.id,auth.id,costs);
    return account;
  },{sale:true});
  async function requireActiveAccount(q,s,id) {
    const account=await q('SELECT 1 FROM accounts WHERE (store_id,id)=($1,$2) AND archived_at IS NULL',[s,validId(id)]);
    if (!account.rowCount) reject(404,'NOT_FOUND');
  }
  register('POST','accounts/:accountId/archive',async(q,s,b,{params:{accountId}})=>{
    if (b.confirm!==true) reject(400,'CONFIRM_REQUIRED');
    await requireActiveAccount(q,s,accountId);
    const {rows:[{busy}]}=await q(`SELECT EXISTS (
      SELECT 1 FROM profiles p WHERE (p.store_id,p.account_id)=($1,$2) AND (
        p.status<>'AVAILABLE' OR EXISTS (
          SELECT 1 FROM rentals r WHERE (r.store_id,r.profile_id)=(p.store_id,p.id)
            AND r.status<>'CLOSED' AND NOT r.profile_unassigned
        )
      )
    ) OR EXISTS (
      SELECT 1 FROM jobs WHERE (store_id,account_id)=($1,$2)
        AND status IN ('QUEUED','LEASED','RUNNING','RETRY_WAIT','RECONCILING')
    ) AS busy`,[s,accountId]);
    if (busy) reject(409,'ACCOUNT_IN_USE');
    await q('UPDATE accounts SET archived_at=clock_timestamp() WHERE (store_id,id)=($1,$2)',[s,accountId]);
    return {id:accountId};
  },{owner:true});
  register('POST','profiles',async(q,s,b)=>{
    const label=shortText(b.label);
    if (label.toLowerCase()==='profile1') reject(409,'PRIMARY_PROFILE_RESERVED');
    await requireActiveAccount(q,s,b.account_id);
    return insert(q,'INSERT INTO profiles(store_id,account_id,label) VALUES($1,$2,$3) RETURNING id',[s,b.account_id,label]);
  },{sale:true});
  register('GET','accounts/:accountId/cost',async(q,s,b,{params:{accountId}})=>{
    const {rows:[entry]}=await q(`SELECT a.id,c.amount,c.effective_at,
      COALESCE(c.broker_amount,0)::numeric(18,2) AS broker_amount,
      COALESCE(c.subscription_amount,c.amount) AS subscription_amount,
      round(c.amount/NULLIF(p.profile_count,0),2)::text AS profile_monthly_cost,
      round(c.amount/(30::numeric*NULLIF(p.profile_count,0)),2)::text AS profile_daily_cost
      FROM accounts a LEFT JOIN LATERAL (
        SELECT amount,broker_amount,subscription_amount,effective_at FROM streaming_account_cost_rates
        WHERE (store_id,account_id)=(a.store_id,a.id) AND effective_at<=now()
        ORDER BY effective_at DESC,id DESC LIMIT 1
      ) c ON true CROSS JOIN LATERAL (
        SELECT count(*) AS profile_count FROM profiles p
        WHERE (p.store_id,p.account_id)=(a.store_id,a.id) AND ${rentableProfile('p')}
      ) p WHERE (a.store_id,a.id)=($1,$2) AND a.archived_at IS NULL`,[s,accountId]);
    if (!entry) reject(404,'NOT_FOUND');
    return entry;
  },{owner:true});
  register('POST','accounts/:accountId/cost',(q,s,b,{params:{accountId}},auth)=>
    saveAccountCost(q,s,accountId,auth.id,accountCostParts(b)),{owner:true});
  const profilePath='accounts/:accountId/profiles/:profileId/';
  register('POST',profilePath+'rename',async(q,s,b,{params:{accountId,profileId}})=>{
    await requireActiveAccount(q,s,accountId);
    const name=shortText(b.label);
    if (name.toLowerCase()==='profile1'){
      const target=await q('SELECT 1 FROM profiles WHERE (store_id,account_id,id)=($1,$2,$3) AND is_primary',[s,accountId,profileId]);
      if (!target.rowCount) reject(409,'PRIMARY_PROFILE_RESERVED');
    }
    const {rows:[profile]}=await q(`UPDATE profiles SET label=$4
      WHERE store_id=$1 AND account_id=$2 AND id=$3 AND archived_at IS NULL RETURNING id,label`,
      [s,accountId,profileId,name]);
    if (!profile) reject(404,'NOT_FOUND');
    return profile;
  },{owner:true});
  register('POST',profilePath+'pin',async(q,s,b,{params:{accountId,profileId}})=>{
    await requireActiveAccount(q,s,accountId);
    if (typeof b.pin!=='string'||!/^\d{4}$/.test(b.pin)) reject(400,'INVALID_PROFILE_PIN');
    const target=await q(`SELECT status FROM profiles WHERE store_id=$1 AND account_id=$2 AND id=$3 AND archived_at IS NULL`,
      [s,accountId,profileId]);
    if (!target.rowCount) reject(404,'NOT_FOUND');
    if (target.rows[0].status!=='AVAILABLE') reject(409,'PROFILE_IN_USE');
    await q('UPDATE profiles SET pin_hash=$4,encrypted_pin=$5 WHERE store_id=$1 AND account_id=$2 AND id=$3',
      [s,accountId,profileId,await passwordHash('streaming-profile-pin:'+b.pin),encryptCredential(b.pin,s,profileId)]);
    return {pin_set:true};
  },{owner:true});
  register('GET',profilePath+'pin',async(q,s,b,req)=>{
    const {accountId,profileId}=req.params;
    await requireActiveAccount(q,s,accountId);
    const {rows:[profile]}=await q(`SELECT encrypted_pin,pin_hash IS NOT NULL AS pin_set FROM profiles
      WHERE (store_id,account_id,id)=($1,$2,$3) AND archived_at IS NULL`,[s,accountId,validId(profileId)]);
    if (!profile) reject(404,'NOT_FOUND');
    return {pin:decryptCredential(profile.encrypted_pin,s,profileId),pin_set:profile.pin_set};
  },{owner:true});
  register('GET','accounts/:accountId/profile-pins',async(q,s,b,{params:{accountId}})=>{
    await requireActiveAccount(q,s,accountId);
    const {rows}=await q(`SELECT id,encrypted_pin FROM profiles
      WHERE (store_id,account_id)=($1,$2) AND archived_at IS NULL`,[s,accountId]);
    return Object.fromEntries(rows.map(row=>[row.id,decryptCredential(row.encrypted_pin,s,row.id)]));
  },{owner:true});
  register('POST',profilePath+'archive',async(q,s,b,{params:{accountId,profileId}})=>{
    await requireActiveAccount(q,s,accountId);
    if (b.confirm!==true) reject(400,'CONFIRM_REQUIRED');
    const target=await q(`SELECT p.status,p.is_primary OR lower(btrim(p.label))='profile1' AS primary_profile,EXISTS (SELECT 1 FROM jobs j WHERE j.store_id=p.store_id AND j.profile_id=p.id
      AND j.status IN ('QUEUED','LEASED','RUNNING','RETRY_WAIT','RECONCILING')) AS pending
      FROM profiles p WHERE p.store_id=$1 AND p.account_id=$2 AND p.id=$3 AND p.archived_at IS NULL`,[s,accountId,profileId]);
    if (!target.rowCount) reject(404,'NOT_FOUND');
    if (target.rows[0].primary_profile) reject(409,'PRIMARY_PROFILE_RESERVED');
    if (target.rows[0].status!=='AVAILABLE'||target.rows[0].pending) reject(409,'PROFILE_IN_USE');
    await q('UPDATE profiles SET archived_at=now(),pin_hash=NULL,encrypted_pin=NULL WHERE store_id=$1 AND account_id=$2 AND id=$3',[s,accountId,profileId]);
    return {ok:true};
  },{owner:true});
  register('POST','payment-requests',(q,s,b)=>insert(q,'INSERT INTO payment_requests(store_id,customer_id,amount) VALUES($1,$2,$3) RETURNING id',
    [s,validId(b.customer_id),money(b.amount)]),{sale:true,owner:true});
  register('POST','transfers',(q,s,b)=>{
    if (!/^mock-[a-zA-Z0-9_-]{3,100}$/.test(b.evidence??'')) reject(400,'MOCK_EVIDENCE_REQUIRED');
    return insert(q,'INSERT INTO transfers(store_id,payment_id,amount,evidence) VALUES($1,$2,$3,$4) RETURNING id',
      [s,validId(b.payment_id),money(b.amount),b.evidence]);
  },{owner:true});
  register('POST','transfers/:id/approve',async(q,s,b,req)=>{
    if (b.confirm!==true) reject(400,'CONFIRM_REQUIRED');
    const id=validId(req.params.id);
    const {rows:[transfer]}=await q(`SELECT t.approved_at,t.amount,p.customer_id FROM transfers t
      JOIN payment_requests p ON p.store_id=t.store_id AND p.id=t.payment_id WHERE t.store_id=$1 AND t.id=$2`,[s,id]);
    if (!transfer) reject(404,'NOT_FOUND');
    if (!transfer.approved_at) {
      await q('INSERT INTO wallet_ledger(store_id,customer_id,transfer_id,amount) VALUES($1,$2,$3,$4)',[s,transfer.customer_id,id,transfer.amount]);
      await q('UPDATE transfers SET approved_at=now() WHERE store_id=$1 AND id=$2',[s,id]);
    }
    return {ok:true};
  },{owner:true});
  register('POST','orders',async(q,s,b)=>{
    if (b.confirm!==true) reject(400,'CONFIRM_REQUIRED');
    const customer=validId(b.customer_id), packageId=validId(b.package_id);
    const {amount,days,platform}=await packageQuote(q,s,packageId,b);
    await assertCredit(q,s,customer,amount);
    const order=await insert(q,'INSERT INTO orders(store_id,customer_id,amount,days,package_id,platform) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status',
      [s,customer,amount,days,packageId,platform]);
    await debit(q,s,customer,order.id,amount);
    return order;
  },{sale:true});
  for (const [action,kind] of [['renew','RENEWAL'],['compensate','COMPENSATION']]) {
    const renewal=kind==='RENEWAL';
    register('POST','rentals/:rentalId/'+action,async(q,s,b,req,auth)=>{
      if (b.confirm!==true) reject(400,'CONFIRM_REQUIRED');
      const id=req.params.rentalId;
      const {rows:[rental]}=await q(`SELECT r.ends_at,r.status,r.profile_id,o.customer_id,o.package_id
        FROM rentals r JOIN orders o ON (o.store_id,o.id)=(r.store_id,r.order_id)
        WHERE r.store_id=$1 AND r.id=$2`,[s,id]);
      if (!rental) reject(404,'NOT_FOUND');
      if (rental.ends_at.toISOString()!==b.expected_ends_at) reject(409,'RENTAL_CHANGED');
      if (renewal && (!rental.package_id || rental.package_id!==b.package_id)) reject(409,'ORIGINAL_PACKAGE_REQUIRED');
      const terms=renewal?await packageQuote(q,s,rental.package_id,b):{amount:'0',days:duration(b.days),platform:null};
      const reason=renewal?null:shortText(b.reason);
      const {amount,days,platform}=terms;
      if (renewal) await assertCredit(q,s,rental.customer_id,amount);
      const extension=await q(`UPDATE rentals r SET ends_at=r.ends_at+$3::integer*interval '24 hours'
        FROM profiles p JOIN accounts a ON (a.store_id,a.id)=(p.store_id,p.account_id)
        WHERE r.store_id=$1 AND r.id=$2 AND (p.store_id,p.id)=(r.store_id,r.profile_id)
        AND r.status='ACTIVE' AND NOT r.profile_unassigned AND r.ends_at>clock_timestamp() AND p.status='OCCUPIED'
        AND (NOT $4::boolean OR (${rentableProfile('p')}))
        AND a.health='HEALTHY' AND a.checked_at>clock_timestamp()-interval '24 hours'
        AND a.subscription_until>=r.ends_at+$3::integer*interval '24 hours'
        RETURNING r.ends_at`,[s,id,days,renewal]);
      if (!extension.rowCount) reject(409,'RENTAL_EXTENSION_UNAVAILABLE');
      const order=await insert(q,`INSERT INTO orders(store_id,customer_id,profile_id,amount,days,package_id,platform,status,kind,rental_id,reason,actor_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'FULFILLED',$8,$9,$10,$11) RETURNING id,kind`,
        [s,rental.customer_id,rental.profile_id,amount,days,renewal?rental.package_id:null,platform,kind,id,reason,auth.id]);
      await recordServicePeriod(q,s,order.id,id,rental.profile_id,rental.ends_at,extension.rows[0].ends_at);
      if (renewal) await debit(q,s,rental.customer_id,order.id,amount);
      return {...order,ends_at:extension.rows[0].ends_at};
    },{owner:true,sale:renewal});
  }
  register('GET','allocation-accounts',async(q,s,b,req)=>{
    const orderId=req.query.order_id===undefined?null:validId(req.query.order_id);
    let platform=null,days=null;
    if(orderId){
      const {rows:[order]}=await q("SELECT platform,days FROM orders WHERE store_id=$1 AND id=$2 AND status='PAID_WAITING'",[s,orderId]);
      if(!order) reject(404,'WAITING_ORDER_NOT_FOUND');
      platform=order.platform;
      days=order.days;
    }
    return (await q(`SELECT a.id,a.platform,a.email,a.health,count(p.id)::int AS available_profiles,
      COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'label',p.label) ORDER BY length(p.label),p.label,p.id)
        FILTER (WHERE p.id IS NOT NULL),'[]'::jsonb) AS profiles,
      a.subscription_until,now()+$4::integer*interval '24 hours' AS required_until,
      CASE WHEN count(p.id)=0 THEN 'NO_FREE_PROFILE'
        WHEN a.health='BLOCKED' THEN 'ACCOUNT_BLOCKED'
        WHEN a.health<>'HEALTHY' OR a.checked_at IS NULL OR a.subscription_until IS NULL THEN 'NOT_VERIFIED'
        WHEN a.checked_at<=now()-interval '24 hours' THEN 'CHECK_EXPIRED'
        WHEN a.subscription_until<=now() THEN 'SUBSCRIPTION_EXPIRED'
        WHEN a.subscription_until<now()+$4::integer*interval '24 hours' THEN 'SUBSCRIPTION_TOO_SHORT'
      END AS blocked_reason,
      EXISTS (SELECT 1 FROM orders o WHERE ${eligibleOrder} AND ($2::uuid IS NULL OR o.id=$2)) AS accepts_waiting_order
      FROM accounts a LEFT JOIN profiles p ON (p.store_id,p.account_id)=(a.store_id,a.id) AND ${availableProfile}
      WHERE a.store_id=$1 AND a.archived_at IS NULL AND ($3::text IS NULL OR a.platform=$3)
      GROUP BY a.store_id,a.id ORDER BY a.platform,a.email,a.id`,[s,orderId,platform,days])).rows;
  });
  register('POST','allocate',async(q,s,b,req,auth)=>{
    const account=b.account_id===undefined?null:validId(b.account_id);
    const orderId=b.order_id===undefined?null:validId(b.order_id);
    const profileId=b.profile_id===undefined?null:validId(b.profile_id);
    const {rows:[candidate]}=await q(`SELECT o.id AS order_id,p.id AS profile_id,p.account_id FROM orders o
      JOIN profiles p ON p.store_id=o.store_id AND ${availableProfile}
      JOIN accounts a ON a.store_id=p.store_id AND a.id=p.account_id
      WHERE o.store_id=$1 AND ($2::uuid IS NULL OR a.id=$2) AND ($3::uuid IS NULL OR o.id=$3)
        AND ($4::uuid IS NULL OR p.id=$4) AND ${eligibleOrder}
      ORDER BY o.created_at,o.id,p.id LIMIT 1`,[s,account,orderId,profileId]);
    if (!candidate) reject(409,'NO_ELIGIBLE_ALLOCATION');
    await q("UPDATE profiles SET status='RESERVED' WHERE store_id=$1 AND id=$2",[s,candidate.profile_id]);
    await q("UPDATE orders SET status='DELIVERING',profile_id=$3 WHERE store_id=$1 AND id=$2",[s,candidate.order_id,candidate.profile_id]);
    const job=await enqueue(q,s,{...candidate,type:'DELIVER_ACCESS'},auth.id,req.id);
    return {job_id:job.id};
  });
  register('POST','rentals/expire',async(q,s,b,req,auth)=>{
    await q(`UPDATE rentals r SET status='CLOSED' WHERE store_id=$1 AND status='ACTIVE'
      AND profile_unassigned AND ends_at<=now() AND NOT ${assignmentPending}`,[s]);
    const {rows}=await q(`UPDATE rentals SET status='REVOCATION_PENDING' WHERE store_id=$1 AND status='ACTIVE' AND ends_at<=now()
      AND NOT profile_unassigned
      RETURNING id,profile_id,order_id`,[s]);
    for (const row of rows) await enqueue(q,s,{...row,rental_id:row.id,type:'REVOKE_ACCESS'},auth.id,req.id);
    return {queued:rows.length};
  });
}

