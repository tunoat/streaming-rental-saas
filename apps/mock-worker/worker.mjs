import { WorkerClient } from '../../packages/shared/worker-client.mts';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const capabilities=['VERIFY_LOGIN','VERIFY_SUBSCRIPTION','VERIFY_PROFILE_READINESS','HEALTH_CHECK',
  'RECOVERY_VERIFICATION','DELIVER_ACCESS','REVOKE_ACCESS','RECONCILE_DELIVERY','RECONCILE_REVOCATION'];

export class MockStreamingProviderAdapter {
  execute(job, now=new Date()) {
    const observed_at=now.toISOString();
    return {
      outcome:'PASS',observed_at,evidence:{kind:'MOCK',reference:'mock-'+job.id,observed_at,source:'mock-provider'},
      checks:{login:'PASS',subscription:'PASS',profile_readiness:'PASS'},
      subscription_expires_at:new Date(now.getTime()+365*86400000).toISOString(),
      ...(job.type.includes('REVO')?{access_revoked_at:observed_at}:{}),
      ...(job.type==='DELIVER_ACCESS'||job.type==='RECONCILE_DELIVERY'?{delivery_occurred_at:observed_at}:{})
    };
  }
}
export async function runOnce(client,adapter=new MockStreamingProviderAdapter()) {
  const claim=await client.claim(capabilities);
  if (!claim) return null;
  const {job,lease_token,fencing_token}=claim;
  const lease={lease_token,fencing_token,worker_id:client.workerId};
  await client.start(job.id,lease);
  await client.heartbeat(job.id,lease);
  const result=adapter.execute(job);
  return client.report(job.id,{...lease,...result});
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  const {BOT_API_URL='http://127.0.0.1:3000',BOT_WORKER_ID,BOT_WORKER_TOKEN}=process.env;
  const url=new URL(BOT_API_URL);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !BOT_WORKER_ID || !BOT_WORKER_TOKEN)
    throw new Error('Set BOT_API_URL, BOT_WORKER_ID and BOT_WORKER_TOKEN');
  const client=new WorkerClient(url.origin,BOT_WORKER_TOKEN,BOT_WORKER_ID);
  while (true) {
    try {
      const result=await runOnce(client);
      if (result) console.info('Mock job '+result.status);
    } catch {
      console.error('Mock worker request failed');
    }
    await delay(2000);
  }
}

