import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';

export class MockNetflixAdapter {
  verify(job){
    return job.status==='BINDING'&&job.challenge==='MANUAL'?'WAITING_FOR_USER':'VERIFIED';
  }
}

export async function runNetflixOnce(config,adapter=new MockNetflixAdapter()){
  const {base,store,worker,token}=config;
  async function post(path,body){
    const response=await fetch(base+'/v1/netflix-worker/stores/'+store+'/'+path,{method:'POST',redirect:'error',
      signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':randomUUID()},
      body:JSON.stringify({worker_id:worker,...body})});
    if(!response.ok) throw new Error('Mock Netflix worker HTTP '+response.status);
    return response.status===204?null:response.json();
  }
  const job=await post('claim',{});
  if(!job) return null;
  if(job.mode!=='mock') throw new Error('Unexpected Netflix job mode');
  const {generation,fence,lease_token}=job;
  const lease={generation,fence,lease_token};
  await post(job.email_id+'/heartbeat',lease);
  const report=outcome=>post(job.email_id+'/report',{...lease,provenance:'MOCK',outcome});
  if(job.status==='BINDING'){
    const steps=['OTP_REQUESTED','WAITING_FOR_EMAIL',...(job.challenge==='AUTO'?['EMAIL_RECEIVED']:[])];
    for(const step of steps){
      const state=await report(step);
      if(state.status!=='BINDING') return state;
    }
  }
  return report(adapter.verify(job));
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const {BOT_API_URL='http://127.0.0.1:3000',NETFLIX_WORKER_STORE_ID:store,BOT_WORKER_ID:worker,BOT_WORKER_TOKEN:token}=process.env;
  const base=new URL(BOT_API_URL);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||
    !/^[a-f0-9-]{36}$/i.test(store??'')||!/^[a-zA-Z0-9_-]{1,128}$/.test(worker??'')||!/^[a-zA-Z0-9_-]{43}$/.test(token??''))
    throw new Error('Invalid Netflix mock worker configuration');
  while(true){
    try{await runNetflixOnce({base:base.origin,store,worker,token});}catch{console.error('Netflix mock worker request failed');}
    await wait(2000);
  }
}
